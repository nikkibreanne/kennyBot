// Pure loot engine (spec §5.2). RNG injected so drop selection and the claim
// window are deterministic under test.

/** @typedef {'common'|'uncommon'|'rare'|'epic'|'legendary'} Rarity */

/**
 * Weighted pick of a key from a {key: weight} map.
 * @template T
 * @param {Record<string, number>} weights
 * @param {() => number} rng  in [0,1)
 * @returns {string}
 */
export function weightedPick(weights, rng) {
  const entries = Object.entries(weights).filter(([, w]) => w > 0);
  const total = entries.reduce((s, [, w]) => s + w, 0);
  if (total <= 0) throw new Error('weightedPick: weights sum to 0');
  let roll = rng() * total;
  for (const [key, w] of entries) {
    roll -= w;
    if (roll < 0) return key;
  }
  return entries[entries.length - 1][0]; // FP safety net
}

/**
 * Roll a rarity off the configured ladder.
 * @param {() => number} rng
 * @param {{ loot: { rarityWeights: Record<Rarity, number> } }} config
 * @returns {Rarity}
 */
export function rollRarity(rng, config) {
  return /** @type {Rarity} */ (weightedPick(config.loot.rarityWeights, rng));
}

/**
 * Choose a concrete item to drop from a season's loot table. Rolls a rarity,
 * then picks uniformly among loot-table items of that rarity; if none match the
 * rolled rarity, falls back to a uniform pick over the whole table so a drop
 * never fails to materialize.
 *
 * @param {string[]} lootTable  item ids eligible this season
 * @param {(itemId: string) => ({ rarity: Rarity }|null)} getItem
 * @param {() => number} rng
 * @param {object} config
 * @returns {string|null} chosen item id, or null if the table is empty
 */
export function pickDrop(lootTable, getItem, rng, config) {
  const pool = (lootTable || []).filter((id) => getItem(id));
  if (pool.length === 0) return null;

  const rarity = rollRarity(rng, config);
  const ofRarity = pool.filter((id) => getItem(id).rarity === rarity);
  const choices = ofRarity.length > 0 ? ofRarity : pool;
  const idx = Math.floor(rng() * choices.length);
  return choices[Math.min(idx, choices.length - 1)];
}

/**
 * One claimer's independent roll within the claim window (spec §5.2): not
 * first-to-type. `guaranteed` forces success for a player's very first claim
 * (good first impression, spec §5.5).
 * @param {() => number} rng
 * @param {{ loot: { claimChance: number } }} config
 * @param {{ guaranteed?: boolean }} [opts]
 * @returns {boolean}
 */
export function rollClaim(rng, config, opts = {}) {
  if (opts.guaranteed) return true;
  return rng() < config.loot.claimChance;
}
