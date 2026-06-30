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
 * Roll a rarity off a weight table. Defaults to the chat-drop ladder; pass
 * `weights` (e.g. config.loot.bossRarityWeights) for richer boss-battle loot.
 * @param {() => number} rng
 * @param {{ loot: { rarityWeights: Record<Rarity, number> } }} config
 * @param {Record<Rarity, number>} [weights]
 * @returns {Rarity}
 */
export function rollRarity(rng, config, weights) {
  return /** @type {Rarity} */ (weightedPick(weights || config.loot.rarityWeights, rng));
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
 * @param {Record<string, number>} [weights]  rarity weight override (boss loot)
 * @returns {string|null} chosen item id, or null if the table is empty
 */
export function pickDrop(lootTable, getItem, rng, config, weights) {
  const pool = (lootTable || []).filter((id) => getItem(id));
  if (pool.length === 0) return null;

  const rarity = rollRarity(rng, config, weights);
  const ofRarity = pool.filter((id) => getItem(id).rarity === rarity);
  const choices = ofRarity.length > 0 ? ofRarity : pool;
  const idx = Math.floor(rng() * choices.length);
  return choices[Math.min(idx, choices.length - 1)];
}

/**
 * Draw exactly ONE winner uniformly from a drop's entrants (spec §5.2). The claim
 * window is a LOTTERY, not per-user rolls: everyone who !grabs in the window is
 * entered, then a single winner takes the single item — so a drop never mints
 * duplicates no matter how many people grab. Pure + RNG-injected for testing.
 * @param {Record<string, unknown>} entries  map of entrant userId → entry
 * @param {() => number} rng  in [0,1)
 * @returns {string|null} the winning userId, or null if there were no entrants
 */
export function pickWinner(entries, rng) {
  const ids = Object.keys(entries || {});
  if (ids.length === 0) return null;
  const idx = Math.floor(rng() * ids.length);
  return ids[Math.min(idx, ids.length - 1)];
}
