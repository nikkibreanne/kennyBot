// MEDIA SLOTS (`!media`) — the offline half: slot parsing, mapping validation,
// and the obs-websocket request sequence that plays one.
//
// The sequence is tested with a fake `request` rather than a socket, the same way
// replayBufferSequence is, because every bug worth catching here is an ORDERING
// bug: reveal the source, then play it. A socket would only obscure that.
//
// The stateful half — slots persisted to RTDB, the mirror being readable in the
// same breath as the write, and every reply `!media` gives — is covered by the
// e2e scenario in test/e2e/scenarios.js, which drives the real dispatcher.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSlot, cleanName, validateMapping, sortSlots, describeSlot, isAction,
  MEDIA_ACTIONS, DEFAULT_ACTION, MAX_SLOT, MAX_NAME_LEN,
} from '../../src/rules/media.js';
import { mediaSequence, OBS_MEDIA_ACTION } from '../../src/integrations/obsMedia.js';

/** Records every request in order, so the sequence itself can be asserted. */
function fakeObs({ sceneItemId = 7, fail = null } = {}) {
  const calls = [];
  return {
    calls,
    request: async (type, data) => {
      calls.push({ type, data });
      if (fail === type) throw new Error(`OBS rejected ${type}`);
      if (type === 'GetSceneItemId') return { sceneItemId };
      return {};
    },
  };
}

// ── slot numbers ──────────────────────────────────────────────────────────────

test('parseSlot accepts whole numbers in range', () => {
  assert.equal(parseSlot('1'), 1);
  assert.equal(parseSlot(String(MAX_SLOT)), MAX_SLOT);
  assert.equal(parseSlot(' 3 '), 3, 'chat leaves whitespace everywhere');
});

test('parseSlot refuses what parseInt would silently accept', () => {
  // These are the whole reason parseSlot exists: parseInt('1.5') is 1 and
  // parseInt('2x') is 2, either of which maps a slot the mod never named.
  assert.equal(parseSlot('1.5'), null);
  assert.equal(parseSlot('2x'), null);
  assert.equal(parseSlot('-1'), null);
  assert.equal(parseSlot(''), null);
  assert.equal(parseSlot(undefined), null);
});

test('parseSlot bounds the map', () => {
  assert.equal(parseSlot('0'), null, 'slots are 1-based, as typed');
  assert.equal(parseSlot(String(MAX_SLOT + 1)), null);
  assert.equal(parseSlot('99999'), null);
});

// ── OBS names ─────────────────────────────────────────────────────────────────

test('cleanName collapses whitespace but keeps the name OBS knows', () => {
  assert.equal(cleanName('  Airhorn   SFX '), 'Airhorn SFX');
  assert.equal(cleanName('Alert'), 'Alert');
});

test('cleanName refuses empty and over-long names', () => {
  assert.equal(cleanName('   '), null);
  assert.equal(cleanName(''), null);
  assert.equal(cleanName('x'.repeat(MAX_NAME_LEN)), 'x'.repeat(MAX_NAME_LEN));
  assert.equal(cleanName('x'.repeat(MAX_NAME_LEN + 1)), null);
});

// ── mapping validation ────────────────────────────────────────────────────────

test('validateMapping builds the patch to persist', () => {
  const res = validateMapping({ input: ' Airhorn ', scene: 'Alerts', action: 'stop' });
  assert.deepEqual(res, { ok: true, patch: { input: 'Airhorn', scene: 'Alerts', action: 'stop' } });
});

test('validateMapping distinguishes "clear the scene" from "leave it alone"', () => {
  // Three states, and the difference matters: omitting scene must not wipe one a
  // mod already set, and `null` must actually wipe it.
  assert.deepEqual(validateMapping({ action: 'play' }).patch, { action: 'play' }, 'scene untouched');
  assert.deepEqual(validateMapping({ scene: null }).patch, { scene: null }, 'scene cleared');
});

test('validateMapping refuses a typo rather than writing a dead slot', () => {
  assert.deepEqual(validateMapping({ action: 'restrat' }), { ok: false, reason: 'bad-action' });
  assert.deepEqual(validateMapping({ input: '   ' }), { ok: false, reason: 'bad-input' });
  assert.deepEqual(validateMapping({ scene: '' }), { ok: false, reason: 'bad-scene' });
});

test('validateMapping lowercases the action a mod shouted', () => {
  assert.equal(validateMapping({ action: 'RESTART' }).patch.action, 'restart');
});

