// MEDIA SLOTS — the pure half of `!media`: the vocabulary, the parsing, and the
// validation that decides whether a mapping is worth writing.
//
// Pure on purpose, like every other src/rules module: no config import, no RTDB,
// no OBS. That's what lets the whole of it run in the offline suite, and it's
// where every rule that has bitten us in chat gets a test.
//
// A SLOT is `{ inputs, scene?, action?, label? }`:
//   inputs  one or more OBS source names, fired together — OBS keeps a GIF and
//           its sound as separate sources, so one alert is usually two of them
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

/**
 * How many sources one slot may fire. A slot exists to make ONE alert out of the
 * pieces OBS keeps separate — a GIF and its sound — not to be a scene switcher.
 */
export const MAX_PARTS = 5;

/** What separates source names in `!media set 1 A | B`. OBS names contain spaces. */
export const PART_SEPARATOR = '|';

/** True when `a` is an action a mod may name. */
export function isAction(a) {
  return MEDIA_ACTIONS.includes(String(a || '').toLowerCase());
}

/**
 * The OBS sources a slot fires, in order, normalised from every shape the record
 * can legitimately have:
 *   - `inputs: ["A", "B"]`      the current form
 *   - `inputs: {0:"A", 1:"B"}`  the same thing after an RTDB round trip, which
 *                               stores arrays as numeric-keyed objects
 *   - `input: "A"`              a single-source slot
 * Normalising here means nothing downstream has to know which it got.
 * @returns {string[]}
 */
export function slotInputs(slot) {
  const raw = slot?.inputs ?? slot?.input;
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : typeof raw === 'object' ? Object.values(raw) : [raw];
  return list.map((s) => String(s ?? '').trim()).filter(Boolean);
}

/**
 * Split `A | B` into source names. All-or-nothing: one empty part rejects the
 * whole line, because a slot that silently drops half an alert is worse than one
 * that refuses to be created.
 * @returns {string[]|null}
 */
export function parseInputList(raw) {
  const parts = String(raw ?? '').split(PART_SEPARATOR).map(cleanName);
  if (!parts.length || parts.some((p) => !p)) return null;
  return parts;
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

  if (edit.inputs !== undefined) {
    const list = Array.isArray(edit.inputs) ? edit.inputs.map(cleanName) : parseInputList(edit.inputs);
    if (!list || !list.length || list.some((p) => !p)) return { ok: false, reason: 'bad-input' };
    if (list.length > MAX_PARTS) return { ok: false, reason: 'too-many-parts' };
    patch.inputs = list;
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
    .filter(([, slot]) => slot && typeof slot === 'object' && slotInputs(slot).length)
    .map(([n, slot]) => ({ ...slot, n: Number(n) }))
    .sort((a, b) => a.n - b.n);
}

/** One-liner for chat: `3 airhorn → "Airhorn GIF" + "Airhorn SFX" (stop)`. */
export function describeSlot(slot) {
  const bits = [String(slot.n)];
  if (slot.label) bits.push(slot.label);
  bits.push(`→ ${slotInputs(slot).map((i) => `"${i}"`).join(' + ')}`);
  if (slot.scene) bits.push(`in "${slot.scene}"`);
  // The default is the overwhelmingly common case; printing it on every line
  // would bury the one slot that differs.
  const action = slot.action || DEFAULT_ACTION;
  if (action !== DEFAULT_ACTION) bits.push(`(${action})`);
  return bits.join(' ');
}
