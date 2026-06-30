// Active loot-drop persistence (spec §5.2). A drop is a claim WINDOW with
// independent rolls (not first-to-type): every claimer rolls within the window.
// Claims are recorded per-user so a duplicate/echoed !grab is idempotent — a
// viewer rolls exactly once per drop.

import { database, PATHS } from './firebase.js';
import { rollClaim } from '../rules/loot.js';
import { addLoot } from './players.js';
import { getItem } from '../content/items.js';
import { config } from '../config.js';

/**
 * Publish a new active drop, replacing any current one. Visible to clients
 * (read-only) so the site can show it too.
 * @param {string} itemId
 * @returns {Promise<{ itemId: string, rarity: string, name: string, expiresAt: number }>}
 */
export async function setDrop(itemId) {
  const item = getItem(itemId);
  if (!item) throw new Error(`unknown item: ${itemId}`);
  const expiresAt = Date.now() + config.loot.windowMs;
  const drop = { itemId, rarity: item.rarity, name: item.name, expiresAt, claims: {} };
  await database().ref(PATHS.dropActive()).set(drop);
  return { itemId, rarity: item.rarity, name: item.name, expiresAt };
}

/** Read the active drop (or null). */
export async function getActiveDrop() {
  const snap = await database().ref(PATHS.dropActive()).get();
  const drop = snap.val();
  if (!drop) return null;
  if (typeof drop.expiresAt === 'number' && drop.expiresAt <= Date.now()) return null;
  return drop;
}

/**
 * Attempt a claim. Idempotent per user. `guaranteed` forces a win (a player's
 * first-ever claim, spec §5.5).
 * @param {{ userId: string, guaranteed?: boolean, rng?: () => number }} args
 * @returns {Promise<{ status: 'none'|'expired'|'already'|'claimed', won?: boolean, item?: object }>}
 */
export async function claimDrop({ userId, guaranteed = false, rng = Math.random }) {
  const ref = database().ref(PATHS.dropActive());
  const snap = await ref.get();
  const drop = snap.val();
  if (!drop) return { status: 'none' };
  if (typeof drop.expiresAt === 'number' && drop.expiresAt <= Date.now()) return { status: 'expired' };
  if (drop.claims && drop.claims[userId] != null) {
    return { status: 'already', won: Boolean(drop.claims[userId].won) };
  }

  const won = rollClaim(rng, config, { guaranteed });

  // Record the roll atomically; if a concurrent claim already recorded, defer.
  const res = await database()
    .ref(`${PATHS.dropActive()}/claims/${userId}`)
    .transaction((curr) => (curr == null ? { won, at: Date.now() } : undefined));
  if (!res.committed) {
    return { status: 'already', won: Boolean(res.snapshot.val()?.won) };
  }

  const item = getItem(drop.itemId);
  if (won) await addLoot(userId, drop.itemId);
  return { status: 'claimed', won, item: item ? { ...item, id: drop.itemId } : null };
}
