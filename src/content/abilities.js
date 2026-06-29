// ─────────────────────────────────────────────────────────────────────────────
// okrafans raid game — CONTENT: class ability kits + boss ability library
//
// DROP-IN for src/content/abilities.js. Matches the engine shape exactly:
//   ABILITIES = Record<className, Ability[]>
//   Ability   = { name, kind: 'damage'|'heal'|'aoe', power, cooldown }
//   `power`    multiplies the actor's atk (damage/aoe) or heal (heal).
//   `cooldown` is in TURNS (0 = usable every round; n = unusable for n rounds
//              after use, decremented once per round in rules/combat.js).
//
// IP RULE: original/generic naming only — no Blizzard/WoW expression. Flavor is
// the streamer's campy okra/garden/plant theme (spec §2/§14). Renaming any
// ability is a one-line edit; the engine follows automatically.
//
// DESIGN INTENT — built for the incoming WEIGHTED ability AI (not the current
// random `pick`): dps/tank favor the highest-power *available* ability, so each
// class's signature cooldown is deliberately its single strongest move and will
// be fired on cooldown. Menders heal the hurt ally and otherwise poke with a
// light damage filler, so a healer still contributes when the raid is topped.
//
// CALIBRATION — powers are tuned so a healthy mid-game roster (≈5–6 heroes,
// ~level 5, one trinket) downs the 6000-HP default boss in ~14–18 rounds, i.e.
// inside the 12–25 turn target and under the config turnCap (20). Verified with
// scratchpad/design/_calibrate.mjs (real roleRating + combatStats, weighted-AI
// loop, seed sweep). See that file / the backlog for the numbers.
//
// AVERAGE EFFECTIVE POWER PER ROUND (signature on cd + basic filler), the lever
// that sets clear-speed:
//   Berserker 2.3@cd3 → ~1.43   Arcanist 2.7@cd4 → ~1.43   Ranger 1.7@cd2 → ~1.38
//   Guardian  1.9@cd3 → ~1.23 (low tank atk mult; mostly a soak)
// All three DPS land within a few % of each other on sustained output but FEEL
// distinct: Arcanist spikes hardest every 4th round, Berserker swings big every
// 3rd, Ranger is the metronome (a strong hit every other round).

/** @typedef {{ name: string, kind: 'damage'|'heal'|'aoe', power: number, cooldown: number }} Ability */

/** @type {Record<string, Ability[]>} keyed by class name (see content/classes.js) */
export const ABILITIES = {
  // GUARDIAN (tank) — steady chip damage + a periodic heavy slam. Low atk mult
  // means it barely out-damages a poke, by design: its job is to eat the boss.
  Guardian: [
    { name: 'Thorn Jab', kind: 'damage', power: 0.9, cooldown: 0 },
    { name: 'Compost Crusher', kind: 'damage', power: 1.9, cooldown: 3 }, // signature slam
  ],

  // MENDER (healer) — efficient every-round heal, a strong cooldown heal for
  // spike recovery, and a light filler nuke so a topped raid still earns value.
  // Weighted AI: heals lowest ally when anyone is hurt (prefers the strong heal
  // when ready); otherwise pokes with Okra Lash.
  Mender: [
    { name: 'Quick Sprout', kind: 'heal', power: 1.0, cooldown: 0 }, // efficient filler heal
    { name: 'Bloom of Renewal', kind: 'heal', power: 2.2, cooldown: 3 }, // signature cooldown heal
    { name: 'Okra Lash', kind: 'damage', power: 0.6, cooldown: 0 }, // light damage filler
  ],

  // BERSERKER (melee dps) — reckless, swingy. The high ±20% engine variance
  // already makes the big move feel like a gamble; its job is the highest single
  // hit of any class. Identity: feast-or-famine execute.
  Berserker: [
    { name: 'Hack & Harvest', kind: 'damage', power: 1.0, cooldown: 0 },
    { name: 'Reckless Reaping', kind: 'damage', power: 2.3, cooldown: 3 }, // signature execute
  ],

  // ARCANIST (magic dps) — big-nuke caster. Longest cooldown, biggest number.
  // Identity: patient artillery — fillers between earth-shaking detonations.
  Arcanist: [
    { name: 'Spore Bolt', kind: 'damage', power: 1.0, cooldown: 0 },
    { name: 'Garden Nova', kind: 'damage', power: 2.7, cooldown: 4 }, // signature nuke (long cd)
  ],

  // RANGER (physical dps) — reliable, low-drama. Above-average basic and a
  // frequent (cd2) multi-hit that keeps damage flowing every other round.
  // Identity: the metronome — least variance in *output cadence* of the DPS.
  Ranger: [
    { name: 'Seed Shot', kind: 'damage', power: 1.05, cooldown: 0 }, // reliable basic
    { name: 'Bramble Volley', kind: 'damage', power: 1.7, cooldown: 2 }, // signature multi-hit (frequent)
  ],
};

