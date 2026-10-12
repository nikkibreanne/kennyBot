// CHASE LOG REPORT — the one command you run after two weeks of recording.
//
//   npm run chase:report                        # the recorder's own default path
//   node scripts/chase-report.mjs <file|dir>    # one .jsonl, or a directory of them
//   node scripts/chase-report.mjs <dir> --json  # the same report as one JSON object
//
// The recorder (scripts/chase-record.mjs) is meant to be started and then left
// alone for a fortnight with nobody watching it. That is only a sane plan if a
// single command afterwards can answer the two questions that matter — "did it
// actually run the whole time?" and "what should the settings be?" — from the
// log and nothing else. This is that command.
//
// COVERAGE IS PRINTED FIRST AND IS THE MOST IMPORTANT SECTION. Every other
// number here is conditional on it: an incident rate computed over a log with a
// 40% hole is not a low rate, it is a hole, and a report that buries that fact
// is worse than no report. So the gaps are enumerated before anything is
// concluded, and each one is labelled with whether a clean session stop/start
// bracket explains it or whether the recorder simply died.
//
// THE SWEEP RE-RUNS THE REAL EVALUATOR. `src/rules/chase.js` is imported and
// called, never reimplemented — the whole reason the recorder writes raw `poll`
// records instead of only scores is that the tick data stays replayable under
// settings that did not exist when it was recorded. A second copy of the
// scoring here would answer questions about the copy.
//
// THE ROSTER IS PRIVATE (CLAUDE.md). The log carries opaque org ids and YouTube
// video ids and nothing else; this tool prints those through unchanged and does
// NOT resolve them to outlet names. There is deliberately no lookup here to add.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../src/config.js';
import { evaluateChase, median } from '../src/rules/chase.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIN_MS = 60_000;
const DAY_MS = 24 * 60 * MIN_MS;
const CHANNELS = ['title', 'audience', 'liveness', 'editorial'];
/** Real-world base rate of covered LA pursuits, design §1.1 — the yardstick for §4. */
// MEASURED, not assumed. 28 chases published to a broadcaster's dedicated chase feed
// over 120 days = 1.6/week. The earlier 3-5 was an eyeball estimate from ~19 items in
// ~1 month and it was too high, which matters because this constant drives the verdict
// below: at 3-5 a correctly-behaving monitor gets told it is firing TOO RARELY.
// Re-measure with `npm run chase:backtest`, which prints the rate it observes.
const BASE_RATE_PER_WEEK = [1.5, 2.5];

// ── arguments ────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`
  usage: node scripts/chase-report.mjs [file-or-directory] [options]

    --json          emit the whole report as one JSON object (diffable between runs)
    --threshold=N   score the report against N instead of config.chase.threshold
                    (the log records scores, not the settings they were scored under)
    --no-sweep      skip section 6, which replays every tick once per grid cell

  With no path it reads the recorder's own default destination.
`);
  process.exit(0);
}
const JSON_OUT = argv.includes('--json');
const NO_SWEEP = argv.includes('--no-sweep');
const thresholdFlag = argv.find((a) => a.startsWith('--threshold='));
const positional = argv.filter((a) => !a.startsWith('-'));

/**
 * The recorder owns its default path, so read it back out of the recorder
 * rather than keeping a second copy of it here — a hard-coded duplicate would
 * diverge silently the first time the recorder's default changes, and the
 * failure mode is "the report says there is no log" while the log is right
 * there. The regex matches both the `argv[2] || 'file.jsonl'` and the
 * `argv[2] || 'some/dir'` shapes, so it survives the move to daily files.
 */
function recorderDefault() {
  try {
    const src = readFileSync(join(HERE, 'chase-record.mjs'), 'utf8');
    const m = src.match(/process\.argv\[2\]\s*(?:\|\||\?\?)\s*(['"`])([^'"`\n]+)\1/);
    if (m) return m[2];
  } catch { /* recorder missing — fall through */ }
  return '.workspace/chase-samples.jsonl';
}

const SOURCE = positional[0] || recorderDefault();

// ── small formatters ─────────────────────────────────────────────────────────

const pad2 = (n) => String(n).padStart(2, '0');
const round2 = (n) => Math.round(n * 100) / 100;
const pct = (n, d) => (d > 0 ? `${((100 * n) / d).toFixed(1)}%` : '—');

