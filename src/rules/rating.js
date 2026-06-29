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
  return Math.round(base + level * config.rating.perLevel + gearBonus(player, getItem) + renownBonus(player, config));
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
