// Active loot-drop persistence (spec §5.2). A drop is a LOTTERY over a claim
// WINDOW: every !grab within the window ENTERS the viewer; when the window closes
// a single winner is drawn and gets the single item — so a drop never mints
// duplicates no matter how many people grab. Entries are recorded per-user so a
// duplicated/echoed !grab enters a viewer exactly once.

import { database, PATHS } from './firebase.js';
import { pickWinner } from '../rules/loot.js';
import { addLoot } from './players.js';
import { getItem } from '../content/items.js';
import { config } from '../config.js';

/**
 * Publish a new active drop, replacing any current one. Visible to clients
 * (read-only) so the site can show it too. A fresh drop starts with no entrants.
 * @param {string} itemId
 * @returns {Promise<{ itemId: string, rarity: string, name: string, expiresAt: number }>}
 */
export async function setDrop(itemId) {
  const item = getItem(itemId);
  if (!item) throw new Error(`unknown item: ${itemId}`);
  const expiresAt = Date.now() + config.loot.windowMs;
  const drop = { itemId, rarity: item.rarity, name: item.name, expiresAt, entries: {} };
  await database().ref(PATHS.dropActive()).set(drop);
  return { itemId, rarity: item.rarity, name: item.name, expiresAt };
}

/** Read the active (open, undrawn) drop, or null. */
export async function getActiveDrop() {
  const snap = await database().ref(PATHS.dropActive()).get();
  const drop = snap.val();
  if (!drop) return null;
  if (drop.drawnAt) return null; // already drawn
  if (typeof drop.expiresAt === 'number' && drop.expiresAt <= Date.now()) return null;
  return drop;
}

/**
 * Enter the active drop's lottery. Idempotent per user (one entry per drop), so a
 * duplicated/echoed !grab counts once.
 * @param {{ userId: string, displayName?: string }} args
 * @returns {Promise<{ status: 'none'|'expired'|'already'|'entered', count?: number, item?: {name:string, rarity:string} }>}
 */
export async function enterDrop({ userId, displayName }) {
  const ref = database().ref(PATHS.dropActive());
  const snap = await ref.get();
  const drop = snap.val();
  if (!drop) return { status: 'none' };
  if (drop.drawnAt) return { status: 'expired' };
  if (typeof drop.expiresAt === 'number' && drop.expiresAt <= Date.now()) return { status: 'expired' };

  const item = { name: drop.name, rarity: drop.rarity };
  const res = await database()
    .ref(`${PATHS.dropActive()}/entries/${userId}`)
    .transaction((curr) => (curr == null ? { at: Date.now(), name: displayName || null } : undefined));
  if (!res.committed) return { status: 'already', item };

  const entries = (await ref.child('entries').get()).val() || {};
  return { status: 'entered', count: Object.keys(entries).length, item };
}

/**
 * Close the active drop and draw its single winner — called on a timer once the
 * window has expired. Atomically claims the draw (so only one tick/instance ever
 * draws a given drop), picks one winner uniformly, and awards the one item.
 * Returns null when there is nothing to draw (no drop, window still open, or
 * already drawn).
 * @param {{ rng?: () => number }} [opts]
 * @returns {Promise<null | { itemId: string, item: object|null, winner: {userId:string, name:string|null}|null, count: number }>}
 */
export async function drawActiveDrop({ rng = Math.random } = {}) {
  const ref = database().ref(PATHS.dropActive());
  const now = Date.now();
  let claimed = false;
  const res = await ref.transaction((curr) => {
    if (curr == null) return null; // empty cache → refetch+retry (or no-op if truly absent)
    if (curr.drawnAt || (typeof curr.expiresAt === 'number' && curr.expiresAt > now)) {
      claimed = false;
      return undefined; // already drawn, or window still open → abort
    }
    claimed = true;
    return { ...curr, drawnAt: now };
  });
  if (!claimed || !res.committed || !res.snapshot.exists()) return null;

  const drop = res.snapshot.val();
  const entries = drop.entries || {};
  const item = getItem(drop.itemId);
  const itemOut = item ? { ...item, id: drop.itemId } : null;

  const winnerId = pickWinner(entries, rng);
  if (!winnerId) {
    return { itemId: drop.itemId, item: itemOut, winner: null, count: 0 };
  }
  await addLoot(winnerId, drop.itemId);
  const winner = { userId: winnerId, name: entries[winnerId]?.name || null };
  await ref.child('winner').set(winner); // record the result for the website
  return { itemId: drop.itemId, item: itemOut, winner, count: Object.keys(entries).length };
}