/** Local time, because the person reading this is in the timezone the chases are in. */
function stamp(ms) {
  if (!Number.isFinite(ms)) return '—';
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function dur(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  if (h < 48) return `${h}h ${pad2(rem)}m`;
  return `${(h / 24).toFixed(1)}d`;
}

// Printed as it is computed, not buffered: section 6 replays the whole timeline
// once per grid cell and takes a minute on a fortnight of data, and a report
// that shows nothing at all until then looks hung. Coverage — the section that
// decides whether the rest is worth reading — lands on screen immediately.
const say = (text = '') => { if (!JSON_OUT) console.log(text); };
function section(n, title) {
  say('');
  say(`  ${'═'.repeat(66)}`);
  say(`  ${n} · ${title}`);
  say(`  ${'═'.repeat(66)}`);
}

// ── loading ──────────────────────────────────────────────────────────────────

/** A path is either one file or a directory of `*.jsonl` — daily files, in name order. */
function listFiles(source) {
  let st;
  try {
    st = statSync(source);
  } catch {
    return null; // missing — the caller turns this into a message, not a stack trace
  }
  if (st.isDirectory()) {
    return readdirSync(source)
      .filter((f) => f.endsWith('.jsonl'))
      .sort()
      .map((f) => join(source, f));
  }
  return [source];
}

/**
 * Rank within one timestamp. Sorting on `at` alone is stable, which is right
 * inside a single file — but the whole point of accepting a directory is that
 * files can arrive concatenated out of order, and then two records sharing a
 * millisecond would order by which file was read first. This pins the causal
 * order instead: the poll happened, then it was scored, then the incident it
 * opened, then what would have been said about it.
 */
function rank(rec) {
  switch (rec.kind) {
    case 'session': return rec.event === 'stop' ? 8 : 0;
    case 'discovery': return 1;
    case 'search': return 1.5;
    // Resolved out of band ~140 s after the tick that asked, so it is read by a
    // LATER poll than the one it is timestamped near — order it just ahead of
    // the poll that will actually score it.
    case 'aircraft': return 1.8;
    case 'poll': return 2;
    case 'score': return 3;
    case 'incident': return rec.event === 'close' ? 6 : 4;
    case 'announce': return 5;
    case 'backoff': return 7;
    case 'health': return 7;
    default: return 9;
  }
}

function load(source) {
  const files = listFiles(source);
  if (!files) return { missing: true };
  if (!files.length) return { missing: false, files, empty: true, records: [], stats: {} };

  const records = [];
  const stats = { lines: 0, parsed: 0, malformed: 0, truncatedTails: [], undated: 0, unknownKinds: {} };

  for (const file of files) {
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch (err) {
      stats.unreadable = [...(stats.unreadable || []), `${file} (${err?.code || 'unreadable'})`];
      continue;
    }
    const rows = text.split('\n');
    let lastNonEmpty = -1;
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      if (rows[i].trim()) { lastNonEmpty = i; break; }
    }
    for (let i = 0; i < rows.length; i += 1) {
      const raw = rows[i].trim();
      if (!raw) continue;
      stats.lines += 1;
      let rec;
      try {
        rec = JSON.parse(raw);
      } catch {
        // A recording killed mid-write leaves exactly one half-line, at the end
        // of the file. Anywhere else it is corruption and worth counting loudly.
        if (i === lastNonEmpty) stats.truncatedTails.push(file);
        else stats.malformed += 1;
        continue;
      }
      if (!rec || typeof rec !== 'object' || Array.isArray(rec)) { stats.malformed += 1; continue; }
      if (!Number.isFinite(Number(rec.at))) { stats.undated += 1; continue; }
      rec.at = Number(rec.at);
      if (!['session', 'discovery', 'search', 'poll', 'score', 'incident', 'announce', 'health', 'backoff', 'aircraft'].includes(rec.kind)) {
        // Forward compatibility, not an error: the recorder may learn new record
        // kinds while a two-week run is already in flight.
        stats.unknownKinds[String(rec.kind)] = (stats.unknownKinds[String(rec.kind)] || 0) + 1;
        continue;
      }
      records.push(rec);
      stats.parsed += 1;
    }
  }

  records.sort((a, b) => a.at - b.at || rank(a) - rank(b));
  return { missing: false, files, records, stats };
}

// ── 1. coverage ──────────────────────────────────────────────────────────────

function coverage(records, byKind) {
  const polls = byKind.poll;
  const sessions = byKind.session;
  const starts = sessions.filter((s) => s.event === 'start');
  const stops = sessions.filter((s) => s.event === 'stop');

  // The recorder writes pollMs on every session start. Several sessions may
  // disagree (the operator retuned it mid-run); the most common one wins, and
  // config is only the fallback for a log with no session records at all.
  const backoffs = byKind.backoff;
  const votes = {};
  for (const s of starts) if (Number.isFinite(s.pollMs) && s.pollMs > 0) votes[s.pollMs] = (votes[s.pollMs] || 0) + 1;
  const voted = Object.entries(votes).sort((a, b) => b[1] - a[1])[0];
  const pollMs = voted ? Number(voted[0]) : config.chase.pollMs;
  const pollMsSource = voted
    ? `session records${Object.keys(votes).length > 1 ? ` (${Object.keys(votes).length} different values seen)` : ''}`
    : 'src/config.js — no session record in the log';

  const first = records.length ? records[0].at : null;
  const last = records.length ? records[records.length - 1].at : null;
  const spanMs = first != null ? last - first : 0;
  const expected = spanMs > 0 ? Math.floor(spanMs / pollMs) + 1 : polls.length;
  const coveragePct = expected > 0 ? (100 * polls.length) / expected : 0;

  // Gaps are measured between consecutive POLLS, because a poll is the thing the
  // recorder promises once per pollMs. Three intervals is the smallest window
  // that a single failed fetch plus normal jitter cannot produce.
  const gapMin = 3 * pollMs;
  const gaps = [];
  for (let i = 1; i < polls.length; i += 1) {
    const from = polls[i - 1].at;
    const to = polls[i].at;
    if (to - from <= gapMin) continue;
    const tol = pollMs;
    const stopped = stops.find((s) => s.at >= from - tol && s.at <= to + tol);
    const started = starts.find((s) => s.at >= from - tol && s.at <= to + tol);
    // A deliberate backoff is the THIRD reason a hole exists, and it is the one that
    // looks exactly like a crash from the outside: the recorder is alive, it has
    // simply decided not to poll a dead network every 60s. Calling that "it died"
    // would be a wrong diagnosis in the section the whole report hangs on.
    const skipped = backoffs.filter((b) => b.event === 'skip' && b.at >= from && b.at <= to).length;
    gaps.push({
      from,
      to,
      ms: to - from,
      missed: Math.max(0, Math.round((to - from) / pollMs) - 1),
      skipped,
      stopped: stopped ? { at: stopped.at, reason: String(stopped.reason ?? '') } : null,
      started: started ? { at: started.at } : null,
      verdict: stopped && started
        ? 'explained — clean stop, then a restart'
        : skipped
          ? `explained — deliberate backoff: ${skipped} poll(s) skipped after repeated fetch failures`
          : stopped
            ? 'explained at the front — it stopped cleanly and did not come back until later'
            : started
              ? 'UNEXPLAINED — it came back, but nothing recorded it stopping (crash, kill, or the host slept)'
              : 'UNEXPLAINED — no session record either end; the recorder was simply not running',
    });
  }
  const unexplained = gaps.filter((g) => g.verdict.startsWith('UNEXPLAINED'));
  const lostMs = gaps.reduce((a, g) => a + g.ms, 0);
  const unexplainedMs = unexplained.reduce((a, g) => a + g.ms, 0);
  const endedCleanly = stops.length > 0 && (!starts.length || stops[stops.length - 1].at >= starts[starts.length - 1].at);

  const skippedPolls = backoffs.filter((b) => b.event === 'skip').length;
  const backoffEpisodes = backoffs.filter((b) => b.event === 'start').length;
  const data = {
    first, last, spanMs, pollMs, pollMsSource,
    polls: polls.length, expectedPolls: expected, coveragePct: round2(coveragePct),
    sessions: { starts: starts.length, stops: stops.length, endedCleanly },
    backoff: { skippedPolls, episodes: backoffEpisodes },
    gaps, lostMs, unexplainedMs,
  };

  section(1, 'COVERAGE — did it actually run the whole time?');
  say('');
  if (!polls.length) {
    say('  NO POLL RECORDS AT ALL. Nothing below can be trusted; the recorder never');
    say('  completed a single poll, or this is a discovery-only log (no YouTube key).');
    say('');
    return data;
  }
  say(`  first event      ${stamp(first)}`);
  say(`  last event       ${stamp(last)}`);
  say(`  wall clock       ${(spanMs / DAY_MS).toFixed(2)} days`);
  say(`  poll interval    ${pollMs / 1000}s  ← ${pollMsSource}`);
  say(`  polls recorded   ${polls.length}`);
  say(`  polls expected   ${expected}`);
  say(`  COVERAGE         ${coveragePct.toFixed(1)}%${coveragePct >= 99 ? '  ✓' : coveragePct >= 90 ? '  — acceptable' : '  ✗ READ THE GAPS BELOW BEFORE READING ANYTHING ELSE'}`);
  say(`  sessions         ${starts.length} start${starts.length === 1 ? '' : 's'} · ${stops.length} stop${stops.length === 1 ? '' : 's'}${endedCleanly ? '' : ' · the log does NOT end on a stop record (still running, or it died)'}`);
  if (skippedPolls) {
    say(`  backoff          ${skippedPolls} poll${skippedPolls === 1 ? '' : 's'} deliberately skipped across ${backoffEpisodes} episode${backoffEpisodes === 1 ? '' : 's'}`);
    say('                   (the recorder chose not to hammer a failing network — not lost time)');
  }
  say('');
  if (!gaps.length) {
    say(`  no gap longer than ${gapMin / 1000}s (3 poll intervals). The timeline is continuous.`);
  } else {
    say(`  ${gaps.length} gap${gaps.length === 1 ? '' : 's'} longer than 3 poll intervals — ${dur(lostMs)} missing in total,`);
    say(`  of which ${dur(unexplainedMs)} is unexplained by a session stop/start bracket.`);
    say('');
    for (const g of gaps) {
      say(`    ${stamp(g.from)} → ${stamp(g.to)}   ${dur(g.ms).padStart(7)}   ~${g.missed} poll${g.missed === 1 ? '' : 's'} lost`);
      say(`        ${g.verdict}${g.stopped?.reason ? ` · stop reason: ${g.stopped.reason}` : ''}`);
    }
  }
  say('');
  return data;
}

