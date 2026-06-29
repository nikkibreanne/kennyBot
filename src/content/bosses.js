// ─────────────────────────────────────────────────────────────────────────────
// okrafans raid game — SEASON BOSS CONTENT (design draft)
//
// Original / generic IP only. Campy okra-garden flavor. NO Blizzard/WoW names.
//
// 3 seasons × 6 weekly bosses (week 6 = season FINALE set-piece). Difficulty
// escalates across weeks AND seasons.
//
// SHAPE (matches the engine in src/content/bosses.js + src/rules/combat.js):
//   { id, name, baseHp, atk, thresholds:{tank,healer,dps}, affix:(string|null),
//     abilitySet:<name>, flavor }
//
// `baseHp`  — HP calibrated for the REFERENCE ROSTER (see below). The live raid
//             HP is `scaleBossHp(baseHp, signedUpHeroCount)` so a 10-hero and a
//             40-hero raid both get a ~12–20 turn fight (the engine sums ALL
//             heroes' damage, so a fixed HP can't serve both — §HP SCALING).
// `atk`     — drives boss damage = atk * abilityPower * variance(±20%).
//             NOTE: `atk` is tuned PER BOSS against its `abilitySet` to hit a
//             target reference win-rate. Because sets differ in AoE/spike
//             pressure, the raw `atk` integer is intentionally NOT monotonic
//             week-to-week — a nastier set (caster/finale) reaches the same
//             lethality at a LOWER atk. Difficulty is expressed by the win-rate
//             curve and the muster thresholds (both monotonic), not by `atk`.
// `thresholds` — muster-page role-readiness signals (aggregate roleRating vs
//             threshold). NOT combat values; they tell chat "we have enough
//             tank/healer/dps". Climb week→week so finales demand a full muster.
// `affix`   — weekly modifier. NEEDS ENGINE SUPPORT — see bosses-backlog.md.
//             Until implemented the engine treats it as flavor (no mechanical
//             effect), so the strings are safe to ship now.
// `abilitySet` — NAME into the companion BOSS_ABILITY_SETS library
//             (scratchpad/design/abilities.js). The engine reads `boss.abilities`
//             (an array); a thin resolver should map abilitySet → that array.
//             Sets used here, ascending in raid lethality:
//               'swarmer' — frequent low-power AoE (pest swarms); gentle
//               'bruiser' — tank-buster + occasional AoE; gentle
//               'breaker' — big telegraphed single-target spikes; medium
//               'caster'  — ranged hex + heavy spore AoE; harsh (healer check)
//               'finale'  — heavy tank-buster + rare big AoE; the set-piece set
//             These are intents — map to the nearest real set name when wiring.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * REFERENCE ROSTER (calibration assumption)
 * 15 active heroes, role split ~20% tank / 20% healer / 60% dps (3/3/9),
 * engagement multiplier 1.0 (non-sub floor), gear=0 (season gear-reset baseline),
 * at the season's expected hero level (S1≈10, S2≈16, S3≈22).
 *
 * Measured team damage-to-boss per turn for that reference roster (real engine,
 * avg over seeds): S1≈805, S2≈1069, S3≈1333  (≈53.7 / 71.4 / 89.0 per head —
 * per-head DPS is ~flat in roster size, which is why linear-ish HP scaling works).
 * baseHp ≈ teamDPS/turn × targetTurns(week).  targetTurns W1..W6 = 13,14,15,16,17,18.
 */
export const REFERENCE = Object.freeze({
  heroes: 15,
  split: { tank: 0.20, healer: 0.20, dps: 0.60 },
  engagementMult: 1.0,
  seasonLevel: { 1: 10, 2: 16, 3: 22 },
  teamDpsPerTurn: { 1: 805, 2: 1069, 3: 1333 },
});

/**
 * BOSS HP SCALING.
 * The engine sums every signed-up hero's damage, so effective team DPS is ~linear
 * in headcount (per-head DPS is flat — verified). To hold fight length roughly
 * constant from 10 to 40 heroes we scale boss HP with headcount:
 *
 *     scaleBossHp(baseHp, n) = clamp( baseHp * (n / 15)^0.92 )
 *
 * Exponent 0.92 (mild sub-linear compression): big raids kill ~2–3 turns faster
 * (a small reward for a strong muster) and small raids get ~1–2 extra turns of
 * breathing room — both stay inside the 12–20 turn band. The 0.25× floor stops a
 * tiny/no-show raid from facing an absurdly thin boss; the 4× ceiling stops a
 * brigade from inflating HP past the turn budget. refCount is a parameter so a
 * future config can move it.
 *
 * @param {number} baseHp      boss.baseHp (reference-calibrated)
 * @param {number} playerCount number of signed-up heroes
 * @param {number} [refCount=15]
 * @returns {number} integer combat HP to pass to the engine as boss.hp
 */
