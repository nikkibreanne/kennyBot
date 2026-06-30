// Item catalog + starter gear + per-season loot (spec §5.2 / §5.5 / §5.6).
// DESIGNED CONTENT for the "okrafans raid game" — original / generic-fantasy
// naming with campy okra/garden/plant flavor. NO Blizzard/WoW-specific names.
//
// Shape matches src/content/items.js EXACTLY: ITEMS is a map of stable item id
// -> { name, slot, rarity, role, bonuses }. The id lives in the KEY (not inside
// the object); itemObject() denormalizes it back in for storage on a player.
//
// A bonus adds to the wearer's roleRating and ONLY the matching role benefits
// (see rules/rating.js#gearBonus). Magnitudes scale by rarity and ramp per
// season tier (S2 ≈ 1.25×, S3 ≈ 1.5×). See items-backlog.md for rationale.
//
// Ids are IMMUTABLE once live (players.equipped / inventory and SEASON_LOOT
// reference them by string).

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
  // ═══════════════════════════════════════════════════════════════════════════
  // STARTER GEAR (season-agnostic, common). New characters roll a RANDOM weapon
  // and a RANDOM armor from these pools (see getStarterEquipped). 4 weapons +
  // 4 armors per role. Trinket slot starts empty. Campy garden-tool flavor.
  // ═══════════════════════════════════════════════════════════════════════════

  // ── Tank starter weapons ──
  itm_starter_tank_weapon_01: { name: 'Dented Garden Hoe', slot: 'weapon', rarity: 'common', role: 'tank', bonuses: { tank: 10 } },
  itm_starter_tank_weapon_02: { name: 'Cast-Iron Skillet', slot: 'weapon', rarity: 'common', role: 'tank', bonuses: { tank: 10 } },
  itm_starter_tank_weapon_03: { name: 'Sturdy Trellis Post', slot: 'weapon', rarity: 'common', role: 'tank', bonuses: { tank: 9 } },
  itm_starter_tank_weapon_04: { name: 'Knotted Okra Stalk', slot: 'weapon', rarity: 'common', role: 'tank', bonuses: { tank: 11 } },
  // ── Tank starter armor ──
  itm_starter_tank_armor_01: { name: 'Patched Gardening Apron', slot: 'armor', rarity: 'common', role: 'tank', bonuses: { tank: 8 } },
  itm_starter_tank_armor_02: { name: 'Quilted Compost Vest', slot: 'armor', rarity: 'common', role: 'tank', bonuses: { tank: 8 } },
  itm_starter_tank_armor_03: { name: 'Bark-Bound Brigandine', slot: 'armor', rarity: 'common', role: 'tank', bonuses: { tank: 9 } },
  itm_starter_tank_armor_04: { name: 'Mud-Caked Coveralls', slot: 'armor', rarity: 'common', role: 'tank', bonuses: { tank: 7 } },

  // ── Healer starter weapons ──
  itm_starter_heal_weapon_01: { name: 'Cracked Watering Can', slot: 'weapon', rarity: 'common', role: 'healer', bonuses: { healer: 10 } },
  itm_starter_heal_weapon_02: { name: 'Wilted Sprig Wand', slot: 'weapon', rarity: 'common', role: 'healer', bonuses: { healer: 10 } },
  itm_starter_heal_weapon_03: { name: 'Chipped Seed Censer', slot: 'weapon', rarity: 'common', role: 'healer', bonuses: { healer: 9 } },
  itm_starter_heal_weapon_04: { name: 'Dewdrop Dowsing Rod', slot: 'weapon', rarity: 'common', role: 'healer', bonuses: { healer: 11 } },
  // ── Healer starter armor ──
  itm_starter_heal_armor_01: { name: 'Frayed Herbalist Robes', slot: 'armor', rarity: 'common', role: 'healer', bonuses: { healer: 8 } },
  itm_starter_heal_armor_02: { name: 'Pollen-Dusted Shawl', slot: 'armor', rarity: 'common', role: 'healer', bonuses: { healer: 8 } },
  itm_starter_heal_armor_03: { name: 'Woven Reed Mantle', slot: 'armor', rarity: 'common', role: 'healer', bonuses: { healer: 9 } },
  itm_starter_heal_armor_04: { name: 'Faded Greenhouse Smock', slot: 'armor', rarity: 'common', role: 'healer', bonuses: { healer: 7 } },

  // ── DPS starter weapons ──
  itm_starter_dps_weapon_01: { name: 'Worn Pruning Shears', slot: 'weapon', rarity: 'common', role: 'dps', bonuses: { dps: 12 } },
  itm_starter_dps_weapon_02: { name: 'Rusty Machete', slot: 'weapon', rarity: 'common', role: 'dps', bonuses: { dps: 12 } },
  itm_starter_dps_weapon_03: { name: 'Splintered Pitchfork', slot: 'weapon', rarity: 'common', role: 'dps', bonuses: { dps: 11 } },
  itm_starter_dps_weapon_04: { name: 'Twangy Garden Slingbow', slot: 'weapon', rarity: 'common', role: 'dps', bonuses: { dps: 12 } },
  // ── DPS starter armor ──
  itm_starter_dps_armor_01: { name: 'Threadbare Field Leathers', slot: 'armor', rarity: 'common', role: 'dps', bonuses: { dps: 7 } },
  itm_starter_dps_armor_02: { name: 'Scuffed Scout Jerkin', slot: 'armor', rarity: 'common', role: 'dps', bonuses: { dps: 7 } },
  itm_starter_dps_armor_03: { name: 'Sun-Bleached Huntsuit', slot: 'armor', rarity: 'common', role: 'dps', bonuses: { dps: 8 } },
  itm_starter_dps_armor_04: { name: 'Burlap Skirmish Wrap', slot: 'armor', rarity: 'common', role: 'dps', bonuses: { dps: 6 } },

  // ═══════════════════════════════════════════════════════════════════════════
  // SEASON 1 — "The Ashen Sprout"  (ember / mire / thorn; ramp ×1.0)
  // 16 drops spanning the full rarity ladder so pickDrop's rarity roll always
  // lands (incl. commons for the 60-weight common tier). Each role gets a
  // weapon, an armor, and a trinket across the season.
  // ═══════════════════════════════════════════════════════════════════════════
  itm_s1_cinder_spade: { name: 'Cinder-Forged Spade', slot: 'weapon', rarity: 'common', role: 'tank', bonuses: { tank: 10 } },
  itm_s1_mire_poultice: { name: 'Mireheart Poultice', slot: 'trinket', rarity: 'common', role: 'healer', bonuses: { healer: 9 } },
  itm_s1_thornnettle_dirk: { name: 'Thornnettle Dirk', slot: 'weapon', rarity: 'common', role: 'dps', bonuses: { dps: 12 } },

  itm_s1_stoneheart_charm: { name: 'Stoneheart Charm', slot: 'trinket', rarity: 'uncommon', role: 'tank', bonuses: { tank: 18 } },
  itm_s1_pollenward_mantle: { name: 'Pollenward Mantle', slot: 'armor', rarity: 'uncommon', role: 'healer', bonuses: { healer: 19 } },
  itm_s1_ember_token: { name: 'Ember Token', slot: 'trinket', rarity: 'uncommon', role: 'dps', bonuses: { dps: 21 } },

  itm_s1_ashbark_aegis: { name: 'Ashbark Aegis', slot: 'armor', rarity: 'rare', role: 'tank', bonuses: { tank: 36 } },
  itm_s1_dewmender_scepter: { name: 'Dewmender Scepter', slot: 'weapon', rarity: 'rare', role: 'healer', bonuses: { healer: 35 } },
  itm_s1_stormcaller_edge: { name: 'Stormcaller Edge', slot: 'weapon', rarity: 'rare', role: 'dps', bonuses: { dps: 39 } },
  itm_s1_blightstalker_hide: { name: 'Blightstalker Hide', slot: 'armor', rarity: 'rare', role: 'dps', bonuses: { dps: 38 } },

  itm_s1_wardens_bastion: { name: "Warden's Bastion", slot: 'armor', rarity: 'epic', role: 'tank', bonuses: { tank: 58 } },
  itm_s1_choirs_lament: { name: "Choir's Lament", slot: 'weapon', rarity: 'epic', role: 'healer', bonuses: { healer: 60 } },
  itm_s1_emberforged_blade: { name: 'Emberforged Blade', slot: 'weapon', rarity: 'epic', role: 'dps', bonuses: { dps: 64 } },
  itm_s1_tyrants_emberseed: { name: "Tyrant's Emberseed", slot: 'trinket', rarity: 'epic', role: 'dps', bonuses: { dps: 62 } },

  itm_s1_final_knell_reaper: { name: 'Reaper of the Final Knell', slot: 'weapon', rarity: 'legendary', role: 'dps', bonuses: { dps: 104 } },
  itm_s1_heart_of_the_grove: { name: 'Heart of the Grove', slot: 'trinket', rarity: 'legendary', role: 'healer', bonuses: { healer: 96 } },

  // ═══════════════════════════════════════════════════════════════════════════
  // SEASON 2 — "The Drowned Bloom"  (tide / brine / storm / glass; ramp ×1.25)
  // ═══════════════════════════════════════════════════════════════════════════
  itm_s2_brineforged_maul: { name: 'Brineforged Maul', slot: 'weapon', rarity: 'common', role: 'tank', bonuses: { tank: 13 } },
  itm_s2_tidewater_locket: { name: 'Tidewater Locket', slot: 'trinket', rarity: 'common', role: 'healer', bonuses: { healer: 12 } },
  itm_s2_frostbite_sickle: { name: 'Frostbite Sickle', slot: 'weapon', rarity: 'common', role: 'dps', bonuses: { dps: 15 } },

  itm_s2_glacial_anchor: { name: 'Glacial Anchor', slot: 'trinket', rarity: 'uncommon', role: 'tank', bonuses: { tank: 23 } },
  itm_s2_seafoam_vestment: { name: 'Seafoam Vestment', slot: 'armor', rarity: 'uncommon', role: 'healer', bonuses: { healer: 24 } },
  itm_s2_stormspark_idol: { name: 'Stormspark Idol', slot: 'trinket', rarity: 'uncommon', role: 'dps', bonuses: { dps: 26 } },

  itm_s2_glassreef_carapace: { name: 'Glassreef Carapace', slot: 'armor', rarity: 'rare', role: 'tank', bonuses: { tank: 45 } },
  itm_s2_coralbloom_wand: { name: 'Coralbloom Wand', slot: 'weapon', rarity: 'rare', role: 'healer', bonuses: { healer: 44 } },
  itm_s2_squallpiercer_bow: { name: 'Squallpiercer Bow', slot: 'weapon', rarity: 'rare', role: 'dps', bonuses: { dps: 49 } },
  itm_s2_riptide_leathers: { name: 'Riptide Leathers', slot: 'armor', rarity: 'rare', role: 'dps', bonuses: { dps: 48 } },

  itm_s2_bulwark_of_the_deep: { name: 'Bulwark of the Deep', slot: 'armor', rarity: 'epic', role: 'tank', bonuses: { tank: 73 } },
  itm_s2_verdigris_crook: { name: 'Verdigris Crook', slot: 'weapon', rarity: 'epic', role: 'healer', bonuses: { healer: 75 } },
  itm_s2_thunderglass_saber: { name: 'Thunderglass Saber', slot: 'weapon', rarity: 'epic', role: 'dps', bonuses: { dps: 80 } },
  itm_s2_maelstrom_seed: { name: 'Maelstrom Seed', slot: 'trinket', rarity: 'epic', role: 'dps', bonuses: { dps: 78 } },

  itm_s2_aegis_of_the_drowned_court: { name: 'Aegis of the Drowned Court', slot: 'armor', rarity: 'legendary', role: 'tank', bonuses: { tank: 120 } },
  itm_s2_leviathans_edge: { name: "Leviathan's Edge", slot: 'weapon', rarity: 'legendary', role: 'dps', bonuses: { dps: 128 } },

  // ═══════════════════════════════════════════════════════════════════════════
  // SEASON 3 — "The Hallowed Harvest"  (astral / gilded / void / okra-finale;
  // ramp ×1.5). Capstone legendary is the campy "Heart of the World-Okra".
  // ═══════════════════════════════════════════════════════════════════════════
  itm_s3_gilded_warscythe: { name: 'Gilded Warscythe', slot: 'weapon', rarity: 'common', role: 'tank', bonuses: { tank: 15 } },
  itm_s3_sunpetal_phylactery: { name: 'Sunpetal Phylactery', slot: 'trinket', rarity: 'common', role: 'healer', bonuses: { healer: 14 } },
  itm_s3_starthistle_kris: { name: 'Starthistle Kris', slot: 'weapon', rarity: 'common', role: 'dps', bonuses: { dps: 17 } },

  itm_s3_astral_ballast: { name: 'Astral Ballast', slot: 'trinket', rarity: 'uncommon', role: 'tank', bonuses: { tank: 28 } },
  itm_s3_moonbloom_raiment: { name: 'Moonbloom Raiment', slot: 'armor', rarity: 'uncommon', role: 'healer', bonuses: { healer: 29 } },
  itm_s3_cometfall_idol: { name: 'Cometfall Idol', slot: 'trinket', rarity: 'uncommon', role: 'dps', bonuses: { dps: 31 } },

  itm_s3_aurora_bulwark: { name: 'Aurora Bulwark', slot: 'armor', rarity: 'rare', role: 'tank', bonuses: { tank: 54 } },
  itm_s3_starlit_crook: { name: 'Starlit Crook', slot: 'weapon', rarity: 'rare', role: 'healer', bonuses: { healer: 53 } },
  itm_s3_voidthorn_glaive: { name: 'Voidthorn Glaive', slot: 'weapon', rarity: 'rare', role: 'dps', bonuses: { dps: 58 } },
  itm_s3_nightharvest_garb: { name: 'Nightharvest Garb', slot: 'armor', rarity: 'rare', role: 'dps', bonuses: { dps: 57 } },

  itm_s3_colossus_of_dawn: { name: 'Colossus-Plate of Dawn', slot: 'armor', rarity: 'epic', role: 'tank', bonuses: { tank: 88 } },
  itm_s3_everbloom_scepter: { name: 'Everbloom Scepter', slot: 'weapon', rarity: 'epic', role: 'healer', bonuses: { healer: 90 } },
  itm_s3_eclipse_edge: { name: 'Eclipse Edge', slot: 'weapon', rarity: 'epic', role: 'dps', bonuses: { dps: 96 } },
  itm_s3_seed_of_the_eternal: { name: 'Seed of the Eternal', slot: 'trinket', rarity: 'epic', role: 'dps', bonuses: { dps: 93 } },

  itm_s3_lifebloom_of_the_first_dawn: { name: 'Lifebloom of the First Dawn', slot: 'weapon', rarity: 'legendary', role: 'healer', bonuses: { healer: 144 } },
  itm_s3_heart_of_the_worldokra: { name: 'Heart of the World-Okra', slot: 'trinket', rarity: 'legendary', role: 'tank', bonuses: { tank: 150 } },
};

