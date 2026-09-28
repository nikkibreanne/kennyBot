// CHASE RECORDER — writes down what the sources actually did, and what the
// detector WOULD have done about it (design §7.1).
//
//   node scripts/chase-record.mjs                     # → .workspace/chase-samples/chase-<YYYY-MM-DD>.jsonl
//   node scripts/chase-record.mjs /var/log/chase      # a DIRECTORY → one file per local day
//   node scripts/chase-record.mjs one-file.jsonl      # an explicit FILE → no rotation
//
// IT NEVER POSTS ANYWHERE. No Twitch, no Firebase, no emulator, no RTDB — it polls
// the same fetchers the monitor uses, appends what comes back, and runs the real
// evaluator over it in memory. The worst thing it can do is write a file, which is
// what makes it safe to start today and leave running for a fortnight.
//
// It DOES score now, because a recording that cannot answer "did the detector ever
// fire, and on what" only defers the question. Scoring happens in
// `src/rules/chase.js` — the production evaluator, not a copy — with state carried
// forward tick to tick exactly as `src/events/chaseMonitor.js` carries it through
// RTDB. The raw `poll` lines are still written UNCHANGED, so the timeline stays
// replayable through `scripts/chase-sim.mjs` at settings nobody has chosen yet;
// the `score` lines are a second, derived opinion sitting beside the evidence, not
// instead of it.
//
// FORMAT — one JSON object per line. A `poll` record keeps a whole tick together,
// because the evaluator scores a tick at a time and a flat stream of samples would
// lose the boundaries the scoring depends on. THE ROSTER IS PRIVATE (CLAUDE.md), so
// every id below is a placeholder: real ones only ever come out of the gitignored
// roster at runtime, and this file names none of them.
//
//   {"kind":"session","at":0,"event":"start","pollMs":60000,"discoveryMs":600000,
//    "orgs":6,"key":true,"pid":1234}
//   {"kind":"discovery","at":0,"ids":{"org1":["<videoId>"],"org2":[]}}
//   {"kind":"poll","tick":7,"at":0,"samples":[/* StreamSample */],"articles":[/* OrgArticle */]}
//   {"kind":"score","tick":7,"at":0,"score":8,"over":1,"under":0,"open":false,"groups":{}}
//   {"kind":"incident","at":0,"event":"open","id":"org1-0","org":"org1","url":"…","score":8}
//   {"kind":"incident","at":0,"event":"close","id":"org1-0","durationMs":1234,"peakScore":9}
//   {"kind":"announce","at":0,"incidentId":"org1-0","text":"…"}
//   {"kind":"health","at":0,"polls":120,"emptyPolls":3,"fetchFailures":1,"liveStreams":4,"quotaUnits":118}
//   {"kind":"backoff","at":0,"event":"start","failures":3,"remaining":1}
//   {"kind":"session","at":0,"event":"stop","reason":"SIGINT","polls":120}
//
// A `score` line is written on EVERY poll, even a zero — the series has to be
// continuous, because that is the only thing that tells "nothing happened" apart
// from "the process died". The `groups` breakdown is attached only when the score
// is non-zero, which keeps a fortnight of quiet Tuesdays small.
//
// The two gaps a reader can hit are both ATTRIBUTABLE rather than mysterious: a
// `session` stop/start pair brackets a deliberate restart, and a run of `backoff`
// lines brackets a network outage the recorder decided to stop hammering through.
// A gap with neither is a crash or a power cut, and that is worth knowing.
//
// RESTARTS APPEND, never truncate, and the evaluator deliberately starts COLD: its
// audience channel stays disabled until `minSamples` baseline points exist again
// (design §2.4). A restart must never fire on a baseline it does not have, so
// rebuilding that state out of the file would be reconstructing the one guard the
// evaluator has against cold-start false positives.
//
// WITHOUT A YOUTUBE KEY this still runs, but it only records DISCOVERY — no stream
// samples at all, because RSS cannot say whether a video is live. There is no keyless
// way to read concurrent viewers, so the fast loop records nothing, the audience
// channel — the only detector that works on a permanently-titled `chopper`-class cam
// — is simply absent, and every score is 0. The heartbeat says so on every line
// rather than looking healthy while collecting a fixture that proves nothing.
import 'dotenv/config';
import { createWriteStream, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, sep } from 'node:path';
import { config } from '../src/config.js';
import { evaluateChase } from '../src/rules/chase.js';
import {
  fetchLiveSamples, discoverVideoIds, fetchArticles, youtubeKeyPresent,
} from '../src/integrations/chaseSources.js';

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log('usage: node scripts/chase-record.mjs [outdir | outfile.jsonl]');
  console.log('  a directory (the default) rotates daily; an explicit .jsonl file does not.');
  console.log('  env: CHASE_SOURCES_FILE (private roster) · CHASE_HEALTH_MS (health cadence)');
  process.exit(0);
}

