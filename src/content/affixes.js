// Weekly affixes — mechanical modifiers the combat engine applies (spec §5.3).
// Each boss carries an `affix` id (content/bosses.js); the engine resolves it
// here. Campy garden theme. Effects (all optional per affix):
//   adds:        { count, respawnEvery } — spawn critters that attack each round
//   critter/icon: name + icon for this affix's adds
//   dot:         fraction of boss.atk dealt to the WHOLE party each round
//   lessHealing: multiplier (<1) on all healing
//   recoil:      fraction of a hero's atk they take back when they attack
//   bossMulti:   the boss's single-target hit strikes this many heroes (cleave)
//   frost:       per-hero chance each round to be frozen (skip their action)

// NOTE (2026-06 rebalance): several affixes were calibrated BEFORE the engine
// gained interleaved initiative, real critter adds, party DoT and boss cleave —
// which stack with the ability-SET pressure and made whole categories (caster,
// finale, high-season swarm/frost) unwinnable at the reference roster. The five
// intensities below were eased conservatively so each category lands inside a
// tunable band; per-boss baseHp/atk in content/bosses.js does the rest. Each
// change is annotated with its old value and why.
export const AFFIXES = {
  // count 3 → 2: adds derive their atk/hp from boss.atk, so on the high-atk
  // late-season swarm bosses three respawning critters out-damaged the raid.
  swarm: { label: 'Swarm', critter: 'Aphid', icon: '🐛', adds: { count: 2, respawnEvery: 3 } },
  slime: { label: 'Slime', critter: 'Slug', icon: '🐌', adds: { count: 2, respawnEvery: 4 }, lessHealing: 0.85 },
  roots: { label: 'Entangling Roots', recoil: 0.15, bossMulti: 2 },
  burrow: { label: 'Burrowing', bossMulti: 2 },
  // dot 0.16 → 0.10, lessHealing 0.8 → 0.85: blight rides the caster set, whose
  // Pollen Storm is already a party-wide AoE — a heavy second DoT + steep heal
  // cut was a double-AoE the healers could never out-pace.
  blight: { label: 'Blight', dot: 0.1, lessHealing: 0.85 },
  thorns: { label: 'Thornlash', recoil: 0.2 },
  drought: { label: 'Drought', lessHealing: 0.6, dot: 0.08 },
  devour: { label: 'Devour', bossMulti: 2 },
  // dot 0.18 → 0.10: same double-AoE problem as blight (rot also rides caster);
  // the lone maggot add stays for flavor/pressure.
  rot: { label: 'Creeping Rot', critter: 'Maggot', icon: '🪱', adds: { count: 1, respawnEvery: 3 }, dot: 0.1 },
  overgrowth: { label: 'Overgrowth', critter: 'Vine', icon: '🌿', adds: { count: 2, respawnEvery: 3 }, recoil: 0.1 },
  // frost 0.18 → 0.10: a frozen hero loses BOTH its damage and its heal, so 18%
  // was a brutal output tax that pinned the fight near-unwinnable. bossMulti stays
  // because the breaker set it rides is pure single-target — with no cleave axis a
  // boss simply can't threaten 15 healed heroes without absurd per-hit atk; the
  // cleave is what makes the affix tunable. Net: lighter skip, same spike spread.
  frost: { label: 'Untimely Frost', frost: 0.1, bossMulti: 2 },
  inferno: { label: 'Inferno', dot: 0.18, bossMulti: 2 },
  // adds 3 → 2, dot 0.1 → 0.08, bossMulti dropped: the finale already stacks the
  // tyrant set (strong basic + tank-buster + AoE) with adds and DoT. Adding cleave
  // on TOP made the win-rate curve a knife-edge at low hero levels (S1 finale
  // swung ~7 points per +1 atk — a tiny roster wobble faceplanted the raid). With
  // the tyrant's own AoE carrying the raid-wide burst, dropping cleave flattens
  // that curve so 46% is a stable target across all three seasons; dot nudged
  // 0.06→0.08 to keep the overall pressure roughly constant.
  finale: { label: 'Finale', critter: 'Husk', icon: '🌾', adds: { count: 2, respawnEvery: 3 }, dot: 0.08 },
};

/** Resolve an affix id to its effect config (or an empty/no-op object). */
export function affixFor(id) {
  return AFFIXES[id] || {};
}