// ── 2. source health ─────────────────────────────────────────────────────────

function sourceHealth(byKind) {
  const polls = byKind.poll;
  const orgs = new Map();
  const org = (id) => {
    if (!orgs.has(id)) orgs.set(id, { org: id, seen: 0, live: 0, viewers: [], nullViewers: 0, discovered: 0, videoIds: new Set(), streamClass: '' });
    return orgs.get(id);
  };

  // Discovery is read too, so an org that the recorder knows about but which
  // never produced a single sample still gets a row — that silence is precisely
  // the misconfiguration this section exists to catch.
  for (const d of byKind.discovery) {
    for (const [id, ids] of Object.entries(d.ids && typeof d.ids === 'object' ? d.ids : {})) {
      const o = org(String(id));
      o.discovered += 1;
      for (const v of Array.isArray(ids) ? ids : []) if (v) o.videoIds.add(String(v));
    }
  }

  for (const p of polls) {
    const here = new Set();
    const liveHere = new Set();
    for (const s of Array.isArray(p.samples) ? p.samples : []) {
      const id = String(s?.org ?? '');
      if (!id) continue;
      const o = org(id);
      if (!here.has(id)) { o.seen += 1; here.add(id); }
      if (s?.videoId) o.videoIds.add(String(s.videoId));
      if (!o.streamClass && s?.streamClass) o.streamClass = String(s.streamClass);
      if (s?.live) {
        // Count POLLS the org was live in, not live samples: an org can run two
        // concurrent streams (a 24/7 loop plus a chopper cam), which was reporting
        // 101.3% live and reading as a bug in the recorder rather than in this sum.
        if (!liveHere.has(id)) { o.live += 1; liveHere.add(id); }
        const v = Number(s?.viewers);
        if (s?.viewers == null || !Number.isFinite(v)) o.nullViewers += 1;
        else o.viewers.push(v);
      }
    }
  }

  const rows = [...orgs.values()].sort((a, b) => a.org.localeCompare(b.org)).map((o) => {
    const sorted = o.viewers.slice().sort((a, b) => a - b);
    const liveObs = o.live;
    const flags = [];
    if (!o.seen) flags.push('NEVER SAMPLED — discovered but never returned by the fast loop');
    // An `episodic` source is dark until something happens — that is the entire point
    // of the class, and a dedicated chase source goes live ~1.5x/week. Calling that a
    // misconfiguration trains the reader to ignore this section.
    else if (!o.live) {
      flags.push(o.streamClass === 'episodic'
        ? 'never live in this window — EXPECTED for an episodic source; only a concern over many weeks'
        : 'NEVER LIVE — likely a wrong channel id, or a source that does not stream');
    }
    if (o.live && !o.viewers.length) flags.push('NEVER RETURNED VIEWERS — the audience channel is dead for this org');
    else if (liveObs && o.nullViewers / liveObs > 0.5) flags.push('viewers null on most live polls — audience channel mostly disabled');
    return {
      org: o.org,
      pollsSeen: o.seen,
      pollsLive: o.live,
      livePct: polls.length ? round2((100 * o.live) / polls.length) : 0,
      videoIds: o.videoIds.size,
      viewers: sorted.length
        ? { min: sorted[0], median: median(sorted), max: sorted[sorted.length - 1], n: sorted.length }
        : null,
      nullViewers: o.nullViewers,
      nullPct: liveObs ? round2((100 * o.nullViewers) / liveObs) : 0,
      flags,
    };
  });

  const last = byKind.health.length ? byKind.health[byKind.health.length - 1] : null;

  section(2, 'SOURCE HEALTH — is every org actually being observed?');
  say('');
  if (last) {
    say(`  last heartbeat   ${stamp(last.at)} · polls ${last.polls ?? '—'} · empty ${last.emptyPolls ?? '—'}`
      + ` · fetch failures ${last.fetchFailures ?? '—'} · live streams ${last.liveStreams ?? '—'} · quota ${last.quotaUnits ?? '—'}`);
    say('');
  }
  if (!rows.length) {
    say('  no org appeared in any sample or discovery record.');
    say('');
    return { orgs: rows, lastHealth: last };
  }
  say('  org        polls live   % live    viewers  min / median / max      viewers null');
  say(`  ${'─'.repeat(74)}`);
  for (const r of rows) {
    const v = r.viewers
      ? `${String(r.viewers.min).padStart(7)} / ${String(r.viewers.median).padStart(7)} / ${String(r.viewers.max).padStart(7)}`
      : '      —  (never reported)        ';
    say(`  ${r.org.padEnd(10)} ${String(r.pollsLive).padStart(10)} ${`${r.livePct.toFixed(1)}%`.padStart(8)}   ${v}   ${String(r.nullViewers).padStart(6)} (${r.nullPct.toFixed(0)}%)`);
  }
  const flagged = rows.filter((r) => r.flags.length);
  if (flagged.length) {
    say('');
    // Not all of these are faults — an episodic source being dark is expected — so the
    // heading cannot assert a misconfiguration or the reader learns to skip the section.
    say('  WORTH A LOOK');
    for (const r of flagged) for (const f of r.flags) say(`    ${r.org.padEnd(10)} ${f}`);
  }
  say('');
  return { orgs: rows, lastHealth: last };
}

