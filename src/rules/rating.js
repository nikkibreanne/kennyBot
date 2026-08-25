// Pure role-rating engine (spec §4). A character's role rating is what it
// contributes to the weekly raid:
//
//   roleRating = classBase[role] + level*perLevel + Σ equipped gear bonus[role]
//   contribution = round(roleRating * engagementMultiplier)
//
// No I/O. The item catalog is passed in so this stays testable with fixtures.

/** @typedef {'tank'|'healer'|'dps'} Role */

/**
 * Engagement multiplier (spec §7). Subs accelerate growth; clamped so no lever
 * (or stack of levers) ever buys a guaranteed win. Bits/channel-point levers are
 * reserved for Phase 5 and contribute 0 here by default (no pay-to-win EXP).
 * @param {{ subTier?: number }} player
 * @param {{ engagement: object }} config
 * @returns {number} multiplier in [base, max]
 */
export function engagementMultiplier(player, config) {
  const e = config.engagement;
  const tier = Math.max(0, Math.floor(player?.subTier || 0));
  const subMult = e.subTier[tier] ?? e.subTier[0] ?? e.base;
  return Math.min(e.max, Math.max(e.base, subMult));
}

/**
 * Sum of equipped gear bonuses that apply to the player's own role. Equipped
 * slots are stored as denormalized item OBJECTS (carrying `bonuses`); a string
 * id is also accepted and resolved via getItem (defensive / back-compat).
 * @param {{ role: Role, equipped?: Record<string, object|string|null> }} player
 * @param {(itemId: string) => ({ bonuses?: Partial<Record<Role,number>> }|null)} [getItem]
 * @returns {number}
 */
export function gearBonus(player, getItem) {
  const equipped = player?.equipped || {};
  let total = 0;
  for (const slot of Object.values(equipped)) {
    if (!slot) continue;
    const item = typeof slot === 'string' ? getItem?.(slot) : slot;
    const bonus = item?.bonuses?.[player.role];
    if (typeof bonus === 'number') total += bonus;
  }
  return total;
}

/**
 * Base + level + gear role rating (before engagement scaling).
 * @param {{ role: Role, level?: number, equipped?: object }} player
 * @param {{ rating: { classBase: Record<Role,number>, perLevel: number } }} config
 * @param {(itemId: string) => any} getItem
 * @returns {number}
 */
export function roleRating(player, config, getItem) {
  const role = player.role;
  const level = Math.max(1, Math.floor(player?.level || 1));
  const base = config.rating.classBase[role] ?? 0;
  const gear = gearBonus(player, getItem);
  return Math.round(
    base + level * config.rating.perLevel + gear + setBonus(player, config, getItem) + renownBonus(player, config),
  );
}

/**
 * MATCHED SET bonus: a reward for the WEAKEST of your three slots, not the
 * strongest.
 *
 * With 25 items per role×slot per season, "biggest number in each slot" is the
 * only goal gear had, and an empty trinket cost nothing but the trinket. This
 * pays a percentage of your gear rating once all three slots are filled, tiered
 * by the LOWEST rarity you're wearing — so the way to improve it is to fix your
 * worst slot. Keying on the lowest (rather than requiring three of a kind) keeps
 * it monotonic: upgrading any single piece can never reduce the bonus, which a
 * strict "all three match" rule would do the moment you found a legendary.
 *
 * @param {{ role: Role, equipped?: object }} player
 * @param {{ rating: { setBonusPct: Record<string, number> } }} config
 * @param {(itemId: string) => any} [getItem]
 * @returns {number} extra role rating, 0 unless all three slots are filled
 */
export function setBonus(player, config, getItem) {
  const pct = config.rating?.setBonusPct;
  if (!pct) return 0;
  const equipped = player?.equipped || {};
  const tiers = [];
  for (const slot of ['weapon', 'armor', 'trinket']) {
    const worn = equipped[slot];
    if (!worn) return 0; // an empty slot breaks the set
    const item = typeof worn === 'string' ? getItem?.(worn) : worn;
    // Only gear that actually works for this hero counts toward their set.
    if (!item || typeof item.bonuses?.[player.role] !== 'number') return 0;
    tiers.push(item.rarity);
  }
  const weakest = tiers.reduce(
    (low, r) => (RARITY_RANK[r] ?? 0) < (RARITY_RANK[low] ?? 0) ? r : low,
    tiers[0],
  );
  const share = pct[weakest] ?? 0;
  return share > 0 ? Math.round(gearBonus(player, getItem) * share) : 0;
}

/** Rarity ordering used to find the weakest equipped piece. */
const RARITY_RANK = { common: 0, uncommon: 1, rare: 2, epic: 3, legendary: 4 };

/** The set tier a hero is currently wearing, or null (for !char display). */
export function setTier(player, getItem) {
  const equipped = player?.equipped || {};
  const tiers = [];
  for (const slot of ['weapon', 'armor', 'trinket']) {
    const worn = equipped[slot];
    if (!worn) return null;
    const item = typeof worn === 'string' ? getItem?.(worn) : worn;
    if (!item || typeof item.bonuses?.[player.role] !== 'number') return null;
    tiers.push(item.rarity);
  }
  return tiers.reduce((low, r) => (RARITY_RANK[r] ?? 0) < (RARITY_RANK[low] ?? 0) ? r : low, tiers[0]);
}

/**
 * Persistent veteran-reputation bonus (spec §5.6). Renown is earned by clearing
 * raids and survives season gear resets, so returning subscribers stay a step
 * ahead. Capped so it's a perk, never dominant.
 * @param {{ renown?: number }} player
 * @param {{ rating: { renownCap: number, renownPerPoint: number } }} config
 */
export function renownBonus(player, config) {
  const r = Math.min(Math.max(0, player?.renown || 0), config.rating.renownCap);
  return r * config.rating.renownPerPoint;
}

/**
 * Raid contribution = role rating scaled by the engagement multiplier (spec §4).
 * @returns {{ role: Role, roleRating: number, engagementMult: number, contribution: number }}
 */
export function contribution(player, config, getItem) {
  const rating = roleRating(player, config, getItem);
  const mult = engagementMultiplier(player, config);
  return {
    role: player.role,
    roleRating: rating,
    engagementMult: mult,
    contribution: Math.round(rating * mult),
  };
}
