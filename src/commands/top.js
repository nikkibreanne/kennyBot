// !top [role|metric] — the current season's leaderboard (spec §5.8).
//
// Boards are PER ROLE by default, because one damage column ranked a healer
// against a DPS for work healers never do. Each role is measured on its own job:
// dps by boss damage, healer by healing, tank by damage soaked.
import { getSeason } from '../db/configStore.js';
import { getTop, ROLE_METRIC } from '../db/leaderboard.js';

const ROLES = ['tank', 'healer', 'dps'];
/** Explicit metric names still work, for anyone who knows what they want. */
const FIELDS = { damage: 'damage', healing: 'healing', healed: 'healing', taken: 'taken', soaked: 'taken' };

/** Compact ranked line: "1. Alice 12,340 · 2. Bob 9,800". Exported for tests. */
export function formatTop(rows) {
  return rows
    .map((r, i) => `${i + 1}. ${r.displayName} ${Number(r.value).toLocaleString('en-US')}`)
    .join(' · ');
}

/** Resolve the argument into { role, field, label }. Defaults to the dps board. */
export function resolveBoard(arg) {
  const a = String(arg || '').toLowerCase();
  if (ROLES.includes(a)) return { role: a, ...ROLE_METRIC[a] };
  if (FIELDS[a]) {
    const field = FIELDS[a];
    const role = ROLES.find((r) => ROLE_METRIC[r].field === field) || null;
    return { role, field, label: ROLE_METRIC[role]?.label || field };
  }
  return { role: 'dps', ...ROLE_METRIC.dps };
}

export default {
  names: ['top'],
  mod: false,
  cooldownMs: 5_000,
  help: '!top [tank|healer|dps] — the season leaderboard for that role (top 5)',
  async run({ args, reply }) {
    const season = getSeason();
    if (!season?.id) {
      reply('🏆 No active season yet — the leaderboard opens when a season starts.');
      return;
    }
    const { role, field, label } = resolveBoard(args[0]);
    const rows = await getTop(season.id, field, 5, { role });
    const icon = role === 'tank' ? '🛡️' : role === 'healer' ? '💚' : '⚔️';
    const others = ROLES.filter((r) => r !== role).join(' / ');
    if (rows.length === 0) {
      reply(`${icon} Season ${role} (${label}): no scores yet — clear a raid to get on the board! Also: !top ${others}`);
      return;
    }
    reply(`${icon} Season ${role} — ${label}: ${formatTop(rows)} · also !top ${others}`);
  },
};
