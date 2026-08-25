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
const HAND_ITEMS = {
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
//
// These are the ORIGINAL hand-tuned 16 per season. The generated pyramid below
// is appended to them — these ids are already in players' bags and equipped
// slots, so they are never renumbered or removed.
// ─────────────────────────────────────────────────────────────────────────────

/** @type {string[][]} */
const HAND_SEASON_LOOT = [
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

// ═════════════════════════════════════════════════════════════════════════════
// SEASON GEAR PYRAMID
//
// The hand-authored tables above gave each season 16 items TOTAL, which left
// most role×slot pairs with nothing: every season had exactly one tank weapon
// and one dps armor, so a tank's whole six-week weapon progression was "starter
// gear, then the one drop". This block fills each season out to a full pyramid.
//
// Per role × slot, per season:
//     common 9 · uncommon 7 · rare 5 · epic 3 · legendary 1   (= 25)
//   × 3 roles × 3 slots                                       (= 225 a season)
//
// The shape is deliberate: the tiers you roll OFTEN carry the most variety, and
// the top tier is a single trophy. Combined with the rarity weights, a hero sees
// many different commons across a season and at most one legendary.
//
// Authored as a NAME TABLE rather than 600+ object literals: the names are the
// content, while ids and role-rating bonuses follow from them by rule, so the
// balance ladder lives in ONE place instead of being restated 600 times.
//
// IDS ARE DERIVED FROM NAMES (`itm_s<season>_<slug>`) and are the stable
// contract — bags, equipped slots and the site's Compendium all key off them.
// RENAMING AN ITEM CHANGES ITS ID and orphans anything holding it. Add freely;
// rename only with a migration. Tests pin the count and the id derivation.
// ═════════════════════════════════════════════════════════════════════════════

/** Items per rarity, per role × slot, per season. */
export const PYRAMID = Object.freeze({ common: 9, uncommon: 7, rare: 5, epic: 3, legendary: 1 });

/**
 * Season-1 role rating a single item grants, by rarity. Read off the original
 * hand-tuned 48 (common ~10 · uncommon ~19 · rare ~37 · epic ~61 · legendary
 * ~100) so generated gear sits in the same band as the gear beside it.
 */
const RARITY_BASE = Object.freeze({ common: 10, uncommon: 19, rare: 37, epic: 61, legendary: 100 });

/** Power multiplier per season (matches the hand-tuned S2 ≈ 1.25×, S3 ≈ 1.5×). */
const SEASON_POWER = Object.freeze([1.0, 1.25, 1.5]);

/**
 * Spread WITHIN a rarity tier, so nine commons are not nine identical items:
 * a tier fans out ~±4% per step around its base. Finding a better common is
 * then a real (small) upgrade rather than a purely cosmetic one.
 */
const TIER_SPREAD = 0.04;

/**
 * The pyramid as `[name, role, slot, rarity]`, one array per season. Names carry
 * that season's theme, taken from its BOSSES: S1 the first frost and foul weeds,
 * S2 the high-summer blight, S3 the last harvest's rot and untimely frost.
 * @type {[string, 'tank'|'healer'|'dps', 'weapon'|'armor'|'trinket', string][][]}
 */
const SEASON_GEAR = [
  // ══ SEASON 1 — The Proving Bed (first frost & foul weeds) ══
  [
    // tank · weapon
    ['Rust-Bitten Mattock', 'tank', 'weapon', 'common'],
    ['Splintered Fence Maul', 'tank', 'weapon', 'common'],
    ['Chipped Flagstone Cudgel', 'tank', 'weapon', 'common'],
    ['Bent Coldframe Bar', 'tank', 'weapon', 'common'],
    ['Warped Trellis Beam', 'tank', 'weapon', 'common'],
    ['Cracked Millstone Hammer', 'tank', 'weapon', 'common'],
    ['Blunted Turf Spade', 'tank', 'weapon', 'common'],
    ['Frost-Split Fencepost', 'tank', 'weapon', 'common'],
    ['Tempered Loam Mattock', 'tank', 'weapon', 'uncommon'],
    ['Ironbark Cudgel', 'tank', 'weapon', 'uncommon'],
    ['Emberbrand Maul', 'tank', 'weapon', 'uncommon'],
    ['Thistleiron Spade', 'tank', 'weapon', 'uncommon'],
    ['Coldforge Sledge', 'tank', 'weapon', 'uncommon'],
    ['Barkbound Bludgeon', 'tank', 'weapon', 'uncommon'],
    ['Grubcrusher Maul', 'tank', 'weapon', 'uncommon'],
    ['Cinderweight Sledge', 'tank', 'weapon', 'rare'],
    ['Thornsteel Mattock', 'tank', 'weapon', 'rare'],
    ['Rimeplate Warhammer', 'tank', 'weapon', 'rare'],
    ['Mirebreaker Maul', 'tank', 'weapon', 'rare'],
    ['Blightbane Cudgel', 'tank', 'weapon', 'rare'],
    ['Warden\'s Groundbreaker', 'tank', 'weapon', 'epic'],
    ['Emberforged Bulwark-Maul', 'tank', 'weapon', 'epic'],
    ['Hoarfrost Judgement', 'tank', 'weapon', 'epic'],
    ['Anvil of the First Frost', 'tank', 'weapon', 'legendary'],
    // tank · armor
    ['Mud-Crusted Plate', 'tank', 'armor', 'common'],
    ['Patched Burlap Coat', 'tank', 'armor', 'common'],
    ['Splintbark Vest', 'tank', 'armor', 'common'],
    ['Sackcloth Brigandine', 'tank', 'armor', 'common'],
    ['Dented Washtub Cuirass', 'tank', 'armor', 'common'],
    ['Frost-Stiffened Jerkin', 'tank', 'armor', 'common'],
    ['Compost-Stained Hauberk', 'tank', 'armor', 'common'],
    ['Nettle-Woven Guard', 'tank', 'armor', 'common'],
    ['Rough Cordwood Shell', 'tank', 'armor', 'common'],
    ['Ironbark Carapace', 'tank', 'armor', 'uncommon'],
    ['Emberweave Coat', 'tank', 'armor', 'uncommon'],
    ['Thistleplate Girdle', 'tank', 'armor', 'uncommon'],
    ['Loamforged Cuirass', 'tank', 'armor', 'uncommon'],
    ['Rimeguard Hauberk', 'tank', 'armor', 'uncommon'],
    ['Huskshell Brigandine', 'tank', 'armor', 'uncommon'],
    ['Grubhide Bulwark', 'tank', 'armor', 'uncommon'],
    ['Cinderplate Aegis', 'tank', 'armor', 'rare'],
    ['Thornsteel Carapace', 'tank', 'armor', 'rare'],
    ['Mirewrought Bulwark', 'tank', 'armor', 'rare'],
    ['Rimeshell Hauberk', 'tank', 'armor', 'rare'],
    ['Warden\'s Ironroot Plate', 'tank', 'armor', 'epic'],
    ['Scarecrow\'s Tattered Aegis', 'tank', 'armor', 'epic'],
    ['Bastion of the Proving Bed', 'tank', 'armor', 'legendary'],
    // tank · trinket
    ['Chipped Grindstone', 'tank', 'trinket', 'common'],
    ['Knotted Twine Charm', 'tank', 'trinket', 'common'],
    ['River-Smoothed Ballast', 'tank', 'trinket', 'common'],
    ['Cracked Clay Seal', 'tank', 'trinket', 'common'],
    ['Rusted Gate Weight', 'tank', 'trinket', 'common'],
    ['Frostbitten Acorn', 'tank', 'trinket', 'common'],
    ['Split Geode Token', 'tank', 'trinket', 'common'],
    ['Old Fencepost Nail', 'tank', 'trinket', 'common'],
    ['Dry Gourd Rattle', 'tank', 'trinket', 'common'],
    ['Ironbark Knot', 'tank', 'trinket', 'uncommon'],
    ['Emberstone Seal', 'tank', 'trinket', 'uncommon'],
    ['Thistleroot Anchor', 'tank', 'trinket', 'uncommon'],
    ['Loamheart Talisman', 'tank', 'trinket', 'uncommon'],
    ['Rimebound Ballast', 'tank', 'trinket', 'uncommon'],
    ['Huskiron Sigil', 'tank', 'trinket', 'uncommon'],
    ['Cinderheart Stone', 'tank', 'trinket', 'rare'],
    ['Thornsteel Sigil', 'tank', 'trinket', 'rare'],
    ['Mireroot Anchor', 'tank', 'trinket', 'rare'],
    ['Rimeforged Seal', 'tank', 'trinket', 'rare'],
    ['Blightward Totem', 'tank', 'trinket', 'rare'],
    ['Warden\'s Unmoving Stone', 'tank', 'trinket', 'epic'],
    ['Ironroot Heartseal', 'tank', 'trinket', 'epic'],
    ['Hoarfrost Keystone', 'tank', 'trinket', 'epic'],
    ['Keystone of the Unbroken Row', 'tank', 'trinket', 'legendary'],
    // healer · weapon
    ['Chipped Clay Ladle', 'healer', 'weapon', 'common'],
    ['Split Willow Wand', 'healer', 'weapon', 'common'],
    ['Tarnished Dew Bell', 'healer', 'weapon', 'common'],
    ['Frayed Reed Crook', 'healer', 'weapon', 'common'],
    ['Cracked Pollen Censer', 'healer', 'weapon', 'common'],
    ['Bent Copper Sprinkler', 'healer', 'weapon', 'common'],
    ['Knotted Sprig Rod', 'healer', 'weapon', 'common'],
    ['Frost-Dulled Chime', 'healer', 'weapon', 'common'],
    ['Hollow Stem Pipette', 'healer', 'weapon', 'common'],
    ['Ironbark Crook', 'healer', 'weapon', 'uncommon'],
    ['Emberlight Censer', 'healer', 'weapon', 'uncommon'],
    ['Thistledown Wand', 'healer', 'weapon', 'uncommon'],
    ['Loambloom Scepter', 'healer', 'weapon', 'uncommon'],
    ['Rimewater Aspergillum', 'healer', 'weapon', 'uncommon'],
    ['Huskbloom Rod', 'healer', 'weapon', 'uncommon'],
    ['Grubwax Taper', 'healer', 'weapon', 'uncommon'],
    ['Cinderbloom Scepter', 'healer', 'weapon', 'rare'],
    ['Thornmend Crook', 'healer', 'weapon', 'rare'],
    ['Mireblossom Wand', 'healer', 'weapon', 'rare'],
    ['Rimewater Censer', 'healer', 'weapon', 'rare'],
    ['Warden\'s Mending Bough', 'healer', 'weapon', 'epic'],
    ['Hoarfrost Benediction', 'healer', 'weapon', 'epic'],
    ['Bell of the Quiet Bloom', 'healer', 'weapon', 'legendary'],
    // healer · armor
    ['Threadbare Herb Wrap', 'healer', 'armor', 'common'],
    ['Pollen-Dusted Smock', 'healer', 'armor', 'common'],
    ['Frayed Muslin Veil', 'healer', 'armor', 'common'],
    ['Patched Seedcloth Robes', 'healer', 'armor', 'common'],
    ['Damp Moss Mantle', 'healer', 'armor', 'common'],
    ['Frost-Touched Shawl', 'healer', 'armor', 'common'],
    ['Rough Linen Vestment', 'healer', 'armor', 'common'],
    ['Faded Chamomile Wrap', 'healer', 'armor', 'common'],
    ['Stained Apiary Veil', 'healer', 'armor', 'common'],
    ['Ironbark Raiment', 'healer', 'armor', 'uncommon'],
    ['Emberweave Shawl', 'healer', 'armor', 'uncommon'],
    ['Thistledown Mantle', 'healer', 'armor', 'uncommon'],
    ['Loambloom Vestment', 'healer', 'armor', 'uncommon'],
    ['Rimesilk Veil', 'healer', 'armor', 'uncommon'],
    ['Huskweave Robes', 'healer', 'armor', 'uncommon'],
    ['Cinderbloom Raiment', 'healer', 'armor', 'rare'],
    ['Thornmend Vestment', 'healer', 'armor', 'rare'],
    ['Mirebloom Shawl', 'healer', 'armor', 'rare'],
    ['Rimesilk Mantle', 'healer', 'armor', 'rare'],
    ['Blightward Robes', 'healer', 'armor', 'rare'],
    ['Warden\'s Verdant Raiment', 'healer', 'armor', 'epic'],
    ['Hoarfrost Shroud', 'healer', 'armor', 'epic'],
    ['Scarecrow\'s Kindly Wrap', 'healer', 'armor', 'epic'],
    ['Mantle of the First Green', 'healer', 'armor', 'legendary'],
    // healer · trinket
    ['Cracked Dew Phial', 'healer', 'trinket', 'common'],
    ['Wilted Sprig Locket', 'healer', 'trinket', 'common'],
    ['Dry Seed Pouch', 'healer', 'trinket', 'common'],
    ['Chipped Honey Jar', 'healer', 'trinket', 'common'],
    ['Frostbitten Bloom', 'healer', 'trinket', 'common'],
    ['Tarnished Chime', 'healer', 'trinket', 'common'],
    ['Knotted Herb Bundle', 'healer', 'trinket', 'common'],
    ['Hollow Reed Whistle', 'healer', 'trinket', 'common'],
    ['Ironbark Phial', 'healer', 'trinket', 'uncommon'],
    ['Emberdew Locket', 'healer', 'trinket', 'uncommon'],
    ['Thistlebloom Sachet', 'healer', 'trinket', 'uncommon'],
    ['Loamheart Seed', 'healer', 'trinket', 'uncommon'],
    ['Rimedew Vial', 'healer', 'trinket', 'uncommon'],
    ['Huskbloom Charm', 'healer', 'trinket', 'uncommon'],
    ['Grubwax Salve', 'healer', 'trinket', 'uncommon'],
    ['Cinderdew Phial', 'healer', 'trinket', 'rare'],
    ['Thornmend Locket', 'healer', 'trinket', 'rare'],
    ['Mirebloom Sachet', 'healer', 'trinket', 'rare'],
    ['Rimedew Reliquary', 'healer', 'trinket', 'rare'],
    ['Blightward Poultice', 'healer', 'trinket', 'rare'],
    ['Warden\'s Everdew Phial', 'healer', 'trinket', 'epic'],
    ['Hoarfrost Reliquary', 'healer', 'trinket', 'epic'],
    ['Scarecrow\'s Last Kindness', 'healer', 'trinket', 'epic'],
    // dps · weapon
    ['Notched Pruning Shears', 'dps', 'weapon', 'common'],
    ['Rusted Scythe-Blade', 'dps', 'weapon', 'common'],
    ['Chipped Flint Kris', 'dps', 'weapon', 'common'],
    ['Splintered Cane Spear', 'dps', 'weapon', 'common'],
    ['Bent Harvest Sickle', 'dps', 'weapon', 'common'],
    ['Frost-Cracked Dirk', 'dps', 'weapon', 'common'],
    ['Crude Bramble Glaive', 'dps', 'weapon', 'common'],
    ['Warped Yew Bow', 'dps', 'weapon', 'common'],
    ['Ironbark Sickle', 'dps', 'weapon', 'uncommon'],
    ['Emberbrand Dirk', 'dps', 'weapon', 'uncommon'],
    ['Thistlebarb Kris', 'dps', 'weapon', 'uncommon'],
    ['Loamsteel Edge', 'dps', 'weapon', 'uncommon'],
    ['Rimeglass Shiv', 'dps', 'weapon', 'uncommon'],
    ['Huskthorn Glaive', 'dps', 'weapon', 'uncommon'],
    ['Grubfang Bow', 'dps', 'weapon', 'uncommon'],
    ['Cinderfang Sickle', 'dps', 'weapon', 'rare'],
    ['Thornsteel Glaive', 'dps', 'weapon', 'rare'],
    ['Mirestalker Kris', 'dps', 'weapon', 'rare'],
    ['Rimeglass Edge', 'dps', 'weapon', 'rare'],
    ['Warden\'s Culling Edge', 'dps', 'weapon', 'epic'],
    ['Hoarfrost Executioner', 'dps', 'weapon', 'epic'],
    // dps · armor
    ['Scuffed Bramble Hide', 'dps', 'armor', 'common'],
    ['Patched Poacher\'s Leathers', 'dps', 'armor', 'common'],
    ['Frayed Nightshade Garb', 'dps', 'armor', 'common'],
    ['Torn Burlap Shroud', 'dps', 'armor', 'common'],
    ['Dust-Caked Jerkin', 'dps', 'armor', 'common'],
    ['Frost-Rimed Cloak', 'dps', 'armor', 'common'],
    ['Crude Grubskin Wrap', 'dps', 'armor', 'common'],
    ['Stiffened Husk Mail', 'dps', 'armor', 'common'],
    ['Nettle-Scratched Vest', 'dps', 'armor', 'common'],
    ['Ironbark Leathers', 'dps', 'armor', 'uncommon'],
    ['Emberweave Shroud', 'dps', 'armor', 'uncommon'],
    ['Thistlehide Garb', 'dps', 'armor', 'uncommon'],
    ['Loamstalker Jerkin', 'dps', 'armor', 'uncommon'],
    ['Rimeshadow Cloak', 'dps', 'armor', 'uncommon'],
    ['Huskmail Wrap', 'dps', 'armor', 'uncommon'],
    ['Grubskin Leathers', 'dps', 'armor', 'uncommon'],
    ['Cinderstalker Hide', 'dps', 'armor', 'rare'],
    ['Thornshade Leathers', 'dps', 'armor', 'rare'],
    ['Mirecreeper Garb', 'dps', 'armor', 'rare'],
    ['Rimeshadow Shroud', 'dps', 'armor', 'rare'],
    ['Warden\'s Silent Garb', 'dps', 'armor', 'epic'],
    ['Hoarfrost Predator\'s Hide', 'dps', 'armor', 'epic'],
    ['Scarecrow\'s Ragged Shroud', 'dps', 'armor', 'epic'],
    ['Shroud of the Rotten Row', 'dps', 'armor', 'legendary'],
    // dps · trinket
    ['Dull Beetle Carapace', 'dps', 'trinket', 'common'],
    ['Cracked Thorn Talon', 'dps', 'trinket', 'common'],
    ['Dry Husk Seed', 'dps', 'trinket', 'common'],
    ['Chipped Flint Spark', 'dps', 'trinket', 'common'],
    ['Frostbitten Fang', 'dps', 'trinket', 'common'],
    ['Knotted Snare Cord', 'dps', 'trinket', 'common'],
    ['Rusted Trap Spring', 'dps', 'trinket', 'common'],
    ['Hollow Wasp Gall', 'dps', 'trinket', 'common'],
    ['Splintered Quill', 'dps', 'trinket', 'common'],
    ['Ironbark Talon', 'dps', 'trinket', 'uncommon'],
    ['Thistlebarb Fang', 'dps', 'trinket', 'uncommon'],
    ['Loamspark Idol', 'dps', 'trinket', 'uncommon'],
    ['Rimeglass Shard', 'dps', 'trinket', 'uncommon'],
    ['Huskthorn Seed', 'dps', 'trinket', 'uncommon'],
    ['Grubfang Charm', 'dps', 'trinket', 'uncommon'],
    ['Cinderspark Idol', 'dps', 'trinket', 'rare'],
    ['Thornfang Talisman', 'dps', 'trinket', 'rare'],
    ['Mirestalker Fang', 'dps', 'trinket', 'rare'],
    ['Rimeglass Focus', 'dps', 'trinket', 'rare'],
    ['Blightseed Token', 'dps', 'trinket', 'rare'],
    ['Warden\'s Hunting Fang', 'dps', 'trinket', 'epic'],
    ['Hoarfrost Killing Seed', 'dps', 'trinket', 'epic'],
    ['Ember of the Foul Bloom', 'dps', 'trinket', 'legendary'],
  ],
  // ══ SEASON 2 — The Sweltering Patch (high summer blight) ══
  [
    // tank · weapon
    ['Sun-Warped Mattock', 'tank', 'weapon', 'common'],
    ['Dust-Choked Maul', 'tank', 'weapon', 'common'],
    ['Cracked Kiln Hammer', 'tank', 'weapon', 'common'],
    ['Blistered Fencepost', 'tank', 'weapon', 'common'],
    ['Parched Cordwood Cudgel', 'tank', 'weapon', 'common'],
    ['Chaff-Clogged Flail', 'tank', 'weapon', 'common'],
    ['Heat-Bent Turf Spade', 'tank', 'weapon', 'common'],
    ['Split Tasselwood Beam', 'tank', 'weapon', 'common'],
    ['Kilnforged Mattock', 'tank', 'weapon', 'uncommon'],
    ['Bramblebound Cudgel', 'tank', 'weapon', 'uncommon'],
    ['Sunbaked Sledge', 'tank', 'weapon', 'uncommon'],
    ['Cornsilk-Wound Maul', 'tank', 'weapon', 'uncommon'],
    ['Resin-Sealed Bludgeon', 'tank', 'weapon', 'uncommon'],
    ['Beetleplate Hammer', 'tank', 'weapon', 'uncommon'],
    ['Droughtiron Spade', 'tank', 'weapon', 'uncommon'],
    ['Scorchsteel Sledge', 'tank', 'weapon', 'rare'],
    ['Thornwretch Mattock', 'tank', 'weapon', 'rare'],
    ['Cicadabrand Warhammer', 'tank', 'weapon', 'rare'],
    ['Sapforged Maul', 'tank', 'weapon', 'rare'],
    ['Hornworm Crusher', 'tank', 'weapon', 'rare'],
    ['Sunscorch\'s Anvil-Hand', 'tank', 'weapon', 'epic'],
    ['Tassel-Tyrant Groundbreaker', 'tank', 'weapon', 'epic'],
    ['Solstice Judgement', 'tank', 'weapon', 'epic'],
    ['Hammer of the Standing Noon', 'tank', 'weapon', 'legendary'],
    // tank · armor
    ['Dust-Caked Plate', 'tank', 'armor', 'common'],
    ['Sun-Bleached Brigandine', 'tank', 'armor', 'common'],
    ['Cracked Husk Cuirass', 'tank', 'armor', 'common'],
    ['Parched Leather Coat', 'tank', 'armor', 'common'],
    ['Chaff-Stuffed Gambeson', 'tank', 'armor', 'common'],
    ['Blistered Tin Hauberk', 'tank', 'armor', 'common'],
    ['Sweat-Stained Guard', 'tank', 'armor', 'common'],
    ['Kiln-Fired Clay Vest', 'tank', 'armor', 'common'],
    ['Frayed Tarpaulin Shell', 'tank', 'armor', 'common'],
    ['Kilnplate Carapace', 'tank', 'armor', 'uncommon'],
    ['Bramblebound Girdle', 'tank', 'armor', 'uncommon'],
    ['Sunbaked Cuirass', 'tank', 'armor', 'uncommon'],
    ['Cornhusk Brigandine', 'tank', 'armor', 'uncommon'],
    ['Resin-Sealed Hauberk', 'tank', 'armor', 'uncommon'],
    ['Beetleback Carapace', 'tank', 'armor', 'uncommon'],
    ['Droughtiron Coat', 'tank', 'armor', 'uncommon'],
    ['Scorchplate Aegis', 'tank', 'armor', 'rare'],
    ['Thornwretch Carapace', 'tank', 'armor', 'rare'],
    ['Sapwrought Bulwark', 'tank', 'armor', 'rare'],
    ['Ten-Lined Shellguard', 'tank', 'armor', 'rare'],
    ['Sunscorch\'s Blistered Plate', 'tank', 'armor', 'epic'],
    ['Colossus Huskmail', 'tank', 'armor', 'epic'],
    // tank · trinket
    ['Sun-Cracked Grindstone', 'tank', 'trinket', 'common'],
    ['Dry Cistern Weight', 'tank', 'trinket', 'common'],
    ['Chipped Kiln Brick', 'tank', 'trinket', 'common'],
    ['Dusty Ballast Stone', 'tank', 'trinket', 'common'],
    ['Blistered Iron Ring', 'tank', 'trinket', 'common'],
    ['Parched Clay Seal', 'tank', 'trinket', 'common'],
    ['Hollow Cicada Shell', 'tank', 'trinket', 'common'],
    ['Split Sunstone Shard', 'tank', 'trinket', 'common'],
    ['Knotted Cornsilk Cord', 'tank', 'trinket', 'common'],
    ['Kilnstone Seal', 'tank', 'trinket', 'uncommon'],
    ['Bramble-Knot Anchor', 'tank', 'trinket', 'uncommon'],
    ['Sunbaked Sigil', 'tank', 'trinket', 'uncommon'],
    ['Cornheart Talisman', 'tank', 'trinket', 'uncommon'],
    ['Resin-Locked Ballast', 'tank', 'trinket', 'uncommon'],
    ['Beetleshell Totem', 'tank', 'trinket', 'uncommon'],
    ['Scorchheart Stone', 'tank', 'trinket', 'rare'],
    ['Thornwretch Sigil', 'tank', 'trinket', 'rare'],
    ['Saproot Anchor', 'tank', 'trinket', 'rare'],
    ['Cicadastone Seal', 'tank', 'trinket', 'rare'],
    ['Droughtward Totem', 'tank', 'trinket', 'rare'],
    ['Sunscorch\'s Unmoving Ember', 'tank', 'trinket', 'epic'],
    ['Tassel-Tyrant Keystone', 'tank', 'trinket', 'epic'],
    ['Solstice Heartseal', 'tank', 'trinket', 'epic'],
    ['Keystone of the Endless Dry', 'tank', 'trinket', 'legendary'],
    // healer · weapon
    ['Sun-Split Ladle', 'healer', 'weapon', 'common'],
    ['Dry Gourd Dipper', 'healer', 'weapon', 'common'],
    ['Cracked Nectar Censer', 'healer', 'weapon', 'common'],
    ['Warped Cane Crook', 'healer', 'weapon', 'common'],
    ['Dusty Pollen Bell', 'healer', 'weapon', 'common'],
    ['Blistered Copper Sprinkler', 'healer', 'weapon', 'common'],
    ['Parched Reed Rod', 'healer', 'weapon', 'common'],
    ['Hollow Cornstalk Pipe', 'healer', 'weapon', 'common'],
    ['Tarnished Sun Chime', 'healer', 'weapon', 'common'],
    ['Kilnlight Censer', 'healer', 'weapon', 'uncommon'],
    ['Bramblebloom Crook', 'healer', 'weapon', 'uncommon'],
    ['Sunbloom Scepter', 'healer', 'weapon', 'uncommon'],
    ['Cornsilk Wand', 'healer', 'weapon', 'uncommon'],
    ['Resin-Sealed Aspergillum', 'healer', 'weapon', 'uncommon'],
    ['Nectarwarm Rod', 'healer', 'weapon', 'uncommon'],
    ['Cicadasong Chime', 'healer', 'weapon', 'uncommon'],
    ['Scorchbloom Scepter', 'healer', 'weapon', 'rare'],
    ['Thornwretch Crook', 'healer', 'weapon', 'rare'],
    ['Sapmender Wand', 'healer', 'weapon', 'rare'],
    ['Solstice Censer', 'healer', 'weapon', 'rare'],
    ['Sunscorch\'s Mercy', 'healer', 'weapon', 'epic'],
    ['Broodmother Benediction', 'healer', 'weapon', 'epic'],
    ['Chime of the Long Noon', 'healer', 'weapon', 'legendary'],
    // healer · armor
    ['Sun-Bleached Smock', 'healer', 'armor', 'common'],
    ['Dust-Grimed Veil', 'healer', 'armor', 'common'],
    ['Frayed Shade Wrap', 'healer', 'armor', 'common'],
    ['Parched Muslin Robes', 'healer', 'armor', 'common'],
    ['Sweat-Stained Vestment', 'healer', 'armor', 'common'],
    ['Cracked Resin Mantle', 'healer', 'armor', 'common'],
    ['Rough Cornsilk Shawl', 'healer', 'armor', 'common'],
    ['Faded Nectar Wrap', 'healer', 'armor', 'common'],
    ['Threadbare Awning Cloak', 'healer', 'armor', 'common'],
    ['Kilnweave Raiment', 'healer', 'armor', 'uncommon'],
    ['Bramblebloom Shawl', 'healer', 'armor', 'uncommon'],
    ['Sunshade Mantle', 'healer', 'armor', 'uncommon'],
    ['Cornsilk Vestment', 'healer', 'armor', 'uncommon'],
    ['Resinweave Veil', 'healer', 'armor', 'uncommon'],
    ['Nectarbloom Robes', 'healer', 'armor', 'uncommon'],
    ['Scorchbloom Raiment', 'healer', 'armor', 'rare'],
    ['Thornwretch Vestment', 'healer', 'armor', 'rare'],
    ['Sapbloom Shawl', 'healer', 'armor', 'rare'],
    ['Cicadasilk Mantle', 'healer', 'armor', 'rare'],
    ['Droughtward Robes', 'healer', 'armor', 'rare'],
    ['Sunscorch\'s Kindly Shade', 'healer', 'armor', 'epic'],
    ['Broodmother Shroud', 'healer', 'armor', 'epic'],
    ['Tassel-Tyrant Raiment', 'healer', 'armor', 'epic'],
    ['Shade of the Sweltering Patch', 'healer', 'armor', 'legendary'],
    // healer · trinket
    ['Cracked Nectar Phial', 'healer', 'trinket', 'common'],
    ['Dry Sunflower Locket', 'healer', 'trinket', 'common'],
    ['Dusty Seed Pouch', 'healer', 'trinket', 'common'],
    ['Chipped Resin Jar', 'healer', 'trinket', 'common'],
    ['Sun-Wilted Bloom', 'healer', 'trinket', 'common'],
    ['Hollow Cicada Whistle', 'healer', 'trinket', 'common'],
    ['Knotted Cornsilk Bundle', 'healer', 'trinket', 'common'],
    ['Tarnished Dew Vial', 'healer', 'trinket', 'common'],
    ['Kilnfired Phial', 'healer', 'trinket', 'uncommon'],
    ['Bramblebloom Sachet', 'healer', 'trinket', 'uncommon'],
    ['Sundew Locket', 'healer', 'trinket', 'uncommon'],
    ['Cornheart Seed', 'healer', 'trinket', 'uncommon'],
    ['Resin-Sealed Vial', 'healer', 'trinket', 'uncommon'],
    ['Nectarwarm Charm', 'healer', 'trinket', 'uncommon'],
    ['Cicadashell Salve', 'healer', 'trinket', 'uncommon'],
    ['Scorchdew Phial', 'healer', 'trinket', 'rare'],
    ['Thornwretch Locket', 'healer', 'trinket', 'rare'],
    ['Sapbloom Sachet', 'healer', 'trinket', 'rare'],
    ['Solstice Reliquary', 'healer', 'trinket', 'rare'],
    ['Droughtward Poultice', 'healer', 'trinket', 'rare'],
    ['Sunscorch\'s Everdew', 'healer', 'trinket', 'epic'],
    ['Broodmother Reliquary', 'healer', 'trinket', 'epic'],
    ['Venus Nectar-Heart', 'healer', 'trinket', 'epic'],
    ['Heart of the High Summer', 'healer', 'trinket', 'legendary'],
    // dps · weapon
    ['Sun-Notched Shears', 'dps', 'weapon', 'common'],
    ['Dust-Dulled Sickle', 'dps', 'weapon', 'common'],
    ['Cracked Flint Kris', 'dps', 'weapon', 'common'],
    ['Warped Cane Spear', 'dps', 'weapon', 'common'],
    ['Blistered Pruning Blade', 'dps', 'weapon', 'common'],
    ['Parched Yew Bow', 'dps', 'weapon', 'common'],
    ['Chaff-Clogged Glaive', 'dps', 'weapon', 'common'],
    ['Heat-Bent Dirk', 'dps', 'weapon', 'common'],
    ['Kilnbrand Sickle', 'dps', 'weapon', 'uncommon'],
    ['Bramblebarb Kris', 'dps', 'weapon', 'uncommon'],
    ['Sunfang Dirk', 'dps', 'weapon', 'uncommon'],
    ['Cornsilk-Wound Edge', 'dps', 'weapon', 'uncommon'],
    ['Resin-Slick Shiv', 'dps', 'weapon', 'uncommon'],
    ['Beetlefang Glaive', 'dps', 'weapon', 'uncommon'],
    ['Cicadawing Bow', 'dps', 'weapon', 'uncommon'],
    ['Scorchfang Sickle', 'dps', 'weapon', 'rare'],
    ['Thornwretch Glaive', 'dps', 'weapon', 'rare'],
    ['Sapstalker Kris', 'dps', 'weapon', 'rare'],
    ['Hornworm Ripper', 'dps', 'weapon', 'rare'],
    ['Sunscorch\'s Culling Blaze', 'dps', 'weapon', 'epic'],
    ['Snaptrap Executioner', 'dps', 'weapon', 'epic'],
    // dps · armor
    ['Sun-Faded Hide', 'dps', 'armor', 'common'],
    ['Dust-Caked Leathers', 'dps', 'armor', 'common'],
    ['Frayed Bramble Garb', 'dps', 'armor', 'common'],
    ['Torn Awning Shroud', 'dps', 'armor', 'common'],
    ['Blistered Poacher’s Jerkin', 'dps', 'armor', 'common'],
    ['Parched Snakeskin Wrap', 'dps', 'armor', 'common'],
    ['Crude Beetleshell Vest', 'dps', 'armor', 'common'],
    ['Stiffened Cornhusk Mail', 'dps', 'armor', 'common'],
    ['Chaff-Strewn Cloak', 'dps', 'armor', 'common'],
    ['Kilnweave Leathers', 'dps', 'armor', 'uncommon'],
    ['Bramblehide Garb', 'dps', 'armor', 'uncommon'],
    ['Sunstalker Jerkin', 'dps', 'armor', 'uncommon'],
    ['Cornhusk Shroud', 'dps', 'armor', 'uncommon'],
    ['Resin-Slick Wrap', 'dps', 'armor', 'uncommon'],
    ['Beetleshell Leathers', 'dps', 'armor', 'uncommon'],
    ['Cicadawing Cloak', 'dps', 'armor', 'uncommon'],
    ['Scorchstalker Hide', 'dps', 'armor', 'rare'],
    ['Thornwretch Leathers', 'dps', 'armor', 'rare'],
    ['Sapcreeper Garb', 'dps', 'armor', 'rare'],
    ['Ten-Lined Carapace', 'dps', 'armor', 'rare'],
    ['Sunscorch\'s Silent Ash', 'dps', 'armor', 'epic'],
    ['Broodmother Chitin', 'dps', 'armor', 'epic'],
    ['Snaptrap Shroud', 'dps', 'armor', 'epic'],
    ['Hide of the Ten-Lined Horde', 'dps', 'armor', 'legendary'],
    // dps · trinket
    ['Dull Beetle Wing', 'dps', 'trinket', 'common'],
    ['Cracked Bramble Talon', 'dps', 'trinket', 'common'],
    ['Dry Cornsilk Tuft', 'dps', 'trinket', 'common'],
    ['Chipped Sunstone Spark', 'dps', 'trinket', 'common'],
    ['Sun-Wilted Fang', 'dps', 'trinket', 'common'],
    ['Knotted Snare Wire', 'dps', 'trinket', 'common'],
    ['Sun-Seized Trap Spring', 'dps', 'trinket', 'common'],
    ['Hollow Hornworm Casing', 'dps', 'trinket', 'common'],
    ['Splintered Cicada Quill', 'dps', 'trinket', 'common'],
    ['Kilnspark Idol', 'dps', 'trinket', 'uncommon'],
    ['Bramblebarb Fang', 'dps', 'trinket', 'uncommon'],
    ['Sunspark Token', 'dps', 'trinket', 'uncommon'],
    ['Cornheart Charm', 'dps', 'trinket', 'uncommon'],
    ['Resin-Locked Shard', 'dps', 'trinket', 'uncommon'],
    ['Beetlefang Talisman', 'dps', 'trinket', 'uncommon'],
    ['Scorchspark Idol', 'dps', 'trinket', 'rare'],
    ['Thornwretch Talisman', 'dps', 'trinket', 'rare'],
    ['Sapstalker Fang', 'dps', 'trinket', 'rare'],
    ['Cicadaglass Focus', 'dps', 'trinket', 'rare'],
    ['Droughtseed Token', 'dps', 'trinket', 'rare'],
    ['Sunscorch\'s Killing Ember', 'dps', 'trinket', 'epic'],
    ['Broodmother Eggseed', 'dps', 'trinket', 'epic'],
    ['Ember of the Tassel Crown', 'dps', 'trinket', 'legendary'],
  ],
  // ══ SEASON 3 — The Last Harvest (rot & untimely frost) ══
  [
    // tank · weapon
    ['Rot-Pitted Mattock', 'tank', 'weapon', 'common'],
    ['Hollow Gourd Maul', 'tank', 'weapon', 'common'],
    ['Cracked Grave-Marker', 'tank', 'weapon', 'common'],
    ['Tattered Flail', 'tank', 'weapon', 'common'],
    ['Mulch-Clogged Sledge', 'tank', 'weapon', 'common'],
    ['Frost-Split Threshing Bar', 'tank', 'weapon', 'common'],
    ['Worm-Bored Cudgel', 'tank', 'weapon', 'common'],
    ['Dulled Sheaf Hammer', 'tank', 'weapon', 'common'],
    ['Mulchforged Mattock', 'tank', 'weapon', 'uncommon'],
    ['Gourdplate Cudgel', 'tank', 'weapon', 'uncommon'],
    ['Wormwood Sledge', 'tank', 'weapon', 'uncommon'],
    ['Tatterbound Maul', 'tank', 'weapon', 'uncommon'],
    ['Sheafiron Spade', 'tank', 'weapon', 'uncommon'],
    ['Duskforged Bludgeon', 'tank', 'weapon', 'uncommon'],
    ['Lanternlight Hammer', 'tank', 'weapon', 'uncommon'],
    ['Graveweight Sledge', 'tank', 'weapon', 'rare'],
    ['Hollowbone Mattock', 'tank', 'weapon', 'rare'],
    ['Wormwood Warhammer', 'tank', 'weapon', 'rare'],
    ['Reaper’s Groundbreaker', 'tank', 'weapon', 'rare'],
    ['Hoarfrost Threshing Maul', 'tank', 'weapon', 'rare'],
    ['Gourdfather\'s Hollow Fist', 'tank', 'weapon', 'epic'],
    ['Tatterking\'s Rusted Sceptre', 'tank', 'weapon', 'epic'],
    ['Requiem Judgement', 'tank', 'weapon', 'epic'],
    ['Anvil of the Last Furrow', 'tank', 'weapon', 'legendary'],
    // tank · armor
    ['Rot-Streaked Plate', 'tank', 'armor', 'common'],
    ['Hollow Gourd Cuirass', 'tank', 'armor', 'common'],
    ['Tattered Scarecrow Coat', 'tank', 'armor', 'common'],
    ['Mulch-Caked Brigandine', 'tank', 'armor', 'common'],
    ['Chaff-Stuffed Hauberk', 'tank', 'armor', 'common'],
    ['Frost-Rimed Guard', 'tank', 'armor', 'common'],
    ['Worm-Bored Shell', 'tank', 'armor', 'common'],
    ['Grave-Soil Gambeson', 'tank', 'armor', 'common'],
    ['Split Sheafwood Vest', 'tank', 'armor', 'common'],
    ['Mulchplate Carapace', 'tank', 'armor', 'uncommon'],
    ['Gourdshell Girdle', 'tank', 'armor', 'uncommon'],
    ['Wormwood Cuirass', 'tank', 'armor', 'uncommon'],
    ['Tatterweave Brigandine', 'tank', 'armor', 'uncommon'],
    ['Sheafiron Hauberk', 'tank', 'armor', 'uncommon'],
    ['Duskplate Coat', 'tank', 'armor', 'uncommon'],
    ['Lanternward Carapace', 'tank', 'armor', 'uncommon'],
    ['Gravewrought Aegis', 'tank', 'armor', 'rare'],
    ['Hollowbone Carapace', 'tank', 'armor', 'rare'],
    ['Wormwood Bulwark', 'tank', 'armor', 'rare'],
    ['Hoarfrost Shellguard', 'tank', 'armor', 'rare'],
    ['Gourdfather\'s Hollow Aegis', 'tank', 'armor', 'epic'],
    ['Tatterking\'s Ragged Plate', 'tank', 'armor', 'epic'],
    ['Bastion of the Verdant Majesty', 'tank', 'armor', 'legendary'],
    // tank · trinket
    ['Cracked Grave Weight', 'tank', 'trinket', 'common'],
    ['Hollow Gourd Rattle', 'tank', 'trinket', 'common'],
    ['Rot-Blackened Seal', 'tank', 'trinket', 'common'],
    ['Tattered Binding Cord', 'tank', 'trinket', 'common'],
    ['Mulch-Packed Ballast', 'tank', 'trinket', 'common'],
    ['Frostbitten Root-Knot', 'tank', 'trinket', 'common'],
    ['Worm-Bored Stone', 'tank', 'trinket', 'common'],
    ['Dry Sheaf Token', 'tank', 'trinket', 'common'],
    ['Chipped Lantern Glass', 'tank', 'trinket', 'common'],
    ['Mulchstone Seal', 'tank', 'trinket', 'uncommon'],
    ['Gourdheart Anchor', 'tank', 'trinket', 'uncommon'],
    ['Wormwood Sigil', 'tank', 'trinket', 'uncommon'],
    ['Tatterknot Talisman', 'tank', 'trinket', 'uncommon'],
    ['Sheafbound Ballast', 'tank', 'trinket', 'uncommon'],
    ['Duskstone Totem', 'tank', 'trinket', 'uncommon'],
    ['Graveroot Anchor', 'tank', 'trinket', 'rare'],
    ['Hollowheart Stone', 'tank', 'trinket', 'rare'],
    ['Wormwood Keystone', 'tank', 'trinket', 'rare'],
    ['Reaper’s Seal', 'tank', 'trinket', 'rare'],
    ['Hoarfrost Ballast', 'tank', 'trinket', 'rare'],
    ['Gourdfather\'s Hollow Heart', 'tank', 'trinket', 'epic'],
    ['Tatterking\'s Crown-Nail', 'tank', 'trinket', 'epic'],
    ['Requiem Heartseal', 'tank', 'trinket', 'epic'],
    // healer · weapon
    ['Cracked Grave Censer', 'healer', 'weapon', 'common'],
    ['Hollow Gourd Dipper', 'healer', 'weapon', 'common'],
    ['Tattered Prayer Bell', 'healer', 'weapon', 'common'],
    ['Rot-Dulled Ladle', 'healer', 'weapon', 'common'],
    ['Mulch-Stained Crook', 'healer', 'weapon', 'common'],
    ['Frost-Cracked Chime', 'healer', 'weapon', 'common'],
    ['Worm-Bored Reed Rod', 'healer', 'weapon', 'common'],
    ['Dry Sheaf Aspergillum', 'healer', 'weapon', 'common'],
    ['Guttered Lantern Wand', 'healer', 'weapon', 'common'],
    ['Mulchbloom Crook', 'healer', 'weapon', 'uncommon'],
    ['Gourdlight Censer', 'healer', 'weapon', 'uncommon'],
    ['Wormwood Wand', 'healer', 'weapon', 'uncommon'],
    ['Tatterweave Scepter', 'healer', 'weapon', 'uncommon'],
    ['Sheafbloom Rod', 'healer', 'weapon', 'uncommon'],
    ['Dusklight Chime', 'healer', 'weapon', 'uncommon'],
    ['Lanternbearer’s Crook', 'healer', 'weapon', 'uncommon'],
    ['Gravebloom Scepter', 'healer', 'weapon', 'rare'],
    ['Hollowlight Crook', 'healer', 'weapon', 'rare'],
    ['Wormwood Censer', 'healer', 'weapon', 'rare'],
    ['Hoarfrost Aspergillum', 'healer', 'weapon', 'rare'],
    ['Gourdfather\'s Quiet Lantern', 'healer', 'weapon', 'epic'],
    ['Wormwood Choir-Bell', 'healer', 'weapon', 'epic'],
    // healer · armor
    ['Rot-Stained Smock', 'healer', 'armor', 'common'],
    ['Hollow Gourd Veil', 'healer', 'armor', 'common'],
    ['Tattered Shroud-Wrap', 'healer', 'armor', 'common'],
    ['Mulch-Grimed Robes', 'healer', 'armor', 'common'],
    ['Chaff-Dusted Vestment', 'healer', 'armor', 'common'],
    ['Frostbitten Shawl', 'healer', 'armor', 'common'],
    ['Worm-Bored Mantle', 'healer', 'armor', 'common'],
    ['Dry Sheaf Cloak', 'healer', 'armor', 'common'],
    ['Guttered Lantern Wrap', 'healer', 'armor', 'common'],
    ['Mulchweave Raiment', 'healer', 'armor', 'uncommon'],
    ['Gourdsilk Shawl', 'healer', 'armor', 'uncommon'],
    ['Wormwood Vestment', 'healer', 'armor', 'uncommon'],
    ['Tatterweave Veil', 'healer', 'armor', 'uncommon'],
    ['Sheafbloom Mantle', 'healer', 'armor', 'uncommon'],
    ['Duskweave Robes', 'healer', 'armor', 'uncommon'],
    ['Gravebloom Raiment', 'healer', 'armor', 'rare'],
    ['Hollowsilk Vestment', 'healer', 'armor', 'rare'],
    ['Wormwood Shawl', 'healer', 'armor', 'rare'],
    ['Reaper’s Mantle', 'healer', 'armor', 'rare'],
    ['Hoarfrost Veil', 'healer', 'armor', 'rare'],
    ['Gourdfather\'s Kindly Hollow', 'healer', 'armor', 'epic'],
    ['Wormwood Choir-Robes', 'healer', 'armor', 'epic'],
    ['Tatterking\'s Mercy', 'healer', 'armor', 'epic'],
    ['Raiment of the Okra Eternal', 'healer', 'armor', 'legendary'],
    // healer · trinket
    ['Cracked Grave Phial', 'healer', 'trinket', 'common'],
    ['Hollow Gourd Seed', 'healer', 'trinket', 'common'],
    ['Tattered Herb Bundle', 'healer', 'trinket', 'common'],
    ['Rot-Blackened Locket', 'healer', 'trinket', 'common'],
    ['Mulch-Packed Pouch', 'healer', 'trinket', 'common'],
    ['Frostbitten Blossom', 'healer', 'trinket', 'common'],
    ['Worm-Bored Vial', 'healer', 'trinket', 'common'],
    ['Guttered Lantern Ember', 'healer', 'trinket', 'common'],
    ['Mulchheart Phial', 'healer', 'trinket', 'uncommon'],
    ['Gourdbloom Sachet', 'healer', 'trinket', 'uncommon'],
    ['Wormwood Vial', 'healer', 'trinket', 'uncommon'],
    ['Tatterknot Charm', 'healer', 'trinket', 'uncommon'],
    ['Sheafbloom Seed', 'healer', 'trinket', 'uncommon'],
    ['Dusklight Locket', 'healer', 'trinket', 'uncommon'],
    ['Lanternwarm Salve', 'healer', 'trinket', 'uncommon'],
    ['Gravebloom Phial', 'healer', 'trinket', 'rare'],
    ['Hollowheart Locket', 'healer', 'trinket', 'rare'],
    ['Wormwood Reliquary', 'healer', 'trinket', 'rare'],
    ['Reaper’s Poultice', 'healer', 'trinket', 'rare'],
    ['Hoarfrost Sachet', 'healer', 'trinket', 'rare'],
    ['Gourdfather\'s Everdew', 'healer', 'trinket', 'epic'],
    ['Wormwood Choir-Reliquary', 'healer', 'trinket', 'epic'],
    ['Requiem Blossom', 'healer', 'trinket', 'epic'],
    ['Seed of the Verdant Majesty', 'healer', 'trinket', 'legendary'],
    // dps · weapon
    ['Rust-Eaten Scythe', 'dps', 'weapon', 'common'],
    ['Hollow Gourd Shears', 'dps', 'weapon', 'common'],
    ['Tattered Reaping Hook', 'dps', 'weapon', 'common'],
    ['Chipped Grave Kris', 'dps', 'weapon', 'common'],
    ['Mulch-Dulled Sickle', 'dps', 'weapon', 'common'],
    ['Frost-Cracked Glaive', 'dps', 'weapon', 'common'],
    ['Worm-Bored Yew Bow', 'dps', 'weapon', 'common'],
    ['Splintered Sheaf Spear', 'dps', 'weapon', 'common'],
    ['Mulchbrand Sickle', 'dps', 'weapon', 'uncommon'],
    ['Gourdfang Kris', 'dps', 'weapon', 'uncommon'],
    ['Wormwood Glaive', 'dps', 'weapon', 'uncommon'],
    ['Tatterbarb Edge', 'dps', 'weapon', 'uncommon'],
    ['Sheafsteel Scythe', 'dps', 'weapon', 'uncommon'],
    ['Duskfang Shiv', 'dps', 'weapon', 'uncommon'],
    ['Lanternglass Bow', 'dps', 'weapon', 'uncommon'],
    ['Gravefang Scythe', 'dps', 'weapon', 'rare'],
    ['Hollowbone Glaive', 'dps', 'weapon', 'rare'],
    ['Wormwood Kris', 'dps', 'weapon', 'rare'],
    ['Hoarfrost Ripper', 'dps', 'weapon', 'rare'],
    ['Gourdfather\'s Hollow Edge', 'dps', 'weapon', 'epic'],
    ['Tatterking\'s Culling Hook', 'dps', 'weapon', 'epic'],
    ['Scythe of the Final Sheaf', 'dps', 'weapon', 'legendary'],
    // dps · armor
    ['Rot-Streaked Hide', 'dps', 'armor', 'common'],
    ['Hollow Gourd Vest', 'dps', 'armor', 'common'],
    ['Tattered Poacher’s Garb', 'dps', 'armor', 'common'],
    ['Mulch-Caked Leathers', 'dps', 'armor', 'common'],
    ['Chaff-Strewn Shroud', 'dps', 'armor', 'common'],
    ['Frost-Gnawed Cloak', 'dps', 'armor', 'common'],
    ['Worm-Bored Jerkin', 'dps', 'armor', 'common'],
    ['Dry Sheaf Wrap', 'dps', 'armor', 'common'],
    ['Guttered Lantern Mail', 'dps', 'armor', 'common'],
    ['Mulchweave Leathers', 'dps', 'armor', 'uncommon'],
    ['Gourdshell Garb', 'dps', 'armor', 'uncommon'],
    ['Wormwood Jerkin', 'dps', 'armor', 'uncommon'],
    ['Tatterweave Shroud', 'dps', 'armor', 'uncommon'],
    ['Sheafhide Wrap', 'dps', 'armor', 'uncommon'],
    ['Duskstalker Cloak', 'dps', 'armor', 'uncommon'],
    ['Lanternshade Leathers', 'dps', 'armor', 'uncommon'],
    ['Gravestalker Hide', 'dps', 'armor', 'rare'],
    ['Hollowbone Leathers', 'dps', 'armor', 'rare'],
    ['Wormwood Garb', 'dps', 'armor', 'rare'],
    ['Hoarfrost Cerement', 'dps', 'armor', 'rare'],
    ['Gourdfather\'s Silent Hollow', 'dps', 'armor', 'epic'],
    ['Tatterking\'s Ragged Shade', 'dps', 'armor', 'epic'],
    ['Requiem Chitin', 'dps', 'armor', 'epic'],
    ['Shroud of the Wormwood Choir', 'dps', 'armor', 'legendary'],
    // dps · trinket
    ['Dull Grave Talon', 'dps', 'trinket', 'common'],
    ['Hollow Gourd Seed-Rattle', 'dps', 'trinket', 'common'],
    ['Tattered Snare Cord', 'dps', 'trinket', 'common'],
    ['Cracked Reaping Fang', 'dps', 'trinket', 'common'],
    ['Mulch-Packed Spark', 'dps', 'trinket', 'common'],
    ['Frostbitten Thorn', 'dps', 'trinket', 'common'],
    ['Worm-Bored Quill', 'dps', 'trinket', 'common'],
    ['Chaff-Bound Token', 'dps', 'trinket', 'common'],
    ['Guttered Lantern Shard', 'dps', 'trinket', 'common'],
    ['Mulchspark Idol', 'dps', 'trinket', 'uncommon'],
    ['Gourdfang Charm', 'dps', 'trinket', 'uncommon'],
    ['Wormwood Talon', 'dps', 'trinket', 'uncommon'],
    ['Tatterbarb Fang', 'dps', 'trinket', 'uncommon'],
    ['Sheafseed Rattle', 'dps', 'trinket', 'uncommon'],
    ['Duskglass Shard', 'dps', 'trinket', 'uncommon'],
    ['Gravespark Idol', 'dps', 'trinket', 'rare'],
    ['Hollowheart Fang', 'dps', 'trinket', 'rare'],
    ['Wormwood Focus', 'dps', 'trinket', 'rare'],
    ['Reaper’s Talisman', 'dps', 'trinket', 'rare'],
    ['Hoarfrost Reaping Seed', 'dps', 'trinket', 'rare'],
    ['Gourdfather\'s Hollow Ember', 'dps', 'trinket', 'epic'],
    ['Tatterking\'s Last Nail', 'dps', 'trinket', 'epic'],
    ['Knell of the Untimely Frost', 'dps', 'trinket', 'legendary'],
  ],
];

/** `"Warden's Groundbreaker"` → `wardens_groundbreaker` (id-safe, ASCII). */
function slugify(name) {
  return String(name)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['‘’]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * Expand the name table into full item records. Bonus = the rarity's base for
 * that season, fanned across its tier by TIER_SPREAD, floored at 1.
 * @returns {{ items: Record<string, object>, bySeason: string[][] }}
 */
function buildSeasonGear() {
  const items = {};
  const bySeason = SEASON_GEAR.map(() => []);

  SEASON_GEAR.forEach((rows, seasonIdx) => {
    const power = SEASON_POWER[seasonIdx] ?? 1;
    // Group by role+slot+rarity so a tier's spread is computed over its own members.
    const tiers = new Map();
    for (const row of rows) {
      const key = `${row[1]}/${row[2]}/${row[3]}`;
      if (!tiers.has(key)) tiers.set(key, []);
      tiers.get(key).push(row);
    }
    for (const tier of tiers.values()) {
      const n = tier.length;
      tier.forEach(([name, role, slot, rarity], i) => {
        const step = n > 1 ? (i - (n - 1) / 2) * TIER_SPREAD : 0;
        const bonus = Math.max(1, Math.round((RARITY_BASE[rarity] ?? 1) * power * (1 + step)));
        const id = `itm_s${seasonIdx + 1}_${slugify(name)}`;
        items[id] = { name, slot, rarity, role, bonuses: { [role]: bonus } };
        bySeason[seasonIdx].push(id);
      });
    }
  });

  return { items, bySeason };
}

const SEASON_GEAR_BUILT = buildSeasonGear();

/**
 * The full gear catalog: hand-authored entries (starter gear + the original 48
 * season items, whose ids are already in players' bags) plus the generated
 * pyramid. Hand-authored entries WIN on an id clash, so a generated item can
 * never quietly redefine one people already own.
 */
export const ITEMS = { ...SEASON_GEAR_BUILT.items, ...HAND_ITEMS };

/**
 * Per-season drop pools: the original hand-tuned ids first (stable, already
 * owned), then that season's pyramid.
 * @type {string[][]}
 */
export const SEASON_LOOT = HAND_SEASON_LOOT.map((ids, i) => [...ids, ...SEASON_GEAR_BUILT.bySeason[i]]);

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
 * Resolve untrusted chat input to an item id the player OWNS (present in
 * `inventory`). Accepts, in order: a 1-based bag index (as shown by !bag), an
 * exact item id, or a CASE-INSENSITIVE item name. Returns the item id, or null
 * if it isn't owned — callers must reject (never trust chat text; §G input
 * handling). Shared by !equip and !trade so item lookup behaves identically.
 * @param {string[]} inventory
 * @param {string} input
 * @returns {string|null}
 */
export function resolveOwnedItem(inventory, input) {
  const list = Array.isArray(inventory) ? inventory : [];
  const raw = String(input || '').trim();
  if (!raw) return null;
  // 1-based bag index (e.g. "!equip 3")
  if (/^\d+$/.test(raw)) {
    const idx = Number(raw) - 1;
    return idx >= 0 && idx < list.length ? list[idx] : null;
  }
  // exact item id
  if (list.includes(raw)) return raw;
  // case-insensitive item name
  const needle = raw.toLowerCase();
  return list.find((id) => (ITEMS[id]?.name || '').toLowerCase() === needle) ?? null;
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