// A DIRECTORY by default: two weeks of this is a fortnight of daily files, not one
// giant one. The literal is written INLINE rather than behind a named constant on
// purpose — scripts/chase-report.mjs reads this default back out of this file's
// source so the two can never drift, and it matches on the string sitting right
// here next to `process.argv[2]`.
const TARGET = process.argv[2] || '.workspace/chase-samples';
/** Overridable only so the shape can be exercised in a short run; the real cadence is 30m. */
const HEALTH_MS = Math.max(1000, Number(process.env.CHASE_HEALTH_MS) || 30 * 60_000);

/** After this many consecutive failed polls, start skipping polls instead of hammering. */
const BACKOFF_AFTER = 3;
/** ...but never skip more than this many in a row, or a recovered network goes unnoticed for hours. */
const BACKOFF_MAX_SKIPS = 15;

const { chase } = config;

// Same floors as the real scheduler. These are not just defaults: a mistyped interval
// is the one config error here that costs quota rather than accuracy, and this process
// is meant to run unattended for a fortnight.
const POLL_MS = Math.max(15_000, Number(chase.pollMs) || 60_000);
const DISCOVERY_MS = Math.max(60_000, Number(chase.discoveryMs) || 10 * 60_000);

// Heartbeats go to stdout, everything the fetchers have to say goes to stderr,
// so `node scripts/chase-record.mjs > heartbeat.log` stays readable.
//
// The loggers also COUNT. The fetchers in src/integrations/chaseSources.js never
// throw — a dead feed returns `[]` and logs — so the return value cannot tell a
// quiet minute apart from a broken one. The warning is the only place that
// distinction exists, which makes this the honest place to count from.
const NETWORK_TROUBLE = /\b(rejected|unreachable|failed)\b/i;
let fetchFailures = 0;

function makeLogger(onTrouble) {
  const emit = (tag, m, meta) => console.error(`  [${tag}] ${m}${meta ? ` ${JSON.stringify(meta)}` : ''}`);
  const noticing = (tag) => (m, meta) => {
    if (NETWORK_TROUBLE.test(String(m))) onTrouble();
    emit(tag, m, meta);
  };
  return {
    debug() {},
    info: (m, meta) => emit('info', m, meta),
    warn: noticing('warn'),
    error: noticing('err '),
  };
}

/** Set by the fast loop's own logger, so a discovery failure never triggers its backoff. */
let pollTroubled = false;
const pollLog = makeLogger(() => { fetchFailures += 1; pollTroubled = true; });
const log = makeLogger(() => { fetchFailures += 1; });

