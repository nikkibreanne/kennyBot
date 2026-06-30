// Pure-logic tests for the leaderboard ranking + the !top line formatter. These
// touch no Firebase: rankEntries and formatTop are deterministic helpers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rankEntries } from '../../src/db/leaderboard.js';
import { formatTop } from '../../src/commands/top.js';

test('rankEntries sorts descending by field and caps at n', () => {
  const entries = {
    a: { damage: 100 },
    b: { damage: 300 },
    c: { damage: 200 },
    d: { damage: 50 },
  };
  const top = rankEntries(entries, 'damage', 2);
  assert.deepEqual(top, [
    { uid: 'b', value: 300 },
    { uid: 'c', value: 200 },
  ]);
});

test('rankEntries drops zero/absent/non-numeric scores', () => {
  const entries = {
    a: { damage: 0 },
    b: {},
    c: { damage: 42 },
    d: { damage: 'nope' },
  };
  assert.deepEqual(rankEntries(entries, 'damage', 5), [{ uid: 'c', value: 42 }]);
});

test('rankEntries handles a missing/empty leaderboard node', () => {
  assert.deepEqual(rankEntries(null), []);
  assert.deepEqual(rankEntries(undefined), []);
  assert.deepEqual(rankEntries({}), []);
});

test('rankEntries can rank by an arbitrary field', () => {
  const entries = { a: { heal: 9 }, b: { heal: 11 } };
  assert.deepEqual(rankEntries(entries, 'heal', 5), [
    { uid: 'b', value: 11 },
    { uid: 'a', value: 9 },
  ]);
});

test('formatTop renders a compact 1-indexed line with grouped thousands', () => {
  const line = formatTop([
    { uid: 'u1', value: 12340, displayName: 'Alice' },
    { uid: 'u2', value: 9800, displayName: 'Bob' },
  ]);
  assert.equal(line, '1. Alice 12,340 · 2. Bob 9,800');
});

test('formatTop of an empty list is an empty string', () => {
  assert.equal(formatTop([]), '');
});
