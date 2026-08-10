// REMINDERS — the stateful half: seeding into config/reminders (and NOT
// clobbering what mods changed), schedule edits, the liveSince stamp that the
// "30 minutes after going live" reminder counts from, and the scheduler tick
// that ties it together. The scheduling judgement itself is covered offline in
// test/rules/reminders.test.js. Skipped without the emulator host.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { initFirebase, database, closeFirebase } from '../src/db/firebase.js';
import { startConfigMirror, setLive, getLiveSince, getConfig } from '../src/db/configStore.js';
import { seedReminders, listReminders, getReminder, editReminder, patchReminder } from '../src/db/reminders.js';
import { startReminderScheduler } from '../src/events/reminderScheduler.js';
import { DEFAULT_REMINDERS } from '../src/content/reminders.js';
import { config } from '../src/config.js';

const host = process.env.FIREBASE_DATABASE_EMULATOR_HOST;
const runOrSkip = host ? test : test.skip;

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll until the RTDB listener has echoed a change into the mirror. */
async function until(pred, ms = 2000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (pred()) return true;
    await sleep(15);
  }
  return pred();
}

async function wipe() {
  await database().ref('config/reminders').remove().catch(() => {});
  await setLive(false, 'test', silentLogger);
  await until(() => Object.keys(listReminders()).length === 0 && !getConfig().live);
}

before(async () => {
  if (!host) return;
  initFirebase();
  await startConfigMirror(silentLogger);
});
after(async () => { if (host) { await wipe(); await closeFirebase(); } });
beforeEach(async () => { if (host) await wipe(); });

runOrSkip('seed: creates the shipped defaults, and is a no-op the second time', async () => {
  const first = await seedReminders();
  assert.deepEqual(first.seeded.sort(), DEFAULT_REMINDERS.map((r) => r.id).sort());
  const second = await seedReminders();
  assert.deepEqual(second.seeded, [], 'a redeploy must not re-seed');
  await until(() => listReminders().length === DEFAULT_REMINDERS.length);
  assert.equal(getReminder('ghosty').channel, 'nikkibreanne', 'Nikki-specific by data, not by code');
  // RTDB stores no nulls, so "any channel" comes back absent rather than null —
  // which is why the evaluator tests falsiness and never `=== null`.
  assert.ok(!getReminder('hydration').channel, 'hydration runs on any channel');
});

runOrSkip('seed: NEVER clobbers a schedule a mod has changed', async () => {
  await seedReminders();
  await until(() => Boolean(getReminder('ghosty')));
  await editReminder('ghosty', { times: ['09:30'], text: 'custom feeding time' });

  await seedReminders(); // a deploy happens
  const stored = (await database().ref('config/reminders/ghosty').get()).val();
  assert.deepEqual(stored.times, ['09:30'], 'the mod-set time survived the deploy');
  assert.equal(stored.text, 'custom feeding time');
});

runOrSkip('edit: validates times, zones and periods instead of storing nonsense', async () => {
  await seedReminders();
  await until(() => Boolean(getReminder('ghosty')));

  assert.match((await editReminder('ghosty', { times: ['25:00'] })).reason, /^bad-time/);
  assert.equal((await editReminder('ghosty', { times: [] })).reason, 'no-times');
  assert.equal((await editReminder('ghosty', { timeZone: 'Mars/Olympus' })).reason, 'bad-zone');
  assert.equal((await editReminder('hydration', { everyMs: 30_000 })).reason, 'too-often');
  assert.equal((await editReminder('nope', { enabled: false })).reason, 'unknown');
  assert.deepEqual(getReminder('ghosty').times, ['08:00', '17:00'], 'nothing bad was written');

  const ok = await editReminder('ghosty', { times: ['07:15', '18:45'], timeZone: 'Europe/London' });
  assert.deepEqual(ok.reminder.times, ['07:15', '18:45']);
  assert.equal(ok.reminder.timeZone, 'Europe/London');
});