// The roster is PRIVATE and `config.chase.orgs` ships empty (CLAUDE.md). The bot reads
// it from RTDB, but this recorder deliberately runs with NO Firebase — the whole point
// is that it can collect evidence anywhere, with nothing configured. So it reads the
// same gitignored file the loader does.
const SOURCES_FILE = process.env.CHASE_SOURCES_FILE || '.workspace/chase-sources.json';
function loadSources() {
  if (chase.orgs.length) return chase.orgs; // a caller that populated config wins
  try {
    const parsed = JSON.parse(readFileSync(SOURCES_FILE, 'utf8'));
    return Array.isArray(parsed) ? parsed.filter((o) => o?.id && o?.channelId) : [];
  } catch {
    return [];
  }
}
const orgs = loadSources();
if (!orgs.length) {
  console.error(`\n  no sources — ${SOURCES_FILE} is missing or empty.`);
  console.error('  That file is gitignored and is NOT in the repo; see scripts/chase-sources-load.mjs');
  console.error('  for its shape, or set CHASE_SOURCES_FILE to another path.\n');
  process.exit(1);
}

/** What the evaluator is given: the shipped settings, with the private roster layered on. */
const cfg = { ...chase, orgs };

/**
 * An org's DISPLAY NAME is the one roster field that reaches an announcement, and
 * stdout gets tailed, redirected and screen-shared. So the console prints the
 * sentence with every display name swapped for its opaque org id; the log file —
 * which is gitignored operational data, like every raw title already in it — keeps
 * the real text, because "what would it have said" is the question being recorded.
 * Longest names first, so one name that contains another cannot be half-replaced.
 */
const ORG_NAMES = orgs
  .filter((o) => o?.name && o?.id)
  .map((o) => [String(o.name), String(o.id)])
  .sort((a, b) => b[0].length - a[0].length);
const deName = (text) => ORG_NAMES.reduce((s, [name, id]) => s.split(name).join(id), String(text ?? ''));