// ── 3. score distribution ────────────────────────────────────────────────────

function scoreDistribution(byKind, threshold) {
  const scores = byKind.score;
  const values = scores.map((s) => Number(s.score)).filter(Number.isFinite);
  const nonZero = values.filter((v) => v > 0);
  const atOrOver = values.filter((v) => v >= threshold).length;
  const max = values.length ? Math.max(...values) : 0;

  // Cross-check, because the log records SCORES but never the settings they were
  // scored under: `over` is the evaluator's own consecutive-ticks-at-threshold
  // counter, so the run already told us which side of its threshold each tick
  // fell on. `over > 0` implies score >= threshold, soundly. `over === 0` implies
  // score < threshold ONLY when the tick did not open or close an incident —
  // both of those reset the counter with the score still high — so those ticks
  // are excluded rather than believed.
  const lifecycleAt = new Set(byKind.incident.map((i) => i.at));
  let lowestOver = Infinity;
  let highestUnder = -Infinity;
  for (const s of scores) {
    const v = Number(s.score);
    if (!Number.isFinite(v)) continue;
    if (Number(s.over) > 0) lowestOver = Math.min(lowestOver, v);
    else if (!lifecycleAt.has(s.at)) highestUnder = Math.max(highestUnder, v);
  }
  const implied = Number.isFinite(lowestOver)
    ? { atMost: lowestOver, above: highestUnder === -Infinity ? null : highestUnder }
    : null;
  const mismatch = Boolean(implied
    && (threshold > implied.atMost || (implied.above != null && threshold <= implied.above)));

  const buckets = new Map();
  for (const v of nonZero) {
    const b = Math.floor(v);
    buckets.set(b, (buckets.get(b) || 0) + 1);
  }
  // Empty buckets inside the range are kept. A histogram that silently drops
  // them reads as a dense distribution when it is actually two clusters with a
  // hole between them — which is exactly the shape that matters here.
  const present = [...buckets.keys()].sort((a, b) => a - b);
  const keys = present.length
    ? Array.from({ length: present[present.length - 1] - present[0] + 1 }, (_, i) => present[0] + i)
    : [];
  const peak = keys.length ? Math.max(...keys.map((k) => buckets.get(k) || 0)) : 0;

  section(3, 'SCORE DISTRIBUTION');
  say('');
  if (!scores.length) {
    say('  no score records in the log — the recorder ran without scoring (pure capture).');
    say('  Sections 3, 4 and 5 need them; section 6 replays the raw polls regardless.');
    say('');
    return { ticks: 0, nonZero: 0, atOrOver: 0, max: 0, threshold, buckets: [], implied, mismatch: false };
  }
  say(`  scored ticks      ${values.length}`);
  say(`  non-zero          ${nonZero.length}  (${pct(nonZero.length, values.length)})`);
  say(`  at/over ${String(threshold).padEnd(10)}${atOrOver}  (${pct(atOrOver, values.length)})`);
  say(`  max score         ${max.toFixed(2)}${max < threshold ? '  ← never reached the threshold' : ''}`);
  say('');
  if (!nonZero.length) {
    say('  every scored tick was 0. Nothing scored at all — see SOURCE HEALTH.');
  } else {
    for (const k of keys) {
      const n = buckets.get(k) || 0;
      const bar = n ? '█'.repeat(Math.max(1, Math.round((40 * n) / peak))) : '';
      const mark = k >= Math.floor(threshold) ? '  ◄ at/over threshold' : '';
      say(`  ${String(k).padStart(3)}–${String(k + 1).padEnd(3)} │${bar} ${n}${mark}`);
    }
  }
  if (mismatch) {
    say('');
    say(`  ⚠ the log's own over-counter says the run treated ${implied.atMost} as at/over its threshold`
      + `${implied.above != null ? ` and ${implied.above} as under it` : ''},`);
    say(`    which does not fit ${threshold}. Re-run with --threshold=<n>, or sections 3–5 describe a`);
    say('    threshold this recording never used.');
  }
  say('');
  return {
    ticks: values.length, nonZero: nonZero.length, atOrOver, max: round2(max), threshold,
    buckets: keys.map((k) => ({ from: k, to: k + 1, ticks: buckets.get(k) })),
    implied, mismatch: Boolean(mismatch),
  };
}

// ── 4. incidents ─────────────────────────────────────────────────────────────

