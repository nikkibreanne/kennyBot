// Behavioral test for the signup-phase roster refresh (refreshMusteredRoster).
// Proves: while a raid is in the SIGNUP phase, a hero who levels up after
// mustering gets re-snapshotted onto the roster (so the site updates without a
// manual re-!muster); redundant passes write nothing; and once the roster LOCKS
// the snapshot is frozen. Run via `npm run test:emulator` (skipped without the
// emulator host, same as firebase-rules.test.js).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { initFirebase, database, closeFirebase, PATHS } from '../src/db/firebase.js';
import { startConfigMirror, getRaidPointer, setRaidPointer } from '../src/db/configStore.js';
import { setupRaidWeek, enlist, getSignup, refreshMusteredRoster } from '../src/db/raid.js';

const host = process.env.FIREBASE_DATABASE_EMULATOR_HOST;
const runOrSkip = host ? test : test.skip;
const noopLogger = { info() {}, warn() {}, error() {}, debug() {} };

const SEASON = 's_rtest';
const NEXT_SEASON = 's_rtest_next';
const WEEK = 'w1';
const NEXT_WEEK = 'w2';
const UID = 'u_rtest';

const makePlayer = (level) => ({
  displayName: 'RTester', class: 'Ranger', role: 'dps', level, equipped: {}, subTier: 0, renown: 0, exp: 0,
});

// The config mirror is fed by an async RTDB listener — poll until it converges.
async function waitForPointer(pred, ms = 3000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred(getRaidPointer())) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('config/raid mirror did not converge in time');
}

before(async () => {
  if (!host) return;
  initFirebase();
  await startConfigMirror(noopLogger);
});

after(async () => {
  if (!host) return;
  await database().ref(PATHS.raid(SEASON, WEEK)).remove().catch(() => {});
  await database().ref(PATHS.raid(SEASON, NEXT_WEEK)).remove().catch(() => {});
  await database().ref(PATHS.raid(NEXT_SEASON, WEEK)).remove().catch(() => {});
  await database().ref(PATHS.bossesForSeason(SEASON)).remove().catch(() => {});
  await database().ref(PATHS.bossesForSeason(NEXT_SEASON)).remove().catch(() => {});
  await database().ref(PATHS.player(UID)).remove().catch(() => {});
  await database().ref(PATHS.configRaid()).remove().catch(() => {});
  await closeFirebase();
});

runOrSkip('signup phase: a mustered hero who levels up is re-snapshotted', async () => {
  const db = database();
  await db.ref(PATHS.player(UID)).set(makePlayer(1));
  await setupRaidWeek({
    seasonId: SEASON, weekId: WEEK,
    boss: { name: 'Test Boss', thresholds: { tank: 0, healer: 0, dps: 0 } },
    locksAt: Date.now() + 3_600_000, startsAt: Date.now() + 7_200_000,
  });
  await waitForPointer((p) => p?.seasonId === SEASON && p?.phase === 'signup');

  await enlist({ seasonId: SEASON, weekId: WEEK, userId: UID, player: makePlayer(1) });
  assert.equal((await getSignup(SEASON, WEEK, UID)).level, 1, 'mustered at level 1');

  // Hero levels up after mustering → a refresh updates the card.
  await db.ref(PATHS.player(UID)).update({ level: 5 });
  assert.equal(await refreshMusteredRoster(), 1, 'one card refreshed');
  assert.equal((await getSignup(SEASON, WEEK, UID)).level, 5, 'card now reflects level 5');

  // Nothing changed since → no redundant write.
  assert.equal(await refreshMusteredRoster(), 0, 'unchanged roster writes nothing');
});

runOrSkip('locked phase: the roster is frozen — no refresh', async () => {
  const db = database();
  await setRaidPointer({ phase: 'locked' });
  await waitForPointer((p) => p?.phase === 'locked');

  await db.ref(PATHS.player(UID)).update({ level: 9 });
  assert.equal(await refreshMusteredRoster(), 0, 'a locked roster must not be rewritten');
  assert.equal((await getSignup(SEASON, WEEK, UID)).level, 5, 'snapshot stays frozen at lock-time level');
});

runOrSkip('new boss in the same season inherits the mustered roster', async () => {
  const db = database();
  await db.ref(PATHS.player(UID)).set(makePlayer(7));
  await setupRaidWeek({
    seasonId: SEASON, weekId: WEEK,
    boss: { name: 'First Boss', thresholds: { tank: 0, healer: 0, dps: 0 } },
    locksAt: Date.now() + 3_600_000, startsAt: Date.now() + 7_200_000,
  });
  await waitForPointer((p) => p?.seasonId === SEASON && p?.weekId === WEEK && p?.phase === 'signup');
  await enlist({ seasonId: SEASON, weekId: WEEK, userId: UID, player: makePlayer(7) });

  await db.ref(PATHS.player(UID)).update({ level: 8 });
  await setupRaidWeek({
    seasonId: SEASON, weekId: NEXT_WEEK,
    boss: { name: 'Next Boss', thresholds: { tank: 0, healer: 0, dps: 0 } },
    locksAt: Date.now() + 10_800_000, startsAt: Date.now() + 14_400_000,
  });

  const carried = await getSignup(SEASON, NEXT_WEEK, UID);
  assert.equal(carried.level, 8, 'carry-over uses a fresh player snapshot');
});

runOrSkip('new season week 1 starts with an empty muster roster', async () => {
  await setupRaidWeek({
    seasonId: NEXT_SEASON, weekId: WEEK,
    boss: { name: 'Fresh Season Boss', thresholds: { tank: 0, healer: 0, dps: 0 } },
    locksAt: Date.now() + 3_600_000, startsAt: Date.now() + 7_200_000,
  });

  assert.equal(await getSignup(NEXT_SEASON, WEEK, UID), null, 'season boundary clears participation');
});