// ─────────────────────────────────────────────────────────────────────────────
// STARTER POOLS (role -> [item ids]). New characters roll one weapon + one armor
// at random from their role's pool, for a little starter variety (spec §5.5).
// ─────────────────────────────────────────────────────────────────────────────

/** @type {Record<Role, string[]>} */
export const STARTER_WEAPONS = {
  tank: ['itm_starter_tank_weapon_01', 'itm_starter_tank_weapon_02', 'itm_starter_tank_weapon_03', 'itm_starter_tank_weapon_04'],
  healer: ['itm_starter_heal_weapon_01', 'itm_starter_heal_weapon_02', 'itm_starter_heal_weapon_03', 'itm_starter_heal_weapon_04'],
  dps: ['itm_starter_dps_weapon_01', 'itm_starter_dps_weapon_02', 'itm_starter_dps_weapon_03', 'itm_starter_dps_weapon_04'],
};

/** @type {Record<Role, string[]>} */
export const STARTER_ARMOR = {
  tank: ['itm_starter_tank_armor_01', 'itm_starter_tank_armor_02', 'itm_starter_tank_armor_03', 'itm_starter_tank_armor_04'],
  healer: ['itm_starter_heal_armor_01', 'itm_starter_heal_armor_02', 'itm_starter_heal_armor_03', 'itm_starter_heal_armor_04'],
  dps: ['itm_starter_dps_armor_01', 'itm_starter_dps_armor_02', 'itm_starter_dps_armor_03', 'itm_starter_dps_armor_04'],
};

