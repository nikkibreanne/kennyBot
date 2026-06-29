// Item catalog + starter gear (spec §5.2 / §5.5). Your own data — no external
// dependency. Equipment slots: weapon, armor, trinket (spec §5.2 proposal,
// flagged §13.5). Each item has a slot, rarity, role affinity, and per-role
// stat bonuses that raise the matching role rating when equipped.
//
// Item ids are stable strings ("itm_xxx") referenced by players.equipped /
// inventory and by a season's lootTable. Keep ids immutable once live.

/** @typedef {'weapon'|'armor'|'trinket'} Slot */
/** @typedef {'common'|'uncommon'|'rare'|'epic'|'legendary'} Rarity */
/** @typedef {'tank'|'healer'|'dps'} Role */

export const SLOTS = /** @type {const} */ (['weapon', 'armor', 'trinket']);

/**
 * @type {Record<string, {
 *   name: string, slot: Slot, rarity: Rarity, role: Role,
 *   bonuses: Partial<Record<Role, number>>
 * }>}
 */
export const ITEMS = {
  // ── Starter weapons (common, one per role) ──
  itm_starter_tank_weapon: { name: 'Dented Bulwark', slot: 'weapon', rarity: 'common', role: 'tank', bonuses: { tank: 10 } },
  itm_starter_heal_weapon: { name: 'Cracked Focus', slot: 'weapon', rarity: 'common', role: 'healer', bonuses: { healer: 10 } },
  itm_starter_dps_weapon: { name: 'Worn Blade', slot: 'weapon', rarity: 'common', role: 'dps', bonuses: { dps: 12 } },

  // ── Starter armor (common, one per role) ──
  itm_starter_tank_armor: { name: 'Patched Plate', slot: 'armor', rarity: 'common', role: 'tank', bonuses: { tank: 8 } },
  itm_starter_heal_armor: { name: 'Frayed Vestments', slot: 'armor', rarity: 'common', role: 'healer', bonuses: { healer: 8 } },
  itm_starter_dps_armor: { name: 'Threadbare Leathers', slot: 'armor', rarity: 'common', role: 'dps', bonuses: { dps: 6 } },

  // ── A small drop pool for the live loot loop (rarity drives magnitude) ──
  itm_uncommon_tank_trinket: { name: 'Stoneheart Charm', slot: 'trinket', rarity: 'uncommon', role: 'tank', bonuses: { tank: 18 } },
  itm_uncommon_heal_trinket: { name: 'Verdant Sigil', slot: 'trinket', rarity: 'uncommon', role: 'healer', bonuses: { healer: 18 } },
  itm_uncommon_dps_trinket: { name: 'Ember Token', slot: 'trinket', rarity: 'uncommon', role: 'dps', bonuses: { dps: 20 } },
  itm_rare_dps_weapon: { name: 'Stormcaller Edge', slot: 'weapon', rarity: 'rare', role: 'dps', bonuses: { dps: 38 } },
  itm_rare_tank_armor: { name: 'Aegis of the Vigil', slot: 'armor', rarity: 'rare', role: 'tank', bonuses: { tank: 34 } },
  itm_epic_dps_weapon: { name: 'Emberforged Blade', slot: 'weapon', rarity: 'epic', role: 'dps', bonuses: { dps: 60 } },
  itm_legendary_heal_trinket: { name: 'Heart of the Grove', slot: 'trinket', rarity: 'legendary', role: 'healer', bonuses: { healer: 95 } },
};

/** Default drop pool when a season has no explicit lootTable configured. */
export const DEFAULT_LOOT_TABLE = [
  'itm_uncommon_tank_trinket',
  'itm_uncommon_heal_trinket',
  'itm_uncommon_dps_trinket',
  'itm_rare_dps_weapon',
  'itm_rare_tank_armor',
  'itm_epic_dps_weapon',
  'itm_legendary_heal_trinket',
];

/** Look up an item by id, or null. */
export function getItem(itemId) {
  return ITEMS[itemId] ?? null;
}

/**
 * Denormalized item object stored in player.equipped[slot] and signups.equipped.
 * Carries the display fields the website reads ({name, rarity}) AND the bonuses
 * the engine reads — so neither side needs the catalog at read time.
 * @param {string} itemId
 * @returns {{ id: string, name: string, slot: Slot, rarity: Rarity, role: Role, bonuses: object }|null}
 */
export function itemObject(itemId) {
  const it = ITEMS[itemId];
  return it ? { id: itemId, ...it } : null;
}

/**
 * Starter gear set granted on !create (spec §5.5), as denormalized item objects.
 * @param {Role} role
 * @returns {{ weapon: object, armor: object, trinket: null }}
 */
export function starterEquipped(role) {
  const ids = {
    tank: { weapon: 'itm_starter_tank_weapon', armor: 'itm_starter_tank_armor' },
    healer: { weapon: 'itm_starter_heal_weapon', armor: 'itm_starter_heal_armor' },
    dps: { weapon: 'itm_starter_dps_weapon', armor: 'itm_starter_dps_armor' },
  }[role];
  if (!ids) throw new Error(`unknown role: ${role}`);
  return { weapon: itemObject(ids.weapon), armor: itemObject(ids.armor), trinket: null };
}
