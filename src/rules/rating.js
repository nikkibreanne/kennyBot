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
  const raw = base + level * config.rating.perLevel + gear + setBonus(player, config, getItem) + renownBonus(player, config);
  // Prestige MULTIPLIES. It is the permanent reward for having surrendered a
  // character, so it has to scale with everything you rebuild rather than being
  // a flat lump that later levels swamp.
  return Math.round(raw * prestigeMultiplier(player, config));
}

/**
 * Permanent power multiplier from prestige — the half of the prestige trade you
 * keep. `prestige` is only ever granted by a season rollover, which resets level
 * and EXP to 1/0, so this always represents a character actually given up.
 * @param {{ prestige?: number }} player
 * @param {{ rating: { prestigeRatingPct: number, prestigeCap: number } }} config
 * @returns {number} >= 1
 */
export function prestigeMultiplier(player, config) {
  const p = Math.min(Math.max(0, player?.prestige || 0), config.rating.prestigeCap);
  return 1 + p * config.rating.prestigeRatingPct;
}

/**
 * Permanent EXP multiplier from prestige. This is the part that makes a prestige
 * loop worth repeating: each run back up the levels is faster than the last.
 * Without it, resetting is pure loss.
 * @param {{ prestige?: number }} player
 * @param {{ rating: { prestigeExpPct: number, prestigeCap: number } }} config
 * @returns {number} >= 1
 */
export function prestigeExpMultiplier(player, config) {
  const p = Math.min(Math.max(0, player?.prestige || 0), config.rating.prestigeCap);
  return 1 + p * config.rating.prestigeExpPct;
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
 * THIS SEASON's veteran standing. +1 per raid cleared, worth a little rating,
 * and reset at rollover where it is converted into prestige. Deliberately not
 * permanent — permanence is prestige's job, and having two permanent stats is
 * what made renown feel like it did nothing.
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
