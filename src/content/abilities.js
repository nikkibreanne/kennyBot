// Combat abilities (spec §5.8 / IMPLEMENTATION §L). Mirrors the website's
// reference battle (_includes/live.html `genDemoBattle()`) so the authoritative
// engine here and the site's replay player read consistently. Tune freely —
// `power` scales the actor's atk/heal; `cooldown` is in turns.
//
// kind: 'damage' (single target), 'heal' (lowest ally), 'aoe' (whole party).

/** @typedef {{ name: string, kind: 'damage'|'heal'|'aoe', power: number, cooldown: number }} Ability */

/** @type {Record<string, Ability[]>} keyed by class name */
export const ABILITIES = {
  Guardian: [
    { name: 'Shield Bash', kind: 'damage', power: 0.8, cooldown: 0 },
    { name: 'Bulwark Slam', kind: 'damage', power: 1.4, cooldown: 3 },
  ],
  Mender: [
    { name: 'Mend', kind: 'heal', power: 1.0, cooldown: 0 },
    { name: 'Renewing Bloom', kind: 'heal', power: 2.0, cooldown: 3 },
    { name: 'Smite', kind: 'damage', power: 0.6, cooldown: 0 },
  ],
  Berserker: [
    { name: 'Cleave', kind: 'damage', power: 1.0, cooldown: 0 },
    { name: 'Rampage', kind: 'damage', power: 2.0, cooldown: 3 },
  ],
  Arcanist: [
    { name: 'Firebolt', kind: 'damage', power: 1.0, cooldown: 0 },
    { name: 'Meteor', kind: 'damage', power: 2.4, cooldown: 4 },
  ],
  Ranger: [
    { name: 'Aimed Shot', kind: 'damage', power: 1.0, cooldown: 0 },
    { name: 'Volley', kind: 'damage', power: 1.6, cooldown: 3 },
  ],
};

/** Default boss ability set (single-target + an AoE on cooldown). Overridable per boss. */
export const DEFAULT_BOSS_ABILITIES = [
  { name: 'Cinder Swipe', kind: 'damage', power: 1.0, cooldown: 0 },
  { name: 'Infernal Nova', kind: 'aoe', power: 0.7, cooldown: 3 },
];

/** Abilities for a class, falling back to a basic strike for unknown classes. */
export function abilitiesFor(className) {
  return ABILITIES[className] || [{ name: 'Strike', kind: 'damage', power: 1.0, cooldown: 0 }];
}
