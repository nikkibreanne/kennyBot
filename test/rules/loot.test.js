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

// ─── role-aware raid rewards ────────────────────────────────────────────────
// Gear only pays out via bonuses[player.role], so an off-role item is worth
// exactly 0 to the hero who receives it — forever. That is tolerable for a chat
// drop (announced first, winner random, tradeable) but not for a raid reward,
// which lands straight in one named hero's bag with no lottery and no choice.

import { SEASON_LOOT, ITEMS } from '../../src/content/items.js';
import { cheerRarityFloor, RARITY_ORDER } from '../../src/rules/loot.js';

test('a raid reward rolled for a role is ALWAYS usable by that role', () => {
  for (const role of ['tank', 'healer', 'dps']) {
    for (const table of SEASON_LOOT) {
      for (let i = 0; i < 400; i++) {
        const id = pickDrop(table, getItem, Math.random, config, config.loot.bossRarityWeights, { role });
        assert.ok(
          typeof ITEMS[id].bonuses?.[role] === 'number',
          `${role} was handed ${id}, which does nothing for them`,
        );
      }
    }
  }
});

test('a role with nothing in the table still gets an item rather than nothing', () => {
  // Never silently drop the reward on the floor if a season has no role gear.
  const table = ['itm_starter_tank_weapon_01'];
  const id = pickDrop(table, getItem, Math.random, config, null, { role: 'healer' });
  assert.equal(id, 'itm_starter_tank_weapon_01');
});

test('chat drops pass no role and stay open to the whole table', () => {
  const seen = new Set();
  for (let i = 0; i < 600; i++) seen.add(pickDrop(SEASON_LOOT[0], getItem, Math.random, config));
  const roles = new Set([...seen].flatMap((id) => Object.keys(ITEMS[id].bonuses || {})));
  assert.ok(roles.size > 1, 'the lottery pool must not be silently narrowed to one role');
});

// ─── cheer → rarity floor ───────────────────────────────────────────────────

test('a cheer below the trigger drops nothing at all', () => {
  assert.equal(cheerRarityFloor(0, config), undefined);
  assert.equal(cheerRarityFloor(100, config), undefined, '100 bits used to fire — too often');
  assert.equal(cheerRarityFloor(config.loot.cheer.minBits - 1, config), undefined);
});

test('bigger cheers buy a higher rarity floor, monotonically', () => {
  let prev = -1;
  for (const [bits, rarity] of config.loot.cheer.floors) {
    const got = cheerRarityFloor(bits, config);
    assert.equal(got, rarity, `${bits} bits should floor at ${rarity}`);
    const idx = RARITY_ORDER.indexOf(got);
    assert.ok(idx > prev, 'floors must ascend with the cheer size');
    prev = idx;
  }
  const [topBits, topRarity] = config.loot.cheer.floors.at(-1);
  assert.equal(cheerRarityFloor(topBits * 10, config), topRarity, 'above the top band it stays capped');
});

test('a floor never rolls below itself, and still reaches the tiers above', () => {
  const seen = new Set();
  for (let i = 0; i < 3000; i++) seen.add(rollRarity(Math.random, config, null, 'epic'));
  assert.deepEqual([...seen].sort(), ['epic', 'legendary'], 'epic floor: epic or better, and legendary is reachable');
  for (let i = 0; i < 200; i++) {
    assert.equal(rollRarity(Math.random, config, null, 'legendary'), 'legendary', 'the top floor is a guarantee');
  }
});

test('a floor no weight can satisfy falls back rather than failing the roll', () => {
  // bossRarityWeights has no zero entries, but a tuned table might.
  const noTop = { common: 10, uncommon: 5, rare: 0, epic: 0, legendary: 0 };
  const r = rollRarity(Math.random, config, noTop, 'epic');
  assert.ok(RARITY_ORDER.includes(r), 'must still return a rarity');
});

test('a 5000-bit cheer cannot produce a common', () => {
  const floor = cheerRarityFloor(5000, config);
  for (let i = 0; i < 500; i++) {
    const id = pickDrop(SEASON_LOOT[0], getItem, Math.random, config, null, { minRarity: floor });
    assert.ok(
      RARITY_ORDER.indexOf(ITEMS[id].rarity) >= RARITY_ORDER.indexOf(floor),
      `5000 bits rolled a ${ITEMS[id].rarity}`,
    );
  }
});