function incidents(byKind, spanMs) {
  const opens = byKind.incident.filter((i) => i.event === 'open');
  const closes = new Map();
  for (const c of byKind.incident) if (c.event === 'close') closes.set(String(c.id), c);
  const announces = new Map();
  for (const a of byKind.announce) if (!announces.has(String(a.incidentId))) announces.set(String(a.incidentId), a);

  const rows = opens.map((o) => {
    const id = String(o.id ?? '');
    const c = closes.get(id) || null;
    const a = announces.get(id) || null;
    return {
      id,
      at: o.at,
      org: String(o.org ?? ''),
      url: String(o.url ?? ''),
      openScore: Number(o.score) || 0,
      durationMs: c && Number.isFinite(Number(c.durationMs)) ? Number(c.durationMs) : (c ? c.at - o.at : null),
      peakScore: c && Number.isFinite(Number(c.peakScore)) ? Number(c.peakScore) : (Number(o.score) || 0),
      closed: Boolean(c),
      // The log's own announcement text, printed through verbatim. It is the
      // answer to "what would chat have seen"; nothing is reconstructed here,
      // and no id is resolved to a name.
      text: a ? String(a.text ?? '') : null,
    };
  });

  const days = spanMs > 0 ? spanMs / DAY_MS : 0;
  const perWeek = days > 0 ? (rows.length / days) * 7 : 0;
  const [lo, hi] = BASE_RATE_PER_WEEK;
  let verdict;
  if (!rows.length) {
    verdict = 'NOTHING FIRED. Over a fortnight the real world would have supplied several '
      + `chases (~${lo}-${hi}/week), so this is almost certainly the detector being deaf, not a quiet city. `
      + 'Read SOURCE HEALTH and NEAR MISSES before touching a weight.';
  } else if (perWeek < lo / 2) {
    verdict = `TOO RARELY — ~${lo}-${hi} covered chases happen per week and this fired ${perWeek.toFixed(1)}. `
      + 'Most real events are being missed; loosen threshold or dwell (section 6).';
  } else if (perWeek <= hi * 1.2) {
    verdict = `ABOUT RIGHT — the real base rate is ~${lo}-${hi}/week and this fired ${perWeek.toFixed(1)}. `
      + 'The remaining work is checking WHICH ones, not how many.';
  } else if (perWeek <= hi * 3) {
    verdict = `TOO OFTEN — ${perWeek.toFixed(1)}/week against a real ~${lo}-${hi}/week. `
      + 'Expect false positives; tighten threshold or dwell (section 6).';
  } else {
    verdict = `FAR TOO OFTEN — ${perWeek.toFixed(1)}/week against a real ~${lo}-${hi}/week. `
      + 'This is not a tuning problem yet; something is scoring that should not.';
  }
  const shortWindow = days > 0 && days < 7;

  section(4, 'INCIDENTS — what it would have announced');
  say('');
  if (!rows.length) {
    say('  none.');
  } else {
    for (const r of rows) {
      say(`  ${stamp(r.at)}   ${r.org.padEnd(10)} opened at ${r.openScore.toFixed(2)} · peak ${r.peakScore.toFixed(2)} · `
        + `${r.closed ? `ran ${dur(r.durationMs)}` : 'NEVER CLOSED in this log'}`);
      say(`      would have said: ${r.text ?? '(no announce record — shadow mode wrote none)'}`);
    }
  }
  say('');
  say(`  ${rows.length} incident${rows.length === 1 ? '' : 's'} over ${days.toFixed(2)} days = ${perWeek.toFixed(1)} per week`);
  if (shortWindow) say('  (under a week of data — the weekly figure is an extrapolation and noisy)');
  say('');
  for (const l of wrap(verdict, 72)) say(`  ${l}`);
  say('');
  return { incidents: rows, days: round2(days), perWeek: round2(perWeek), baseRatePerWeek: BASE_RATE_PER_WEEK, verdict, shortWindow };
}

function wrap(text, width) {
  const out = [];
  let line = '';
  for (const word of String(text).split(/\s+/)) {
    if (line && line.length + 1 + word.length > width) { out.push(line); line = word; } else line = line ? `${line} ${word}` : word;
  }
  if (line) out.push(line);
  return out;
}

// ── 5. near misses ───────────────────────────────────────────────────────────

/**
 * The `search.list` sweeps — the only part of this monitor that spends real YouTube
 * quota (100 units a call against 10,000/day, vs 1 unit for a whole poll).
 *
 * Reported because the burn rate has already gone wrong once in production: a
 * waiver that skipped the sweep cooldown spent ~6,000 units in a day and 20 of its
 * 24 sweeps found nothing at all. The fix was a separate, shorter cooldown — but
 * the evidence for it was only ever visible by hand-grepping the JSONL, because
 * the report discarded `search` records as an unknown kind and said nothing.
 *
 * A high `found nothing` share is the signature of that failure returning.
 */
function searchSweeps(byKind) {
  const sweeps = byKind.search;
  section(8, 'SEARCH SWEEPS — the only thing that spends real quota');
  say('');
  if (!sweeps.length) {
    say('  no sweeps. Either nothing ever went blind (RSS answered every time), or');
    say('  the cooldown held the whole run. Both are the cheap, healthy outcome.');
    say('');
    return { sweeps: 0, units: 0 };
  }

  const units = sweeps.reduce((n, r) => n + (Number(r.units) || 0), 0);
  const asked = sweeps.reduce((n, r) => n + (Array.isArray(r.asked) ? r.asked.length : 0), 0);
  const blind = sweeps.filter((r) => !(Array.isArray(r.found) ? r.found.length : 0));

  // Per quota-day (midnight Pacific is what YouTube bills on, but the log is UTC
  // and a calendar day is close enough to spot a runaway).
  const byDay = {};
  for (const r of sweeps) {
    const day = new Date(r.at).toISOString().slice(0, 10);
    byDay[day] = (byDay[day] || 0) + (Number(r.units) || 0);
  }
  const worst = Object.entries(byDay).sort((a, b) => b[1] - a[1])[0];
  const cap = Number(config.chase.searchDailyUnitCap) || 0;

  say(`  sweeps          ${sweeps.length} · ${asked} channel(s) asked · ${units} units total`);
  say(`  found nothing   ${blind.length} of ${sweeps.length} (${pct(blind.length, sweeps.length)})`);
  say(`  busiest day     ${worst[0]} · ${worst[1]} units${cap ? ` of a ${cap} cap (${pct(worst[1], cap)})` : ''}`);
  say('');
  if (blind.length / sweeps.length > 0.5) {
    say('  MORE THAN HALF the sweeps found nothing. That is the signature of the burn');
    say('  this cooldown exists to prevent — check searchBlindCooldownMs before the');
    say('  daily cap starts clipping real discoveries.');
    say('');
  } else if (cap && worst[1] > cap * 0.8) {
    say('  The busiest day came within 20% of the cap. A capped-out day is a BLIND day:');
    say('  discovery stops and the monitor only sees streams it already knew about.');
    say('');
  }
  return {
    sweeps: sweeps.length,
    asked,
    units,
    foundNothing: blind.length,
    busiestDay: worst[0],
    busiestDayUnits: worst[1],
  };
}

