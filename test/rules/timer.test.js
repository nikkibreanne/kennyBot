// !timer parsing/formatting — the pure half of src/db/timer.js (no clock, no
// RTDB). The failures that matter here are silent misreadings: `!timer 10`
// meaning ten seconds instead of ten minutes, `5:75` becoming a real duration,
// or a stray word being swallowed as time instead of kept as the label.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseDurationToken, takeDuration, parseAdjustment, formatDuration, remainingMs, cleanLabel,
} from '../../src/db/timer.js';
import { config } from '../../src/config.js';

const MIN = 60_000;

test('a bare number is MINUTES — the thing a mod types most', () => {
  assert.equal(parseDurationToken('10'), 10 * MIN);
  assert.equal(parseDurationToken('1'), MIN);
  assert.equal(parseDurationToken('2.5'), 2.5 * MIN);
});

test('unit forms parse, including run-ons and the long spellings', () => {
  assert.equal(parseDurationToken('90s'), 90_000);
  assert.equal(parseDurationToken('45m'), 45 * MIN);
  assert.equal(parseDurationToken('2h'), 2 * 60 * MIN);
  assert.equal(parseDurationToken('1h30m'), 90 * MIN);
  assert.equal(parseDurationToken('30sec'), 30_000);
  assert.equal(parseDurationToken('5mins'), 5 * MIN);
  assert.equal(parseDurationToken('2hours'), 120 * MIN);
  assert.equal(parseDurationToken('1minute'), MIN, 'long spellings must not read as "1m" + junk');
});

test('clock form parses; an impossible clock is rejected, not rounded', () => {
  assert.equal(parseDurationToken('5:30'), 5 * MIN + 30_000);
  assert.equal(parseDurationToken('1:05:00'), 65 * MIN);
  assert.equal(parseDurationToken('5:75'), null, '75 seconds is a typo, not 6:15');
});

test('non-durations are rejected outright — no partial credit', () => {
  for (const bad of ['', '   ', 'soon', '5x', '10m!', 'break', 'm', '-5']) {
    assert.equal(parseDurationToken(bad), null, `${JSON.stringify(bad)} must not parse`);
  }
});

test('takeDuration consumes the leading time and keeps the rest as the label', () => {
  assert.deepEqual(takeDuration(['10m', 'Coffee', 'break']), { ms: 10 * MIN, rest: ['Coffee', 'break'] });
  assert.deepEqual(takeDuration(['1h', '30m', 'BRB']), { ms: 90 * MIN, rest: ['BRB'] }, 'split run-on');
  assert.deepEqual(takeDuration(['10', 'min', 'break']), { ms: 10 * MIN, rest: ['break'] }, 'spaced unit word');
  assert.deepEqual(takeDuration(['10']), { ms: 10 * MIN, rest: [] });
  assert.equal(takeDuration(['break', '10m']), null, 'must START with a duration');
  assert.equal(takeDuration([]), null);
});

test('a label word that looks time-ish stays a label', () => {
  // "minute" alone carries no number — swallowing it would eat the label.
  assert.deepEqual(takeDuration(['5', 'minute', 'warning']), { ms: 5 * MIN, rest: ['warning'] });
});

test('adjustments are signed; an unsigned or empty one is not an adjustment', () => {
  assert.equal(parseAdjustment(['+5']), 5 * MIN);
  assert.equal(parseAdjustment(['-2m']), -2 * MIN);
  assert.equal(parseAdjustment(['-90s']), -90_000);
  assert.equal(parseAdjustment(['+1h30m']), 90 * MIN);
  assert.equal(parseAdjustment(['5']), null, 'unsigned is a SET, not an adjust');
  assert.equal(parseAdjustment(['+']), null);
  assert.equal(parseAdjustment(['+soon']), null);
});

test('formatDuration reads like a countdown', () => {
  assert.equal(formatDuration(45_000), '45s');
  assert.equal(formatDuration(4 * MIN + 12_000), '4m 12s');
  assert.equal(formatDuration(5 * MIN), '5m');
  assert.equal(formatDuration(65 * MIN), '1h 05m');
  assert.equal(formatDuration(2 * 60 * MIN), '2h');
  assert.equal(formatDuration(-1), '0s', 'an expired timer never reads negative');
  assert.equal(formatDuration(config.timer.maxMs), '12h');
});

test('remainingMs: running counts down, paused is frozen, missing is zero', () => {
  const now = 1_000_000;
  assert.equal(remainingMs({ endsAt: now + 30_000 }, now), 30_000);
  assert.equal(remainingMs({ endsAt: now - 5_000 }, now), 0, 'never negative');
  assert.equal(remainingMs({ paused: true, remainingMs: 42_000, endsAt: null }, now), 42_000, 'a paused clock ignores wall time');
  assert.equal(remainingMs(null, now), 0);
});

test('labels are collapsed, trimmed, clipped, and empty means none', () => {
  assert.equal(cleanLabel('  Coffee   break '), 'Coffee break');
  assert.equal(cleanLabel('   '), null);
  assert.equal(cleanLabel(undefined), null);
  const long = cleanLabel('x'.repeat(200));
  assert.equal(long.length, config.timer.maxLabelLen);
  assert.ok(long.endsWith('…'));
});
