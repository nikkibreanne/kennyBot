// Local-capture tests. The load-bearing guarantee: triggering the streamer's OBS
// is BEST EFFORT — a PC that's off, an OBS that's closed, or a dead tailnet must
// resolve as a reported failure, never throw out of `!clip`.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { initCapture, initCaptureWith, captureReady, triggerCapture } from '../../src/integrations/capture.js';
import {
  deriveAuth,
  websocketAvailable,
  replayBufferSequence,
  verticalBacktrackSequence,
  AITUM_VENDOR,
} from '../../src/integrations/obsWebsocket.js';

const noopLogger = { info() {}, warn() {}, error() {}, debug() {} };

afterEach(() => initCaptureWith(null)); // never leak config between tests

test('capture is disabled when no OBS url is configured', () => {
  initCapture({ url: '' }, noopLogger);
  assert.equal(captureReady(), false);
});

test('an unknown backend disables capture rather than guessing', () => {
  initCapture({ backend: 'aitum', url: 'ws://x:4455' }, noopLogger);
  // Aitum IS supported — but via obs-websocket vendor requests on the obs-websocket
  // backend, not as a backend name. An unknown name must disable capture, never guess.
  assert.equal(captureReady(), false, 'an unrecognised backend must not silently use obs');
});

test('a valid obs-websocket config enables capture', () => {
  initCapture({ backend: 'obs-websocket', url: 'ws://obs.invalid:4455' }, noopLogger);
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


// ── the request sequence itself ─────────────────────────────────────────────
// Both bugs found against a real OBS lived here, so they get regression tests.
const noSleep = async () => {};

/** A fake OBS: scripted responses per request type, recording the call order. */
function fakeObs({ active, lastPaths = [], onSave } = {}) {
  const calls = [];
  let activeNow = active;
  let idx = 0;
  return {
    calls,
    request: async (type) => {
      calls.push(type);
      switch (type) {
        case 'GetReplayBufferStatus':
          return { outputActive: activeNow };
        case 'StartReplayBuffer':
          activeNow = true; // OBS flips it asynchronously; here, on the next poll
          return {};
        case 'SaveReplayBuffer':
          onSave?.();
          return {};
        case 'GetLastReplayBufferReplay': {
          const p = lastPaths[Math.min(idx, lastPaths.length - 1)];
          idx += 1;
          return { savedReplayPath: p };
        }
        default:
          throw new Error(`unexpected request ${type}`);
      }
    },
  };
}

test('cold buffer: starts it and does NOT claim a save (regression: 501 OutputNotRunning)', async () => {
  let saved = false;
  const obs = fakeObs({ active: false, onSave: () => { saved = true; } });
  const res = await replayBufferSequence(obs.request, noSleep);
  assert.deepEqual(res, { path: null, started: true });
  assert.equal(saved, false, 'must not save into a buffer that was not running');
  assert.ok(obs.calls.includes('StartReplayBuffer'));
});

test('warm buffer: saves and reports the NEW path, never the previous one', async () => {
  // GetLastReplayBufferReplay returns the OLD file first (OBS finalizes async).
  const obs = fakeObs({ active: true, lastPaths: ['C:/old.mp4', 'C:/old.mp4', 'C:/new.mp4'] });
  const res = await replayBufferSequence(obs.request, noSleep);
  assert.equal(res.started, false);
  assert.equal(res.path, 'C:/new.mp4', 'regression: reported the stale path before');
});

test('warm buffer: a path that never changes is reported as null, not stale', async () => {
  const obs = fakeObs({ active: true, lastPaths: ['C:/old.mp4'] });
  const res = await replayBufferSequence(obs.request, noSleep);
  assert.equal(res.path, null, 'better no path than the wrong one');
  assert.ok(obs.calls.includes('SaveReplayBuffer'), 'the save still happened');
});


// ── Aitum vertical Backtrack ────────────────────────────────────────────────
// The 9:16 canvas has its own replay buffer ("Backtrack"), reached through
// obs-websocket vendor requests on the SAME connection as the horizontal save.

/** A fake Aitum Stream Suite vendor endpoint. */
function fakeAitum({ outputs, saveResult = { success: true } } = {}) {
  const calls = [];
  const state = new Map(outputs.map((o) => [o.name, o.active]));
  return {
    calls,
    request: async (type, data) => {
      if (type !== 'CallVendorRequest') throw new Error(`unexpected ${type}`);
      const { vendorName, requestType, requestData } = data;
      assert.equal(vendorName, AITUM_VENDOR, 'must address the Stream Suite vendor');
      calls.push(requestType);
      switch (requestType) {
        case 'get_outputs':
          return { responseData: { success: true, outputs: [...state].map(([name, active]) => ({ name, active, type: 'backtrack' })) } };
        case 'start_output':
          state.set(requestData.output, true); // flips on the next poll
          return { responseData: { success: true } };
        case 'save_backtrack':
          return { responseData: saveResult };
        default:
          throw new Error(`unexpected vendor request ${requestType}`);
      }
    },
  };
}

test('vertical: an inactive Backtrack is started and NOT treated as a save', async () => {
  const aitum = fakeAitum({ outputs: [{ name: 'Vertical Backtrack', active: false }] });
  const res = await verticalBacktrackSequence(aitum.request, 'Vertical Backtrack', noSleep);
  assert.deepEqual(res, { ok: true, requested: false, started: true });
  assert.ok(!aitum.calls.includes('save_backtrack'), 'nothing buffered yet — saving would be a lie');
});

test('vertical: an active Backtrack is saved', async () => {
  const aitum = fakeAitum({ outputs: [{ name: 'Vertical Backtrack', active: true }] });
  const res = await verticalBacktrackSequence(aitum.request, 'Vertical Backtrack', noSleep);
  assert.deepEqual(res, { ok: true, requested: true, started: false });
  assert.ok(aitum.calls.includes('save_backtrack'));
});

// Found against a real Stream Suite 1.2.1: with a 15-minute-full buffer,
// save_backtrack answered {success:true} and wrote NO file, because the output
// had no recording path. The vendor API can't read that path back, so we must
// never promote acceptance to "saved".
test('vertical: success means REQUESTED, never a file on disk', async () => {
  const aitum = fakeAitum({ outputs: [{ name: 'Vertical Backtrack', active: true }] });
  const res = await verticalBacktrackSequence(aitum.request, 'Vertical Backtrack', noSleep);
  assert.equal(res.requested, true);
  assert.ok(!('path' in res), 'no path field — we cannot know it, so we must not imply it');
  assert.ok(!('saved' in res), 'must not claim a save it cannot verify');
});

test('vertical: an explicit failure from the plugin is surfaced', async () => {
  const aitum = fakeAitum({
    outputs: [{ name: 'Vertical Backtrack', active: true }],
    saveResult: { success: false, error: "'output' not set" },
  });
  await assert.rejects(
    () => verticalBacktrackSequence(aitum.request, 'Vertical Backtrack', noSleep),
    /output' not set/,
  );
});

test('vertical: a missing output names itself rather than failing vaguely', async () => {
  const aitum = fakeAitum({ outputs: [{ name: 'Vertical Stream', active: true }] });
  await assert.rejects(
    () => verticalBacktrackSequence(aitum.request, 'Vertical Backtrack', noSleep),
    /no Aitum output named "Vertical Backtrack"/,
  );
});