export function scaleBossHp(baseHp, playerCount, refCount = REFERENCE.heroes) {
  const n = Math.max(1, Math.floor(playerCount || 0));
  const f = Math.pow(n / refCount, 0.92);
  const scaled = Math.round((baseHp || 0) * f);
  const floor = Math.round((baseHp || 0) * 0.25);
  const ceil = Math.round((baseHp || 0) * 4.0);
  return Math.max(floor, Math.min(ceil, scaled));
}

// Campy season arcs (flavor only — the bot can surface these on the muster page).
export const SEASON_THEMES = Object.freeze([
  { id: 's1', title: 'The Proving Bed', sub: 'First Frost & Foul Weeds' },
  { id: 's2', title: 'The Sweltering Patch', sub: 'High Summer Blight' },
  { id: 's3', title: 'The Last Harvest', sub: 'Reap What Ye Have Sown' },
]);

/** @typedef {{id:string,name:string,baseHp:number,atk:number,thresholds:{tank:number,healer:number,dps:number},affix:(string|null),abilitySet:string,flavor:string}} Boss */

/**
 * SEASONS — array of 3 seasons, each an array of 6 weekly boss defs.
 * id format: s<season>w<week>.  Reference win-rate ramp per week (measured,
 * REF=15): ~100% → ~98% → ~92% → ~80% → ~62% → ~46% (finale = hardest).
 * @type {Boss[][]}
 */
