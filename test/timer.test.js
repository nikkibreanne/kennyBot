// MOD TIMER (`!timer`) — the stateful half: the config/timer record's lifecycle
// (set → adjust → pause → resume → clear) and the countdown scheduler that
// announces it. The pure parsing/formatting half is covered offline in
// test/rules/timer.test.js. Skipped without the emulator host.
//
// The scheduler tests shrink `config.timer` (tick + marks) so a crossing can be
// observed in milliseconds instead of minutes; the original is restored after.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { initFirebase, database, closeFirebase } from '../src/db/firebase.js';
import { setTimerState, getTimer } from '../src/db/configStore.js';
import { startTimer, addTime, pauseTimer, resumeTimer, clearTimer, remainingMs } from '../src/db/timer.js';
import { startTimerScheduler } from '../src/events/timerScheduler.js';
import { config } from '../src/config.js';

const host = process.env.FIREBASE_DATABASE_EMULATOR_HOST;
const runOrSkip = host ? test : test.skip;

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Clear through the store (not a raw ref.remove()) so the in-memory mirror the
// timer functions read stays in step with RTDB.
async function wipe() { await setTimerState(null); }

/**
 * Run the scheduler over a pre-planted record and collect what it said.
 *
 * The deadline is stamped AFTER the record is written and the scheduler is
 * running, so RTDB write latency can't eat into the window the test is timing.
 * Without that, a slow write under load shifts every deadline earlier relative
 * to the observation window and the expiry gatecrashes a heads-up test — which
 * is exactly how this suite went flaky once. Every timing below is also given
 * margin far larger than a tick, so nothing here rides on a millisecond.
 *
 * `marks` are millisecond-scale so a crossing is observable in a test, which
 * also means `warnMinLeadMs` has to shrink with them — at its real 30s a
 * millisecond mark would never be eligible and every heads-up test would pass
 * vacuously. Which marks a timer qualifies for is covered at REAL scale offline
 * (test/rules/timer.test.js); what these tests own is the crossing behaviour.
 *
 * @param {(startedAt:number) => object|null} plant builds the record from the
 *   instant observation actually begins
 */
async function withScheduler(plant, { forMs = 400, marks, minLeadMs = 0, tickMs = 25 } = {}) {
  const said = [];
  const original = { ...config.timer };
  if (marks) { config.timer.warnAtMs = marks; config.timer.warnMinLeadMs = minLeadMs; }
  config.timer.tickMs = tickMs;
  const stop = startTimerScheduler({ send: { say: (t) => { said.push(t); } }, logger: silentLogger });
  try {
    await setTimerState(plant(Date.now())); // deadline stamped as late as possible
    await sleep(forMs);
  } finally {
    stop();
    Object.assign(config.timer, original);
  }
  return said;
}

/**
 * Just the heads-up lines. The three mark tests below are about WHICH heads-ups
 * fire, never about whether the timer also ran out — and it can, because a
 * `sleep(n)` on a busy event loop is a floor, not a ceiling: an overrun that
 * carries the window past the deadline is what made these flaky. Filtering makes
 * them depend on the scheduler's logic instead of on the host's timing. Expiry
 * has its own tests, which can't be polluted in return (a short timer's marks are
 * skipped by the 1.5x guard — a rule, not a race).
 */
const headsUps = (said) => said.filter((line) => line.endsWith('left.'));

/** A running record `ms` from expiry, as if it had been set for `span`. */
function running(ms, { span = ms, label = null } = {}) {
  return (from) => ({
    setAt: from - 1, label, by: 'Mod', durationMs: span, endsAt: from + ms, paused: false, remainingMs: null,
  });
}

before(async () => { if (host) initFirebase(); });
after(async () => { if (host) { await wipe(); await closeFirebase(); } });
beforeEach(async () => { if (host) await wipe(); });

runOrSkip('timer: set stores an absolute deadline and reports the replaced one', async () => {
  const first = await startTimer({ durationMs: 10 * 60_000, label: '  Coffee   break ', by: 'Mod' });
  assert.equal(first.ok, true);
  assert.equal(first.replaced, null, 'nothing to replace');
  assert.equal(first.timer.label, 'Coffee break', 'label cleaned');
  assert.equal(first.timer.paused, false);
  assert.ok(first.timer.endsAt > Date.now(), 'stores a deadline, not a duration countdown');

  const second = await startTimer({ durationMs: 60_000, by: 'Mod' });
  assert.equal(second.replaced?.label, 'Coffee break', 'setting a new one replaces the old (only ever one)');
  assert.equal(second.timer.label, null, 'a label is optional');

  const stored = (await database().ref('config/timer').get()).val();
  assert.equal(stored.endsAt, second.timer.endsAt, 'persisted so a restart resumes it');
});

runOrSkip('timer: set refuses the absurd in both directions', async () => {
  assert.equal((await startTimer({ durationMs: 1_000 })).reason, 'too-short');
  assert.equal((await startTimer({ durationMs: config.timer.maxMs + 1 })).reason, 'too-long');
  assert.equal(getTimer(), null, 'a rejected set leaves no timer behind');
});

