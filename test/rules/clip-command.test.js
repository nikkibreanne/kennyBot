// !clip mode selection. The default is LOCAL: !clip triggers the streamer's
// OBS/Aitum capture and posts NOTHING to Twitch. These lock down which half of
// the command fires for each clip mode — the failure that matters is a mode
// quietly making a Twitch clip the streamer didn't ask for.
//
// The live mirror is `false` throughout (no RTDB here), which is exactly the
// interesting case: the local buffer works offline, Twitch's Create Clip doesn't.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import clip, { activeClipMode } from '../../src/commands/clip.js';
import { parseClipMode, readClipTargets, clipTargets, primeConfigForTest } from '../../src/db/configStore.js';
import { initClipsWith } from '../../src/twitch/clips.js';
import { initCaptureWith } from '../../src/integrations/capture.js';

const noopLogger = { info() {}, warn() {}, error() {}, debug() {} };
const alice = { id: 'u1', displayName: 'Alice' };

/** Run !clip and return what it said in chat. */
async function runClip() {
  let said = '';
  await clip.run({ user: alice, reply: (t) => { said = t; }, logger: noopLogger });
  return said;
}

afterEach(() => {
  primeConfigForTest({ clipMode: null }); // back to a cold mirror
  initClipsWith(null);
  initCaptureWith(null);
});

test('the mode is a SET of targets, in any order, with aliases', () => {
  // Canonical form, so 'a b' and 'b,a' are the same stored value.
  assert.equal(parseClipMode('horizontal vertical'), 'horizontal,vertical');
  assert.equal(parseClipMode('vertical,horizontal'), 'horizontal,vertical', 'order-independent');
  assert.equal(parseClipMode('HORIZONTAL'), 'horizontal', 'case-insensitive');
  assert.equal(parseClipMode('horizontal twitch'), 'horizontal,twitch');
  assert.equal(parseClipMode('twitch'), 'twitch');
  assert.equal(parseClipMode('vertical'), 'vertical');
  // Shorthands, kept so old stored values and muscle memory keep working.
  assert.equal(parseClipMode('local'), 'horizontal,vertical');
  assert.equal(parseClipMode('both'), 'horizontal,vertical,twitch');
  assert.equal(parseClipMode('all'), 'horizontal,vertical,twitch');
  assert.equal(parseClipMode('local twitch'), 'horizontal,vertical,twitch', 'alias + target mixes');
});

test("'off' is storable and does not decay back to the default", () => {
  // An empty target list must not round-trip through '' — that would read back as
  // "unrecognised" and silently re-enable clipping a mod had turned off.
  assert.equal(parseClipMode('off'), 'off');
  assert.equal(parseClipMode(parseClipMode('off')), 'off', 'stable across a re-read');
  assert.equal(clipTargets('off').none, true);
});

test('a mode is all-or-nothing — one bad token rejects the whole thing', () => {
  // Dropping the bad token would leave a mode that looks accepted but does less
  // than asked, and the symptom is a clip that silently is not made.
  assert.equal(readClipTargets('horizontal nonsense'), null);
  assert.equal(readClipTargets('nonsense'), null);
  // Bad input from RTDB still lands on the safe default, never on Twitch.
  for (const bad of [undefined, null, '', 'nonsense', 42, {}]) {
    assert.equal(parseClipMode(bad), 'horizontal,vertical', `${JSON.stringify(bad)} must not enable Twitch`);
  }
});

test('clipTargets turns a mode into what to actually do', () => {
  assert.deepEqual(clipTargets('horizontal'), { horizontal: true, vertical: false, twitch: false, none: false });
  assert.deepEqual(clipTargets('vertical,twitch'), { horizontal: false, vertical: true, twitch: true, none: false });
  assert.deepEqual(clipTargets('all'), { horizontal: true, vertical: true, twitch: true, none: false });
});

// The point of making this runtime config: a mod flips it from chat the moment the
// streamer's OBS dies, without an SSH session and a redeploy.
test('the live RTDB value is what !clip obeys', async () => {
  let captures = 0;
  primeConfigForTest({ clipMode: 'twitch' }); // a mod ran `!clipmode twitch`
  assert.equal(activeClipMode(), 'twitch');
  initClipsWith(async () => 'TwitchClipId');
  initCaptureWith(async () => { captures += 1; return { path: 'x.mkv' }; });

  const reply = await runClip(); // not live, so the twitch half is gated
  assert.equal(captures, 0, 'local capture must not fire — the live mode is twitch');
  assert.match(reply, /only clip while the stream is live/i);
});

test('a cold mirror falls back to the configured default, never to Twitch', () => {
  // clipMode is null until startConfigMirror lands its first snapshot — true in
  // unit tests, and true for the window during boot before the mirror is warm.
  primeConfigForTest({ clipMode: null });
  assert.equal(activeClipMode(), 'horizontal,vertical');
});

test('by default !clip captures locally and makes NO Twitch clip', async () => {
  let clips = 0;
  let captures = 0;
  initClipsWith(async () => { clips += 1; return 'TwitchClipId'; });
  initCaptureWith(async () => { captures += 1; return { path: 'D:/rec/Replay.mkv' }; });

  const reply = await runClip();
  assert.equal(captures, 1);
  assert.equal(clips, 0, 'the Twitch half must not fire in the default mode');
  assert.equal(reply, '@Alice 🎬 clipped it!');
});

