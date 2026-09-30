// Season leaderboard reads (spec §5.8). finishBattle() writes per-uid totals to
// `leaderboard/<seasonId>/<uid>` (e.g. { damage }); the website renders that node
// directly. This module gives chat a sorted top-N view with display names
// resolved from each hero's record — read-only, no writes.

import { database, PATHS } from './firebase.js';

/**
 * Pure ranking: turn a `leaderboard/<seasonId>` snapshot value (a map of
 * uid → entry) into the top `n` rows by `field`, descending. Zero/absent scores
 * are dropped so a damage board never lists heroes who dealt none (tanks/healers
 * still get an entry from finishBattle's increment(0)). Exported for unit tests.
 *
 * @param {Record<string, Record<string, number>>|null|undefined} entries
 * @param {string} [field='damage']
 * @param {number} [n=5]
 * @returns {Array<{ uid: string, value: number }>}
 */
export function rankEntries(entries, field = 'damage', n = 5, { role = null } = {}) {
  return Object.entries(entries || {})
    .filter(([, entry]) => !role || entry?.role === role)
    .map(([uid, entry]) => ({ uid, value: Number(entry?.[field] ?? 0), role: entry?.role ?? null }))
    .filter((row) => Number.isFinite(row.value) && row.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, Math.max(0, n));
}

/**
 * The metric each role is actually judged on. Ranking a healer by boss damage
 * compares them on work they never do, so every role gets the board that
 * measures its own job.
 */
export const ROLE_METRIC = Object.freeze({
  dps: { field: 'damage', label: 'damage' },
  healer: { field: 'healing', label: 'healing' },
  tank: { field: 'taken', label: 'damage soaked' },
});

/**
 * Read the current season leaderboard once and resolve the top `n` heroes by
 * `field`, attaching each uid's display name (players/<uid>/displayName, falling
 * back to the raw uid). Returns [] when there's no season id or no scores.
 *
 * @param {string} seasonId
 * @param {string} [field='damage']
 * @param {number} [n=5]
 * @returns {Promise<Array<{ uid: string, value: number, displayName: string }>>}
 */
export async function getTop(seasonId, field = 'damage', n = 5, { role = null } = {}) {
  if (!seasonId) return [];
  const snap = await database().ref(`leaderboard/${seasonId}`).get();
  const ranked = rankEntries(snap.val(), field, n, { role });
  return Promise.all(
    ranked.map(async ({ uid, value, role: r }) => {
      const nameSnap = await database().ref(`${PATHS.player(uid)}/displayName`).get();
      return { uid, value, role: r, displayName: nameSnap.val() || uid };
    }),
  );
}