export const SEASONS = [
  // ══ SEASON 1 — The Proving Bed (expected hero level ≈10) ════════════════════
  [
    {
      id: 's1w1', name: 'Lady Aphidia, the Aphid Empress', baseHp: 10500, atk: 100,
      thresholds: { tank: 390, healer: 370, dps: 1050 }, affix: 'swarm', abilitySet: 'swarmer',
      flavor: 'A glistening green matriarch riding a parade float of her own children. She is, frankly, thriving — and your rosebushes are not. "Hello darlings! Don\'t mind the kids."',
    },
    {
      id: 's1w2', name: 'The Slugfather', baseHp: 11300, atk: 142,
      thresholds: { tank: 430, healer: 410, dps: 1170 }, affix: 'slime', abilitySet: 'bruiser',
      flavor: 'He made the lettuce an offer it could not refuse. Leaves a trail of iridescent menace and unpaid protection debts. Capisce?',
    },
    {
      id: 's1w3', name: 'Bindweed Behemoth', baseHp: 12100, atk: 150,
      thresholds: { tank: 480, healer: 460, dps: 1300 }, affix: 'roots', abilitySet: 'bruiser',
      flavor: 'You pulled it up last week. You pulled it up the week before. It has opinions about that, and roughly nine thousand feet of runners under your feet RIGHT NOW.',
    },
    {
      id: 's1w4', name: 'Sir Nibblesworth, Tyrant of the Carrot Tops', baseHp: 12900, atk: 132,
      thresholds: { tank: 530, healer: 500, dps: 1430 }, affix: 'burrow', abilitySet: 'breaker',
      flavor: 'A rabbit of unusually large ambition and a tiny embroidered crown. He has eaten the entire row and is now, somehow, the row\'s legitimate monarch. He pounces from his warren without warning.',
    },
    {
      id: 's1w5', name: 'The Powdery Mildew Wraith', baseHp: 13700, atk: 130,
      thresholds: { tank: 570, healer: 540, dps: 1540 }, affix: 'blight', abilitySet: 'caster',
      flavor: 'A pale haze that settles on every leaf and whispers, "wouldn\'t it be easier to just give up gardening?" It withers heals and dusts the whole party. Dust it off. Dust it ALL off.',
    },
    {
      id: 's1w6', name: 'Jack o\' the Rotten Row, the Scarecrow King', baseHp: 14500, atk: 150,
      thresholds: { tank: 630, healer: 600, dps: 1700 }, affix: 'finale', abilitySet: 'finale',
      flavor: 'SEASON FINALE. The straw man you built to scare the crows has been holding court. The crows answer to HIM now. He tips his gourd-head and the whole field goes quiet. "Welcome to my garden party."',
    },
  ],

  // ══ SEASON 2 — The Sweltering Patch (expected hero level ≈16) ════════════════
  [
    {
      id: 's2w1', name: 'Thornwretch the Bramblebound', baseHp: 13900, atk: 158,
      thresholds: { tank: 510, healer: 490, dps: 1400 }, affix: 'thorns', abilitySet: 'bruiser',
      flavor: 'What started as a polite blackberry hedge has achieved sentience, property ownership, and a deep personal grudge against ankles.',
    },
    {
      id: 's2w2', name: 'Old Man Sunscorch', baseHp: 15000, atk: 172,
      thresholds: { tank: 560, healer: 540, dps: 1560 }, affix: 'drought', abilitySet: 'bruiser',
      flavor: 'He has not let it rain in six weeks and he is PROUD of that. Cracks the soil, cracks the hose, cracks the occasional terrible heat-stroke pun.',
    },
    {
      id: 's2w3', name: 'The Ten-Lined Horde', baseHp: 16000, atk: 182,
      thresholds: { tank: 620, healer: 600, dps: 1730 }, affix: 'swarm', abilitySet: 'swarmer',
      flavor: 'Potato beetles. Not one. Not a hundred. A single chittering will composed of ten thousand striped little bodies, and it would like to discuss your nightshades.',
    },
    {
      id: 's2w4', name: 'Madame Venus & the Snaptrap Coven', baseHp: 17100, atk: 162,
      thresholds: { tank: 690, healer: 660, dps: 1900 }, affix: 'devour', abilitySet: 'breaker',
      flavor: 'A sisterhood of carnivorous belles who insist they only eat flies. The flies are the size of a Berserker. "Come closer, sugar, I don\'t bite — much."',
    },
    {
      id: 's2w5', name: 'The Hornworm Broodmother', baseHp: 18200, atk: 158,
      thresholds: { tank: 740, healer: 710, dps: 2050 }, affix: 'rot', abilitySet: 'caster',
      flavor: 'Plump, horned, and disturbingly well-camouflaged until she has stripped a tomato plant to a green skeleton. She is eating for nine hundred, and the rot spreads where she chews.',
    },
    {
      id: 's2w6', name: 'The Cornstalk Colossus, Tyrant of Tassels', baseHp: 19200, atk: 175,
      thresholds: { tank: 820, healer: 790, dps: 2270 }, affix: 'finale', abilitySet: 'finale',
      flavor: 'SEASON FINALE. Twelve feet of stalk, knuckles of dried husk, a crown of tassels catching the dead-summer light. Every ear of corn turns to watch you. It has been a very good year for corn. A very bad year for you.',
    },
  ],

  // ══ SEASON 3 — The Last Harvest (expected hero level ≈22) ════════════════════
  [
    {
      id: 's3w1', name: 'The Mulchgeist', baseHp: 17300, atk: 190,
      thresholds: { tank: 620, healer: 600, dps: 1760 }, affix: 'overgrowth', abilitySet: 'bruiser',
      flavor: 'The compost heap has been quietly composting MORE than vegetable scraps. It rises, steaming and fragrant, an elemental of pure decomposition and a startling number of beneficial worms.',
    },
    {
      id: 's3w2', name: 'Gourdfather the Hollow', baseHp: 18700, atk: 200,
      thresholds: { tank: 690, healer: 670, dps: 1940 }, affix: 'blight', abilitySet: 'bruiser',
      flavor: 'A pumpkin lich who left the candle burning a LITTLE too long. His grin is carved, eternal, and deeply unbothered. "Trick," he rasps. There is no treat option.',
    },
    {
      id: 's3w3', name: 'The Tatterking', baseHp: 20000, atk: 210,
      thresholds: { tank: 770, healer: 740, dps: 2160 }, affix: 'swarm', abilitySet: 'swarmer',
      flavor: 'You burned the Scarecrow King two seasons ago. You did not burn him ENOUGH. He is back, stitched from the season\'s grudges, and every crow in three counties answers his ragged whistle.',
    },
    {
      id: 's3w4', name: 'Hoarfrost the Untimely', baseHp: 21300, atk: 188,
      thresholds: { tank: 840, healer: 820, dps: 2380 }, affix: 'frost', abilitySet: 'breaker',
      flavor: 'An early-frost reaper who showed up THREE WEEKS before the almanac said he could. Rude. He drives a killing spike of cold through one hero at a time, leaf by silvered leaf.',
    },
    {
      id: 's3w5', name: 'Root of All Rot, the Wormwood Choir', baseHp: 22700, atk: 183,
      thresholds: { tank: 910, healer: 880, dps: 2570 }, affix: 'rot', abilitySet: 'caster',
      flavor: 'Beneath the whole garden, one tangled taproot has been listening, and learning, and harmonizing. When it finally sings, every dead thing in the soil sings the bitter green descant with it.',
    },
    {
      id: 's3w6', name: 'Her Verdant Majesty, the Okra Eternal', baseHp: 24000, atk: 198,
      thresholds: { tank: 1010, healer: 980, dps: 2840 }, affix: 'finale', abilitySet: 'finale',
      flavor: 'GRAND FINALE. The Mother Pod. The first seed and the last. She unfurls from the center of the garden in ridges of impossible green, ten feet of regal okra wreathed in pollinators, and she is SO proud of all of you for making it this far. "Now, my darlings. Show me what the garden taught you." (multi-phase — see backlog)',
    },
  ],
];

