// MEDIA SLOT persistence for `!media`. The decisions — what a valid slot number
// is, what a usable OBS name is, which actions exist — are pure and live in
// src/rules/media.js; this file only reads and writes them.
//
// There is no seed file, and that is deliberate. Every other config in this bot
// ships sensible defaults, but a default slot would name an OBS source that
// exists on no particular machine, and a slot pointing at nothing fails at the
// worst possible moment: live, in front of chat. Slots start empty and get
// mapped from `!media inputs`, which asks OBS what it actually has.

import { getMediaSlots, setMediaSlot, clearMediaSlot } from './configStore.js';
import { sortSlots, validateMapping, slotInputs, MAX_PARTS } from '../rules/media.js';

export { getMediaSlots, clearMediaSlot };

/** Slots as a number-sorted list, each with its `n`. The order `!media` prints. */
export function listSlots() {
  return sortSlots(getMediaSlots());
}

/** One slot by number, or null. An entry with no source to fire is not a slot. */
export function getSlot(n) {
  const slot = getMediaSlots()[String(n)];
  return slot && slotInputs(slot).length ? { ...slot, n: Number(n) } : null;
}

/**
 * Map a slot to an OBS input. Creating and re-pointing are the same operation.
 * @param {number} n
 * @param {{inputs?: string[]|string, scene?: string|null, action?: string, label?: string|null}} edit
 * @returns {Promise<{ok:true,slot:object}|{ok:false,reason:string}>}
 */
export async function mapSlot(n, edit) {
  const res = validateMapping(edit);
  if (!res.ok) return res;
  // Refuse a patch that would leave a slot with no source to play — an entry
  // that exists but can't fire reads as "mapped" in the list and isn't.
  if (!res.patch.inputs && !getSlot(n)) return { ok: false, reason: 'unmapped' };
  const slot = await setMediaSlot(n, res.patch);
  return { ok: true, slot: { ...slot, n } };
}

/**
 * Append a source to a slot, so a GIF and its sound become one alert without
 * retyping both names. Writes the WHOLE list rather than pushing a child: RTDB
 * stores arrays as numeric-keyed objects, and a partial write is how you get a
 * sparse one that reads back with holes.
 * @returns {Promise<{ok:true,slot:object}|{ok:false,reason:string}>}
 */
export async function addInput(n, name) {
  const cur = getSlot(n);
  if (!cur) return { ok: false, reason: 'unmapped' };
  const next = [...slotInputs(cur), String(name ?? '')];
  if (next.length > MAX_PARTS) return { ok: false, reason: 'too-many-parts' };
  return mapSlot(n, { inputs: next });
}
