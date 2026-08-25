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
import { rolloverAllPlayers } from '../src/db/players.js';
import bossCmd from '../src/commands/mod/boss.js';
import seasonCmd from '../src/commands/mod/season.js';
import { nextWeekId } from '../src/db/raid.js';
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

runOrSkip('rollover grants prestige ONLY to heroes who raided the outgoing season', async () => {
  const db = database();
  await db.ref(PATHS.player(VET)).set(makePlayer(4));
  await db.ref(PATHS.player(AFK)).set(makePlayer(0));
  // The veteran was on the roster of 3 resolved raids; the AFK hero has a
  // character but never raided, so attends none.
  await seedAttendance(VET, 3);

  const { reset, prestiged, best } = await rolloverAllPlayers({ seasonId: SEASON });

  assert.equal(prestiged, 1, 'exactly one veteran');
  assert.ok(reset >= 2, 'gear resets for everyone, veteran or not');

  const vet = (await db.ref(PATHS.player(VET)).get()).val();
  const expected = 3 * config.raid.prestigePerRaid;
  assert.equal(best, expected);
  assert.equal(vet.renown, 4 + expected, 'veteran keeps its 4 renown and gains prestige per raid attended');
  assert.equal(vet.stats.seasonsPlayed, 1);

  const afk = (await db.ref(PATHS.player(AFK)).get()).val();
  assert.equal(afk.renown, 0, 'a hero who never raided earns no prestige');
  assert.equal(afk.stats.seasonsPlayed, 0, 'nor a season played');
});

runOrSkip('rollover resets gear for everyone, including non-participants', async () => {
  const db = database();
  await db.ref(PATHS.player(VET)).set(makePlayer(4));
  await db.ref(PATHS.player(AFK)).set(makePlayer(0));
  await seedAttendance(VET, 1);

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
  await seedAttendance(VET, 4);

  const { prestiged } = await rolloverAllPlayers({ seasonId: null });

  assert.equal(prestiged, 0, 'there is no season to have been a veteran of');
  const vet = (await db.ref(PATHS.player(VET)).get()).val();
  assert.equal(vet.renown, 4, 'renown untouched');
  assert.ok(vet.equipped.weapon.id.startsWith('itm_starter_'));
});

runOrSkip('prestige SCALES with attendance — more raids, more renown', async () => {
  const db = database();
  const KEEN = 'u_keen_test';
  const RARE = 'u_rare_test';
  await db.ref(PATHS.player(KEEN)).set(makePlayer(0));
  await db.ref(PATHS.player(RARE)).set(makePlayer(0));
  await seedAttendance(KEEN, 6); // every week
  await seedAttendance(RARE, 2); // turned up twice

  const { granted, best } = await rolloverAllPlayers({ seasonId: SEASON });

  const keen = (await db.ref(PATHS.player(KEEN)).get()).val();
  const rare = (await db.ref(PATHS.player(RARE)).get()).val();
  assert.equal(keen.renown, 6 * config.raid.prestigePerRaid);
  assert.equal(rare.renown, 2 * config.raid.prestigePerRaid);
  assert.ok(keen.renown > rare.renown, 'attendance must be worth more than a cameo');
  assert.equal(best, keen.renown);
  assert.equal(granted, keen.renown + rare.renown);

  await db.ref(PATHS.player(KEEN)).remove();
  await db.ref(PATHS.player(RARE)).remove();
});

runOrSkip('a week that was scheduled but never fought earns no prestige', async () => {
  const db = database();
  await db.ref(PATHS.player(VET)).set(makePlayer(0));
  await seedAttendance(VET, 2);
  // A third week exists with a roster but no result — the battle never ran.
  await db.ref(`raids/${SEASON}/w3/signups/${VET}`).set({ displayName: 'Tester', role: 'dps', level: 12 });

  const { best } = await rolloverAllPlayers({ seasonId: SEASON });

  assert.equal(best, 2 * config.raid.prestigePerRaid, 'only the two RESOLVED raids count');
});

runOrSkip('prestige is bounded so an overlong season cannot mint a runaway veteran', async () => {
  const db = database();
  await db.ref(PATHS.player(VET)).set(makePlayer(0));
  await seedAttendance(VET, config.raid.prestigeMax + 5);

  const { best } = await rolloverAllPlayers({ seasonId: SEASON });

  assert.equal(best, config.raid.prestigeMax, 'capped at config.raid.prestigeMax');
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
