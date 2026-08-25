// Undelivered announcements — "tell them next time they talk".
//
// THIS IS NOT A CLAIM QUEUE. The item is already theirs: `finishBattle` calls
// `addLoot` and it is in their bag before anything here runs. Nothing is held
// back, nothing expires, and the player never has to collect it. The only thing
// queued is the SENTENCE telling them it happened.
//
// That queue exists because raid rewards are paid with nobody required to be
// present: announcing once at resolve time reaches whoever happens to be in chat
// that minute and nobody else, so the people who actually earned gear routinely
// never found out they had it. The line is instead held until that player next
// says ANYTHING in chat — the one moment we know they're there — and said
// publicly, because other viewers seeing someone come back from a raid with loot
// is the cheapest advertising the raid has.
//
// Cost model: checking every chat message against RTDB would be a read per
// message per user. Instead this mirrors the (small, short-lived) `notices/`
// node into memory — exactly the pattern configStore uses — so the hot path is
// a Map lookup and only a real hit touches the database.

import { database, PATHS } from './firebase.js';

/** uid -> undelivered announcement. Mirrors `notices/`; empty until started. */
let mirror = new Map();
let started = false;

/**
 * Begin mirroring `notices/`. Idempotent. Safe to skip entirely — every read
 * below just reports "nothing pending", so a bot that never starts the mirror
 * simply doesn't deliver notices rather than breaking chat.
 */
export async function startNoticeMirror(logger = console) {
  if (started) return;
  started = true;
  const ref = database().ref(PATHS.notices());
  const snap = await ref.get();
  mirror = new Map(Object.entries(snap.val() || {}));
  ref.on(
    'value',
    (s) => { mirror = new Map(Object.entries(s.val() || {})); },
    (err) => logger.error?.('notice mirror failed', { err: String(err) }),
  );
  return mirror.size;
}

/** Test seam: prime the mirror without RTDB. */
export function primeNoticesForTest(entries) {
  mirror = new Map(Object.entries(entries || {}));
}

/** Cheap enough for every chat message: is anything waiting for this user? */
export function hasNotice(userId) {
  return mirror.has(String(userId));
}

/** How many announcements are still undelivered (logging / diagnostics). */
export function undeliveredCount() {
  return mirror.size;
}

/**
 * Queue the announcement for a player who has ALREADY been given their item.
 * Overwrites any previous one — someone who misses two raids before chatting
 * hears about the most recent, not a backlog (chat is not an inbox). Losing a
 * notice costs nothing but the sentence; the gear is unaffected either way.
 * @param {string} userId
 * @param {object} notice
 */
export async function setNotice(userId, notice) {
  await database().ref(PATHS.notice(userId)).set({ ...notice, at: Date.now() });
}

/**
 * Take this player's undelivered announcement, exactly once, and remove it. The
 * delete is a TRANSACTION so two near-simultaneous messages (or two bot
 * instances) can't both say it — the loser sees null. Returns it, or null.
 * @param {string} userId
 * @returns {Promise<object|null>}
 */
export async function takeNotice(userId) {
  const uid = String(userId);
  if (!mirror.has(uid)) return null; // fast path — no round trip
  let claimed = null;
  const res = await database().ref(PATHS.notice(uid)).transaction((curr) => {
    if (curr == null) return null; // already taken (or empty cache → refetch)
    claimed = curr;
    return null; // delete
  });
  if (!res.committed) return null;
  mirror.delete(uid); // don't wait for the listener to catch up
  return claimed;
}

/** Drop every undelivered line (season rollover — last season's news is stale). */
export async function clearAllNotices() {
  await database().ref(PATHS.notices()).remove();
  mirror = new Map();
}
