// Raid payout must happen EXACTLY ONCE (spec §5.8). Run via `npm run test:emulator`.
//
// finishBattle's cheap short-circuit reads the in-memory config mirror, which two
// overlapping callers can both observe as 'live' — two bot instances, or a payout
// that outruns the 30s phase tick. Before the atomic claim, a probe showed two
// concurrent calls awarding everything twice: 2 renown, 2 raidsParticipated,
// 6 loot rolls instead of 3, and doubled leaderboard damage.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { initFirebase, database, closeFirebase, PATHS } from '../src/db/firebase.js';
import { startConfigMirror, setRaidPointer, setSeason } from '../src/db/configStore.js';
import { finishBattle } from '../src/db/raid.js';

const host = process.env.FIREBASE_DATABASE_EMULATOR_HOST;
const runOrSkip = host ? test : test.skip;
const noopLogger = { info() {}, warn() {}, error() {}, debug() {} };

const S = 's_payout_test';
const W = 'w1';
const U = 'u_payout_test';

/** A cleared battle with one surviving MVP: 1 participation + 1 survivor + 1 MVP roll. */
async function seedResolvedBattle() {
  const db = database();
  await db.ref(PATHS.player(U)).set({
    displayName: 'Payee', class: 'Ranger', role: 'dps', level: 5, renown: 0,
    equipped: {}, inventory: [], stats: { raidsParticipated: 0 },
  });
  await db.ref(PATHS.signup(S, W, U)).set({
    displayName: 'Payee', role: 'dps', level: 5, maxHp: 100, power: 10, healing: 0,
  });
  await db.ref(PATHS.combat(S, W)).set({
    seed: 1, status: 'live', bossMaxHp: 100,
    result: { downed: true, bossHpRemaining: 0, mvp: U, survivors: [U] },
    log: { 0: { type: 'action', kind: 'damage', target: 'boss', actor: U, amount: 500 } },
  });
  await db.ref(`leaderboard/${S}`).remove();
  await setRaidPointer({ seasonId: S, weekId: W, phase: 'live', doneAt: 1 });
}

async function payout() {
  const db = database();
  const p = (await db.ref(PATHS.player(U)).get()).val();
  const lb = (await db.ref(PATHS.leaderboardEntry(S, U)).get()).val();
  return {
    renown: p.renown || 0,
    raids: p.stats?.raidsParticipated || 0,
    items: (p.inventory || []).length,
    damage: lb?.damage || 0,
  };
}

before(async () => {
  if (!host) return;
  initFirebase();
  await startConfigMirror(noopLogger);
  await setSeason({ id: S, name: 'Payout', tier: 1, weeks: 6, lootTable: ['itm_s1_thornnettle_dirk'] });
});

beforeEach(async () => {
  if (!host) return;
  await seedResolvedBattle();
});

after(async () => {
  if (!host) return;
  const db = database();
  await Promise.all([
    db.ref(PATHS.player(U)).remove(),
    db.ref(`raids/${S}`).remove(),
    db.ref(`leaderboard/${S}`).remove(),
    db.ref(PATHS.configRaid()).remove(),
    db.ref(PATHS.seasonCurrent()).remove(),
  ]).catch(() => {});
  await closeFirebase();
});

runOrSkip('a single payout awards loot, renown, participation and damage once', async () => {
  await finishBattle(S, W);
  assert.deepEqual(await payout(), { renown: 1, raids: 1, items: 3, damage: 500 });
});

runOrSkip('calling finishBattle again is a no-op', async () => {
  await finishBattle(S, W);
  const once = await payout();
  await finishBattle(S, W);
  assert.deepEqual(await payout(), once, 'a second sequential call must not re-award');
});

runOrSkip('TWO CONCURRENT payouts award exactly once, not twice', async () => {
  // The regression: overlapping phase ticks with a mirror that still says 'live'.
  const [a, b] = await Promise.all([finishBattle(S, W), finishBattle(S, W)]);
  assert.deepEqual(await payout(), { renown: 1, raids: 1, items: 3, damage: 500 });
  assert.ok(a === null || b === null, 'exactly one caller should win the claim');
});

runOrSkip('five concurrent payouts still award exactly once', async () => {
  const results = await Promise.all(Array.from({ length: 5 }, () => finishBattle(S, W)));
  assert.deepEqual(await payout(), { renown: 1, raids: 1, items: 3, damage: 500 });
  assert.equal(results.filter(Boolean).length, 1, 'exactly one winner among five racers');
});

runOrSkip('every raid reward is usable by the hero it lands on', async () => {
  // The dps hero must never be handed tank/healer gear by the raid payout.
  await database().ref(PATHS.seasonCurrent()).update({
    lootTable: ['itm_s1_cinder_spade', 'itm_s1_mire_poultice', 'itm_s1_thornnettle_dirk'],
  });
  await new Promise((r) => setTimeout(r, 200)); // let the season mirror catch up
  await finishBattle(S, W);
  const p = (await database().ref(PATHS.player(U)).get()).val();
  const bag = p.inventory || [];
  assert.ok(bag.length > 0, 'the clear should have paid out');
  for (const entry of bag) {
    const id = typeof entry === 'string' ? entry : entry?.id;
    assert.equal(id, 'itm_s1_thornnettle_dirk', `dps was handed ${id}, which does nothing for them`);
  }
});