/**
 * The aircraft channel, as a CALIBRATION report rather than a detection one.
 *
 * The weight (3) is a guess. What it should be depends on a number nobody has
 * measured: how often 2+ aircraft orbit one spot in the LA basin WITHOUT a
 * pursuit. The background rate is the whole question, so this prints the raw
 * material for it — how often a reading was taken, how often it found a
 * cluster, and whether any cluster ever coincided with an incident.
 *
 * A high cluster rate with no incidents means the weight is too high and the
 * sky is simply busy; clusters only ever appearing alongside incidents means it
 * is earning its keep and could rise.
 */
function aircraftReport(byKind) {
  const reads = byKind.aircraft;
  section(7, 'AIRCRAFT CORROBORATION (calibration)');
  say('');
  if (!reads.length) {
    say('  no readings — the channel is off, unavailable, or no tick ever reached the');
    say('  suspicion floor. A quiet log is the expected result, not a broken source.');
    say('');
    return { readings: 0 };
  }

  const len = (v) => (Array.isArray(v) ? v.length : 0);
  const withCluster = reads.filter((r) => len(r.clusters) > 0 || len(r.pursuitClusters) > 0);
  const orbitCounts = reads.map((r) => len(r.orbiting));
  const failed = reads.filter((r) => !Number.isFinite(Number(r.samples)) || Number(r.samples) === 0);
  const rate = reads.map((r) => Number(r.rateRemaining)).filter(Number.isFinite);
  const took = reads.map((r) => Number(r.tookMs)).filter(Number.isFinite);
  const orbitCl = reads.filter((r) => len(r.clusters) > 0);
  const pursuitCl = reads.filter((r) => len(r.pursuitClusters) > 0);
  const pursuitCounts = reads.map((r) => len(r.pursuing));
  // Only present on readings taken after the counts were added, so they are
  // reported separately rather than averaged with older ones as if they were 0.
  const counted = reads.filter((r) => Number.isFinite(Number(r.aircraftSeen)));
  const seen = counted.map((r) => Number(r.aircraftSeen));
  const tracked = counted.map((r) => Number(r.tracked));

  // Did a cluster ever coincide with an open incident? Readings resolve ~140 s
  // after the tick that asked, so allow a 5-minute window either side rather
  // than demanding a shared timestamp.
  const opens = byKind.incident.filter((i) => i.event === 'open').map((i) => i.at);
  const NEAR_MS = 5 * 60_000;
  const clusteredDuringIncident = withCluster.filter((r) => opens.some((o) => Math.abs(o - r.at) <= NEAR_MS));

  say(`  readings        ${reads.length}${failed.length ? ` · ${failed.length} returned nothing` : ''}`);
  say(`  found a cluster ${withCluster.length} of ${reads.length} (${pct(withCluster.length, reads.length)})`
    + `  [orbit ${orbitCl.length} · pursuit ${pursuitCl.length}]`);
  say(`  orbiting/read   max ${Math.max(...orbitCounts)} · median ${median(orbitCounts).toFixed(1)}`);
  say(`  pursuing/read   max ${Math.max(...pursuitCounts)} · median ${median(pursuitCounts).toFixed(1)}`);
  if (seen.length) {
    // The line that makes an empty reading readable rather than ambiguous.
    say(`  sky size        seen median ${median(seen).toFixed(0)} · tracked median ${median(tracked).toFixed(0)}`
      + `${counted.length < reads.length ? `  (${counted.length} of ${reads.length} readings carry counts)` : ''}`);
  } else if (reads.length) {
    say('  sky size        not recorded — these readings predate the raw counts, so an');
    say('                  empty result cannot be told apart from an empty sky');
  }
  if (took.length) say(`  sampling took   median ${(median(took) / 1000).toFixed(0)}s`);
  if (rate.length) say(`  ADS-B budget    lowest remaining seen ${Math.min(...rate)}`);
  say('');
  if (!withCluster.length) {
    say('  NO clusters at all. The channel has cost calls and contributed nothing.');
    if (seen.length && median(seen) > 0 && median(tracked) > 0) {
      say(`  The sky was NOT empty (median ${median(seen).toFixed(0)} aircraft, ${median(tracked).toFixed(0)} tracked across passes),`);
      say('  so this is the shape tests being too strict, not a fetch or bbox problem.');
    } else if (seen.length) {
      say('  The sky came back EMPTY, which is a fetch or bounding-box problem rather');
      say('  than a detector one — check the box covers where the chases actually are.');
    }
    say('  Either way: do not raise the weight on this.');
  } else if (!opens.length) {
    say(`  ${withCluster.length} cluster(s) and NO incidents in the same log. This is the background`);
    say('  rate, and it is the argument for keeping the weight BELOW the threshold:');
    say('  a busy sky is common, a pursuit is not.');
  } else {
    say(`  ${clusteredDuringIncident.length} of ${withCluster.length} cluster(s) fell within 5 min of an incident opening.`);
    say('  The rest are the false-positive rate this weight has to survive.');
  }
  say('');
  return {
    readings: reads.length,
    failed: failed.length,
    withCluster: withCluster.length,
    orbitClusterReadings: orbitCl.length,
    pursuitClusterReadings: pursuitCl.length,
    medianSeen: seen.length ? median(seen) : null,
    medianTracked: tracked.length ? median(tracked) : null,
    clusteredDuringIncident: clusteredDuringIncident.length,
    maxOrbiting: Math.max(...orbitCounts),
    lowestRateRemaining: rate.length ? Math.min(...rate) : null,
  };
}

/**
 * Where recall is lost. A tick that scored 6.2 against a threshold of 8 is not a
 * quiet minute — it is the monitor looking straight at something and declining to
 * call it, and the useful question is never "how close was it" but "which
 * evidence channel was missing". Grouping by the ABSENT set answers that: if
 * `audience` is absent in 98% of them, no threshold change fixes this and the
 * YouTube key or `minSamples` is the real bug.
 */
