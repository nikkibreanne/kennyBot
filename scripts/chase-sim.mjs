// CHASE SIMULATOR — replays a timeline through the REAL evaluator.
//
//   npm run test:chase                                    # built-in synthetic timeline
//   node scripts/chase-sim.mjs                            # the same, without an emulator
//   node scripts/chase-sim.mjs .workspace/chase-samples.jsonl
//   npx firebase emulators:exec --only database --project okrafans \
//     "node scripts/chase-sim.mjs .workspace/chase-samples.jsonl"
//
// You cannot schedule a police chase, so this drives src/rules/chase.js — the
// production evaluator, not a copy of it — with hand-built or recorded ticks.
// Grouping, the per-channel dedupe, the within-org discount, dwell, hysteresis,
// the reopen lockout and the negative markers are all the real thing; only the
// clock and the network are faked. Same reasoning as scripts/subathon-sim.mjs.
//
// It prints the PER-ORG BREAKDOWN on every tick, which is the whole point. When
// a threshold misbehaves the question is never "what was the total" — it is
// always "which org contributed what, through which evidence channel", and a
// bare score cannot answer it.
//
// With no file argument it runs a synthetic timeline covering the four cases
// that have to be right before this feature can be trusted:
//
//   1. a quiet baseline                      → silence, and the audience channel
//                                              stays disabled until it has samples
//   2. a chopper-class retitle + 8x spike    → OPENS  (design §2.4 row 1)
//   3. a retrospective clip ("Raw video: …") → SILENT (design §2.4 row 7) even
//                                              though the same numbers fired in 2
//   4. a newscast retitles while the chopper
//      spikes                                → OPENS  (design §2.4 row 3)
//
// With an emulator running it reads the LIVE settings out of RTDB first, so the
// numbers a mod just changed with `!chasemon threshold` are the numbers being
// simulated. Without one it falls back to config.chase and still runs.
import { readFileSync } from 'node:fs';
import { config } from '../src/config.js';
import { evaluateChase } from '../src/rules/chase.js';
import { emptyState, getChaseSettings } from '../src/db/chaseMonitor.js';
import { initFirebase, closeFirebase } from '../src/db/firebase.js';

const FILE = process.argv[2] || null;

// ── the synthetic world ──────────────────────────────────────────────────────

// THE ROSTER IS PRIVATE (CLAUDE.md), so the orgs below are invented. The simulated
// world carries its own roster because the per-org cap and the display name in an
// announcement come from the SETTINGS, while the class comes off the sample.
const SIM_ORGS = [
  { id: 'org1', name: 'Org One', streamClass: 'chopper' },
  { id: 'org2', name: 'Org Two', streamClass: 'newscast' },
  { id: 'org3', name: 'Org Three', streamClass: 'newscast' },
  { id: 'org4', name: 'Org Four', streamClass: 'newscast' },
  { id: 'org5', name: 'Org Five', streamClass: 'chopper', groupCap: 7 },
  { id: 'org6', name: 'Org Six', streamClass: 'episodic' },
];

// Quiet-state numbers are the SHAPE of a dull weekday (design §1.1, §1.2): a
// chopper-class cam idling in the low hundreds, newscasts a little above it, and
// the episodic source dark until it has something to carry.
const BASE = [
  { org: 'org1', videoId: 'org1-chopper', streamClass: 'chopper', live: true, viewers: 243, title: '🔴LIVE: Chopper Camera' },
  { org: 'org2', videoId: 'org2-live', streamClass: 'newscast', live: true, viewers: 910, title: 'LIVE: Org Two Evening News' },
  { org: 'org3', videoId: 'org3-live', streamClass: 'newscast', live: true, viewers: 405, title: 'Org Three News' },
  { org: 'org4', videoId: 'org4-live', streamClass: 'newscast', live: true, viewers: 300, title: 'Org Four Desk: Live' },
  { org: 'org5', videoId: 'org5-loop', streamClass: 'chopper', live: true, viewers: 820, title: 'Org Five 24/7 Loop' },
  { org: 'org6', videoId: 'org6-live', streamClass: 'episodic', live: false, viewers: null, title: 'Org Six News at 11' },
];

