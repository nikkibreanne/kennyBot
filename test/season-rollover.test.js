// Season rollover + end-of-season guard (spec §5.6). Run via `npm run test:emulator`
// (skipped without the emulator host, same as roster-refresh.test.js).
//
// Two guarantees, both learned from an eight-week prod incident where the season
// never ended:
//   1. `!boss next` STOPS at the finale instead of re-scheduling it forever.
//   2. Prestige on rollover is EARNED — only heroes who actually raided the
//      outgoing season get the renown + seasonsPlayed bump. Gear resets for all.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { initFirebase, database, closeFirebase, PATHS } from '../src/db/firebase.js';
import { startConfigMirror, setSeason, getSeason } from '../src/db/configStore.js';
import { rolloverAllPlayers } from '../src/db/players.js';
import bossCmd from '../src/commands/mod/boss.js';
import { itemObject } from '../src/content/items.js';
import { config } from '../src/config.js';

const host = process.env.FIREBASE_DATABASE_EMULATOR_HOST;
const runOrSkip = host ? test : test.skip;
const noopLogger = { info() {}, warn() {}, error() {}, debug() {} };

const SEASON = 's_rollover_test';
const VET = 'u_vet_test';
const AFK = 'u_afk_test';
const WEEKS = config.raid.seasonWeeks;

const makePlayer = (renown) => ({
  displayName: 'Tester', class: 'Ranger', role: 'dps', level: 12,
  equipped: { weapon: itemObject('itm_s1_final_knell_reaper'), armor: itemObject('itm_s1_blightstalker_hide') },
  inventory: ['itm_s1_ember_token', 'itm_s1_cinder_spade'],
  renown, exp: 0, stats: { seasonsPlayed: 0, raidsParticipated: 0 },
});

/** The season mirror is fed by an async RTDB listener — poll until it converges. */
async function waitForSeason(pred, ms = 3000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred(getSeason())) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('config/season mirror did not converge in time');
}

/** Pretend `n` bosses have already been scheduled this season, so nextWeekId → w(n+1). */
async function seedScheduledWeeks(n) {
  const weeks = {};
  for (let i = 1; i <= n; i++) weeks[`w${i}`] = { name: `Boss ${i}`, baseHp: 1000, atk: 50, status: 'downed' };
  await database().ref(PATHS.bossesForSeason(SEASON)).set(weeks);
}

/** Run `!boss <args>` and return what it said in chat. */
async function runBoss(...args) {
  let said = '';
  await bossCmd.run({ args, reply: (t) => { said = t; }, logger: noopLogger });
  return said;
}

async function cleanGame() {
  await Promise.all([
    database().ref(PATHS.bossesForSeason(SEASON)).remove(),
    database().ref(`raids/${SEASON}`).remove(),
    database().ref(`leaderboard/${SEASON}`).remove(),
    database().ref(PATHS.player(VET)).remove(),
    database().ref(PATHS.player(AFK)).remove(),
    database().ref(PATHS.configRaid()).remove(),
  ]);
}

before(async () => {
  if (!host) return;
  initFirebase();
  await startConfigMirror(noopLogger);
});

beforeEach(async () => {
  if (!host) return;
  await cleanGame();
});

after(async () => {
  if (!host) return;
  await cleanGame().catch(() => {});
  await database().ref(PATHS.seasonCurrent()).remove().catch(() => {});
  await closeFirebase();
});

// ── 1. the end-of-season guard ──────────────────────────────────────────────

runOrSkip('!boss next refuses past the finale instead of repeating it', async () => {
  await setSeason({ id: SEASON, name: 'Rollover Test', tier: 1, weeks: WEEKS, startsAt: Date.now() });
  await waitForSeason((s) => s?.id === SEASON);
  await seedScheduledWeeks(WEEKS); // the whole season is already scheduled

  const said = await runBoss('next');

  assert.match(said, /complete/i, `expected a season-complete refusal, got: ${said}`);
  assert.match(said, /rollover/i, 'the refusal must point at the way forward');
  const after = await database().ref(PATHS.boss(SEASON, `w${WEEKS + 1}`)).get();
  assert.equal(after.exists(), false, 'a week past the finale must NOT be scheduled');
});

runOrSkip('!boss next still schedules the finale itself, and labels it', async () => {
  await setSeason({ id: SEASON, name: 'Rollover Test', tier: 1, weeks: WEEKS, startsAt: Date.now() });
  await waitForSeason((s) => s?.id === SEASON);
  await seedScheduledWeeks(WEEKS - 1); // one week left: the finale

  const said = await runBoss('next');

  assert.match(said, /FINALE/, `the last week should announce itself, got: ${said}`);
  const finale = await database().ref(PATHS.boss(SEASON, `w${WEEKS}`)).get();
  assert.equal(finale.exists(), true, 'the finale must still be schedulable');
  assert.equal(finale.val().status, 'signup');
});

// ── 2. prestige is earned, not handed out ───────────────────────────────────

runOrSkip('rollover grants prestige ONLY to heroes who raided the outgoing season', async () => {
  const db = database();
  await db.ref(PATHS.player(VET)).set(makePlayer(4));
  await db.ref(PATHS.player(AFK)).set(makePlayer(0));
  // finishBattle writes a leaderboard entry for every signup of a resolved raid.
  // The AFK hero has a character but never raided, so has none.
  await db.ref(PATHS.leaderboardEntry(SEASON, VET)).set({ damage: 12345 });

  const { reset, prestiged } = await rolloverAllPlayers({ seasonId: SEASON, prestigeRenown: 3 });

  assert.equal(prestiged, 1, 'exactly one veteran');
  assert.ok(reset >= 2, 'gear resets for everyone, veteran or not');

  const vet = (await db.ref(PATHS.player(VET)).get()).val();
  assert.equal(vet.renown, 7, 'veteran keeps its 4 renown and gains 3 prestige');
  assert.equal(vet.stats.seasonsPlayed, 1);

  const afk = (await db.ref(PATHS.player(AFK)).get()).val();
  assert.equal(afk.renown, 0, 'a hero who never raided earns no prestige');
  assert.equal(afk.stats.seasonsPlayed, 0, 'nor a season played');
});

runOrSkip('rollover resets gear for everyone, including non-participants', async () => {
  const db = database();
  await db.ref(PATHS.player(VET)).set(makePlayer(4));
  await db.ref(PATHS.player(AFK)).set(makePlayer(0));
  await db.ref(PATHS.leaderboardEntry(SEASON, VET)).set({ damage: 1 });

  await rolloverAllPlayers({ seasonId: SEASON });

  for (const uid of [VET, AFK]) {
    const p = (await db.ref(PATHS.player(uid)).get()).val();
    assert.ok(p.equipped.weapon.id.startsWith('itm_starter_'), `${uid} should be back on starter gear`);
    assert.equal(p.inventory ?? null, null, `${uid}'s bag should be empty`);
    assert.equal(p.level, 12, 'level survives the reset');
  }
});

runOrSkip('with no outgoing season nobody is a veteran, but gear still resets', async () => {
  const db = database();
  await db.ref(PATHS.player(VET)).set(makePlayer(4));
  await db.ref(PATHS.leaderboardEntry(SEASON, VET)).set({ damage: 1 });

  const { prestiged } = await rolloverAllPlayers({ seasonId: null });

  assert.equal(prestiged, 0, 'there is no season to have been a veteran of');
  const vet = (await db.ref(PATHS.player(VET)).get()).val();
  assert.equal(vet.renown, 4, 'renown untouched');
  assert.ok(vet.equipped.weapon.id.startsWith('itm_starter_'));
});