const clock = () => new Date().toTimeString().slice(0, 8);
const short = (n) => (n >= 10_000 ? `${(n / 1000).toFixed(0)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const RULE = '─'.repeat(64);
/** Incidents are the whole point of leaving this running — they do not get one quiet line. */
const loud = (m) => console.log(`\n${RULE}\n  ${clock()}  ${m}\n${RULE}\n`);

// ── the sink: a directory rotates daily, an explicit file does not ────────────

/** An existing directory, a trailing separator, or no extension at all. */
function targetIsDirectory(p) {
  try { return statSync(p).isDirectory(); } catch { /* not created yet — fall through */ }
  return p.endsWith('/') || p.endsWith(sep) || extname(p) === '';
}
const DIR_MODE = targetIsDirectory(TARGET);

const pad2 = (n) => String(n).padStart(2, '0');
/** LOCAL midnight, not UTC: the operator reads this log in the timezone they live in. */
const localDay = (d = new Date()) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

let out = null;
let outDay = null;
let outPath = null;

/**
 * ALWAYS `flags:'a'`. A restart must extend the record, not destroy it — the whole
 * value of this file is that it is two weeks long, and a truncating reopen after a
 * crash would be an unrecoverable loss of exactly the days worth having.
 */
function openSink(path) {
  const stream = createWriteStream(path, { flags: 'a' });
  // A full disk arrives as an 'error' EVENT; unhandled, that is an exception that
  // takes the timers with it. Losing the log is survivable, losing the run is not.
  stream.on('error', (err) => console.error(`  [err ] log stream: ${err?.message || err}`));
  return stream;
}

function sink() {
  if (!DIR_MODE) {
    if (!out) {
      mkdirSync(dirname(TARGET) || '.', { recursive: true });
      outPath = TARGET;
      out = openSink(outPath);
    }
    return out;
  }
  const day = localDay();
  if (out && day === outDay) return out;
  mkdirSync(TARGET, { recursive: true });
  const previous = out;
  outPath = join(TARGET, `chase-${day}.jsonl`);
  outDay = day;
  out = openSink(outPath);
  if (previous) {
    previous.end();
    console.log(`${clock()}  rolled over → ${outPath}`);
  }
  return out;
}

let lines = 0;
function write(record) {
  try {
    sink().write(`${JSON.stringify(record)}\n`);
    lines += 1;
  } catch (err) {
    // Never fatal. A recorder that dies because it could not write one line has
    // thrown away the rest of the fortnight to report a single missing line.
    console.error(`  [err ] could not write a '${record?.kind}' line: ${err?.message || err}`);
  }
}

// ── state ────────────────────────────────────────────────────────────────────

let tick = 0;
let emptyPolls = 0;
let liveStreams = 0;
/** `videos.list` bills 1 unit per CALL against a 10,000/day budget (design §3). */
let quotaUnits = 0;
let consecutiveFailures = 0;
let skipsRemaining = 0;
let polling = false;
let stopping = false;

/**
 * Carried forward in memory exactly as the scheduler carries it through RTDB:
 * `state = result.state` every tick. `null` is what a fresh install hands the
 * evaluator, and it normalizes it into an empty state itself.
 * @type {import('../src/rules/chase.js').MonitorState|null}
 */
let state = null;

/**
 * Discovery results MERGED per org, never replaced. An org whose feed failed is
 * absent from a sweep rather than empty (by design, in chaseSources.js), so
 * replacing would forget a live stream because one request timed out — for the ten
 * minutes until the next sweep, which is most of a short chase.
 * @type {Record<string, string[]>}
 */
let knownByOrg = {};
/** The flat list the fast loop asks about — up to 50 ids in one billed call. */
let known = [];
/**
 * The last article sweep, carried forward between sweeps on purpose: the
 * evaluator re-checks each item's age against the tick it is scoring, so a
 * 10-minute-old fetch ages out by itself rather than needing a re-fetch.
 */
let articles = [];

/**
 * Discovery returns ids grouped by org; the fast loop wants one flat list,
 * because `videos.list` takes up to 50 ids in a single quota unit and the org
 * each video belongs to is recovered from its channelId on the way back.
 */
function flatten(byOrg) {
  const seen = new Set();
  for (const ids of Object.values(byOrg || {})) {
    for (const id of ids || []) if (id) seen.add(id);
  }
  return [...seen];
}

async function discover() {
  try {
    const byOrg = await discoverVideoIds(orgs, log);
    if (byOrg && typeof byOrg === 'object') knownByOrg = { ...knownByOrg, ...byOrg };
    known = flatten(knownByOrg);
    write({ kind: 'discovery', at: Date.now(), ids: byOrg });
  } catch (err) {
    fetchFailures += 1;
    log.error('discovery failed', { err: err?.message });
  }
  try {
    articles = (await fetchArticles(orgs, log)) || [];
  } catch (err) {
    fetchFailures += 1;
    log.error('article sweep failed', { err: err?.message });
  }
}

async function poll() {
  // A slow fetch must not overlap the next tick — the timers keep firing whatever
  // the network is doing, and two in-flight polls would double the quota spend.
  if (polling) {
    console.error('  [warn] previous poll still in flight — skipping this tick');
    return;
  }
  // Politeness, not punishment: after a run of failures the network is down, and a
  // request a minute for the next six hours helps nobody. The decision is recorded,
  // so the resulting hole in the series reads as a decision rather than a death.
  if (skipsRemaining > 0) {
    skipsRemaining -= 1;
    write({ kind: 'backoff', at: Date.now(), event: 'skip', failures: consecutiveFailures, remaining: skipsRemaining });
    console.log(`${clock()}  backing off — ${consecutiveFailures} failures, ${skipsRemaining} more poll(s) skipped`);
    return;
  }

  polling = true;
  tick += 1;
  const at = Date.now();
  let samples = [];
  let threw = false;
  pollTroubled = false;

  try {
    // Mirrors fetchLiveSamples' own early returns: with no key, or nothing
    // discovered yet, it spends no quota, so neither does this counter.
    const billed = youtubeKeyPresent() && known.length > 0;
    if (billed) quotaUnits += 1;
    try {
      samples = (await fetchLiveSamples(orgs, known, pollLog)) || [];
    } catch (err) {
      // A dead fetch is data too — record the empty tick so a gap in the timeline
      // is visible as a gap rather than as a quiet stretch.
      threw = true;
      fetchFailures += 1;
      pollLog.error('sample fetch failed', { err: err?.message });
    }

    // UNCHANGED, and first: this line is the evidence. Everything below it is an
    // opinion about the evidence, and opinions get re-derived from a replay.
    write({ kind: 'poll', tick, at, samples, articles });

    if (!samples.length) emptyPolls += 1;
    const live = samples.filter((s) => s.live);
    liveStreams = live.length;

    if (threw || pollTroubled) {
      consecutiveFailures += 1;
      if (consecutiveFailures >= BACKOFF_AFTER && skipsRemaining === 0) {
        skipsRemaining = Math.min(consecutiveFailures - BACKOFF_AFTER + 1, BACKOFF_MAX_SKIPS);
        write({ kind: 'backoff', at: Date.now(), event: 'start', failures: consecutiveFailures, remaining: skipsRemaining });
        console.log(`${clock()}  ${consecutiveFailures} consecutive fetch failures — skipping the next ${skipsRemaining} poll(s)`);
      }
    } else if (consecutiveFailures) {
      write({ kind: 'backoff', at: Date.now(), event: 'recovered', failures: consecutiveFailures, remaining: 0 });
      console.log(`${clock()}  sources reachable again after ${consecutiveFailures} failure(s)`);
      consecutiveFailures = 0;
      skipsRemaining = 0;
    }

    // ── the same judgement the bot would make, on the same tick ───────────────
    let result = null;
    try {
      result = evaluateChase({ samples, articles, state, now: at, cfg });
      state = result.state;
    } catch (err) {
      log.error('scoring threw — the raw sample line above is still intact', { err: err?.message });
    }

    if (result) {
      const line = {
        kind: 'score',
        tick,
        at,
        score: result.score,
        over: result.state.overCount,
        under: result.state.underCount,
        open: Boolean(result.state.incident),
      };
      // Only when there is something to break down. Two weeks of zeroes with a full
      // per-org breakdown attached is a large file saying nothing.
      if (result.score > 0) line.groups = result.groups;
      write(line);

      if (result.opened && result.state.incident) {
        const inc = result.state.incident;
        write({ kind: 'incident', at, event: 'open', id: inc.id, org: inc.org, url: inc.url, score: result.score });
        loud(`INCIDENT OPEN   ${inc.id}   org ${inc.org}   score ${result.score}   ${inc.url}`);
      }
      if (result.closed && result.state.lastIncident) {
        const last = result.state.lastIncident;
        const durationMs = Math.max(0, at - (Number(last.openedAt) || at));
        write({ kind: 'incident', at, event: 'close', id: last.id, durationMs, peakScore: last.peakScore });
        loud(`INCIDENT CLOSE  ${last.id}   after ${Math.round(durationMs / 60_000)}m   peak ${last.peakScore}`);
      }
      if (result.announce) {
        write({ kind: 'announce', at, incidentId: result.announce.incident?.id ?? null, text: result.announce.text });
        loud(`WOULD HAVE SAID  "${deName(result.announce.text)}"  (nothing was sent — this recorder never posts)`);
      }
    }

    const seen = live
      .filter((s) => Number.isFinite(s.viewers))
      .map((s) => `${s.org} ${short(s.viewers)}`)
      .join(' · ');
    const audience = youtubeKeyPresent() ? seen || 'no viewer counts' : 'NO KEY — discovery only, no samples';
    console.log(
      `${clock()}  poll #${String(tick).padStart(4)}  ` +
      `${String(live.length).padStart(2)}/${String(samples.length).padStart(2)} live  ` +
      `${audience}  ·  ${articles.length} article${articles.length === 1 ? '' : 's'}  ·  ${lines} lines` +
      `  ·  score ${result ? result.score : '?'}`,
    );
  } finally {
    polling = false;
  }
}