// A pursuit gets retitled as it MOVES — that is what a producer actually does,
// and it is also the only way a title signal survives a multi-poll dwell, since
// an unchanged title scores zero forever (design §2.4). A single retitle held
// for three polls would score on the first poll and nothing after it.
const CHOPPER_PURSUIT = [
  '🔴LIVE: Police pursuit downtown — Chopper Camera',
  '🔴LIVE: Police pursuit heads onto the freeway — Chopper Camera',
  '🔴LIVE: Police pursuit through the east side — Chopper Camera',
  '🔴LIVE: Police pursuit, suspect driving on rims — Chopper Camera',
];

const NEWSCAST_PURSUIT = [
  'LIVE: Police pursuit in the north valley | Org Two',
  'LIVE: Police pursuit heads for the freeway | Org Two',
  'LIVE: Police pursuit — suspect enters surface streets | Org Two',
  'LIVE: Police pursuit continues on surface streets | Org Two',
];

const PHASES = [
  {
    name: 'quiet baseline — nothing is happening',
    ticks: 24,
    expect: 'silent',
    why: 'audience signals stay DISABLED under minSamples, so a cold start can never fire',
    shape: () => ({}),
  },
  {
    name: 'a chopper-class source — pursuit retitle + 8x audience spike',
    ticks: 4,
    expect: 'open',
    why: 'title 5 + 0.6 x audience 5 = 8.0, held for dwell polls (design §2.4 row 1)',
    shape: (i) => ({ org1: { title: CHOPPER_PURSUIT[i % CHOPPER_PURSUIT.length], viewers: 2600 + i * 180 } }),
  },
  {
    name: 'the chopper-class source — it ends, everything returns to normal',
    ticks: 7,
    expect: 'close',
    why: 'score falls under clearScore and stays there for clearPolls',
    shape: () => ({}),
  },
  {
    name: 'cooldown — long enough to clear the reopen lockout',
    ticks: 26,
    expect: 'silent',
    // Without this the next phase would be silent for the WRONG reason and the
    // veto would look tested when it never ran.
    why: 'the next phase has to fail on the negative marker, not on a 20-minute lockout',
    shape: () => ({}),
  },
  {
    name: 'retrospective clip — the common false positive',
    ticks: 4,
    expect: 'silent',
    why: 'identical numbers to the phase that fired, but "raw video" zeroes the org (design §2.4 row 7)',
    shape: () => ({
      org1: { title: 'Raw video: police pursuit ends in fiery crash', viewers: 2600 },
      org6: { live: true, title: 'Raw video: chase ends in crash' },
    }),
  },
  {
    name: 'quiet again',
    ticks: 8,
    expect: 'silent',
    why: 'the vetoed spike is still in the baseline window — a MEDIAN shrugs it off',
    shape: () => ({}),
  },
  {
    name: 'two orgs agree — a newscast retitles while the chopper-class source spikes',
    ticks: 4,
    expect: 'open',
    why: 'no cross-org discount: 5 + 5 = 10 (design §2.4 row 3)',
    shape: (i) => ({
      org2: { title: NEWSCAST_PURSUIT[i % NEWSCAST_PURSUIT.length] },
      org1: { viewers: 2600 },
    }),
  },
  {
    name: 'it ends',
    ticks: 7,
    expect: 'close',
    why: 'the second incident closes the same way the first did',
    shape: () => ({}),
  },
];

/**
 * Build the tick list. Viewer counts carry a small deterministic wobble so the
 * trailing median is a median of real numbers rather than of one value repeated
 * — a degenerate baseline hides off-by-one errors in the window trimming.
 */
