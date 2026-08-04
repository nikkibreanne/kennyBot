// OKRA FACTS moderation (/info/ page). Viewers suggest facts via `!fact suggest`;
// a mod approves. Submissions live in an admin-only moderation queue
// (`factSubmissions/<id>`) keyed by a short atomic counter so mods can reference
// them in chat (`!fact approve 7`). Approved facts are copied to `facts/<pushId>`
// — client-READ-ONLY — which the website renders. All writes are Admin-SDK only.

import { database, PATHS, SERVER_TIMESTAMP } from './firebase.js';
import { CURATED_FACTS } from '../content/facts.js';

const MIN_LEN = 3;
const MAX_LEN = 200;

// Stable key for a curated fact by its 1-based position (curated-01, curated-02…).
// Fixed keys make the seed an idempotent UPSERT — re-running never duplicates.
const curatedKey = (i) => `curated-${String(i + 1).padStart(2, '0')}`;

/**
 * Upsert the curated fun facts (../content/facts.js) into `facts/` so `!fact` and
 * the /info/ page share ONE source. Idempotent: fixed keys overwrite in place, and
 * curated-* keys beyond the current list are pruned (so the list can shrink). Runs
 * on every boot. Curated facts carry `source:'curated'` + an `order` (stable
 * display) and have no `by` attribution.
 * @returns {Promise<{count:number}>}
 */
export async function seedCuratedFacts() {
  const ref = database().ref(PATHS.facts());
  const existing = (await ref.get()).val() || {};
  const updates = {};
  CURATED_FACTS.forEach((text, i) => {
    updates[curatedKey(i)] = { text, source: 'curated', order: i + 1 };
  });
  // Prune orphaned curated-* entries if the canonical list got shorter.
  for (const key of Object.keys(existing)) {
    if (key.startsWith('curated-') && !(key in updates)) updates[key] = null;
  }
  await ref.update(updates);
  return { count: CURATED_FACTS.length };
}

/** Normalize submitted text: collapse whitespace, trim. */
export function cleanFactText(raw) {
  return String(raw || '').replace(/\s+/g, ' ').trim();
}

/**
 * Queue a viewer's fact suggestion for moderation.
 * @returns {Promise<{ ok: true, id: number } | { ok: false, reason: string }>}
 */
export async function suggestFact({ userId, login, displayName, text }) {
  const clean = cleanFactText(text);
  if (clean.length < MIN_LEN) return { ok: false, reason: 'too-short' };
  if (clean.length > MAX_LEN) return { ok: false, reason: 'too-long' };

  const counter = await database().ref(PATHS.factCounter()).transaction((n) => (n || 0) + 1);
  const id = counter.snapshot.val();
  await database().ref(PATHS.factSubmission(id)).set({
    text: clean,
    by: displayName || login || 'anon',
    byId: String(userId),
    login: login || null,
    status: 'pending',
    at: SERVER_TIMESTAMP,
  });
  return { ok: true, id };
}

/** Pending suggestions (oldest first), for the mod queue. */
export async function listPendingFacts(limit = 10) {
  const snap = await database().ref(PATHS.factSubmissions()).get();
  const val = snap.val() || {};
  return Object.entries(val)
    .filter(([, f]) => f && f.status === 'pending')
    .map(([id, f]) => ({ id: Number(id), text: f.text, by: f.by }))
    .sort((a, b) => a.id - b.id)
    .slice(0, limit);
}

/**
 * Approve a pending suggestion: publish it to `facts/` and mark the submission.
 * @returns {Promise<{ ok: true, fact: {text,by} } | { ok: false, reason: string }>}
 */
export async function approveFact(id) {
  const subRef = database().ref(PATHS.factSubmission(id));
  const sub = (await subRef.get()).val();
  if (!sub) return { ok: false, reason: 'not-found' };
  if (sub.status === 'approved') return { ok: false, reason: 'already-approved' };

  const factRef = database().ref(PATHS.facts()).push();
  await factRef.set({ text: sub.text, by: sub.by || null, at: SERVER_TIMESTAMP });
  await subRef.update({ status: 'approved', factId: factRef.key });
  return { ok: true, fact: { text: sub.text, by: sub.by } };
}

/** Reject a pending suggestion (kept as audit, status flipped). */
export async function rejectFact(id) {
  const subRef = database().ref(PATHS.factSubmission(id));
  const sub = (await subRef.get()).val();
  if (!sub) return { ok: false, reason: 'not-found' };
  await subRef.update({ status: 'rejected' });
  return { ok: true, text: sub.text };
}

/**
 * The /info/ page's display order, mirrored EXACTLY: curated facts first in their
 * seeded `order`, then viewer submissions newest-first.
 *
 * This is a duplicate of `sortFacts` in the website's `_includes/info.html`, and it
 * has to stay one — `!fact <n>` promises the number a viewer can see on the page,
 * and the page numbers its `<ol>` positionally, storing no number anywhere. If the
 * two orderings drift, `!fact 3` starts quoting a different fact than the site
 * shows, silently. Change one, change the other.
 *
 * Pure and exported so it can be unit-tested without a database.
 */
export function sortFacts(facts) {
  return facts.slice().sort((a, b) => {
    const ca = a.source === 'curated';
    const cb = b.source === 'curated';
    if (ca && cb) return (a.order || 0) - (b.order || 0);
    if (ca !== cb) return ca ? -1 : 1;
    return (b.at || 0) - (a.at || 0);
  });
}

/** Every approved fact, in the same order the /info/ page numbers them. */
export async function orderedFacts() {
  const snap = await database().ref(PATHS.facts()).get();
  return sortFacts(Object.values(snap.val() || {}).filter((f) => f && f.text));
}

/**
 * The fact shown as **#n** on /info/ (1-based).
 * @returns {Promise<{ fact: object|null, number?: number, total: number }>}
 *   `fact` is null when n is out of range; `total` always lets the caller say
 *   what the valid range is instead of guessing for the viewer.
 */
export async function factByNumber(n) {
  const facts = await orderedFacts();
  if (!Number.isInteger(n) || n < 1 || n > facts.length) return { fact: null, total: facts.length };
  return { fact: facts[n - 1], number: n, total: facts.length };
}

/**
 * A random approved fact — carrying the number it shows as on /info/, so the
 * numbering is discoverable from chat without visiting the page.
 * @returns {Promise<(object & { number: number, total: number })|null>}
 */
export async function randomApprovedFact() {
  const facts = await orderedFacts();
  if (!facts.length) return null;
  const i = Math.floor(Math.random() * facts.length);
  return { ...facts[i], number: i + 1, total: facts.length };
}