test('every named action has a wire encoding', () => {
  // The vocabulary (rules) and the protocol table (integration) are separate
  // files; a word in one and not the other is a slot that validates and then
  // throws at play time.
  for (const name of MEDIA_ACTIONS) {
    assert.ok(OBS_MEDIA_ACTION[name], `no obs-websocket enum for "${name}"`);
  }
  assert.equal(Object.keys(OBS_MEDIA_ACTION).length, MEDIA_ACTIONS.length, 'and no extras');
  assert.ok(isAction(DEFAULT_ACTION), 'the default must itself be valid');
});

// ── listing ───────────────────────────────────────────────────────────────────

test('sortSlots orders numerically, not by RTDB string key', () => {
  const slots = { 10: { input: 'J' }, 2: { input: 'B' }, 1: { input: 'A' } };
  assert.deepEqual(sortSlots(slots).map((s) => s.n), [1, 2, 10]);
});

test('sortSlots drops entries that could never play', () => {
  const slots = { 1: { input: 'A' }, 2: { label: 'no input' }, 3: null };
  assert.deepEqual(sortSlots(slots).map((s) => s.n), [1]);
});

test('describeSlot prints the non-default action and hides the default', () => {
  assert.equal(describeSlot({ n: 3, input: 'Airhorn' }), '3 → "Airhorn"');
  assert.equal(describeSlot({ n: 3, input: 'Airhorn', action: DEFAULT_ACTION }), '3 → "Airhorn"');
  assert.equal(describeSlot({ n: 3, input: 'Airhorn', action: 'stop' }), '3 → "Airhorn" (stop)');
  assert.equal(
    describeSlot({ n: 1, label: 'airhorn', input: 'Airhorn SFX', scene: 'Alerts' }),
    '1 airhorn → "Airhorn SFX" in "Alerts"',
  );
});

// ── the request sequence ──────────────────────────────────────────────────────

test('a slot with no scene is one request', async () => {
  const obs = fakeObs();
  const res = await mediaSequence(obs.request, { input: 'Airhorn' });

  assert.deepEqual(res, { played: true, shown: false });
  assert.deepEqual(obs.calls, [{
    type: 'TriggerMediaInputAction',
    data: { inputName: 'Airhorn', mediaAction: OBS_MEDIA_ACTION.restart },
  }]);
});

test('a slot with a scene reveals the source BEFORE playing it', async () => {
  const obs = fakeObs({ sceneItemId: 42 });
  const res = await mediaSequence(obs.request, { input: 'Airhorn', scene: 'Alerts' });

  assert.deepEqual(res, { played: true, shown: true });
  // Order is the assertion. Reversed, the first frames play to a hidden source.
  assert.deepEqual(obs.calls.map((c) => c.type), [
    'GetSceneItemId', 'SetSceneItemEnabled', 'TriggerMediaInputAction',
  ]);
  assert.deepEqual(obs.calls[0].data, { sceneName: 'Alerts', sourceName: 'Airhorn' });
  assert.deepEqual(obs.calls[1].data, { sceneName: 'Alerts', sceneItemId: 42, sceneItemEnabled: true });
});

test('the scene item id comes from OBS, never from the slot', async () => {
  // SetSceneItemEnabled takes a numeric id with no name-based form, so the id
  // MUST be whatever GetSceneItemId just answered — a remembered one goes stale
  // the moment a source is reordered in the scene.
  const obs = fakeObs({ sceneItemId: 99 });
  await mediaSequence(obs.request, { input: 'GIF', scene: 'Alerts' });
  assert.equal(obs.calls[1].data.sceneItemId, 99);
});

test('the slot chooses the action', async () => {
  const obs = fakeObs();
  await mediaSequence(obs.request, { input: 'Music Bed', action: 'stop' });
  assert.equal(obs.calls[0].data.mediaAction, OBS_MEDIA_ACTION.stop);
});

test('an unknown action throws instead of reaching OBS', async () => {
  const obs = fakeObs();
  await assert.rejects(
    () => mediaSequence(obs.request, { input: 'Airhorn', action: 'explode' }),
    /unknown media action "explode"/,
  );
  assert.equal(obs.calls.length, 0, 'nothing was sent');
});

test('a slot with no input throws instead of reaching OBS', async () => {
  const obs = fakeObs();
  await assert.rejects(() => mediaSequence(obs.request, {}), /no OBS input name/);
  assert.equal(obs.calls.length, 0);
});

test('a missing source surfaces the OBS failure rather than playing blind', async () => {
  // Renaming a source in OBS without updating the slot is the expected failure
  // in real use. It must fail at the lookup, not fall through to a trigger that
  // does nothing and reports success.
  const obs = fakeObs({ fail: 'GetSceneItemId' });
  await assert.rejects(
    () => mediaSequence(obs.request, { input: 'Gone', scene: 'Alerts' }),
    /OBS rejected GetSceneItemId/,
  );
  assert.deepEqual(obs.calls.map((c) => c.type), ['GetSceneItemId']);
});