/**
 * BOSS ABILITY LIBRARY — named archetype kits the bosses file references by
 * name (e.g. `abilities: BOSS_ABILITY_SETS.bruiser`). Each is a small array of
 * the same {name,kind,power,cooldown} shape; `power` multiplies the boss `atk`.
 *
 * Engine reminder: boss 'damage' hits the tank ~60% of the time else a random
 * hero; 'aoe' hits the whole party. The shipping engine picks the boss's ability
 * RANDOMLY among those off cooldown (unlike the weighted HERO AI), so COOLDOWN —
 * not power — is what paces an AoE. That is why each AoE's `power` sits *below*
 * the set's single-target basic: per-target it should hurt less than a focused
 * hit, and random selection still fires it on schedule. (Heads-up, see backlog:
 * if bosses ever gain a power-greedy AI, a strictly-lower-power AoE would never
 * be chosen — it'd need explicit weights or power×targets scoring.)
 * Keep aoe power ≤ ~0.85 or a single AoE round starts one-shotting squishies as
 * boss atk climbs across a season (90→140). Names lean garden-menace / campy.
 *
 * @type {Record<string, Ability[]>}
 */
export const BOSS_ABILITY_SETS = {
  // BRUISER — relentless melee. Mostly single-target into the tank with a heavy
  // slam on cooldown. Tests the tank+healer core; gentle on the rest of the raid.
  bruiser: [
    { name: 'Bramble Backhand', kind: 'damage', power: 1.0, cooldown: 0 },
    { name: 'Rootquake Slam', kind: 'damage', power: 1.7, cooldown: 3 }, // tank-buster spike
  ],

  // CASTER — AoE-heavy spellslinger. Frequent party-wide blasts punish thin
  // healing and reward stacking extra Menders. The pressure-test archetype.
  caster: [
    { name: 'Witherbolt', kind: 'damage', power: 0.9, cooldown: 0 },
    { name: 'Pollen Storm', kind: 'aoe', power: 0.75, cooldown: 2 }, // frequent raid damage
  ],

  // SWARMER — chip everything down. Low-power but near-constant AoE plus a light
  // jab; no single hit is scary, attrition is. Healers must spread coverage.
  swarmer: [
    { name: 'Aphid Skitter', kind: 'damage', power: 0.7, cooldown: 0 },
    { name: 'Locust Tide', kind: 'aoe', power: 0.6, cooldown: 1 }, // near-constant small AoE
  ],

  // EXECUTIONER — feast-or-famine burst. Quiet basic, then a huge single-target
  // detonation on a long cooldown that can delete an unlucky squishy. Rewards a
  // tank who reliably eats the hit (60% taunt) and a healer who pre-tops.
  executioner: [
    { name: 'Creeping Vine', kind: 'damage', power: 0.8, cooldown: 0 },
    { name: 'Harvest Reckoning', kind: 'damage', power: 2.6, cooldown: 4 }, // long-cd nuke
  ],

  // WARDEN — balanced all-rounder (the default-boss feel): steady single-target
  // with a moderate AoE on cooldown. A fair fight for a fair roster.
  warden: [
    { name: 'Thorned Lash', kind: 'damage', power: 1.0, cooldown: 0 },
    { name: 'Bramble Nova', kind: 'aoe', power: 0.7, cooldown: 3 }, // moderate raid damage
  ],

  // TYRANT — finale set. Hits hard on every axis: strong basic, a tank-buster
  // slam AND a big AoE, both on cooldown. Built for the season-ending boss with
  // a deep, well-geared raid; will wipe an underbaked roster (intended gate).
  tyrant: [
    { name: 'Verdant Wrath', kind: 'damage', power: 1.2, cooldown: 0 },
    { name: 'Crushing Bloom', kind: 'damage', power: 2.0, cooldown: 3 }, // tank-buster
    { name: 'Blightfall', kind: 'aoe', power: 0.8, cooldown: 3 }, // raid-wide spike
  ],
};

/** Default boss kit when a boss declares none — the balanced 'warden' set. */
export const DEFAULT_BOSS_ABILITIES = BOSS_ABILITY_SETS.warden;

/** Abilities for a class, falling back to a basic strike for unknown classes. */
export function abilitiesFor(className) {
  return ABILITIES[className] || [{ name: 'Strike', kind: 'damage', power: 1.0, cooldown: 0 }];
}
