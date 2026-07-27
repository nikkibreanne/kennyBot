// Local-capture tests. The load-bearing guarantee: triggering the streamer's OBS
// is BEST EFFORT — a PC that's off, an OBS that's closed, or a dead tailnet must
// never break `!clip`, which still produces a perfectly good Twitch clip.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { initCapture, initCaptureWith, captureReady, triggerCapture } from '../../src/integrations/capture.js';
import { deriveAuth, websocketAvailable } from '../../src/integrations/obsWebsocket.js';

const noopLogger = { info() {}, warn() {}, error() {}, debug() {} };

afterEach(() => initCaptureWith(null)); // never leak config between tests

test('capture is disabled when no OBS url is configured', () => {
  initCapture({ url: '' }, noopLogger);
  assert.equal(captureReady(), false);
});

test('an unknown backend disables capture rather than guessing', () => {
  initCapture({ backend: 'aitum', url: 'ws://x:4455' }, noopLogger);
  assert.equal(captureReady(), false, 'aitum is not implemented yet — must not silently use obs');
});

test('a valid obs-websocket config enables capture', () => {
  initCapture({ backend: 'obs-websocket', url: 'ws://100.82.136.16:4455' }, noopLogger);
  assert.equal(captureReady(), websocketAvailable(), 'enabled iff the runtime has WebSocket');
});

test('triggerCapture reports the saved path on success', async () => {
  initCaptureWith(async () => ({ path: 'C:\\clips\\Replay 2026-07-27.mkv', started: false }));
  const res = await triggerCapture(noopLogger);
  assert.deepEqual(res, { ok: true, path: 'C:\\clips\\Replay 2026-07-27.mkv', started: false });
});

test('a save with no reported path still counts as success', async () => {
  initCaptureWith(async () => ({ path: null, started: true }));
  const res = await triggerCapture(noopLogger);
  assert.equal(res.ok, true);
  assert.equal(res.started, true, 'reports that it had to start the buffer');
});

test('an unreachable OBS resolves as a failure — it never throws', async () => {
  initCaptureWith(async () => { throw new Error('could not reach OBS at ws://x:4455'); });
  const res = await triggerCapture(noopLogger);
  assert.equal(res.ok, false);
  assert.match(res.reason, /could not reach OBS/);
});

test('triggerCapture is a no-op when unconfigured', async () => {
  initCaptureWith(null);
  const res = await triggerCapture(noopLogger);
  assert.deepEqual(res, { ok: false, reason: 'not configured' });
});

test('a global rate limit stops a burst of !clips writing many huge files', async () => {
  let fired = 0;
  initCaptureWith(async () => { fired += 1; return { path: `f${fired}.mkv` }; }, { minIntervalMs: 60_000 });
  const t0 = 1_000_000;
  assert.equal((await triggerCapture(noopLogger, t0)).ok, true, 'first fires');
  const second = await triggerCapture(noopLogger, t0 + 5_000);
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'rate-limited');
  assert.equal(second.retryInMs, 55_000, 'reports when it will be allowed again');
  assert.equal(fired, 1, 'the expensive save ran once for the burst');
  // …and it opens back up once the window passes.
  assert.equal((await triggerCapture(noopLogger, t0 + 60_000)).ok, true);
  assert.equal(fired, 2);
});

test('the rate limit is per-channel, not per-user (that is !clip\'s job)', async () => {
  let fired = 0;
  initCaptureWith(async () => { fired += 1; return { path: 'x.mkv' }; }, { minIntervalMs: 60_000 });
  // Different viewers, same window — capture.js has no notion of who asked.
  await triggerCapture(noopLogger, 1000);
  await triggerCapture(noopLogger, 2000);
  await triggerCapture(noopLogger, 3000);
  assert.equal(fired, 1);
});

test('a failed capture does not burn the rate-limit window', async () => {
  let calls = 0;
  initCaptureWith(async () => {
    calls += 1;
    if (calls === 1) throw new Error('could not reach OBS');
    return { path: 'ok.mkv' };
  }, { minIntervalMs: 60_000 });
  assert.equal((await triggerCapture(noopLogger, 1000)).ok, false, 'PC was off');
  const retry = await triggerCapture(noopLogger, 2000); // immediately after
  assert.equal(retry.ok, true, 'next !clip may retry straight away');
});

test('obs-websocket auth is the documented two-round derivation', () => {
  // secret = base64(sha256(password + salt)); auth = base64(sha256(secret + challenge))
  const auth = deriveAuth('pw', 'salt', 'chal');
  assert.match(auth, /^[A-Za-z0-9+/]+=*$/, 'base64');
  assert.equal(Buffer.from(auth, 'base64').length, 32, 'sha256 digest');
  // Every input participates — a change in any one changes the result.
  assert.notEqual(auth, deriveAuth('pw2', 'salt', 'chal'));
  assert.notEqual(auth, deriveAuth('pw', 'salt2', 'chal'));
  assert.notEqual(auth, deriveAuth('pw', 'salt', 'chal2'));
  assert.equal(auth, deriveAuth('pw', 'salt', 'chal'), 'deterministic');
});
