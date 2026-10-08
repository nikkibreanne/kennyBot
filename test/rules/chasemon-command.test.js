// `!chasemon`'s two pure helpers, which had no tests at all — and that is how the
// bug below reached production and sat there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ceilingScore, statusLine } from '../../src/commands/mod/chasemon.js';
import { config } from '../../src/config.js';

const CAP = config.chase.groupCap;
const AC = config.chase.aircraft;

/** Settings as `getChaseSettings()` returns them: config defaults + the RTDB roster. */
function settings(over = {}) {
  return {
    ...config.chase,
    aircraft: { ...config.chase.aircraft },
    orgs: [{ id: 'org1' }, { id: 'org2' }],
    ...over,
  };
}

test('the ceiling comes from the LOADED roster, not the empty one in the repo', () => {
  // The regression. `config.chase.orgs` ships [] because the roster is private and
  // lives in RTDB, so reducing over it returned 0 on every real deployment. The
  // floor is `clearScore`, so `n > 0` rejected EVERY threshold a mod could type:
  // `!chasemon threshold 8` was impossible in production and said only "must be
  // between 6 and 0", which reads as a typo rather than a bug.
  assert.deepEqual(config.chase.orgs, [], 'premise: the shipped roster is empty');

  const s = settings();
  const expected = 2 * CAP + AC.weight;
  assert.equal(ceilingScore(s), expected);
  assert.ok(
    ceilingScore(s) >= s.threshold,
    `the configured threshold ${s.threshold} must be reachable, got ceiling ${ceilingScore(s)}`,
  );
  assert.ok(ceilingScore(s) > Number(s.clearScore), 'and the accepted band must not be empty');
});

test('a per-org groupCap override is respected', () => {
  const s = settings({ orgs: [{ id: 'org1', groupCap: 4 }, { id: 'org2' }] });
  assert.equal(ceilingScore(s), 4 + CAP + AC.weight);
});

test('switching aircraft off lowers the ceiling by exactly its weight', () => {
  const on = ceilingScore(settings());
  const off = ceilingScore(settings({ aircraft: { ...AC, enabled: false } }));
  assert.equal(on - off, AC.weight);
});

test('no roster and no aircraft is a ceiling of 0 — inert, and honestly reported', () => {
  assert.equal(ceilingScore(settings({ orgs: [], aircraft: { ...AC, enabled: false } })), 0);
  // Garbage in must not throw: this runs inside a chat command.
  assert.equal(ceilingScore({}), 0);
  assert.equal(ceilingScore(null), 0);
  assert.equal(ceilingScore({ orgs: 'not-an-array' }), 0);
});

test('the status line answers whether aircraft is on, and leaks no roster', () => {
  const on = statusLine(settings(), null);
  assert.match(on, /aircraft on/);
  const off = statusLine(settings({ aircraft: { ...AC, enabled: false } }), null);
  assert.match(off, /aircraft off/);

  // Count only — never which outlets. Same contract as the sources count beside it.
  assert.match(on, /2 sources/);
  for (const line of [on, off]) {
    assert.doesNotMatch(line, /org1|org2/, 'source ids must not reach chat');
    assert.doesNotMatch(line, /\bUC[A-Za-z0-9_-]{22}\b/, 'no channel ids in chat');
  }
});

test('an absent aircraft block reads as on, matching how the monitor gates it', () => {
  // The monitor treats only `enabled === false` as off (`ac.enabled !== false`), so
  // the status line must not call a missing block "off" and disagree with it.
  assert.match(statusLine(settings({ aircraft: undefined }), null), /aircraft on/);
});

// ── settings merge ──────────────────────────────────────────────────────────
// `mergeSettings` is what turns the RTDB record into the settings every other
// chase module reads, and it had no tests either.
import { mergeSettings, validateSetting, seedRecord } from '../../src/db/chaseMonitor.js';

