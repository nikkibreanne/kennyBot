// Boss content (spec §5.8). Your own data. `hp` is the combat HP pool (tuned so
// a modest roster downs it within the turn cap), `atk` drives boss damage,
// `thresholds` are the role-readiness signals the muster page shows, `abilities`
// feed the combat engine. A season fields one boss per week (§5.6).
import { DEFAULT_BOSS_ABILITIES } from './abilities.js';

/**
 * A testable default boss scaffold for `!boss set`.
 * @param {string} name
 * @param {object} [overrides]
 */
export function defaultBoss(name, overrides = {}) {
  return {
    name,
    hp: 6000,
    atk: 90,
    thresholds: { tank: 120, healer: 90, dps: 240 },
    affix: null,
    abilities: DEFAULT_BOSS_ABILITIES,
    ...overrides,
  };
}

/** A 6-week season roster (original/generic high-fantasy names, spec §2). */
export const SEASON_BOSSES = [
  defaultBoss('The Ashen Warden', { hp: 5000, atk: 80, affix: 'inferno' }),
  defaultBoss('Mireheart the Drowned', { hp: 6000, atk: 90, affix: 'tides' }),
  defaultBoss('Gravewind Colossus', { hp: 7000, atk: 100 }),
  defaultBoss('The Hollow Choir', { hp: 8000, atk: 110, affix: 'dirge' }),
  defaultBoss('Embermaw Tyrant', { hp: 9000, atk: 120, affix: 'inferno' }),
  defaultBoss('Vauntreach, the Final Knell', { hp: 12000, atk: 140, affix: 'finale' }),
];

/** Boss for a given 1-based week (clamps to the roster, last = finale). */
export function bossForWeek(weekNumber) {
  const idx = Math.max(1, Math.min(SEASON_BOSSES.length, weekNumber)) - 1;
  return { ...SEASON_BOSSES[idx] };
}
