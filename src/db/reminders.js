// REMINDERS persistence. The schedules themselves are DATA at
// config/reminders/<id> — seeded once from src/content/reminders.js and edited
// from chat with `!reminder` — so changing when Ghosty eats never needs a
// deploy. The decision of what's due is pure and lives in src/rules/reminders.js.
//
// Seeding is idempotent and NEVER clobbers: a record that already exists is left
// exactly as the mods left it, the same contract the fact and item-catalog seeds
// follow. That's what makes an edited time survive the next release.

import { database, PATHS } from './firebase.js';
import { getReminders, patchReminder, setReminderState } from './configStore.js';
import { DEFAULT_REMINDERS } from '../content/reminders.js';
import { parseClock, normalizeChannel } from '../rules/reminders.js';
import { config } from '../config.js';

export { getReminders, patchReminder, setReminderState };

/**
 * Create any missing default reminder. Existing ids are untouched.
 * @returns {Promise<{seeded: string[], kept: string[]}>}
 */
export async function seedReminders(defaults = DEFAULT_REMINDERS) {
  const seeded = [];
  const kept = [];
  for (const def of defaults) {
    // Returning undefined ABORTS the transaction — the existing record isn't
    // even rewritten, so a mod's edited times can't be lost to a race here.
    const res = await database().ref(PATHS.reminder(def.id)).transaction((cur) => (cur == null ? def : undefined));
    (res.committed ? seeded : kept).push(def.id);
  }
  return { seeded, kept };
}

/** One reminder by id (from the mirror), or undefined. */
export function getReminder(id) {
  return getReminders()[id];
}

/** Reminder records as a stable, id-sorted list — the order `!reminder` prints. */
export function listReminders() {
  return Object.entries(getReminders())
    .filter(([, r]) => r && typeof r === 'object')
    .map(([id, r]) => ({ ...r, id: r.id || id }))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

/** Collapse whitespace and clip an announcement to something chat-sized. */
export function cleanText(raw) {
  const text = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length > config.reminders.maxTextLen
    ? `${text.slice(0, config.reminders.maxTextLen - 1)}…`
    : text;
}

/**
 * Validate + apply a schedule edit from chat. Returns the reason a change was
 * refused rather than writing something the scheduler would silently ignore.
 * @param {string} id
 * @param {{times?: string[], leadMs?: number, everyMs?: number, jitterMs?: number,
 *          afterMs?: number, text?: string, leadText?: string, enabled?: boolean,
 *          channel?: string|null, timeZone?: string}} patch
 * @returns {Promise<{ok:true,reminder:object}|{ok:false,reason:string}>}
 */
export async function editReminder(id, patch) {
  const cur = getReminder(id);
  if (!cur) return { ok: false, reason: 'unknown' };

  if (patch.times) {
    if (!patch.times.length) return { ok: false, reason: 'no-times' };
    for (const t of patch.times) if (parseClock(t) == null) return { ok: false, reason: `bad-time:${t}` };
  }
  if (patch.timeZone && !isValidTimeZone(patch.timeZone)) return { ok: false, reason: 'bad-zone' };
  for (const key of ['leadMs', 'everyMs', 'jitterMs', 'afterMs']) {
    if (patch[key] == null) continue;
    if (!Number.isFinite(patch[key]) || patch[key] < 0) return { ok: false, reason: `bad-${key}` };
  }
  if (patch.everyMs != null && patch.everyMs < 60_000) return { ok: false, reason: 'too-often' };

  const next = { ...patch };
  if (patch.channel !== undefined) next.channel = patch.channel ? normalizeChannel(patch.channel) : null;
  // A schedule change invalidates what was already scheduled off the old one.
  if (patch.everyMs != null || patch.jitterMs != null) next.state = { ...(cur.state || {}), nextAt: null };

  const reminder = await patchReminder(id, next);
  return { ok: true, reminder };
}

/** True when the runtime actually knows this IANA zone (a typo must not stick). */
export function isValidTimeZone(timeZone) {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone });
    return true;
  } catch {
    return false;
  }
}
