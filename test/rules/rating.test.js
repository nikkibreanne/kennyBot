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
  assert.equal(engagementMultiplier({ subTier: 0 }, config), 1.0);
  assert.equal(engagementMultiplier({ subTier: 1 }, config), 1.25);
  assert.equal(engagementMultiplier({ subTier: 3 }, config), 1.6);
  // Unknown/huge tier falls back without exceeding the clamp.
  assert.ok(engagementMultiplier({ subTier: 99 }, config) <= config.engagement.max);
});

test('gearBonus only counts bonuses for the player own role', () => {
  const player = { role: 'dps', equipped: starterEquipped('dps') };
  // dps starter weapon(12) + armor(6) = 18
  assert.equal(gearBonus(player, getItem), 18);
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
  // 80 + 5*10 + 18 = 148
  assert.equal(roleRating(player, config, getItem), 148);
});

test('contribution scales role rating by engagement multiplier', () => {
  const player = { role: 'dps', level: 5, subTier: 1, equipped: starterEquipped('dps') };
  const c = contribution(player, config, getItem);
  assert.equal(c.role, 'dps');
  assert.equal(c.roleRating, 148);
  assert.equal(c.engagementMult, 1.25);
  assert.equal(c.contribution, Math.round(148 * 1.25));
});
