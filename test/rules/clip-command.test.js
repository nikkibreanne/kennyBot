// !clip mode selection. The default is LOCAL: !clip triggers the streamer's
// OBS/Aitum capture and posts NOTHING to Twitch. These lock down which half of
// the command fires for each CLIP_MODE — the failure that matters is a mode
// quietly making a Twitch clip the streamer didn't ask for.
//
// The live mirror is `false` throughout (no RTDB here), which is exactly the
// interesting case: the local buffer works offline, Twitch's Create Clip doesn't.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import clip, { resolveClipMode } from '../../src/commands/clip.js';
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
  delete process.env.CLIP_MODE;
  initClipsWith(null);
  initCaptureWith(null);
});

test('CLIP_MODE parses the three modes and defaults to local', () => {
  assert.equal(resolveClipMode(undefined), 'local', 'unset → local');
  assert.equal(resolveClipMode(''), 'local');
  assert.equal(resolveClipMode('  BOTH '), 'both', 'trimmed + case-insensitive');
  assert.equal(resolveClipMode('twitch'), 'twitch');
  assert.equal(resolveClipMode('nonsense'), 'local', 'a typo must not silently enable Twitch clips');
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

test("CLIP_MODE=twitch restores the old behaviour and doesn't touch OBS", async () => {
  let captures = 0;
  process.env.CLIP_MODE = 'twitch';
  initClipsWith(async () => 'TwitchClipId');
  initCaptureWith(async () => { captures += 1; return { path: 'x.mkv' }; });

  const reply = await runClip(); // not live
  assert.equal(captures, 0, 'no local capture in twitch mode');
  assert.match(reply, /only clip while the stream is live/i);
});

test('CLIP_MODE=both while offline still saves locally instead of failing', async () => {
  let clips = 0;
  process.env.CLIP_MODE = 'both';
  initClipsWith(async () => { clips += 1; return 'TwitchClipId'; });
  initCaptureWith(async () => ({ path: 'D:/rec/Replay.mkv' }));

  const reply = await runClip(); // not live → Twitch half is impossible
  assert.equal(clips, 0, 'Create Clip would be rejected offline — do not call it');
  assert.match(reply, /clipped it/i);
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