/** Every 30 minutes: enough to see quota burn, an outage and a stall without reading the whole file. */
function health() {
  write({
    kind: 'health',
    at: Date.now(),
    polls: tick,
    emptyPolls,
    fetchFailures,
    liveStreams,
    quotaUnits,
  });
  console.log(
    `${clock()}  health  ${tick} polls · ${emptyPolls} empty · ${fetchFailures} fetch failures · `
    + `${liveStreams} live · ${quotaUnits}/10000 quota units`,
  );
}

async function main() {
  console.log(`  recording to ${DIR_MODE ? `${join(TARGET, 'chase-<YYYY-MM-DD>.jsonl')} (rolls at local midnight)` : TARGET}`);
  const every = (ms) => (ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60_000)}m`);
  console.log(`  fast loop ${every(POLL_MS)} · discovery ${every(DISCOVERY_MS)} · health ${every(HEALTH_MS)} · ${orgs.length} orgs`);
  if (!youtubeKeyPresent()) {
    console.log('  ⚠ no YOUTUBE_API_KEY — DISCOVERY ONLY. No stream samples will be recorded at all:');
    console.log('    RSS lists videos but never says which are live, so there is nothing to score.');
  }
  console.log('  ctrl-c to stop. This scores but NEVER posts anywhere.\n');

  // First line in the file, so a reader always knows what the run was configured to
  // do before it reads a single sample — and so a restart is visible as a restart.
  write({
    kind: 'session',
    at: Date.now(),
    event: 'start',
    pollMs: POLL_MS,
    discoveryMs: DISCOVERY_MS,
    orgs: orgs.length,
    key: youtubeKeyPresent(), // a boolean, never the key
    pid: process.pid,
  });

  await discover();
  await poll();

  // Every loop is wrapped at the call site, so a thrown fetch can never kill a
  // timer and silently end a two-week recording.
  const fast = setInterval(() => { poll().catch((err) => log.error('poll threw', { err: err?.message })); }, POLL_MS);
  const slow = setInterval(() => { discover().catch((err) => log.error('discovery threw', { err: err?.message })); }, DISCOVERY_MS);
  const beat = setInterval(() => { try { health(); } catch (err) { log.error('health threw', { err: err?.message }); } }, HEALTH_MS);

  const stop = (reason) => {
    if (stopping) return;
    stopping = true;
    clearInterval(fast);
    clearInterval(slow);
    clearInterval(beat);
    write({ kind: 'session', at: Date.now(), event: 'stop', reason, polls: tick });
    const done = () => {
      console.log(`\n  stopped after ${tick} polls — ${lines} lines in ${outPath}`);
      process.exit(0);
    };
    // Flush, but never hang on the flush: an exit that waits forever on a wedged
    // stream is a process the operator has to kill -9, and kill -9 loses the stop line.
    setTimeout(done, 2000).unref();
    if (out) out.end(done); else done();
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
  // Deliberately NOT SIGHUP: installing a handler for it overrides the SIG_IGN that
  // `nohup` sets, which would make closing the terminal stop a fortnight-long run.
}

// Unattended for weeks means every one of these is eventually load-bearing. Node
// exits on an unhandled rejection by default, and an exception out of a timer
// callback would take the other timers with it — either one ends the recording
// quietly, hours before anyone looks.
process.on('unhandledRejection', (err) => log.error('unhandled rejection (ignored, recording continues)', { err: String(err?.message || err) }));
process.on('uncaughtException', (err) => log.error('uncaught exception (ignored, recording continues)', { err: String(err?.stack || err) }));
// A `| head` or a dead `tail` closes stdout; an unhandled EPIPE from a heartbeat
// would then kill a run that is otherwise perfectly healthy.
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

main().catch((err) => {
  console.error('\n  RECORDER FAILED:', err?.message || err);
  process.exitCode = 1;
});
