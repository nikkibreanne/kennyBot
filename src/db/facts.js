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

/** A random approved fact (for the bare `!fact` command), or null if none. */
export async function randomApprovedFact() {
  const snap = await database().ref(PATHS.facts()).get();
  const facts = Object.values(snap.val() || {}).filter((f) => f && f.text);
  if (!facts.length) return null;
  return facts[Math.floor(Math.random() * facts.length)];
}