// ─────────────────────────────────────────────────────────────────────────────
// SEASON LOOT TABLES — one array of item ids per season (index 0 = Season 1).
// Gear RESETS each season; the active season's array is the lootTable passed to
// rules/loot.js#pickDrop. Each table deliberately spans common -> legendary so
// every rarity roll has a match (otherwise the 60-weight common rolls fall back
// to a uniform pick over the whole table and over-drop rares+).
// ─────────────────────────────────────────────────────────────────────────────

/** @type {string[][]} */
export const SEASON_LOOT = [
  // Season 1 — The Ashen Sprout
  [
    'itm_s1_cinder_spade', 'itm_s1_mire_poultice', 'itm_s1_thornnettle_dirk',
    'itm_s1_stoneheart_charm', 'itm_s1_pollenward_mantle', 'itm_s1_ember_token',
    'itm_s1_ashbark_aegis', 'itm_s1_dewmender_scepter', 'itm_s1_stormcaller_edge', 'itm_s1_blightstalker_hide',
    'itm_s1_wardens_bastion', 'itm_s1_choirs_lament', 'itm_s1_emberforged_blade', 'itm_s1_tyrants_emberseed',
    'itm_s1_final_knell_reaper', 'itm_s1_heart_of_the_grove',
  ],
  // Season 2 — The Drowned Bloom
  [
    'itm_s2_brineforged_maul', 'itm_s2_tidewater_locket', 'itm_s2_frostbite_sickle',
    'itm_s2_glacial_anchor', 'itm_s2_seafoam_vestment', 'itm_s2_stormspark_idol',
    'itm_s2_glassreef_carapace', 'itm_s2_coralbloom_wand', 'itm_s2_squallpiercer_bow', 'itm_s2_riptide_leathers',
    'itm_s2_bulwark_of_the_deep', 'itm_s2_verdigris_crook', 'itm_s2_thunderglass_saber', 'itm_s2_maelstrom_seed',
    'itm_s2_aegis_of_the_drowned_court', 'itm_s2_leviathans_edge',
  ],
  // Season 3 — The Hallowed Harvest
  [
    'itm_s3_gilded_warscythe', 'itm_s3_sunpetal_phylactery', 'itm_s3_starthistle_kris',
    'itm_s3_astral_ballast', 'itm_s3_moonbloom_raiment', 'itm_s3_cometfall_idol',
    'itm_s3_aurora_bulwark', 'itm_s3_starlit_crook', 'itm_s3_voidthorn_glaive', 'itm_s3_nightharvest_garb',
    'itm_s3_colossus_of_dawn', 'itm_s3_everbloom_scepter', 'itm_s3_eclipse_edge', 'itm_s3_seed_of_the_eternal',
    'itm_s3_lifebloom_of_the_first_dawn', 'itm_s3_heart_of_the_worldokra',
  ],
];