/** Convenience: boss for a 1-based season and week (clamped). Returns a copy. */
export function bossFor(seasonNumber, weekNumber) {
  const s = Math.max(1, Math.min(SEASONS.length, seasonNumber || 1)) - 1;
  const weeks = SEASONS[s];
  const w = Math.max(1, Math.min(weeks.length, weekNumber || 1)) - 1;
  return { ...weeks[w] };
}

/** Flat list of all 18 bosses (id-keyed iteration / admin tooling). */
export const ALL_BOSSES = SEASONS.flat();

// ─── engine wiring (resolve ability sets + back-compat helpers) ──────────────
import { BOSS_ABILITY_SETS, DEFAULT_BOSS_ABILITIES } from './abilities.js';

// Boss "intent" set names → real BOSS_ABILITY_SETS keys (the bosses use a couple
// of intent names the ability library expresses under different keys).
const ABILITY_SET_ALIAS = { breaker: 'executioner', finale: 'tyrant' };

/** Resolve a boss.abilitySet name to its concrete ability array (engine input). */
export function bossAbilities(abilitySet) {
  const key = ABILITY_SET_ALIAS[abilitySet] || abilitySet;
  return BOSS_ABILITY_SETS[key] || DEFAULT_BOSS_ABILITIES;
}

/** Recommended hero count by week (surfaced during muster; finales want more). */
export const RECOMMENDED_BY_WEEK = [8, 10, 11, 13, 14, 16];

/**
 * Build a runnable boss for a 1-based season + week: resolves the ability set
 * and a recommended hero count. Keeps `baseHp` — the live combat HP is
 * `scaleBossHp(baseHp, mustered)` computed at lock.
 */
export function seasonBoss(seasonNumber, weekNumber) {
  const b = bossFor(seasonNumber, weekNumber);
  const w = Math.max(1, Math.min(RECOMMENDED_BY_WEEK.length, weekNumber || 1));
  return { ...b, abilities: bossAbilities(b.abilitySet), recommended: RECOMMENDED_BY_WEEK[w - 1] };
}

/** Season-1 boss for a week (back-compat for callers using bossForWeek). */
export function bossForWeek(weekNumber) {
  return seasonBoss(1, weekNumber);
}

/**
 * Ad-hoc / custom boss (mod !boss set, dev scenarios). Defaults to the balanced
 * 'warden' kit. An `hp` override sets baseHp (scaled by roster size at lock).
 */
export function defaultBoss(name, overrides = {}) {
  const abilitySet = overrides.abilitySet ?? 'warden';
  return {
    name,
    baseHp: overrides.hp ?? overrides.baseHp ?? 6000,
    atk: overrides.atk ?? 90,
    thresholds: overrides.thresholds ?? { tank: 120, healer: 90, dps: 240 },
    affix: overrides.affix ?? null,
    abilitySet,
    abilities: bossAbilities(abilitySet),
    recommended: overrides.recommended ?? 6,
  };
}
