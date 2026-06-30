import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  engagementMultiplier,
  gearBonus,
  roleRating,
  contribution,
} from '../../src/rules/rating.js';
import { config } from '../../src/config.js';
import { getItem, starterEquipped } from '../../src/content/items.js';

test('engagementMultiplier follows sub tier and clamps to max', () => {
  assert.equal(engagementMultiplier({ subTier: 0 }, config), config.engagement.subTier[0]);
  assert.equal(engagementMultiplier({ subTier: 1 }, config), config.engagement.subTier[1]);
  assert.equal(engagementMultiplier({ subTier: 3 }, config), config.engagement.subTier[3]);
  assert.ok(config.engagement.subTier[1] > config.engagement.subTier[0], 'higher tier = higher mult');
  // Unknown/huge tier falls back without exceeding the clamp.
  assert.ok(engagementMultiplier({ subTier: 99 }, config) <= config.engagement.max);
});

test('gearBonus only counts bonuses for the player own role', () => {
  const player = { role: 'dps', equipped: starterEquipped('dps') };
  const expected = (player.equipped.weapon.bonuses.dps || 0) + (player.equipped.armor.bonuses.dps || 0);
  assert.ok(expected > 0);
  assert.equal(gearBonus(player, getItem), expected);
  // A tank wearing dps gear gets nothing toward tank rating.
  const mismatched = { role: 'tank', equipped: starterEquipped('dps') };
  assert.equal(gearBonus(mismatched, getItem), 0);
});

test('gearBonus ignores null slots and unknown item ids', () => {
  const player = { role: 'tank', equipped: { weapon: 'itm_does_not_exist', armor: null, trinket: null } };
  assert.equal(gearBonus(player, getItem), 0);
});

test('roleRating = classBase + level*perLevel + gear', () => {
  const player = { role: 'dps', level: 5, equipped: starterEquipped('dps') };
  const expected = config.rating.classBase.dps + 5 * config.rating.perLevel + gearBonus(player, getItem);
  assert.equal(roleRating(player, config, getItem), expected);
});

test('renown adds a capped role-rating bonus (veteran reputation)', () => {
  const base = { role: 'dps', level: 1, equipped: starterEquipped('dps') };
  const r0 = roleRating(base, config, getItem);
  const r10 = roleRating({ ...base, renown: 10 }, config, getItem);
  assert.equal(r10 - r0, 10 * config.rating.renownPerPoint, 'renown scales the bonus');
  const rBig = roleRating({ ...base, renown: 9999 }, config, getItem);
  assert.equal(rBig - r0, config.rating.renownCap * config.rating.renownPerPoint, 'bonus is capped');
});

test('contribution scales role rating by engagement multiplier', () => {
  const player = { role: 'dps', level: 5, subTier: 1, equipped: starterEquipped('dps') };
  const c = contribution(player, config, getItem);
  const expectedRating = roleRating(player, config, getItem);
  assert.equal(c.role, 'dps');
  assert.equal(c.roleRating, expectedRating);
  assert.equal(c.engagementMult, config.engagement.subTier[1]);
  assert.equal(c.contribution, Math.round(expectedRating * config.engagement.subTier[1]));
});
