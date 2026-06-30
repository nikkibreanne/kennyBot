// !top [damage] — the current season's top 5 on the leaderboard (spec §5.8).
// One compact chat line. Only `damage` is tracked today; the optional arg is
// validated against a small allowlist so a future metric is a one-line change.
import { getSeason } from '../db/configStore.js';
import { getTop } from '../db/leaderboard.js';

const FIELDS = new Set(['damage']);

/** Compact ranked line: "1. Alice 12,340 · 2. Bob 9,800". Exported for tests. */
export function formatTop(rows) {
  return rows
    .map((r, i) => `${i + 1}. ${r.displayName} ${Number(r.value).toLocaleString('en-US')}`)
    .join(' · ');
}

export default {
  names: ['top'],
  mod: false,
  cooldownMs: 5_000,
  help: '!top [damage] — the season leaderboard (top 5)',
  async run({ args, reply }) {
    const season = getSeason();
    if (!season?.id) {
      reply('🏆 No active season yet — the leaderboard opens when a season starts.');
      return;
    }
    const field = FIELDS.has((args[0] || '').toLowerCase()) ? args[0].toLowerCase() : 'damage';
    const rows = await getTop(season.id, field, 5);
    if (rows.length === 0) {
      reply(`🏆 Season ${field}: no scores yet — clear a raid to get on the board!`);
      return;
    }
    reply(`🏆 Season ${field}: ${formatTop(rows)}`);
  },
};
