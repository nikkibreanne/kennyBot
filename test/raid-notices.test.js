// Pending raid-reward notices. Run via `npm run test:emulator`.
//
// The payout happens with nobody required to be present, so announcing it once
// at resolve time reaches whoever is in chat that minute and nobody else — the
// people who actually earned gear routinely never found out. A notice is parked
// per hero and delivered the next time they speak.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { initFirebase, database, closeFirebase, PATHS } from '../src/db/firebase.js';
import { startConfigMirror, setSeason, setRaidPointer } from '../src/db/configStore.js';
import { startNoticeMirror, setNotice, takeNotice, hasNotice, clearAllNotices, undeliveredCount } from '../src/db/notices.js';
import { finishBattle } from '../src/db/raid.js';
import { rolloverAllPlayers } from '../src/db/players.js';
import { SEASON_LOOT } from '../src/content/items.js';

const host = process.env.FIREBASE_DATABASE_EMULATOR_HOST;
const runOrSkip = host ? test : test.skip;
const noopLogger = { info() {}, warn() {}, error() {}, debug() {} };

const S = 's_notice_test';
const W = 'w1';
const HEROES = ['u_notice_a', 'u_notice_b'];

/** Let the mirror's RTDB listener catch up with a write. */
async function settle(pred, ms = 3000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('notice mirror did not converge in time');
}

async function seedClearedRaid() {
  const db = database();
  for (const uid of HEROES) {
    await db.ref(PATHS.player(uid)).set({
      displayName: uid, class: 'Ranger', role: 'dps', level: 5, renown: 0,
      equipped: {}, inventory: [], stats: { raidsParticipated: 0 },
    });
    await db.ref(PATHS.signup(S, W, uid)).set({ displayName: uid, role: 'dps', level: 5, maxHp: 100, power: 10, healing: 0 });
  }
  await db.ref(PATHS.boss(S, W)).set({ name: 'The Slugfather', baseHp: 100, atk: 10, status: 'live' });
  await db.ref(`raids/${S}/${W}/lootTable`).set(SEASON_LOOT[0]);
  await db.ref(PATHS.combat(S, W)).set({
    seed: 1, status: 'live', bossMaxHp: 100,
    result: { downed: true, bossHpRemaining: 0, mvp: HEROES[0], survivors: [HEROES[0]] },
    log: { 0: { type: 'action', side: 'party', kind: 'damage', target: 'boss', actor: HEROES[0], amount: 500 } },
  });
  await setRaidPointer({ seasonId: S, weekId: W, phase: 'live', doneAt: 1 });
}

before(async () => {
  if (!host) return;
  initFirebase();
  await startConfigMirror(noopLogger);
  await startNoticeMirror(noopLogger);
  await setSeason({ id: S, name: 'Notice', tier: 1, weeks: 6, lootTable: SEASON_LOOT[0] });
});

beforeEach(async () => { if (host) await clearAllNotices(); });

after(async () => {
  if (!host) return;
  const db = database();
  await Promise.all([
    ...HEROES.map((u) => db.ref(PATHS.player(u)).remove()),
    db.ref(`raids/${S}`).remove(),
    db.ref(`bosses/${S}`).remove(),
    db.ref(`leaderboard/${S}`).remove(),
    db.ref(PATHS.notices()).remove(),
    db.ref(PATHS.configRaid()).remove(),
    db.ref(PATHS.seasonCurrent()).remove(),
  ]).catch(() => {});
  await closeFirebase();
});

runOrSkip('a cleared raid parks a notice for every hero it paid', async () => {
  await seedClearedRaid();
  const res = await finishBattle(S, W);
  assert.equal(res.awards.length, 2);
  await settle(() => HEROES.every((u) => hasNotice(u)));
  for (const uid of HEROES) {
    const n = (await database().ref(PATHS.notice(uid)).get()).val();
    assert.equal(n.kind, 'raidReward');
    assert.equal(n.bossName, 'The Slugfather', 'the notice names the boss');
    assert.ok(n.itemName, 'and the item');
    assert.equal(n.seasonId, S);
  }
});

runOrSkip('the MVP flag rides along so the message can say so', async () => {
  await seedClearedRaid();
  await finishBattle(S, W);
  await settle(() => hasNotice(HEROES[0]));
  const mvp = (await database().ref(PATHS.notice(HEROES[0])).get()).val();
  const other = (await database().ref(PATHS.notice(HEROES[1])).get()).val();
  assert.equal(mvp.mvp, true);
  assert.equal(mvp.survived, true);
  assert.equal(other.mvp, false);
});

runOrSkip('a notice is delivered EXACTLY once, even under a double message', async () => {
  await setNotice(HEROES[0], { kind: 'raidReward', itemId: 'x', itemName: 'Test Blade', bossName: 'B' });
  await settle(() => hasNotice(HEROES[0]));

  // Two messages landing together — both would otherwise announce.
  const [a, b] = await Promise.all([takeNotice(HEROES[0]), takeNotice(HEROES[0])]);
  const got = [a, b].filter(Boolean);
  assert.equal(got.length, 1, 'exactly one claim wins');
  assert.equal(got[0].itemName, 'Test Blade');
  assert.equal(hasNotice(HEROES[0]), false, 'and it is gone afterwards');
  assert.equal(await takeNotice(HEROES[0]), null, 'a later message gets nothing');
});