function nearMisses(byKind, threshold) {
  const band = 2;
  const openAt = new Set(byKind.incident.filter((i) => i.event === 'open').map((i) => i.at));
  const near = [];
  const reachedNeverOpened = [];

  for (const s of byKind.score) {
    const v = Number(s.score);
    if (!Number.isFinite(v)) continue;
    if (s.open === true) continue; // an incident was already running: this is sustain, not a miss
    if (v >= threshold) {
      if (!openAt.has(s.at)) reachedNeverOpened.push(s);
      continue;
    }
    if (v < threshold - band) continue;
    near.push(s);
  }

  const absenceCount = Object.fromEntries(CHANNELS.map((c) => [c, 0]));
  const sets = new Map();
  let vetoed = 0;
  const gaps = [];
  const orgTally = {};
  for (const s of near) {
    const groups = s.groups && typeof s.groups === 'object' ? s.groups : {};
    const present = new Set();
    for (const [id, g] of Object.entries(groups)) {
      if (g?.vetoed) vetoed += 1;
      if (Number(g?.score) > 0) orgTally[id] = (orgTally[id] || 0) + 1;
      for (const [ch, val] of Object.entries(g?.channels || {})) if (Number(val) > 0) present.add(ch);
    }
    const absent = CHANNELS.filter((c) => !present.has(c));
    for (const c of absent) absenceCount[c] += 1;
    const key = absent.length ? absent.join(' + ') : '(all four fired)';
    if (!sets.has(key)) sets.set(key, { absent, ticks: 0, scores: [] });
    const row = sets.get(key);
    row.ticks += 1;
    row.scores.push(Number(s.score));
    gaps.push(threshold - Number(s.score));
  }

  const setRows = [...sets.entries()]
    .map(([key, r]) => ({ absent: r.absent, label: key, ticks: r.ticks, medianScore: round2(median(r.scores)) }))
    .sort((a, b) => b.ticks - a.ticks);
  const weights = config.chase.weights || {};
  const weightNote = {
    title: `T1 ${weights.T1 ?? 5} / T2 ${weights.T2 ?? 2}`,
    audience: `V1 ${weights.V1 ?? 5} / V2 ${weights.V2 ?? 2}`,
    liveness: `L1 ${weights.L1 ?? 5}`,
    editorial: `A1 ${weights.A1 ?? 2}`,
  };

  section(5, 'NEAR MISSES — where recall is being lost');
  say('');
  say(`  band: ${(threshold - band).toFixed(2)} ≤ score < ${threshold.toFixed(2)}, with no incident already open`);
  say('');
  if (!near.length) {
    say('  none. Nothing came close without firing.');
  } else {
    say(`  ${near.length} tick${near.length === 1 ? '' : 's'} · median score ${median(near.map((s) => Number(s.score))).toFixed(2)}`
      + ` · median gap to threshold ${median(gaps).toFixed(2)}`);
    if (vetoed) say(`  a negative marker vetoed an org in ${vetoed} of them (recaps suppressing a live signal)`);
    say('');
    say('  absent channel     ticks    share   what it is worth if it fires');
    say(`  ${'─'.repeat(66)}`);
    for (const c of CHANNELS.slice().sort((a, b) => absenceCount[b] - absenceCount[a])) {
      say(`  ${c.padEnd(16)} ${String(absenceCount[c]).padStart(7)}  ${pct(absenceCount[c], near.length).padStart(7)}   ${weightNote[c]}`);
    }
    say('');
    say('  most common absent sets');
    for (const r of setRows.slice(0, 6)) {
      say(`    ${r.label.padEnd(44)} ${String(r.ticks).padStart(6)} ticks · median ${r.medianScore.toFixed(2)}`);
    }
    const topOrgs = Object.entries(orgTally).sort((a, b) => b[1] - a[1]).slice(0, 5);
    if (topOrgs.length) {
      say('');
      say(`  orgs contributing to them: ${topOrgs.map(([id, n]) => `${id} ×${n}`).join(' · ')}`);
    }
  }
  if (reachedNeverOpened.length) {
    say('');
    say(`  ALSO: ${reachedNeverOpened.length} tick${reachedNeverOpened.length === 1 ? '' : 's'} reached the threshold and still opened nothing —`);
    say('  dwell was not satisfied, or the reopen lockout / hourly cap swallowed it.');
    say('  Section 6 shows what a shorter dwell would have done with them.');
  }
  say('');
  return {
    band: [round2(threshold - band), threshold],
    ticks: near.length,
    medianScore: near.length ? round2(median(near.map((s) => Number(s.score)))) : null,
    medianGap: gaps.length ? round2(median(gaps)) : null,
    vetoedTicks: vetoed,
    absentChannelTicks: absenceCount,
    absentSets: setRows,
    orgs: orgTally,
    reachedThresholdButNeverOpened: reachedNeverOpened.length,
  };
}

// ── 6. what-if sweep ─────────────────────────────────────────────────────────

/**
 * The reason the recorder writes raw `poll` records at all. Every cell replays
 * the whole timeline through the REAL evaluator with one pair of settings
 * changed, threading `state = result.state` exactly as src/events/chaseMonitor.js
 * does — so dwell, hysteresis, the reopen lockout and the hourly cap are the
 * production ones, not an approximation of them.
 */