function syntheticTimeline(startAt, pollMs) {
  const ticks = [];
  let at = startAt;
  let n = 0;
  for (const phase of PHASES) {
    for (let i = 0; i < phase.ticks; i += 1) {
      const over = phase.shape(i) || {};
      const samples = BASE.map((b) => {
        const patch = over[b.org] || {};
        const viewers = patch.viewers ?? b.viewers;
        return {
          ...b,
          ...patch,
          viewers: viewers == null ? null : viewers + ((n * 37) % 11) - 5,
          at,
        };
      });
      ticks.push({
        at,
        samples,
        articles: [],
        phase,
        first: i === 0,
        last: i === phase.ticks - 1,
      });
      at += pollMs;
      n += 1;
    }
  }
  return ticks;
}

// ── replaying a recording ────────────────────────────────────────────────────

/**
 * A recorded file is `poll` records (one per tick, boundaries intact) plus
 * `discovery` records, which the evaluator has no use for. Bare StreamSample
 * lines are accepted too, for hand-written fixtures — those have lost their tick
 * boundaries, so they get bucketed back into poll-sized windows.
 */
function readTimeline(path, pollMs) {
  const ticks = [];
  const loose = new Map();
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const text = line.trim();
    if (!text) continue;
    let rec;
    try { rec = JSON.parse(text); } catch { continue; }
    if (rec.kind === 'discovery') continue;
    if (rec.kind === 'poll') {
      ticks.push({ at: rec.at, samples: rec.samples || [], articles: rec.articles || [] });
      continue;
    }
    if (rec.videoId && Number.isFinite(rec.at)) {
      const bucket = Math.floor(rec.at / pollMs);
      if (!loose.has(bucket)) loose.set(bucket, []);
      loose.get(bucket).push(rec);
    }
  }
  for (const [bucket, samples] of loose) ticks.push({ at: bucket * pollMs, samples, articles: [] });
  return ticks.sort((a, b) => a.at - b.at);
}

// ── output ───────────────────────────────────────────────────────────────────

/**
 * The per-org line. Orgs scoring nothing are dropped — six orgs of `0.0` per
 * tick buries the one that matters — but a VETO is always shown, because
 * "scored nothing" and "was zeroed by a negative marker" are the two answers
 * that look identical in a total and mean opposite things.
 */
function breakdown(groups) {
  const parts = [];
  for (const [org, g] of Object.entries(groups || {})) {
    if (g?.vetoed) { parts.push(`${org} VETOED`); continue; }
    if (!g?.score) continue;
    const channels = Object.entries(g.channels || {})
      .filter(([, v]) => v)
      .map(([k, v]) => `${k} ${v}`)
      .join(' + ');
    parts.push(`${org} ${g.score.toFixed(1)}${channels ? ` [${channels}]` : ''}`);
  }
  return parts.length ? parts.join('  ·  ') : '—';
}