/**
 * Default drop pool when a season has no explicit lootTable configured. Mirrors
 * the existing items.js export name so this module is a drop-in superset.
 * Defaults to Season 1.
 * @type {string[]}
 */
export const DEFAULT_LOOT_TABLE = SEASON_LOOT[0];

// ─────────────────────────────────────────────────────────────────────────────
// Helpers (parity with src/content/items.js so this is drop-in).
// ─────────────────────────────────────────────────────────────────────────────

/** Look up an item by id, or null. */
export function getItem(itemId) {
  return ITEMS[itemId] ?? null;
}

/**
 * Denormalized item object stored in player.equipped[slot] and signups.equipped.
 * Carries display fields ({name, rarity}) AND the bonuses the engine reads.
 * @param {string} itemId
 * @returns {{ id: string, name: string, slot: Slot, rarity: Rarity, role: Role, bonuses: object }|null}
 */
export function itemObject(itemId) {
  const it = ITEMS[itemId];
  return it ? { id: itemId, ...it } : null;
}

/**
 * Randomized starter gear granted on !create (spec §5.5): one random weapon and
 * one random armor from the role's starter pool, trinket empty. Pass an RNG in
 * [0,1) for deterministic tests (defaults to Math.random).
 * @param {Role} role
 * @param {() => number} [rng]
 * @returns {{ weapon: object, armor: object, trinket: null }}
 */
export function getStarterEquipped(role, rng = Math.random) {
  const weapons = STARTER_WEAPONS[role];
  const armors = STARTER_ARMOR[role];
  if (!weapons || !armors) throw new Error(`unknown role: ${role}`);
  const pick = (arr) => arr[Math.min(arr.length - 1, Math.floor(rng() * arr.length))];
  return { weapon: itemObject(pick(weapons)), armor: itemObject(pick(armors)), trinket: null };
}

/** Deterministic starter set (first item of each pool) — used by unit tests. */
export function starterEquipped(role) {
  if (!STARTER_WEAPONS[role]) throw new Error(`unknown role: ${role}`);
  return { weapon: itemObject(STARTER_WEAPONS[role][0]), armor: itemObject(STARTER_ARMOR[role][0]), trinket: null };
}

/** Alias kept for existing call sites (createPlayer, season rollover). */
export const rollStarterEquipped = getStarterEquipped;