runOrSkip('edit: changing the interval re-arms the next ping', async () => {
  await seedReminders();
  await until(() => Boolean(getReminder('hydration')));
  await patchReminder('hydration', { state: { nextAt: Date.now() + 45 * 60_000 } });

  const res = await editReminder('hydration', { everyMs: 30 * 60_000 });
  assert.equal(res.reminder.state.nextAt, null, 'the old schedule must not outlive the change');
});

runOrSkip('edit: a reminder can be pointed at another channel, or at all of them', async () => {
  await seedReminders();
  await until(() => Boolean(getReminder('wallpaper')));
  assert.equal((await editReminder('wallpaper', { channel: '#SomeoneElse' })).reminder.channel, 'someoneelse', 'normalized');
  assert.ok(!(await editReminder('wallpaper', { channel: null })).reminder.channel, 'back to any channel');
  assert.equal((await database().ref('config/reminders/wallpaper/channel').get()).val(), null, 'cleared in RTDB too');
});

runOrSkip('liveSince is stamped on the way up and cleared on the way down', async () => {
  const before = Date.now();
  await setLive(true, 'test', silentLogger);
  await until(() => Boolean(getLiveSince()));
  const stamped = getLiveSince();
  assert.ok(stamped >= before, 'stamped when the stream started');
  assert.equal((await database().ref('config/liveSince').get()).val(), stamped, 'persisted for restarts');

  // An idempotent repeat (the Helix poll re-reporting live) is NOT a new session.
  assert.equal(await setLive(true, 'test-again', silentLogger), false, 'no edge, no write');
  assert.equal(getLiveSince(), stamped, 'a restart mid-stream keeps the original start');

  await setLive(false, 'test', silentLogger);
  await until(() => getLiveSince() == null);
  assert.equal((await database().ref('config/liveSince').get()).val(), null, 'cleared when offline');
});

runOrSkip('scheduler: announces a due reminder once and persists that it did', async () => {
  await seedReminders();
  await until(() => Boolean(getReminder('hydration')));
  // Arm hydration to be due right now, and disable the others so the tick is
  // unambiguous. A tiny tickMs keeps the test in milliseconds.
  await editReminder('wallpaper', { enabled: false });
  await editReminder('ghosty', { enabled: false });
  await patchReminder('hydration', { state: { nextAt: Date.now() - 1000 } });
  await setLive(true, 'test', silentLogger);
  await until(() => getConfig().live === true);

  const said = [];
  const originalTick = config.reminders.tickMs;
  config.reminders.tickMs = 25;
  const stop = startReminderScheduler({
    send: { say: (t) => { said.push(t); } }, channel: 'nikkibreanne', logger: silentLogger, rng: () => 0.5,
  });
  try {
    await sleep(300);
  } finally {
    stop();
    config.reminders.tickMs = originalTick;
  }

  assert.equal(said.length, 1, `exactly one ping, got ${said.length}`);
  assert.match(said[0], /Hydration/);
  const stored = (await database().ref('config/reminders/hydration/state').get()).val();
  assert.ok(stored.nextAt > Date.now(), 're-armed for the next hour, in RTDB so a restart keeps it');
});

runOrSkip('scheduler: stays silent for a channel the reminder does not belong to', async () => {
  await seedReminders();
  await until(() => Boolean(getReminder('hydration')));
  await editReminder('hydration', { channel: 'nikkibreanne' });
  await patchReminder('hydration', { state: { nextAt: Date.now() - 1000 } });
  await setLive(true, 'test', silentLogger);
  await until(() => getConfig().live === true);

  const said = [];
  const originalTick = config.reminders.tickMs;
  config.reminders.tickMs = 25;
  const stop = startReminderScheduler({
    send: { say: (t) => { said.push(t); } }, channel: 'a_different_channel', logger: silentLogger,
  });
  try {
    await sleep(200);
  } finally {
    stop();
    config.reminders.tickMs = originalTick;
  }
  assert.deepEqual(said, [], 'another streamer running this bot must not get Nikki\'s reminders');
});