function sweep(byKind, threshold, dwell) {
  const polls = byKind.poll;
  const thresholds = [6, 7, 8, 9, 10];
  const dwells = [2, 3, 4];

  section(6, 'WHAT-IF SWEEP — incidents each setting would have produced');
  say('');
  if (!polls.length) {
    say('  no raw poll records to replay.');
    say('');
    return { grid: [], thresholds, dwells, replayed: 0 };
  }

  say(`  replaying ${polls.length} ticks through src/rules/chase.js once per grid cell — this takes a moment…`);
  const started = Date.now();
  const grid = [];
  for (const t of thresholds) {
    for (const d of dwells) {
      const cfg = {
        ...config.chase,
        threshold: t,
        dwell: d,
        // clearScore must never exceed the threshold, or an incident opens and can
        // never clear — which would report as "1 incident" for the whole fortnight
        // and look like a tuning result instead of a stuck incident.
        clearScore: Math.min(config.chase.clearScore, t),
      };
      let state = null; // the evaluator normalises null into a fresh state
      let opened = 0;
      let closed = 0;
      let peak = 0;
      for (const p of polls) {
        const res = evaluateChase({
          samples: Array.isArray(p.samples) ? p.samples : [],
          articles: Array.isArray(p.articles) ? p.articles : [],
          state,
          now: p.at,
          cfg,
        });
        state = res.state;
        if (res.opened) opened += 1;
        if (res.closed) closed += 1;
        if (res.score > peak) peak = res.score;
      }
      grid.push({ threshold: t, dwell: d, opened, closed, peak: round2(peak) });
    }
  }
  const elapsedMs = Date.now() - started;

  const spanMs = polls.length ? polls[polls.length - 1].at - polls[0].at : 0;
  const weeks = spanMs > 0 ? spanMs / (7 * DAY_MS) : 0;

  const W = 17;
  say(`  done in ${dur(elapsedMs)} · counts are incidents OPENED, with the per-week rate in brackets`);
  say('');
  say(`  threshold │${dwells.map((d) => `dwell ${d}`.padStart(Math.ceil((W + 7) / 2)).padEnd(W)).join('│')}`.trimEnd());
  say(`  ──────────┼${dwells.map(() => '─'.repeat(W)).join('┼')}`);
  for (const t of thresholds) {
    const cells = dwells.map((d) => {
      const cell = grid.find((g) => g.threshold === t && g.dwell === d);
      const wk = weeks > 0 ? ` [${(cell.opened / weeks).toFixed(1)}/wk]` : '';
      const here = t === threshold && d === dwell ? ' *' : '  ';
      return `${here}${cell.opened}${wk}`.padEnd(W);
    });
    say(`  ${String(t).padStart(9)} │${cells.join('│')}`.trimEnd());
  }
  say('');
  say(`  * = the settings this report used (threshold ${threshold}, dwell ${dwell}).`);
  say(`  Real-world yardstick: ~${BASE_RATE_PER_WEEK[0]}-${BASE_RATE_PER_WEEK[1]} covered LA chases per week.`);
  say('');
  for (const l of wrap(
    'The roster for this replay comes from the log\'s own samples — each one carries its '
    + 'org id and stream class — so the sweep is correct even though config.chase.orgs is '
    + 'empty in this repo. Weights, vocabulary and every other knob are the current '
    + 'src/config.js values; only threshold and dwell move across the grid, with clearScore '
    + 'clamped to the threshold so an incident can always close.', 72,
  )) say(`  ${l}`);
  say('');
  return { grid, thresholds, dwells, replayed: polls.length, elapsedMs, weeks: round2(weeks) };
}

// ── main ─────────────────────────────────────────────────────────────────────

function main() {
  const loaded = load(SOURCE);
  if (loaded.missing) {
    console.error(`\n  no log at ${SOURCE}`);
    console.error('  Pass the recorder\'s output file or the directory it writes daily files into:');
    console.error('    node scripts/chase-report.mjs <file-or-directory>');
    console.error(`  (default, read from scripts/chase-record.mjs: ${recorderDefault()})\n`);
    process.exitCode = 1;
    return;
  }
  if (loaded.empty || !loaded.records.length) {
    console.error(`\n  ${SOURCE} holds no usable records${loaded.files?.length ? ` (${loaded.files.length} file(s) scanned)` : ''}.\n`);
    process.exitCode = 1;
    return;
  }

  const { records, files, stats } = loaded;
  const byKind = { session: [], discovery: [], search: [], poll: [], score: [], incident: [], announce: [], health: [], backoff: [], aircraft: [] };
  for (const r of records) byKind[r.kind].push(r);

  const threshold = thresholdFlag ? Number(thresholdFlag.split('=')[1]) : config.chase.threshold;
  if (!Number.isFinite(threshold)) {
    console.error(`\n  --threshold needs a number, got "${thresholdFlag}"\n`);
    process.exitCode = 1;
    return;
  }
  const dwell = config.chase.dwell;

  say('');
  say(`  CHASE MONITOR — LOG REPORT`);
  say(`  source     ${SOURCE}${files.length > 1 ? `  (${files.length} files)` : ''}`);
  say(`  parsed     ${stats.parsed} of ${stats.lines} lines`
    + `${stats.malformed ? ` · ${stats.malformed} malformed` : ''}`
    + `${stats.truncatedTails.length ? ` · ${stats.truncatedTails.length} truncated final line(s), tolerated` : ''}`
    + `${stats.undated ? ` · ${stats.undated} without a timestamp` : ''}`);
  const unknown = Object.entries(stats.unknownKinds || {});
  if (unknown.length) say(`  unknown    ignored record kinds: ${unknown.map(([k, n]) => `${k} ×${n}`).join(', ')}`);
  if (stats.unreadable) say(`  unreadable ${stats.unreadable.join(', ')}`);
  say(`  scored at  threshold ${threshold}${thresholdFlag ? ' (--threshold)' : ' (src/config.js)'} · dwell ${dwell}`);

  const cov = coverage(records, byKind);
  const health = sourceHealth(byKind);
  const dist = scoreDistribution(byKind, threshold);
  const inc = incidents(byKind, cov.spanMs);
  const miss = nearMisses(byKind, threshold);
  const swept = NO_SWEEP ? null : sweep(byKind, threshold, dwell);
  if (NO_SWEEP) { section(6, 'WHAT-IF SWEEP'); say(''); say('  skipped (--no-sweep)'); say(''); }
  // Last, and after the sweep, so the sections print in their numbered order.
  const air = aircraftReport(byKind);
  const searches = searchSweeps(byKind);

  if (JSON_OUT) {
    console.log(JSON.stringify({
      source: SOURCE,
      files,
      parse: {
        lines: stats.lines,
        parsed: stats.parsed,
        malformed: stats.malformed,
        truncatedTails: stats.truncatedTails,
        undated: stats.undated,
        unknownKinds: stats.unknownKinds,
        unreadable: stats.unreadable || [],
      },
      settings: { threshold, dwell, fromFlag: Boolean(thresholdFlag) },
      coverage: cov,
      sourceHealth: health,
      scoreDistribution: dist,
      incidents: inc,
      nearMisses: miss,
      aircraft: air,
      searchSweeps: searches,
      sweep: swept,
    }, null, 2));
  }
}

try {
  main();
} catch (err) {
  console.error(`\n  REPORT FAILED: ${err?.message || err}\n`);
  process.exitCode = 1;
}
