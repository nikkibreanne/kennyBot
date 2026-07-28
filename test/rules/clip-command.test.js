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
  assert.match(reply, /local capture/i);
  assert.doesNotMatch(reply, /clips\.twitch\.tv/);
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
  assert.match(reply, /local clip capture isn't set up/i);
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
  assert.match(reply, /local capture/i);
});

test('a cold replay buffer tells the viewer the next !clip will work', async () => {
  initCaptureWith(async () => ({ path: null, started: true }));
  assert.match(await runClip(), /next !clip/i);
});

test('a rate-limited capture tells the viewer when to retry', async () => {
  initCaptureWith(async () => ({ path: 'a.mkv' }), { minIntervalMs: 60_000 });
  await runClip();
  const reply = await runClip(); // inside the channel-wide window
  assert.match(reply, /try again in \d+s/i);
});

test('an unreachable OBS gets a plain-English reply, never a stack trace', async () => {
  initCaptureWith(async () => { throw new Error('could not reach OBS at ws://x:4455'); });
  const reply = await runClip();
  assert.match(reply, /couldn't reach the recording PC/i);
  assert.doesNotMatch(reply, /ws:\/\//, 'no internals in chat');
});