// Viewers must not be able to infer HOW a clip is made: no file path, no OBS, no
// second machine, not even that a local recording exists. Every branch of the
// local-only reply gets checked, so a future "helpful" message can't reopen this.
test('no local-only reply leaks anything about the capture setup', async () => {
  const outcomes = [
    async () => ({ path: 'D:/streams/rec/Replay 2026-07-27.mkv' }), // saved
    async () => ({ path: null, started: true }), // buffer was cold
    async () => { throw new Error('could not reach OBS at ws://obs.invalid:4455'); },
  ];
  const leaks = /obs|websocket|replay|buffer|recording|\bPC\b|4k|quality|\.mkv|\.mp4|[A-Z]:[/\\]|ws:\/\/|\d+\.\d+\.\d+\.\d+/i;
  for (const outcome of outcomes) {
    initCaptureWith(outcome);
    assert.doesNotMatch(await runClip(), leaks);
  }
  // …and the rate-limited branch, which needs a second call inside the window.
  initCaptureWith(async () => ({ path: 'a.mkv' }), { minIntervalMs: 60_000 });
  await runClip();
  assert.doesNotMatch(await runClip(), leaks);
});

test('local mode ignores the live gate — OBS records whether or not you are streaming', async () => {
  let captures = 0;
  initCaptureWith(async () => { captures += 1; return { path: 'D:/rec/Replay.mkv' }; });
  const reply = await runClip(); // live === false
  assert.equal(captures, 1, 'offline is fine: the replay buffer is local');
  assert.doesNotMatch(reply, /only clip while the stream is live/i);
});

test('local mode never falls back to Twitch when no capture backend is configured', async () => {
  let clips = 0;
  initClipsWith(async () => { clips += 1; return 'TwitchClipId'; });
  initCaptureWith(null); // OBS not configured

  const reply = await runClip();
  assert.equal(clips, 0, 'silently posting a Twitch clip would defeat the mode');
  assert.match(reply, /clipping isn't set up/i);
});

test("mode 'twitch' restores the old behaviour and doesn't touch OBS", async () => {
  let captures = 0;
  primeConfigForTest({ clipMode: 'twitch' });
  initClipsWith(async () => 'TwitchClipId');
  initCaptureWith(async () => { captures += 1; return { path: 'x.mkv' }; });

  const reply = await runClip(); // not live
  assert.equal(captures, 0, 'no local capture in twitch mode');
  assert.match(reply, /only clip while the stream is live/i);
});

test("mode 'both' while offline still saves locally instead of failing", async () => {
  let clips = 0;
  primeConfigForTest({ clipMode: 'both' });
  initClipsWith(async () => { clips += 1; return 'TwitchClipId'; });
  initCaptureWith(async () => ({ path: 'D:/rec/Replay.mkv' }));

  const reply = await runClip(); // not live → Twitch half is impossible
  assert.equal(clips, 0, 'Create Clip would be rejected offline — do not call it');
  assert.match(reply, /clipped it/i);
});

// The combinations the old local|twitch|both presets could NOT express. Each
// asserts what the capture layer was actually asked for, not just the reply text.
test('horizontal-only does not ask for the vertical save', async () => {
  let asked = null;
  primeConfigForTest({ clipMode: 'horizontal' });
  initCaptureWith(async (t) => { asked = t; return { path: 'h.mkv' }; });
  assert.match(await runClip(), /clipped it/i);
  assert.deepEqual(asked, { horizontal: true, vertical: false });
});

test('vertical-only does not ask for the horizontal save', async () => {
  let asked = null;
  primeConfigForTest({ clipMode: 'vertical' });
  initCaptureWith(async (t) => { asked = t; return { path: null, vertical: { ok: true, requested: true } }; });
  assert.match(await runClip(), /clipped it/i);
  assert.deepEqual(asked, { horizontal: false, vertical: true });
});

test('horizontal + twitch captures locally without the vertical file', async () => {
  let asked = null;
  let clips = 0;
  primeConfigForTest({ clipMode: 'horizontal,twitch' });
  initClipsWith(async () => { clips += 1; return 'TwitchClipId'; });
  initCaptureWith(async (t) => { asked = t; return { path: 'h.mkv' }; });
  await runClip(); // offline → twitch half drops, local still runs
  assert.deepEqual(asked, { horizontal: true, vertical: false });
  assert.equal(clips, 0, 'Create Clip is impossible offline — do not call it');
});

test('asking for vertical with no vertical output configured is a no-op, not a horizontal capture', async () => {
  let captures = 0;
  primeConfigForTest({ clipMode: 'vertical' });
  initCaptureWith(async () => { captures += 1; return { path: 'h.mkv' }; }, { verticalOutput: '' });
  assert.match(await runClip(), /clipping isn't set up/i);
  assert.equal(captures, 0, 'must not silently save the horizontal instead');
});

test("'off' disables !clip entirely without touching either backend", async () => {
  let captures = 0;
  let clips = 0;
  primeConfigForTest({ clipMode: 'off' });
  initClipsWith(async () => { clips += 1; return 'TwitchClipId'; });
  initCaptureWith(async () => { captures += 1; return { path: 'x.mkv' }; });
  assert.match(await runClip(), /clipping isn't set up/i);
  assert.equal(captures, 0);
  assert.equal(clips, 0);
});

test('a cold replay buffer reads as an ordinary miss, not a status report', async () => {
  initCaptureWith(async () => ({ path: null, started: true })); // nothing saved
  assert.match(await runClip(), /couldn't clip that one/i);
});

test('a rate-limited capture tells the viewer when to retry', async () => {
  initCaptureWith(async () => ({ path: 'a.mkv' }), { minIntervalMs: 60_000 });
  await runClip();
  const reply = await runClip(); // inside the channel-wide window
  assert.match(reply, /try again in \d+s/i);
});

test('an unreachable OBS gets a plain-English reply, never a stack trace', async () => {
  initCaptureWith(async () => { throw new Error('could not reach OBS at ws://x:4455'); });
  assert.match(await runClip(), /couldn't clip that one/i);
});
