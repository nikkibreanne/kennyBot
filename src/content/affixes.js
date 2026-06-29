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

export const AFFIXES = {
  swarm: { label: 'Swarm', critter: 'Aphid', icon: '🐛', adds: { count: 3, respawnEvery: 3 } },
  slime: { label: 'Slime', critter: 'Slug', icon: '🐌', adds: { count: 2, respawnEvery: 4 }, lessHealing: 0.85 },
  roots: { label: 'Entangling Roots', recoil: 0.15, bossMulti: 2 },
  burrow: { label: 'Burrowing', bossMulti: 2 },
  blight: { label: 'Blight', dot: 0.16, lessHealing: 0.8 },
  thorns: { label: 'Thornlash', recoil: 0.2 },
  drought: { label: 'Drought', lessHealing: 0.6, dot: 0.08 },
  devour: { label: 'Devour', bossMulti: 2 },
  rot: { label: 'Creeping Rot', critter: 'Maggot', icon: '🪱', adds: { count: 1, respawnEvery: 3 }, dot: 0.18 },
  overgrowth: { label: 'Overgrowth', critter: 'Vine', icon: '🌿', adds: { count: 2, respawnEvery: 3 }, recoil: 0.1 },
  frost: { label: 'Untimely Frost', frost: 0.18, bossMulti: 2 },
  inferno: { label: 'Inferno', dot: 0.18, bossMulti: 2 },
  finale: { label: 'Finale', critter: 'Husk', icon: '🌾', adds: { count: 3, respawnEvery: 3 }, dot: 0.1, bossMulti: 2 },
};

/** Resolve an affix id to its effect config (or an empty/no-op object). */
export function affixFor(id) {
  return AFFIXES[id] || {};
}
