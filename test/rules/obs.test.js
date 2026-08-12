// !obs — the obs-websocket request sequences behind scene switching, source
// visibility, filters and audio.
//
// Driven through a fake `request` rather than a socket (initObsControlWith), so
// what's asserted is the ACTUAL protocol call OBS would receive. Every bug worth
// catching at this layer is either "wrong request" or "wrong order".
//
// The chat surface itself is covered by the e2e scenario in test/e2e/scenarios.js.
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  initObsControlWith, obsControlReady,
  listScenes, setScene, listSources, setSourceVisible,
  listFilters, setFilter, listAudio, setMute, getStats,
} from '../../src/integrations/obsControl.js';

/** Records every request and answers with a small fake OBS. */
function fakeObs(overrides = {}) {
  const calls = [];
  const answers = {
    GetSceneList: { currentProgramSceneName: 'Live', scenes: [{ sceneName: 'BRB' }, { sceneName: 'Live' }] },
    GetSceneItemList: { sceneItems: [
      { sourceName: 'cam', sceneItemId: 1, sceneItemEnabled: true },
      { sourceName: 'overlay', sceneItemId: 2, sceneItemEnabled: false },
    ] },
    GetSceneItemId: { sceneItemId: 7 },
    GetSceneItemEnabled: { sceneItemEnabled: true },
    SetSceneItemEnabled: {},
    SetCurrentProgramScene: {},
    GetSourceFilterList: { filters: [{ filterName: 'Chroma Key', filterKind: 'chroma_key_filter_v2', filterEnabled: true }] },
    SetSourceFilterEnabled: {},
    GetInputList: { inputs: [{ inputName: 'Mic' }, { inputName: 'Image' }] },
    GetInputMute: { inputMuted: false },
    GetInputVolume: { inputVolumeDb: -6 },
    SetInputMute: {},
    GetStats: {
      cpuUsage: 12.5, activeFps: 60, renderSkippedFrames: 3, renderTotalFrames: 1000,
      outputSkippedFrames: 0, outputTotalFrames: 900, availableDiskSpace: 51200,
    },
    GetStreamStatus: { outputActive: true, outputSkippedFrames: 5, outputTotalFrames: 900 },
    ...overrides,
  };
  const request = async (type, data) => {
    calls.push({ type, data });
    const a = answers[type];
    if (a instanceof Error) throw a;
    if (typeof a === 'function') return a(data);
    if (a === undefined) throw new Error(`fake OBS has no answer for ${type}`);
    return a;
  };
  return { calls, request, types: () => calls.map((c) => c.type) };
}

let obs;
beforeEach(() => {
  obs = fakeObs();
  initObsControlWith(obs.request);
});
after(() => initObsControlWith(null));

// ── wiring ────────────────────────────────────────────────────────────────────

test('the test seam stands in for a configured OBS, and null means none', () => {
  assert.equal(obsControlReady(), true);
  initObsControlWith(null);
  assert.equal(obsControlReady(), false);
});

test('with no OBS configured every operation resolves rather than throwing', async () => {
  initObsControlWith(null);
  const res = await setScene('Live');
  assert.deepEqual(res, { ok: false, reason: 'no OBS is configured for this bot' });
});

// ── scenes ────────────────────────────────────────────────────────────────────

test('scenes come back in the order OBS shows them, not the order it sends them', async () => {
  // OBS returns index 0 as the BOTTOM of its scene list; chat should read like
  // the panel the streamer is looking at.
  const res = await listScenes();
  assert.deepEqual(res.data.names, ['Live', 'BRB']);
  assert.equal(res.data.current, 'Live');
});

test('switching a scene sends the name unchanged', async () => {
  const res = await setScene('Starting Soon');
  assert.ok(res.ok);
  assert.deepEqual(obs.calls[0], { type: 'SetCurrentProgramScene', data: { sceneName: 'Starting Soon' } });
});

test("a scene OBS doesn't have surfaces OBS's own error", async () => {
  initObsControlWith(fakeObs({ SetCurrentProgramScene: new Error('No source was found by the name of `Nope`') }).request);
  const res = await setScene('Nope');
  assert.equal(res.ok, false);
  assert.match(res.reason, /No source was found/);
});

// ── sources ───────────────────────────────────────────────────────────────────

