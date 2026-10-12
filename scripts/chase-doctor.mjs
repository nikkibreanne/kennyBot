// Is the chase monitor alive and healthy? One command, no server access needed.
//
//   npm run chase:doctor
//
// It reads the monitor's own state out of RTDB, which is the authoritative record and is
// reachable from any workstation with .env — you do NOT need to get onto the host to
// answer "is it working". For the on-disk evidence (and `chase:report`), see the host
// commands this prints at the end.
//
// Written because answering that question ad-hoc took several attempts, and the failure
// modes are not guessable: the monitor can be enabled, polling, and still blind.
import 'dotenv/config'; // every operator script here needs this — see chase-sources-load.mjs
import { initFirebase, closeFirebase, database } from '../src/db/firebase.js';
import { config } from '../src/config.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const t = (ms) => (ms ? new Date(ms).toLocaleString() : '—');
const mins = (ms) => Math.round((Date.now() - ms) / 60_000);
let problems = 0;
const ok = (m) => console.log(`  \x1b[32mOK\x1b[0m    ${m}`);
const bad = (m) => { problems += 1; console.log(`  \x1b[31mPROBLEM\x1b[0m ${m}`); };
const note = (m) => console.log(`        ${m}`);

async function main() {
  await initFirebase(quiet);
  const db = database();
  const [cfg, state] = await Promise.all([
    db.ref('config/chaseMonitor').get().then((s) => s.val()),
    db.ref('chaseMonitor/state').get().then((s) => s.val()),
  ]);
  const shadow = await db.ref('chaseMonitor/shadow').get().then((s) => s.val());

  console.log('\n  CHASE MONITOR — DOCTOR\n');

  // ── is it switched on at all ────────────────────────────────────────────────
  if (!cfg) {
    bad('config/chaseMonitor is EMPTY — the bot has never started with this feature');
    note('the bot seeds this on boot; if it is missing, the running image predates the monitor');
  } else {
    const n = Array.isArray(cfg.orgs) ? cfg.orgs.length : Object.keys(cfg.orgs || {}).length;
    if (cfg.enabled) ok(`enabled, mode "${cfg.mode}"`);
    else note(`switched OFF (mode "${cfg.mode}") — a mod enables it with !chasemon on`);
    if (cfg.mode === 'live') note('mode is LIVE — it WILL post to chat');
    if (n > 0) ok(`${n} source(s) loaded`);
    else {
      bad('NO sources loaded — the monitor is inert however else it is configured');
      note('fix: npm run chase:sources   (reads the gitignored .workspace/chase-sources.json)');
    }
    note(`threshold ${cfg.threshold} · dwell ${cfg.dwell} · clearScore ${cfg.clearScore}`);

    // CHANNEL COVERAGE. A channel with no inputs is not "scoring 0", it is absent —
    // and absent looks identical to quiet in every other line of this report. The
    // editorial channel ran for TEN DAYS configured on exactly one source, and the
    // one chase the monitor caught in that time was corroborated by a newsroom
    // article from a source that had no feed at all. Nothing said so.
    const feeds = (cfg.orgs || []).filter((o) => o?.articleFeed).length;
    if (n > 0 && feeds === 0) {
      bad('NO source has an articleFeed — the EDITORIAL channel is dead weight');
      note('it can never score, so every incident rests on title/liveness/audience alone');
      note('fix: add "articleFeed" to entries in .workspace/chase-sources.json, then npm run chase:sources');
    } else if (n > 0 && feeds < n) {
      note(`articleFeed on ${feeds} of ${n} source(s) — the editorial channel is inert for the other ${n - feeds}`);
      note('a newsroom that publishes a chase article is free corroboration; a missing feed discards it');
    } else if (n > 0) {
      ok(`articleFeed on all ${feeds} source(s)`);
    }

    // Same reasoning for the aircraft channel: enabled-but-unavailable is silent.
    if (cfg.aircraft?.enabled === false) {
      note('aircraft corroboration is OFF (!chasemon aircraft on) — scoring is news sources only');
    }
  }

  // ── is it actually ticking ─────────────────────────────────────────────────
  if (!state) {
    bad('chaseMonitor/state is EMPTY — no tick has ever completed');
    note('expected if the monitor has never been enabled; a problem if it has');
  } else {
    const streams = Object.entries(state.streams || {});
    const newest = streams.map(([, r]) => r?.seenAt).filter(Boolean).sort((a, b) => b - a)[0];
    const pollMin = Math.max(1, Math.round(config.chase.pollMs / 60_000));
    if (!newest) bad('state exists but no stream has ever been observed');
    else if (mins(newest) <= pollMin * 3) ok(`ticking — last observation ${mins(newest)} min ago`);
    else {
      bad(`STALE — last observation ${mins(newest)} min ago (${t(newest)})`);
      note('the bot is not running, the monitor is switched off, or its tick is wedged');
    }

    const live = streams.filter(([, r]) => r?.live);
    if (streams.length <= 1 && cfg?.enabled) {
      bad(`only ${streams.length} stream tracked — discovery has probably not run yet`);
      note('a Twitch source needs no discovery, so "1 sample per poll" looks healthy but is not');
      note(`it resolves itself within ${Math.round(config.chase.discoveryMs / 60_000)} min, or immediately on enable`);
    } else if (streams.length) {
      ok(`${streams.length} stream(s) tracked, ${live.length} live right now`);
    }
    if (cfg?.enabled && streams.length > 1 && live.length === 0) {
      bad('nothing live — every source dark at once is unusual; check channel ids');
    }
    const withBaseline = Object.values(state.baselines || {}).filter((b) => (b || []).length >= config.chase.minSamples).length;
    note(`${withBaseline} stream(s) have a usable viewer baseline (needs ${config.chase.minSamples} samples)`);
    if (live.length && withBaseline === 0) note('until a baseline builds, the AUDIENCE channel cannot score at all');

    note(`last score ${state.lastScore ?? 0} · dwell ${state.overCount ?? 0}/${cfg?.dwell ?? '?'} · incident ${state.incident ? `OPEN (${state.incident.org})` : 'none'}`);
  }

  // ── has it ever wanted to say something ────────────────────────────────────
  const entries = shadow ? Object.values(shadow) : [];
  note(`shadow log: ${entries.length} would-be announcement(s)`);
  for (const e of entries.slice(-3)) note(`  ${t(e.at)}  score ${e.score}  ${e.incident?.org ?? ''}`);

  console.log();
  if (problems) console.log(`  \x1b[31m${problems} problem(s) above.\x1b[0m A score of 0 is NOT one of them — real chases are ~1.7/week.\n`);
  else console.log('  \x1b[32mHealthy.\x1b[0m A score of 0 is the expected result — real chases are ~1.7/week.\n');

  console.log('  For the on-disk evidence (and chase:report), from the host:');
  // .workspace/, NOT ./ — these logs name the private roster, and a copy git can
  // see puts real outlet names in a public repo.
  console.log('    docker -H ssh://root@faraday cp kennybot:/data/chase-logs .workspace/chase-logs');
  console.log('    npm run chase:report -- .workspace/chase-logs --no-sweep');
  console.log('    (.workspace/ is gitignored on purpose — the logs name the roster)\n');
}

main()
  .catch((err) => { console.error('\n  doctor failed:', err?.message, '\n'); process.exitCode = 1; })
  .finally(() => closeFirebase?.());