runOrSkip('claiming for someone with nothing pending costs no round trip', async () => {
  assert.equal(hasNotice('u_nobody'), false);
  assert.equal(await takeNotice('u_nobody'), null);
});

runOrSkip('a notice survives a restart — it waits until they actually speak', async () => {
  await setNotice(HEROES[1], { kind: 'raidReward', itemId: 'y', itemName: 'Patient Spade', bossName: 'B' });
  await settle(() => hasNotice(HEROES[1]));
  // A fresh boot repopulates the mirror from RTDB rather than losing the queue.
  await startNoticeMirror(noopLogger);
  assert.equal(hasNotice(HEROES[1]), true);
  const n = await takeNotice(HEROES[1]);
  assert.equal(n.itemName, 'Patient Spade');
});

runOrSkip('only the most recent notice is kept — chat is not an inbox', async () => {
  await setNotice(HEROES[0], { kind: 'raidReward', itemId: '1', itemName: 'Old Thing', bossName: 'Week 1' });
  await setNotice(HEROES[0], { kind: 'raidReward', itemId: '2', itemName: 'New Thing', bossName: 'Week 2' });
  await settle(() => hasNotice(HEROES[0]));
  const n = await takeNotice(HEROES[0]);
  assert.equal(n.itemName, 'New Thing');
});

runOrSkip('a season rollover drops stale notices', async () => {
  // Gear resets on rollover, so a pending notice would point at an item the
  // player no longer has.
  await setNotice(HEROES[0], { kind: 'raidReward', itemId: 'z', itemName: 'Doomed', bossName: 'B' });
  await settle(() => undeliveredCount() > 0);
  await rolloverAllPlayers({ seasonId: S });
  assert.equal(hasNotice(HEROES[0]), false, 'no notice should survive the wipe');
  assert.equal((await database().ref(PATHS.notices()).get()).val(), null);
});

runOrSkip('a wipe pays nothing, so it parks no notices', async () => {
  await seedClearedRaid();
  await database().ref(`${PATHS.combat(S, W)}/result`).update({ downed: false, survivors: [] });
  await finishBattle(S, W);
  assert.equal((await database().ref(PATHS.notices()).get()).val(), null);
});

// ── season invites: one line per player per season, never a broadcast ───────

import { inviteToSeason } from '../src/db/notices.js';

runOrSkip('opening a season invites every hero exactly once', async () => {
  const db = database();
  for (const uid of HEROES) {
    await db.ref(PATHS.player(uid)).set({ displayName: uid, class: 'Ranger', role: 'dps', level: 5, equipped: {}, inventory: [] });
  }
  // An account with no character has nothing to enlist.
  await db.ref(PATHS.player('u_no_hero')).set({ displayName: 'Lurker' });

  // `players/` is shared with the other emulator suites, so assert about THESE
  // heroes rather than a global count.
  const queued = await inviteToSeason('t_new', 'The Sweltering Patch');

  assert.ok(queued >= HEROES.length, `expected at least ${HEROES.length} invites, got ${queued}`);
  await settle(() => HEROES.every((u) => hasNotice(u)));
  const n = (await db.ref(PATHS.notice(HEROES[0])).get()).val();
  assert.equal(n.kind, 'seasonInvite');
  assert.equal(n.seasonName, 'The Sweltering Patch');
  assert.equal(hasNotice('u_no_hero'), false);
  await db.ref(PATHS.player('u_no_hero')).remove();
});

runOrSkip('an invite never overwrites a reward — loot news outranks a nag', async () => {
  const db = database();
  for (const uid of HEROES) {
    await db.ref(PATHS.player(uid)).set({ displayName: uid, class: 'Ranger', role: 'dps', level: 5, equipped: {}, inventory: [] });
  }
  await setNotice(HEROES[0], { kind: 'raidReward', itemId: 'x', itemName: 'Precious', bossName: 'B' });
  await settle(() => hasNotice(HEROES[0]));

  await inviteToSeason('t_new', 'Next Season');

  const kept = (await db.ref(PATHS.notice(HEROES[0])).get()).val();
  assert.equal(kept.kind, 'raidReward', 'the reward line survived');
  assert.equal(kept.itemName, 'Precious');
});

runOrSkip('inviting twice does not queue a second line for the same hero', async () => {
  const db = database();
  for (const uid of HEROES) {
    await db.ref(PATHS.player(uid)).set({ displayName: uid, class: 'Ranger', role: 'dps', level: 5, equipped: {}, inventory: [] });
  }
  await inviteToSeason('t_new', 'Next Season');
  await settle(() => HEROES.every((u) => hasNotice(u)));
  const before = await Promise.all(HEROES.map(async (u) => (await database().ref(PATHS.notice(u)).get()).val().at));

  await inviteToSeason('t_new', 'Next Season');

  const after = await Promise.all(HEROES.map(async (u) => (await database().ref(PATHS.notice(u)).get()).val().at));
  assert.deepEqual(after, before, 'a second pass must not re-queue anyone — one line per season');
});
