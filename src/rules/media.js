// MEDIA SLOTS — the pure half of `!media`: the vocabulary, the parsing, and the
// validation that decides whether a mapping is worth writing.
//
// Pure on purpose, like every other src/rules module: no config import, no RTDB,
// no OBS. That's what lets the whole of it run in the offline suite, and it's
// where every rule that has bitten us in chat gets a test.
//
// A SLOT is `{ input, scene?, action?, label? }`:
//   input   the OBS source name, character for character as OBS spells it
//   scene   optional — a scene to reveal that source in before playing it
//   action  what "trigger" means for this slot (default: restart)
//   label   optional human name, so `!media` reads as more than numbers

/** The actions a mod can name. Encoded to obs-websocket's enum in obsMedia.js. */
export const MEDIA_ACTIONS = ['restart', 'play', 'pause', 'stop', 'next', 'previous'];

/**
 * The alert-shaped default. `restart` plays from the first frame whether the
 * source is idle, mid-playback or already finished — `play` does nothing at all
 * on a source that has ended, which is exactly the state an alert is usually in.
 */
export const DEFAULT_ACTION = 'restart';

/** Highest slot number — bounded so a fat-fingered `!media set 99999` can't sprawl. */
export const MAX_SLOT = 20;

/** A sanity bound on OBS names, not an OBS limit. */
export const MAX_NAME_LEN = 100;

/** True when `a` is an action a mod may name. */
export function isAction(a) {
  return MEDIA_ACTIONS.includes(String(a || '').toLowerCase());
}

/**
 * Parse a slot number from chat.
 *
 * Strict digits only: `parseInt` would turn "1.5" into 1 and "2x" into 2, quietly
 * mapping a slot the mod did not name. Refusing is the only safe reading.
 *
 * @returns {number|null} 1..MAX_SLOT, or null
 */
export function parseSlot(raw) {
  const s = String(raw ?? '').trim();
  if (!/^\d{1,3}$/.test(s)) return null;
  const n = Number(s);
  return n >= 1 && n <= MAX_SLOT ? n : null;
}

/**
 * Collapse whitespace in an OBS name and bound its length.
 * @returns {string|null} null when empty or too long
 */
export function cleanName(raw) {
  const name = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!name) return null;
  return name.length > MAX_NAME_LEN ? null : name;
}

/**
 * Validate a mapping edit and return the exact patch to persist.
 *
 * `scene: null` explicitly CLEARS the scene, which is different from omitting it
 * (leave as-is) — so the caller distinguishes "stop revealing this" from "don't
 * touch that field". Same three-state contract the reminder edits use.
 *
 * @param {{input?: string, scene?: string|null, action?: string, label?: string|null}} edit
 * @returns {{ok: true, patch: object} | {ok: false, reason: string}}
 */
export function validateMapping(edit = {}) {
  const patch = {};

  if (edit.input !== undefined) {
    const input = cleanName(edit.input);
    if (!input) return { ok: false, reason: 'bad-input' };
    patch.input = input;
  }

  if (edit.scene !== undefined) {
    if (edit.scene === null) {
      patch.scene = null;
    } else {
      const scene = cleanName(edit.scene);
      if (!scene) return { ok: false, reason: 'bad-scene' };
      patch.scene = scene;
    }
  }

  if (edit.action !== undefined) {
    const action = String(edit.action || '').toLowerCase();
    if (!isAction(action)) return { ok: false, reason: 'bad-action' };
    patch.action = action;
  }

  if (edit.label !== undefined) {
    patch.label = edit.label === null ? null : cleanName(edit.label);
    if (edit.label !== null && !patch.label) return { ok: false, reason: 'bad-label' };
  }

  return { ok: true, patch };
}

/**
 * Slot records → a number-sorted list. RTDB hands back STRING keys, so a plain
 * sort puts slot 10 between 1 and 2.
 * @param {Record<string, object>} slots
 */
export function sortSlots(slots = {}) {
  return Object.entries(slots)
    .filter(([, slot]) => slot && typeof slot === 'object' && slot.input)
    .map(([n, slot]) => ({ ...slot, n: Number(n) }))
    .sort((a, b) => a.n - b.n);
}

/** One-liner for chat: `3 airhorn → "Airhorn SFX" in "Alerts" (stop)`. */
export function describeSlot(slot) {
  const bits = [String(slot.n)];
  if (slot.label) bits.push(slot.label);
  bits.push(`→ "${slot.input}"`);
  if (slot.scene) bits.push(`in "${slot.scene}"`);
  // The default is the overwhelmingly common case; printing it on every line
  // would bury the one slot that differs.
  const action = slot.action || DEFAULT_ACTION;
  if (action !== DEFAULT_ACTION) bits.push(`(${action})`);
  return bits.join(' ');
}
