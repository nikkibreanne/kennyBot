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
import { startConfigMirror, setSeason, getSeason, setRaidPointer, getRaidPointer } from '../src/db/configStore.js';
import { rolloverAllPlayers, prestigeFor } from '../src/db/players.js';
import bossCmd from '../src/commands/mod/boss.js';
import seasonCmd from '../src/commands/mod/season.js';
import { nextWeekId, raidScheduleStatus } from '../src/db/raid.js';
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
/** Record that `uid` was on the roster of `n` RESOLVED raids this season. */
async function seedAttendance(uid, n) {
  const updates = {};
  for (let i = 1; i <= n; i++) {
    updates[`raids/${SEASON}/w${i}/result`] = { downed: true, bossHpRemaining: 0, status: 'done' };
    updates[`raids/${SEASON}/w${i}/signups/${uid}`] = { displayName: uid, role: 'dps', level: 12 };
  }
  await database().ref().update(updates);
}

async function seedScheduledWeeks(n) {
  const weeks = {};
  for (let i = 1; i <= n; i++) weeks[`w${i}`] = { name: `Boss ${i}`, baseHp: 1000, atk: 50, status: 'downed' };
  await database().ref(PATHS.bossesForSeason(SEASON)).set(weeks);
}

/** The raid mirror is fed by an async RTDB listener — poll until it converges. */
async function waitForPointerPhase(phase, ms = 3000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (getRaidPointer()?.phase === phase) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('config/raid mirror did not converge in time');
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

runOrSkip('a rollover RESETS the run: level, EXP and gear all go', async () => {
  const db = database();
  await db.ref(PATHS.player(VET)).set({ ...makePlayer(6), level: 24, exp: 900, levelPressure: 2 });

  await rolloverAllPlayers({ seasonId: SEASON });

  const p = (await db.ref(PATHS.player(VET)).get()).val();
  assert.equal(p.level, 1, 'the level is the thing being surrendered');
  assert.equal(p.exp ?? 0, 0);
  assert.equal(p.levelPressure ?? 0, 0);
  assert.ok(p.equipped.weapon.id.startsWith('itm_starter_'), 'gear back to starter');
  assert.equal(p.inventory ?? null, null, 'bag emptied');
});

runOrSkip('…and pays permanent prestige for the renown that run earned', async () => {
  const db = database();
  await db.ref(PATHS.player(VET)).set({ ...makePlayer(6), level: 24 });

  const res = await rolloverAllPlayers({ seasonId: SEASON });

  const p = (await db.ref(PATHS.player(VET)).get()).val();
  assert.equal(p.prestige, prestigeFor(6), 'renown 6 converts to prestige');
  assert.equal(p.renown, 0, "and this season's renown is spent");
  assert.ok(res.granted > 0 && res.best > 0);
  assert.equal(p.stats.seasonsPlayed, 1);
  assert.equal(p.stats.highestLevel, 24, 'the peak reached is remembered');
});

runOrSkip('prestige accumulates across seasons instead of resetting with the run', async () => {
  const db = database();
  await db.ref(PATHS.player(VET)).set({ ...makePlayer(4), level: 20, prestige: 5 });
  await rolloverAllPlayers({ seasonId: SEASON });
  const p = (await db.ref(PATHS.player(VET)).get()).val();
  assert.equal(p.prestige, 5 + prestigeFor(4), 'last run stacks on top of every run before it');
});

runOrSkip('the CHARACTER survives the reset — class and role are kept', async () => {
  const db = database();
  await db.ref(PATHS.player(VET)).set({ ...makePlayer(3), class: 'Mender', role: 'healer', level: 12 });

  await rolloverAllPlayers({ seasonId: SEASON });

  const p = (await db.ref(PATHS.player(VET)).get()).val();
  assert.equal(p.class, 'Mender', 'you are the same hero — !respec changes that, not a rollover');
  assert.equal(p.role, 'healer');
  assert.ok(p.equipped.weapon.bonuses.healer > 0, 'and the fresh starter gear matches that role');
});

runOrSkip('a hero who earned nothing still resets, but banks nothing', async () => {
  const db = database();
  await db.ref(PATHS.player(AFK)).set({ ...makePlayer(0), level: 9 });

  const res = await rolloverAllPlayers({ seasonId: SEASON });

  const p = (await db.ref(PATHS.player(AFK)).get()).val();
  assert.equal(p.level, 1, 'the reset applies to everyone');
  assert.equal(p.prestige ?? 0, 0, 'but prestige is earned, not handed out');
  assert.ok(res.reset >= 1);
});

// ── operator guards (the three small bugs) ──────────────────────────────────

runOrSkip('!season start refuses to reopen a season that already has weeks', async () => {
  // openSeason writes week 1 unconditionally, so re-running it on a live id
  // overwrote that week's boss AND replaced its raid node — roster and result.
  await setSeason({ id: SEASON, name: 'Rollover Test', tier: 1, weeks: WEEKS, startsAt: Date.now() });
  await waitForSeason((s) => s?.id === SEASON);
  await seedScheduledWeeks(3);
  const db = database();
  await db.ref(PATHS.signup(SEASON, 'w1', VET)).set({ displayName: 'Tester', role: 'dps', level: 12 });
  await db.ref(`raids/${SEASON}/w1/result`).set({ downed: true, status: 'done' });

  let said = '';
  await seasonCmd.run({ args: ['start', SEASON, 'Again'], reply: (t) => { said = t; }, logger: noopLogger });

  assert.match(said, /already exists/i, `expected a refusal, got: ${said}`);
  assert.match(said, /rollover/i, 'and a pointer at the right command');
  const roster = await db.ref(PATHS.signups(SEASON, 'w1')).get();
  assert.equal(roster.exists(), true, "week 1's roster must survive");
  const result = await db.ref(`raids/${SEASON}/w1/result`).get();
  assert.equal(result.val()?.downed, true, "week 1's recorded result must survive");
});

runOrSkip('!season rollover refuses while a raid is locked or live', async () => {
  await setSeason({ id: SEASON, name: 'Rollover Test', tier: 1, weeks: WEEKS, startsAt: Date.now() });
  await waitForSeason((s) => s?.id === SEASON);
  await setRaidPointer({ seasonId: SEASON, weekId: 'w1', phase: 'live', doneAt: Date.now() + 60_000 });
  await waitForPointerPhase('live');

  let said = '';
  await seasonCmd.run({ args: ['rollover', 't_next'], reply: (t) => { said = t; }, logger: noopLogger });

  assert.match(said, /wait/i, `rolling over mid-battle pays the finishing raid from the WRONG table; got: ${said}`);
  const stillOld = (await database().ref(PATHS.seasonCurrent()).get()).val();
  assert.equal(stillOld.id, SEASON, 'the season pointer must not have moved');
  await setRaidPointer({ phase: 'done' });
});

runOrSkip('nextWeekId takes the highest week, so a deleted week cannot collide', async () => {
  // With a child COUNT, deleting any week made the next id collide with an
  // existing one and silently overwrite its boss and roster.
  await seedScheduledWeeks(5);
  await database().ref(PATHS.boss(SEASON, 'w2')).remove(); // a mis-scheduled week cleaned up
  const next = await nextWeekId(SEASON);
  assert.equal(next, 'w6', `expected w6 after the highest (w5), got ${next}`);
});

// ── the silent-stall guard ──────────────────────────────────────────────────
// Weeks are scheduled BY HAND so the muster window opens while the stream is
// live. The cost of that choice is that forgetting is invisible — the game just
// stops for a week, which is how t1 drifted onto its finale three times.

runOrSkip('raidScheduleStatus reports a week in flight as open', async () => {
  await setSeason({ id: SEASON, name: 'Rollover Test', tier: 1, weeks: WEEKS, startsAt: Date.now() });
  await waitForSeason((s) => s?.id === SEASON);
  await seedScheduledWeeks(2);
  await setRaidPointer({ seasonId: SEASON, weekId: 'w2', phase: 'signup' });
  await waitForPointerPhase('signup');

  const st = await raidScheduleStatus();
  assert.equal(st.open, true, 'a signup-phase week needs no prompt');
});

runOrSkip('a finished week with the season unfinished names the next boss', async () => {
  await setSeason({ id: SEASON, name: 'Rollover Test', tier: 1, weeks: WEEKS, startsAt: Date.now() });
  await waitForSeason((s) => s?.id === SEASON);
  await seedScheduledWeeks(2);
  await setRaidPointer({ seasonId: SEASON, weekId: 'w2', phase: 'done' });
  await waitForPointerPhase('done');

  const st = await raidScheduleStatus();
  assert.equal(st.open, false, 'nothing is scheduled — this is the stall');
  assert.equal(st.seasonComplete, false);
  assert.equal(st.nextWeek, 3, 'and it says which week is next');
  assert.ok(st.nextBoss, 'and which boss, so the prompt is actionable');
});

runOrSkip('a finished SEASON prompts a rollover, not another week', async () => {
  await setSeason({ id: SEASON, name: 'Rollover Test', tier: 1, weeks: WEEKS, startsAt: Date.now() });
  await waitForSeason((s) => s?.id === SEASON);
  await seedScheduledWeeks(WEEKS);
  await setRaidPointer({ seasonId: SEASON, weekId: `w${WEEKS}`, phase: 'done' });
  await waitForPointerPhase('done');

  const st = await raidScheduleStatus();
  assert.equal(st.seasonComplete, true);
  assert.equal(st.nextWeek, null, 'there is no week 7 to schedule');
  assert.equal(st.nextTier, 2, 'it points at the next tier instead');
});

runOrSkip('with no season at all there is nothing to prompt about', async () => {
  await database().ref(PATHS.seasonCurrent()).remove();
  await waitForSeason((s) => !s?.id);
  const st = await raidScheduleStatus();
  assert.equal(st.open, false);
  assert.equal(st.nextWeek, null);
  assert.equal(st.seasonComplete, false, 'no season is not a completed season');
});
