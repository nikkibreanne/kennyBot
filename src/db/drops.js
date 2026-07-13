// Active loot-drop persistence (spec §5.2). A drop is a LOTTERY over a claim
// WINDOW: every !loot within the window ENTERS the viewer; when the window closes
// a single winner is drawn and gets the single item — so a drop never mints
// duplicates no matter how many people grab.
//
// Overlapping drops QUEUE instead of clobbering each other: the open drop lives
// at `drops/active`, and any that land while it's open wait (FIFO) in
// `drops/queue`. When the active one is drawn, the next is promoted and its
// window opens — so N queued drops resolve back-to-back, one windowMs apart. At
// most `loot.maxQueue` can be lined up at once; drops past that are ignored.

import { database, PATHS } from './firebase.js';
import { pickWinner } from '../rules/loot.js';
import { addLoot } from './players.js';
import { getItem } from '../content/items.js';
import { config } from '../config.js';

/** Turn a waiting {itemId,rarity,name} into an OPEN drop (window + empty pool). */
function activate(meta, now) {
  return { itemId: meta.itemId, rarity: meta.rarity, name: meta.name, expiresAt: now + config.loot.windowMs, entries: {} };
}

/**
 * Enqueue a drop. Opens it immediately if nothing is active, otherwise lines it
 * up behind the current drop(s). Visible to clients (read-only) so the site can
 * show it too.
 * @param {string} itemId
 * @returns {Promise<{ status: 'open'|'queued'|'full', position: number, itemId: string, rarity: string, name: string }>}
 */
export async function setDrop(itemId) {
  const item = getItem(itemId);
  if (!item) throw new Error(`unknown item: ${itemId}`);
  const now = Date.now();
  const meta = { itemId, rarity: item.rarity, name: item.name };
  let outcome = { status: 'full', position: -1, ...meta };

  await database().ref(PATHS.dropsRoot()).transaction((curr) => {
    const cur = curr || {};
    const active = cur.active || null;
    const queue = Array.isArray(cur.queue) ? cur.queue.filter(Boolean) : [];
    if (!active) {
      // Nothing open → this drop opens right now.
      outcome = { status: 'open', position: 0, ...meta };
      return { ...cur, active: activate(meta, now), queue };
    }
    // Something is in the slot (open / closing / drawn-awaiting-promotion) → line
    // it up, unless the queue (active + waiting) is already at the cap.
    if (1 + queue.length >= config.loot.maxQueue) {
      outcome = { status: 'full', position: -1, ...meta };
      return; // abort — ignore the overflow drop
    }
    outcome = { status: 'queued', position: 1 + queue.length, ...meta };
    return { ...cur, active, queue: [...queue, meta] };
  });

  return outcome;
}

/** Read the active (open, undrawn) drop, or null. */
export async function getActiveDrop() {
  const snap = await database().ref(PATHS.dropActive()).get();
  const drop = snap.val();
  if (!drop || drop.drawnAt) return null;
  if (typeof drop.expiresAt === 'number' && drop.expiresAt <= Date.now()) return null;
  return drop;
}

/**
 * Enter the active drop's lottery. Idempotent per user (one entry per drop).
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
  const res = await ref
    .child(`entries/${userId}`)
    .transaction((curr) => (curr == null ? { at: Date.now(), name: displayName || null } : undefined));
  if (!res.committed) return { status: 'already', item };

  const entries = (await ref.child('entries').get()).val() || {};
  return { status: 'entered', count: Object.keys(entries).length, item };
}

/**
 * Tick: (1) draw the active drop if its window has closed, then (2) promote the
 * next queued drop. Called on a timer. The draw is atomically claimed so it
 * happens exactly once; promotion gives the next drop a fresh window.
 * @param {{ rng?: () => number }} [opts]
 * @returns {Promise<{ drawResult: null | { itemId, item, winner: {userId,name}|null, count: number },
 *                     activated: null | { itemId, rarity, name } }>}
 */
export async function processDrops({ rng = Math.random } = {}) {
  const now = Date.now();
  const activeRef = database().ref(PATHS.dropActive());

  // ── 1. Draw the active drop if its window has closed (atomic claim) ──
  let drewIt = false;
  const claim = await activeRef.transaction((a) => {
    if (a == null) return null; // empty cache → refetch (or no-op if truly absent)
    if (a.drawnAt) return undefined; // already drawn → abort
    if (typeof a.expiresAt === 'number' && a.expiresAt > now) return undefined; // still open → abort
    drewIt = true;
    return { ...a, drawnAt: now };
  });

  let drawResult = null;
  if (drewIt && claim.committed && claim.snapshot.exists()) {
    const drop = claim.snapshot.val();
    const entries = drop.entries || {};
    const item = getItem(drop.itemId);
    const itemOut = item ? { ...item, id: drop.itemId } : null;
    const winnerId = pickWinner(entries, rng);
    if (winnerId) {
      await addLoot(winnerId, drop.itemId);
      const winner = { userId: winnerId, name: entries[winnerId]?.name || null };
      await activeRef.child('winner').set(winner); // record the result for the site
      drawResult = { itemId: drop.itemId, item: itemOut, winner, count: Object.keys(entries).length };
    } else {
      drawResult = { itemId: drop.itemId, item: itemOut, winner: null, count: 0 };
    }
  }

  // ── 2. Promote the next queued drop once the active one is done ──
  let activated = null;
  await database().ref(PATHS.dropsRoot()).transaction((curr) => {
    if (curr === null) return null; // refetch / no-op if truly absent
    const active = curr.active || null;
    const queue = Array.isArray(curr.queue) ? curr.queue.filter(Boolean) : [];
    if (active && !active.drawnAt) return undefined; // still in progress → leave it
    if (!active && queue.length === 0) return undefined; // nothing to promote
    if (queue.length > 0) {
      const next = queue[0];
      activated = next;
      return { ...curr, active: activate(next, now), queue: queue.slice(1) };
    }
    return { ...curr, active: null, queue: [] }; // active drawn, nothing queued → free the slot
  });

  return { drawResult, activated };
}
