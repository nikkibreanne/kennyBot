#!/usr/bin/env node
// Raid balance harness. Runs the REAL combat engine over synthetic rosters and
// reports win rates, so tuning changes are measured rather than guessed.
//
//   node scripts/balance-sim.mjs              # season curves at several roster sizes
//   node scripts/balance-sim.mjs --gear       # does a stronger raid win more?
//   node scripts/balance-sim.mjs --seeds 400  # tighter numbers, slower
//
// Pure read of the rules + content modules — never touches Firebase.
//
// ONE TRAP, and it invalidated an entire round of analysis: abilities are keyed
// by CLASS (`abilitiesFor(p.class)`), not role. A party member built without a
// `class` silently falls back to a single generic Strike — healers never heal,
// nobody uses an AoE, and every number the sim produces is meaningless. Build
// party members with buildParty() below rather than by hand.
import { simulateBattle, combatStats } from '../src/rules/combat.js';
import { roleRating, engagementMultiplier } from '../src/rules/rating.js';
import { seasonBoss, scaleBossHp, scaleBossAtk, SEASONS } from '../src/content/bosses.js';
import { ITEMS, SEASON_LOOT, itemObject, getStarterEquipped } from '../src/content/items.js';
import { config } from '../src/config.js';

const argv = process.argv.slice(2);
const SEEDS = Number(argv[argv.indexOf('--seeds') + 1]) || (argv.includes('--seeds') ? 200 : 200);
const fixedRng = () => 0.5; // deterministic starter-gear rolls

/** Representative class per role — the field the engine actually reads. */
export const CLASS_FOR = { tank: 'Guardian', healer: 'Mender', dps: 'Ranger' };

/** Best in-role item of a slot at a given rarity, for a season. */
function pickItem(season, role, slot, rarity) {
  const pool = SEASON_LOOT[season - 1]
    .map((id) => ({ id, ...ITEMS[id] }))
    .filter((i) => i.slot === slot && i.rarity === rarity && typeof i.bonuses?.[role] === 'number');
  return pool.length ? itemObject(pool[0].id) : null;
}

/**
 * A synthetic roster at the reference role split (20% tank / 20% healer / rest
 * dps), geared to a rarity tier — or 'starter', or null for bare.
 * @returns {Array<object>} party rows in the shape runBattle passes the engine
 */
export function buildParty({ n, season = 1, level = 10, gear = 'starter' }) {
  const tanks = Math.max(1, Math.round(n * 0.2));
  const healers = Math.max(1, Math.round(n * 0.2));
  return Array.from({ length: n }, (_, i) => {
    const role = i < tanks ? 'tank' : i < tanks + healers ? 'healer' : 'dps';
    const equipped = gear === 'starter'
      ? getStarterEquipped(role, fixedRng)
      : gear
        ? { weapon: pickItem(season, role, 'weapon', gear), armor: pickItem(season, role, 'armor', gear), trinket: pickItem(season, role, 'trinket', gear) }
        : {};
    const p = { role, level, equipped, renown: 0, subTier: 0 };
    const rr = Math.round(roleRating(p, config, (id) => ITEMS[id]) * engagementMultiplier(p, config));
    const cs = combatStats(rr, role, config);
    return { uid: `${role}${i}`, name: `${role}${i}`, role, class: CLASS_FOR[role], maxHp: cs.maxHp, atk: cs.atk, heal: cs.heal };
  });
}

/**
 * Win rate (0-100) over `seeds` deterministic battles. Applies the same HP and
 * ATK scaling `lockRaid` does, so this measures what players actually face.
 */
export function winRate({ n, season = 1, week = 1, level = 10, gear = 'starter', seeds = SEEDS }) {
  const party = buildParty({ n, season, level, gear });
  const boss = seasonBoss(season, week);
  const hp = scaleBossHp(boss.baseHp, party.length);
  const atk = scaleBossAtk(boss.atk, party.length);
  let wins = 0;
  for (let s = 0; s < seeds; s++) {
    if (simulateBattle(party, { ...boss, hp, atk }, s * 7919 + 13, config).result.downed) wins++;
  }
  return Math.round((wins / seeds) * 100);
}

// ── report ─────────────────────────────────────────────────────────────────
if (import.meta.url === `file://${process.argv[1]}`) {
  const weeks = SEASONS[0].length;
  const head = '  ' + 'roster'.padEnd(14) + Array.from({ length: weeks }, (_, i) => `w${i + 1}`.padStart(6)).join('');

  if (argv.includes('--gear')) {
    console.log(`Does a stronger raid win more? (Season 1 finale, ${SEEDS} seeds)\n`);
    console.log('  ' + 'gear'.padEnd(22) + [4, 6, 8, 15].map((n) => `${n}h`.padStart(7)).join(''));
    for (const [gear, level] of [['starter', 10], ['common', 13], ['uncommon', 16], ['rare', 19], ['epic', 22]]) {
      const row = [4, 6, 8, 15].map((n) => `${winRate({ n, week: weeks, level, gear })}%`.padStart(7)).join('');
      console.log('  ' + `${gear} lvl ${level}`.padEnd(22) + row);
    }
  } else {
    for (const season of [1, 2, 3]) {
      const level = { 1: 10, 2: 16, 3: 22 }[season];
      console.log(`\n══ SEASON ${season} — level ${level}, starter gear, ${SEEDS} seeds ══`);
      console.log(head);
      for (const n of [4, 6, 8, 15, 30]) {
        const row = Array.from({ length: weeks }, (_, i) => `${winRate({ n, season, week: i + 1, level })}%`.padStart(6)).join('');
        console.log('  ' + `${n} heroes`.padEnd(14) + row);
      }
    }
  }
}
