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

/** Rarity ladder, ascending. Index order is the only thing that defines "better". */
export const RARITY_ORDER = /** @type {Rarity[]} */ (['common', 'uncommon', 'rare', 'epic', 'legendary']);

/**
 * Roll a rarity off a weight table. Defaults to the chat-drop ladder; pass
 * `weights` (e.g. config.loot.bossRarityWeights) for richer raid-reward loot.
 *
 * `minRarity` sets a FLOOR (a big cheer can't roll a common): the ladder is
 * restricted to rarities at or above it and re-rolled on their RELATIVE weights,
 * rather than collapsing everything below onto the floor. So a `rare` floor still
 * reaches epic and legendary in their usual proportions — it just can't fall
 * through. A floor no item can satisfy is ignored rather than failing the roll.
 *
 * @param {() => number} rng
 * @param {{ loot: { rarityWeights: Record<Rarity, number> } }} config
 * @param {Record<Rarity, number>} [weights]
 * @param {Rarity} [minRarity]
 * @returns {Rarity}
 */
export function rollRarity(rng, config, weights, minRarity) {
  const table = weights || config.loot.rarityWeights;
  const floor = RARITY_ORDER.indexOf(/** @type {Rarity} */ (minRarity));
  if (floor > 0) {
    const eligible = Object.fromEntries(
      Object.entries(table).filter(([r, w]) => w > 0 && RARITY_ORDER.indexOf(/** @type {Rarity} */ (r)) >= floor),
    );
    if (Object.keys(eligible).length > 0) return /** @type {Rarity} */ (weightedPick(eligible, rng));
  }
  return /** @type {Rarity} */ (weightedPick(table, rng));
}

/**
 * Choose a concrete item to drop from a season's loot table. Rolls a rarity,
 * then picks uniformly among loot-table items of that rarity; if none match the
 * rolled rarity, falls back to a uniform pick over the whole table so a drop
 * never fails to materialize.
 *
 * `opts.role` narrows the pool to items that BENEFIT that role first. Gear only
 * contributes via `bonuses[player.role]`, so an item for another role is worth
 * exactly 0 to the recipient, forever — dead weight, not a consolation prize.
 * That matters for raid rewards, which land directly in one named hero's bag
 * with no lottery and no choice. Chat drops pass no role on purpose: the winner
 * is not known when the item is picked, it is announced before anyone grabs, and
 * `!trade` / `!offer` can move it afterwards.
 *
 * @param {string[]} lootTable  item ids eligible this season
 * @param {(itemId: string) => ({ rarity: Rarity, bonuses?: Record<string, number> }|null)} getItem
 * @param {() => number} rng
 * @param {object} config
 * @param {Record<string, number>|null} [weights]  rarity weight override (raid rewards)
 * @param {{ role?: string, minRarity?: Rarity }} [opts]
 * @returns {string|null} chosen item id, or null if the table is empty
 */
export function pickDrop(lootTable, getItem, rng, config, weights, opts = {}) {
  let pool = (lootTable || []).filter((id) => getItem(id));
  if (pool.length === 0) return null;

  // Prefer items this role can actually use; keep the whole pool if a season
  // has nothing for them, so a drop never fails to materialize.
  if (opts.role) {
    const usable = pool.filter((id) => typeof getItem(id)?.bonuses?.[opts.role] === 'number');
    if (usable.length > 0) pool = usable;
  }

  const rarity = rollRarity(rng, config, weights, opts.minRarity);
  const ofRarity = pool.filter((id) => getItem(id).rarity === rarity);
  const choices = ofRarity.length > 0 ? ofRarity : pool;
  const idx = Math.floor(rng() * choices.length);
  return choices[Math.min(idx, choices.length - 1)];
}

/**
 * Rarity floor a cheer buys, or undefined below the trigger. Bands are
 * `[minBits, rarity]` ascending; the highest band whose threshold the cheer
 * meets wins. Pure — the caller supplies config.
 * @param {number} bits
 * @param {{ loot: { cheer: { minBits: number, floors: [number, Rarity][] } } }} config
 * @returns {Rarity|undefined}
 */
export function cheerRarityFloor(bits, config) {
  const n = Number(bits) || 0;
  const { minBits, floors } = config.loot.cheer;
  if (n < minBits) return undefined;
  let floor;
  for (const [threshold, rarity] of floors) if (n >= threshold) floor = rarity;
  return floor;
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