function elapsed(ms) {
  const mins = Math.max(0, Math.round(ms / 60_000));
  return `t+${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
}

// ── the run ──────────────────────────────────────────────────────────────────

async function main() {
  // Emulator-optional on purpose: the evaluator is pure, so the interesting half
  // of this script needs no database at all, and a tuning loop that demands one
  // is a tuning loop nobody runs.
  const emulated = Boolean(process.env.FIREBASE_DATABASE_EMULATOR_HOST);
  let cfg = config.chase;
  if (emulated) {
    initFirebase();
    // Spread over config.chase so weights/vocab/orgs survive even if the stored
    // settings only carry the live-tunable subset.
    cfg = { ...config.chase, ...(await getChaseSettings()) };
  }
  // The synthetic timeline invents its own orgs, so it supplies its own roster —
  // the public config ships none. A recording keeps whatever the settings carry.
  if (!FILE) cfg = { ...cfg, orgs: SIM_ORGS };

  const pollMs = cfg.pollMs || 60_000;
  const start = Date.UTC(2026, 8, 28, 17, 0, 0); // fixed clock — every run is identical
  const ticks = FILE ? readTimeline(FILE, pollMs) : syntheticTimeline(start, pollMs);

  if (!ticks.length) {
    console.error(`  nothing to replay${FILE ? ` in ${FILE}` : ''}`);
    process.exitCode = 1;
    return;
  }

  console.log(`
  source     ${FILE || 'built-in synthetic timeline'}
  settings   ${emulated ? 'RTDB (emulator)' : 'src/config.js'} · threshold ${cfg.threshold} · dwell ${cfg.dwell} · clear ${cfg.clearScore}/${cfg.clearPolls} · cap ${cfg.groupCap}
  ticks      ${ticks.length} at ${pollMs / 1000}s
`);

  let state = emptyState();
  const t0 = ticks[0].at;
  const failures = [];
  let opens = 0;
  let closes = 0;
  let peak = 0;
  let phaseOpens = 0;
  let phaseCloses = 0;

  for (const tick of ticks) {
    if (tick.first) {
      console.log(`\n  ── ${tick.phase.name} ── expect ${tick.phase.expect.toUpperCase()}`);
      console.log(`     ${tick.phase.why}`);
      phaseOpens = 0;
      phaseCloses = 0;
    }

    const res = evaluateChase({
      samples: tick.samples,
      articles: tick.articles,
      state,
      now: tick.at,
      cfg,
    });
    state = res.state;
    peak = Math.max(peak, res.score);
    if (res.opened) { opens += 1; phaseOpens += 1; }
    if (res.closed) { closes += 1; phaseCloses += 1; }

    // The counters shown are the ones AFTER this tick, and opening resets
    // overCount — so on the opening tick the marker says it, not the counter.
    const dwell = res.opened
      ? ''
      : res.score >= cfg.threshold
        ? `over ${state.overCount}/${cfg.dwell}`
        : state.incident
          ? `under ${state.underCount}/${cfg.clearPolls}`
          : '';
    const mark = res.opened ? '🚨 OPEN ' : res.closed ? '   close' : '        ';
    console.log(
      `  ${elapsed(tick.at - t0)}  ${res.score.toFixed(2).padStart(6)}  ` +
      `${dwell.padEnd(14)}${mark}  ${breakdown(res.groups)}`,
    );
    if (res.announce) console.log(`             └─ would say: ${res.announce.text}`);

    // Expectations only exist for the synthetic timeline; a recording is
    // evidence, not a test, and asserting against it would be asserting that
    // the world behaved the way the weights currently assume.
    if (tick.last && tick.phase) {
      const want = tick.phase.expect;
      const bad =
        (want === 'open' && phaseOpens !== 1) ||
        (want === 'close' && (phaseCloses !== 1 || phaseOpens !== 0)) ||
        (want === 'silent' && phaseOpens !== 0);
      if (bad) {
        failures.push(`${tick.phase.name} — expected ${want}, got ${phaseOpens} open / ${phaseCloses} close`);
      }
      console.log(`     ${bad ? '✗' : '✓'} ${want}`);
    }
  }

  console.log(`
  ${ticks.length} ticks · ${opens} incident${opens === 1 ? '' : 's'} opened · ${closes} closed · peak score ${peak.toFixed(2)}`);

  if (!FILE) {
    if (failures.length) {
      console.log('\n  ✗ SIM FAILED');
      for (const f of failures) console.log(`      ${f}`);
      process.exitCode = 1;
    } else {
      console.log('\n  ✓ all phases behaved as designed\n');
    }
  } else {
    console.log('');
  }
}

main()
  .catch((err) => { console.error('\n  SIM FAILED:', err?.message || err); process.exitCode = 1; })
  .finally(async () => {
    if (process.env.FIREBASE_DATABASE_EMULATOR_HOST) {
      try { await closeFirebase(); } catch { /* already closed */ }
    }
  });
