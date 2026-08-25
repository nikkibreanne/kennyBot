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
    { uid: 'b', value: 300, role: null },
    { uid: 'c', value: 200, role: null },
  ]);
});

test('rankEntries drops zero/absent/non-numeric scores', () => {
  const entries = {
    a: { damage: 0 },
    b: {},
    c: { damage: 42 },
    d: { damage: 'nope' },
  };
  assert.deepEqual(rankEntries(entries, 'damage', 5), [{ uid: 'c', value: 42, role: null }]);
});

test('rankEntries handles a missing/empty leaderboard node', () => {
  assert.deepEqual(rankEntries(null), []);
  assert.deepEqual(rankEntries(undefined), []);
  assert.deepEqual(rankEntries({}), []);
});

test('rankEntries can rank by an arbitrary field', () => {
  const entries = { a: { heal: 9 }, b: { heal: 11 } };
  assert.deepEqual(rankEntries(entries, 'heal', 5), [
    { uid: 'b', value: 11, role: null },
    { uid: 'a', value: 9, role: null },
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

// ─── per-role boards ────────────────────────────────────────────────────────
// One damage column ranked healers against DPS for work healers never do. Each
// role is now measured on its own job.

import { ROLE_METRIC } from '../../src/db/leaderboard.js';
import { resolveBoard } from '../../src/commands/top.js';

const SEASON = {
  t1: { damage: 5000, healing: 0, taken: 900, role: 'dps' },
  t2: { damage: 300, healing: 0, taken: 4200, role: 'tank' },
  h1: { damage: 120, healing: 7000, taken: 400, role: 'healer' },
  h2: { damage: 90, healing: 3000, taken: 250, role: 'healer' },
  d2: { damage: 4100, healing: 0, taken: 800, role: 'dps' },
};

test('a role board only contains that role', () => {
  for (const role of ['tank', 'healer', 'dps']) {
    const rows = rankEntries(SEASON, ROLE_METRIC[role].field, 10, { role });
    assert.ok(rows.length > 0, `${role} board is empty`);
    for (const r of rows) assert.equal(r.role, role);
  }
});

test('each role is ranked on the metric that measures its own job', () => {
  assert.equal(ROLE_METRIC.dps.field, 'damage');
  assert.equal(ROLE_METRIC.healer.field, 'healing');
  assert.equal(ROLE_METRIC.tank.field, 'taken');

  // The top healer is the one who HEALED most, not the one who hit hardest.
  const healers = rankEntries(SEASON, 'healing', 5, { role: 'healer' });
  assert.equal(healers[0].uid, 'h1');
  // And the top tank is the one who SOAKED most, though the DPS out-damaged them.
  const tanks = rankEntries(SEASON, 'taken', 5, { role: 'tank' });
  assert.equal(tanks[0].uid, 't2');
});

test('a healer can never outrank a DPS on the damage board, or vice versa', () => {
  const dps = rankEntries(SEASON, 'damage', 10, { role: 'dps' });
  assert.deepEqual(dps.map((r) => r.uid), ['t1', 'd2']);
  assert.equal(dps.some((r) => r.uid.startsWith('h')), false, 'no healers on the damage board');
  const heals = rankEntries(SEASON, 'healing', 10, { role: 'healer' });
  assert.equal(heals.some((r) => r.uid === 't1'), false, 'no DPS on the healing board');
});

test('an unfiltered board still works for legacy entries with no role', () => {
  // t1 entries predate role stamping; they must not vanish from a plain board.
  const legacy = { old1: { damage: 500 }, old2: { damage: 100 } };
  const rows = rankEntries(legacy, 'damage', 5);
  assert.equal(rows.length, 2);
  // …but a ROLE-filtered board correctly excludes them (no role recorded).
  assert.equal(rankEntries(legacy, 'damage', 5, { role: 'dps' }).length, 0);
});

test('!top resolves roles, metric aliases, and junk', () => {
  assert.deepEqual(resolveBoard('tank'), { role: 'tank', field: 'taken', label: 'damage soaked' });
  assert.deepEqual(resolveBoard('healer'), { role: 'healer', field: 'healing', label: 'healing' });
  assert.deepEqual(resolveBoard('soaked'), { role: 'tank', field: 'taken', label: 'damage soaked' });
  assert.equal(resolveBoard('').role, 'dps', 'bare !top defaults to the damage board');
  assert.equal(resolveBoard('wat').role, 'dps', 'junk falls back rather than erroring');
});

// ─── contribution extraction from a real combat log ─────────────────────────

import { statsByUid } from '../../src/db/raid.js';

test('statsByUid splits damage, healing and damage soaked', () => {
  const log = {
    0: { type: 'start' },
    1: { type: 'action', side: 'party', kind: 'damage', target: 'boss', actor: 'd1', amount: 300 },
    2: { type: 'action', side: 'party', kind: 'damage', target: 'boss', actor: 'd1', amount: 200 },
    3: { type: 'action', side: 'party', kind: 'heal', actor: 'h1', target: 't1', amount: 150 },
    4: { type: 'action', side: 'enemy', actor: 'boss', kind: 'damage', target: 't1', amount: 400 },
    5: { type: 'action', side: 'enemy', actor: 'boss', kind: 'aoe', target: 'party', amount: 90 },
    6: { type: 'action', side: 'party', kind: 'damage', target: 'add_1', actor: 'd1', amount: 75 },
    7: { type: 'turn', n: 1 },
  };
  const { damage, healing, taken } = statsByUid(log);
  assert.equal(damage.d1, 500, 'only damage AT THE BOSS counts as damage dealt');
  assert.equal(healing.h1, 150);
  assert.equal(taken.t1, 400, 'single-target enemy damage is what the tank soaked');
  assert.equal(taken.add_1, undefined, 'the party hitting an add is not damage anyone soaked');
  assert.equal(taken.party, undefined, 'AoE hits everyone equally, so it ranks nobody');
});

test('statsByUid reads older logs that predate the `side` field', () => {
  // Prod holds eight weeks of combat logs written before `side` existed.
  const legacy = { 0: { type: 'action', kind: 'damage', target: 'boss', actor: 'd1', amount: 42 } };
  assert.equal(statsByUid(legacy).damage.d1, 42);
});

test('statsByUid is safe on an empty or missing log', () => {
  for (const log of [null, undefined, {}]) {
    const s = statsByUid(log);
    assert.deepEqual([s.damage, s.healing, s.taken], [{}, {}, {}]);
  }
});