test('listing sources defaults to the scene that is live', async () => {
  const res = await listSources();
  assert.equal(res.data.scene, 'Live');
  assert.deepEqual(obs.types(), ['GetSceneList', 'GetSceneItemList']);
  assert.equal(obs.calls[1].data.sceneName, 'Live');
  // Reversed like scenes, so the top of the chat list is the top of OBS's list.
  assert.deepEqual(res.data.items.map((i) => i.name), ['overlay', 'cam']);
  assert.deepEqual(res.data.items.map((i) => i.visible), [false, true]);
});

test('an explicit scene skips the lookup of the current one', async () => {
  await listSources('BRB');
  assert.deepEqual(obs.types(), ['GetSceneItemList']);
});

test('show and hide set visibility directly, by numeric id', async () => {
  const res = await setSourceVisible('overlay', 'show');
  assert.equal(res.data.visible, true);
  assert.deepEqual(obs.types(), ['GetSceneList', 'GetSceneItemId', 'SetSceneItemEnabled']);
  // The id must come from OBS — there is no name-based form of this request, and
  // a remembered id goes stale the moment a source is reordered.
  assert.deepEqual(obs.calls[2].data, { sceneName: 'Live', sceneItemId: 7, sceneItemEnabled: true });

  obs = fakeObs();
  initObsControlWith(obs.request);
  assert.equal((await setSourceVisible('overlay', 'hide')).data.visible, false);
  assert.equal(obs.calls[2].data.sceneItemEnabled, false);
});

test('toggle reads the current state first and inverts it', async () => {
  const res = await setSourceVisible('cam', 'toggle');   // fake says enabled: true
  assert.equal(res.data.visible, false);
  assert.deepEqual(obs.types(), [
    'GetSceneList', 'GetSceneItemId', 'GetSceneItemEnabled', 'SetSceneItemEnabled',
  ]);
  assert.equal(obs.calls[3].data.sceneItemEnabled, false);
});

// ── filters ───────────────────────────────────────────────────────────────────

test('filters come back with their enabled state', async () => {
  const res = await listFilters('cam');
  assert.deepEqual(res.data.filters, [
    { name: 'Chroma Key', kind: 'chroma_key_filter_v2', enabled: true },
  ]);
});

test('setting a filter names both the source and the filter', async () => {
  await setFilter('cam', 'Chroma Key', false);
  assert.deepEqual(obs.calls[0].data, {
    sourceName: 'cam', filterName: 'Chroma Key', filterEnabled: false,
  });
});

// ── audio ─────────────────────────────────────────────────────────────────────

test('listing audio keeps only the inputs that HAVE audio', async () => {
  // OBS has no "list audio inputs" request: an input with no audio track errors
  // on GetInputMute, and that error is the filter. An image source must not
  // appear in a list a mod is about to mute.
  const o = fakeObs({
    GetInputMute: (d) => {
      if (d.inputName === 'Image') throw new Error('no audio track');
      return { inputMuted: true };
    },
  });
  initObsControlWith(o.request);
  const res = await listAudio();
  assert.deepEqual(res.data.inputs, [{ name: 'Mic', muted: true, db: -6 }]);
});

test('mute and unmute set the state directly', async () => {
  await setMute('Mic', 'mute');
  assert.deepEqual(obs.calls[0], { type: 'SetInputMute', data: { inputName: 'Mic', inputMuted: true } });

  obs = fakeObs();
  initObsControlWith(obs.request);
  await setMute('Mic', 'unmute');
  assert.equal(obs.calls[0].data.inputMuted, false);
});

test('audio toggle reads first, like the visibility toggle', async () => {
  const res = await setMute('Mic', 'toggle');    // fake says muted: false
  assert.equal(res.data.muted, true);
  assert.deepEqual(obs.types(), ['GetInputMute', 'SetInputMute']);
});

// ── stats ─────────────────────────────────────────────────────────────────────

test('stats carry the stream numbers, not just the app ones', async () => {
  const res = await getStats();
  assert.equal(res.data.fps, 60);
  assert.equal(res.data.streaming, true);
  assert.equal(res.data.streamSkipped, 5);
  assert.equal(res.data.diskGb, 50);
});

test('stats still work when nothing is streaming', async () => {
  // GetStreamStatus is allowed to fail — OBS health is still worth reporting when
  // the stream is down, which is exactly when someone is asking.
  const o = fakeObs({ GetStreamStatus: new Error('not streaming') });
  initObsControlWith(o.request);
  const res = await getStats();
  assert.ok(res.ok);
  assert.equal(res.data.streaming, null);
  assert.equal(res.data.fps, 60);
});
