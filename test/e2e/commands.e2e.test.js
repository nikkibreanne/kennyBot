// END-TO-END command tests. Every scenario in ./scenarios.js is driven through
// the REAL chat dispatcher (see ./harness.js) against the Firebase emulator, so a
// break anywhere in a command's path — parsing, gates, handler, or DB writes —
// fails a test. A COVERAGE test cross-checks the command registry so that adding
// a new command WITHOUT an E2E scenario fails the build (the sync is automatic —
// you can't forget). Run via `npm run test:e2e`.
//
// ── HOW TO ADD A TEST WHEN YOU ADD A COMMAND ────────────────────────────────
//   1. Open test/e2e/scenarios.js.
//   2. Add one `{ command, title, run }` entry to the SCENARIOS array, keyed by
//      your command's PRIMARY name (registry def.names[0]).
//   3. In `run({ bot, u, fx })`, use `bot.send(user, '!yourcmd ...')` to drive it
//      and assert on the returned reply text and/or DB state. Use `fx.*` helpers
//      to set up any needed state (a player, wallet, market, drop, raid, …).
//   The coverage test below then passes. That's it.
// ────────────────────────────────────────────────────────────────────────────
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { initFirebase, database, closeFirebase } from '../../src/db/firebase.js';
import { startConfigMirror, setSeason, setExpMode, setChatMuted, isChatMuted } from '../../src/db/configStore.js';
import { listCommands } from '../../src/commands/registry.js';
import { silentLogger, makeBot, user, until } from './harness.js';
import { getConfig, getSeason, getRaidPointer } from '../../src/db/configStore.js';
import { SCENARIOS, fixtures } from './scenarios.js';

const host = process.env.FIREBASE_DATABASE_EMULATOR_HOST;
const runOrSkip = host ? test : test.skip;

// Everything a command might touch; wiped between scenarios for isolation.
const GAME_PATHS = [
  'players', 'usernames', 'wallets', 'markets', 'marketSuggestions', 'drops',
  'raids', 'bosses', 'facts', 'factSubmissions', 'todos', 'duels', 'trades',
  'leaderboard', 'items', 'counters',
];
async function wipeGame() {
  await Promise.all(GAME_PATHS.map((p) => database().ref(p).remove().catch(() => {})));
}

before(async () => {
  if (!host) return;
  initFirebase();
  await startConfigMirror(silentLogger);
});

after(async () => {
  if (host) { await wipeGame(); await closeFirebase(); }
});

beforeEach(async () => {
  if (!host) return;
  await wipeGame();
  // Reset every config lever a scenario might flip back to a known baseline, then
  // WAIT for the in-memory mirror to reflect it — a stale mute/exp/season/raid
  // pointer would otherwise leak into the next scenario (swallowed replies, wrong
  // season, a raid pointing at wiped data). Season 'e2e' + passive EXP off + not
  // muted + no active raid is the clean slate every scenario starts from.
  await database().ref('config/raid').remove().catch(() => {});
  await setChatMuted(false);
  await setExpMode('off'); // passive EXP off → replies aren't polluted by level-ups
  await setSeason({ id: 'e2e', name: 'E2E Season', startsAt: Date.now() });
  await until(() => !isChatMuted() && getConfig().expMode === 'off' && getSeason()?.id === 'e2e' && getRaidPointer() == null);
});

// One subtest per scenario, driven through the real dispatcher.
for (const scenario of SCENARIOS) {
  runOrSkip(`!${scenario.command} — ${scenario.title}`, async () => {
    const bot = makeBot();
    await scenario.run({ bot, u: user, fx: fixtures });
  });
}

// COVERAGE — the automated registry↔test sync. Fails if any registered command
// lacks a scenario, so a new command can't ship without an E2E test.
runOrSkip('coverage: every registered command has an E2E scenario', () => {
  const covered = new Set(SCENARIOS.map((s) => s.command));
  const missing = listCommands()
    .map((def) => def.names[0])
    .filter((name) => !covered.has(name));
  assert.deepEqual(
    missing, [],
    `these commands have no E2E scenario (add one in test/e2e/scenarios.js): ${missing.join(', ')}`,
  );
});