test('aircraft is switched from a FLAT stored key onto the nested block', () => {
  // Stored flat (a sibling of `threshold`) because that is what the tunable list
  // and `!chasemon` write; read nested because that is what the monitor asks.
  assert.equal(mergeSettings({}).aircraft.enabled, AC.enabled);
  assert.equal(mergeSettings({ aircraftEnabled: false }).aircraft.enabled, false);
  assert.equal(mergeSettings({ aircraftEnabled: true }).aircraft.enabled, true);
  // Calibration is NOT operator-settable: the weight survives the round trip.
  assert.equal(mergeSettings({ aircraftEnabled: false }).aircraft.weight, AC.weight);
  assert.equal(mergeSettings({ aircraftEnabled: false }).aircraft.suspicionFloor, AC.suspicionFloor);
});

test('merging never mutates the module-level config defaults', () => {
  // `{ ...config.chase }` is SHALLOW, so without an explicit clone `merged.aircraft`
  // IS `config.chase.aircraft` — and one `!chasemon aircraft off` would have
  // rewritten the process-wide default for every later reader, including the next
  // request that stored nothing. That is the kind of bug that only shows up as a
  // second operator seeing a setting they never made.
  const before = AC.enabled;
  const off = mergeSettings({ aircraftEnabled: false });
  assert.equal(off.aircraft.enabled, false);
  assert.equal(config.chase.aircraft.enabled, before, 'config.chase must be untouched');
  assert.equal(mergeSettings({}).aircraft.enabled, before, 'and a later merge must be unaffected');
  assert.notEqual(off.aircraft, config.chase.aircraft, 'must be a distinct object');
});

test('a non-boolean aircraftEnabled is rejected rather than coerced', () => {
  // All-or-nothing: an invalid value throws and nothing is written, so a mod never
  // ends up with a monitor that looks configured and behaves otherwise.
  for (const bad of ['off', 'false', 0, 1, null, {}, []]) {
    assert.throws(() => validateSetting('aircraftEnabled', bad), /must be true or false/);
  }
  assert.equal(validateSetting('aircraftEnabled', false), false);
  assert.equal(validateSetting('aircraftEnabled', true), true);
  // And the error names the key, so two boolean settings are distinguishable.
  assert.throws(() => validateSetting('aircraftEnabled', 'off'), /aircraftEnabled/);
});

test('a stored value of null leaves the default alone', () => {
  // RTDB deletes by writing null, and null must mean "unset", not "false".
  assert.equal(mergeSettings({ aircraftEnabled: null }).aircraft.enabled, AC.enabled);
});

test('the seed record is storable — no undefined reaches RTDB', () => {
  // The seed used to be `TUNABLE.map(k => config.chase[k])`, and `aircraftEnabled`
  // has no such key (it names a NESTED value). RTDB rejects a transaction holding
  // undefined, and the rejection propagates out of ensureSeeded() and therefore out
  // of EVERY settings read — so a kill switch with a missing default took `!chase`
  // and `!chasemon` offline together. Caught by e2e, not by unit tests, which is
  // why this one exists.
  const seed = seedRecord();
  for (const [key, value] of Object.entries(seed)) {
    assert.notEqual(value, undefined, `${key} is not storable`);
  }
  // Whatever is seeded must round-trip through the merge to the same value, or the
  // stored record and the running config disagree from the first write.
  const merged = mergeSettings(seed);
  assert.equal(merged.aircraft.enabled, config.chase.aircraft.enabled);
  assert.equal(merged.threshold, config.chase.threshold);
  assert.equal(merged.mode, config.chase.mode);
  assert.equal(merged.enabled, config.chase.enabled);
});

test('every tunable is either seeded or safely defaulted by the merge', () => {
  // The contract that lets seedRecord() skip a key instead of throwing: an absent
  // key must come back from `config.chase` at merge time. This is the guard for the
  // NEXT tunable someone adds without a default.
  const seed = seedRecord();
  const merged = mergeSettings({});
  for (const key of ['enabled', 'mode', 'threshold', 'groupCap', 'dwell',
    'clearScore', 'clearPolls', 'reopenCooldownMs', 'maxPerHour']) {
    assert.notEqual(merged[key], undefined, `${key} must have an effective value`);
    assert.ok(key in seed, `${key} has a config default, so it should be seeded`);
  }
  assert.notEqual(mergeSettings({}).aircraft.enabled, undefined);
});
