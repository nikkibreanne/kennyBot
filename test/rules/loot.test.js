import { test } from 'node:test';
import assert from 'node:assert/strict';
import { weightedPick, rollRarity, pickDrop, pickWinner } from '../../src/rules/loot.js';
import { config } from '../../src/config.js';
import { getItem, DEFAULT_LOOT_TABLE } from '../../src/content/items.js';

test('weightedPick respects boundaries deterministically', () => {
  const weights = { a: 1, b: 1 }; // total 2
  assert.equal(weightedPick(weights, () => 0), 'a');
  assert.equal(weightedPick(weights, () => 0.4), 'a'); // 0.8 < 1
  assert.equal(weightedPick(weights, () => 0.5), 'b'); // 1.0 -> b
  assert.equal(weightedPick(weights, () => 0.99), 'b');
});

test('weightedPick skips zero-weight keys and throws on empty', () => {
  assert.equal(weightedPick({ a: 0, b: 5 }, () => 0.99), 'b');
  assert.throws(() => weightedPick({ a: 0 }, () => 0.5), /sum to 0/);
});

test('rollRarity returns a ladder rarity', () => {
  const r = rollRarity(() => 0, config); // lowest roll -> first/common-ish
  assert.ok(['common', 'uncommon', 'rare', 'epic', 'legendary'].includes(r));
});

test('pickDrop returns an item from the table, preferring the rolled rarity', () => {
  const id = pickDrop(DEFAULT_LOOT_TABLE, getItem, () => 0, config);
  assert.ok(id && getItem(id), 'returns a real item id');
  assert.ok(DEFAULT_LOOT_TABLE.includes(id));
});

test('pickDrop returns null for an empty/invalid table', () => {
  assert.equal(pickDrop([], getItem, () => 0, config), null);
  assert.equal(pickDrop(['itm_nope'], getItem, () => 0, config), null);
});

test('pickDrop honors a rarity-weight override (boss loot skews rarer)', () => {
  // Only "epic" weighted → must pick an epic item from the table.
  const id = pickDrop(DEFAULT_LOOT_TABLE, getItem, () => 0, config, { common: 0, uncommon: 0, rare: 0, epic: 1, legendary: 0 });
  assert.equal(getItem(id).rarity, 'epic');
});

test('pickWinner draws exactly one entrant uniformly, null when empty', () => {
  const entries = { a: {}, b: {}, c: {} }; // Object.keys order: a, b, c
  assert.equal(pickWinner(entries, () => 0), 'a'); // 0   → idx 0
  assert.equal(pickWinner(entries, () => 0.5), 'b'); // 1.5 → idx 1
  assert.equal(pickWinner(entries, () => 0.99), 'c'); // 2.97 → idx 2
  assert.equal(pickWinner({}, () => 0.5), null); // no entrants → no winner
});
