// Class & role content table (spec §4). Original, generic high-fantasy names —
// no Blizzard/WoW-specific expression (spec §2/§14). This is YOUR data: renaming
// or extending is a one-line edit here and the engine follows automatically.
//
// CONFIRMED with the human (2026-06): the placeholder 5-class trinity below.
// Class fixes role, so the community must self-balance tanks/healers/DPS.

/** @typedef {'tank'|'healer'|'dps'} Role */

/**
 * @type {Record<string, { role: Role, kind: string, blurb: string }>}
 */
export const CLASSES = {
  Guardian: {
    role: 'tank',
    kind: 'shield',
    blurb: 'A stalwart bulwark — soaks the boss and holds the line.',
  },
  Mender: {
    role: 'healer',
    kind: 'restoration',
    blurb: 'Keeps the raid standing through the boss’s onslaught.',
  },
  Berserker: {
    role: 'dps',
    kind: 'melee',
    blurb: 'Reckless melee fury — trades safety for raw damage.',
  },
  Arcanist: {
    role: 'dps',
    kind: 'magic',
    blurb: 'Bends raw arcane power into ranged devastation.',
  },
  Ranger: {
    role: 'dps',
    kind: 'physical',
    blurb: 'Precise ranged shots that whittle the boss down from afar.',
  },
};

/** Canonical, case-insensitive list of class names for validation/help text. */
export const CLASS_NAMES = Object.keys(CLASSES);

/**
 * Resolve untrusted chat input to a canonical class name (case-insensitive).
 * Returns null if it isn't a known class — callers must reject (never trust
 * chat text; IMPLEMENTATION §G "input handling").
 * @param {string} input
 * @returns {string|null}
 */
export function resolveClass(input) {
  if (typeof input !== 'string') return null;
  const needle = input.trim().toLowerCase();
  return CLASS_NAMES.find((name) => name.toLowerCase() === needle) ?? null;
}

/**
 * Role for a (already-validated) class name.
 * @param {string} className
 * @returns {Role}
 */
export function roleForClass(className) {
  const entry = CLASSES[className];
  if (!entry) throw new Error(`unknown class: ${className}`);
  return entry.role;
}
