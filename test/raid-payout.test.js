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

/** A cleared battle with one surviving MVP — one reward, at the MVP rarity floor. */
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
  assert.deepEqual(await payout(), { renown: 1, raids: 1, items: 1, damage: 500 });
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
  assert.deepEqual(await payout(), { renown: 1, raids: 1, items: 1, damage: 500 });
  assert.ok(a === null || b === null, 'exactly one caller should win the claim');
});

runOrSkip('five concurrent payouts still award exactly once', async () => {
  const results = await Promise.all(Array.from({ length: 5 }, () => finishBattle(S, W)));
  assert.deepEqual(await payout(), { renown: 1, raids: 1, items: 1, damage: 500 });
  assert.equal(results.filter(Boolean).length, 1, 'exactly one winner among five racers');
});

runOrSkip('every raid reward is usable by the hero it lands on', async () => {
  // The dps hero must never be handed tank/healer gear by the raid payout.
  await database().ref(PATHS.seasonCurrent()).update({
    lootTable: ['itm_s1_cinder_spade', 'itm_s1_mire_poultice', 'itm_s1_thornnettle_dirk'],
  });
  await database().ref(`raids/${S}/${W}/lootTable`).remove(); // fall back to the season
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

runOrSkip('a cleared raid pays every hero exactly one piece of gear', async () => {
  const db = database();
  const OTHERS = ['u_pay_a', 'u_pay_b'];
  for (const uid of OTHERS) {
    await db.ref(PATHS.player(uid)).set({
      displayName: uid, class: 'Ranger', role: 'dps', level: 5, renown: 0,
      equipped: {}, inventory: [], stats: { raidsParticipated: 0 },
    });
    await db.ref(PATHS.signup(S, W, uid)).set({ displayName: uid, role: 'dps', level: 5, maxHp: 100, power: 10, healing: 0 });
  }

  const res = await finishBattle(S, W);

  assert.equal(res.awards.length, 3, 'one award per roster hero, no more');
  for (const uid of [U, ...OTHERS]) {
    const p = (await db.ref(PATHS.player(uid)).get()).val();
    assert.equal((p.inventory || []).length, 1, `${uid} should get exactly one item`);
  }
  for (const uid of OTHERS) await db.ref(PATHS.player(uid)).remove();
});

runOrSkip('surviving and MVP raise the rarity FLOOR rather than adding items', async () => {
  const { config } = await import('../src/config.js');
  const { SEASON_LOOT } = await import('../src/content/items.js');
  const RANK = ['common', 'uncommon', 'rare', 'epic', 'legendary'];
  const floor = RANK.indexOf(config.loot.raidRewardFloors.mvp);
  // A REAL season table — a floor can only be honoured if the pool actually has
  // items at or above it (pickDrop falls back rather than failing to drop).
  for (let i = 0; i < 12; i++) {
    await seedResolvedBattle();
    await database().ref(`raids/${S}/${W}/lootTable`).set(SEASON_LOOT[0]);
    const res = await finishBattle(S, W);
    const award = res.awards.find((a) => a.uid === U);
    assert.ok(RANK.indexOf(award.item.rarity) >= floor, `MVP got ${award.item.rarity}, below the ${config.loot.raidRewardFloors.mvp} floor`);
    assert.equal(award.mvp, true);
    assert.equal(award.item.role, 'dps', 'and still in the hero\'s own role');
  }
});

runOrSkip('a hero who fell gets an item too, just without the floor', async () => {
  const { SEASON_LOOT } = await import('../src/content/items.js');
  const db = database();
  const FALLEN = 'u_fallen_test';
  await db.ref(PATHS.player(FALLEN)).set({
    displayName: 'Fallen', class: 'Ranger', role: 'dps', level: 5, renown: 0,
    equipped: {}, inventory: [], stats: { raidsParticipated: 0 },
  });
  await db.ref(PATHS.signup(S, W, FALLEN)).set({ displayName: 'Fallen', role: 'dps', level: 5, maxHp: 100, power: 10, healing: 0 });
  await db.ref(`raids/${S}/${W}/lootTable`).set(SEASON_LOOT[0]);

  const res = await finishBattle(S, W);

  const award = res.awards.find((a) => a.uid === FALLEN);
  assert.ok(award, 'everyone on the roster is paid on a clear, survivor or not');
  assert.equal(award.mvp, false);
  await db.ref(PATHS.player(FALLEN)).remove();
});

runOrSkip('the payout uses the loot table the raid was SET UP with', async () => {
  const db = database();
  // Stamp a one-item table on the week, then move the season somewhere else —
  // the payout must follow the raid, not the current season pointer.
  await db.ref(`raids/${S}/${W}/lootTable`).set(['itm_s1_cinder_spade']);
  await db.ref(PATHS.player(U)).update({ role: 'tank' });
  await db.ref(PATHS.signup(S, W, U)).update({ role: 'tank' });
  await setSeason({ id: 'some_other_season', name: 'Elsewhere', tier: 3, weeks: 6, lootTable: ['itm_s3_eclipse_edge'] });
  await new Promise((r) => setTimeout(r, 200));

  const res = await finishBattle(S, W);

  assert.equal(res.awards[0].itemId, 'itm_s1_cinder_spade', 'paid from the wrong season table');
  await setSeason({ id: S, name: 'Payout', tier: 1, weeks: 6, lootTable: ['itm_s1_thornnettle_dirk'] });
  await new Promise((r) => setTimeout(r, 200));
});