runOrSkip('timer: +/- adjusts in place and keeps the timer identity', async () => {
  const { timer } = await startTimer({ durationMs: 10 * 60_000, label: 'Break', by: 'Mod' });
  const added = await addTime(5 * 60_000);
  assert.equal(added.timer.setAt, timer.setAt, 'extending must not restart the countdown');
  assert.ok(Math.abs(added.remaining - 15 * 60_000) < 2_000, `~15m left, got ${added.remaining}`);
  assert.equal(added.timer.label, 'Break', 'label survives');

  const removed = await addTime(-14 * 60_000);
  assert.ok(Math.abs(removed.remaining - 60_000) < 2_000, `~1m left, got ${removed.remaining}`);
  assert.equal(removed.ended, false);

  assert.equal((await addTime(config.timer.maxMs)).reason, 'too-long', 'the cap holds on adjust too');
});

runOrSkip('timer: subtracting past zero ends it rather than going negative', async () => {
  await startTimer({ durationMs: 60_000, by: 'Mod' });
  const res = await addTime(-5 * 60_000);
  assert.equal(res.ended, true);
  assert.equal(remainingMs(res.timer), 0, 'due now — the scheduler announces it like any expiry');

  // A PAUSED timer has nothing ticking to notice, so it's cleared outright.
  await startTimer({ durationMs: 60_000, by: 'Mod' });
  await pauseTimer();
  const paused = await addTime(-5 * 60_000);
  assert.deepEqual([paused.ended, paused.timer], [true, null]);
  assert.equal(getTimer(), null, 'cleared, not left frozen at zero');
});

runOrSkip('timer: pause freezes the clock, resume hands the remainder back', async () => {
  await startTimer({ durationMs: 60_000, label: 'Break', by: 'Mod' });
  const paused = await pauseTimer();
  assert.equal(paused.timer.endsAt, null, 'no deadline while paused — wall time stops mattering');
  await sleep(120);
  assert.equal(remainingMs(getTimer()), paused.remaining, 'time passing does not drain a paused timer');
  assert.equal((await pauseTimer()).reason, 'already');

  const resumed = await resumeTimer();
  assert.ok(resumed.timer.endsAt > Date.now(), 'a fresh deadline from the frozen remainder');
  assert.ok(Math.abs(resumed.remaining - paused.remaining) < 2_000);
  assert.equal((await resumeTimer()).reason, 'already');
});

runOrSkip('timer: clear reports what it dismissed; clearing nothing is a no-op', async () => {
  await startTimer({ durationMs: 10 * 60_000, label: 'Break', by: 'Mod' });
  const cleared = await clearTimer();
  assert.equal(cleared.timer.label, 'Break');
  assert.ok(cleared.remaining > 0, 'reports the time that was left');
  assert.equal((await database().ref('config/timer').get()).exists(), false);
  assert.equal((await clearTimer()).reason, 'none');
});

runOrSkip('scheduler: announces time-up exactly once, then clears the record', async () => {
  const said = await withScheduler(running(120, { label: 'Break' }), { forMs: 400 });
  assert.deepEqual(said, ["⏰ Time's up — Break!"], 'once, not once per tick');
  assert.equal(getTimer(), null, 'the record is gone once it has been announced');
});

runOrSkip('scheduler: a timer that expired while the bot was down is cleared silently', async () => {
  const stale = running(-(config.timer.graceMs + 60_000));
  const said = await withScheduler(stale, { forMs: 200 });
  assert.deepEqual(said, [], 'shouting "time\'s up" long after the fact is noise');
  assert.equal(getTimer(), null, '…but it must not linger');
});

runOrSkip('scheduler: heads-up fires as the clock crosses a mark, and only then', async () => {
  // A 2s timer with the mark at 1s: the crossing lands ~1s in, then ~16 more
  // ticks pass below the mark — any repeat would show up here.
  const said = await withScheduler(running(2_000, { label: 'Break' }), { marks: [1_000], forMs: 1_400 });
  assert.deepEqual(headsUps(said), ['⏳ Break: 1s left.'], 'one heads-up, no repeats while below the mark');
});

runOrSkip('scheduler: a mark the timer has no runway before is skipped', async () => {
  // Span 2s against a 1.5s mark needing 1s of lead: the mark would land half a
  // second in, which reads as nonsense ("5 minutes left" on a 5-minute timer).
  // The window runs well past the mark, so silence means the GUARD held — not
  // merely that the crossing hadn't come round yet.
  const said = await withScheduler(running(2_000, { span: 2_000 }), { marks: [1_500], minLeadMs: 1_000, forMs: 900 });
  assert.deepEqual(headsUps(said), []);
});

runOrSkip('scheduler: restarting mid-timer does not re-announce a passed mark', async () => {
  // A timer already BELOW the mark when the scheduler first sees it (exactly the
  // post-restart case) must not fire a heads-up for a mark it passed while down.
  // Its span clears the 1.5x guard, so the mark is eligible — only first-sight
  // suppression keeps it quiet.
  const said = await withScheduler(running(2_000, { span: 10_000 }), { marks: [3_000], forMs: 600 });
  assert.deepEqual(headsUps(said), []);
});
