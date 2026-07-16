// Item catalog → Firebase seed. The static gear catalog (src/content/items.js)
// is the SINGLE source of truth; this projects it into `items/<id>` (client-READ,
// Admin-write) on boot so the website's /items/ Compendium renders the exact data
// the raid engine uses — no second copy to drift (cf. seedCuratedFacts in
// src/db/facts.js). Idempotent: item ids ARE the keys, so writes upsert in place
// and any id dropped from the catalog is pruned. Runs every boot; non-fatal.

import { database, PATHS } from './firebase.js';
import { ITEMS } from '../content/items.js';

/**
 * Display "set" bucket derived from the immutable item id (ids are stable — see
 * items.js). Starter gear vs each season, for the Compendium's set filter.
 * @param {string} id
 * @returns {string}
 */
export function setForItemId(id) {
  if (String(id).startsWith('itm_starter_')) return 'Starter';
  const m = /^itm_s(\d+)_/.exec(id);
  if (m) return `Season ${m[1]}`;
  return 'Other';
}

/**
 * The catalog projected to display rows (ordered as authored). Pure — no I/O —
 * so both seedCatalog() and scripts/export-catalog.mjs share one projection.
 * Each row carries the engine fields ({slot,rarity,role,bonuses}) plus display
 * helpers ({set, order}); `id` lives on the row here (it's the KEY in Firebase).
 * @returns {Array<{id:string,name:string,slot:string,rarity:string,role:string,bonuses:object,set:string,order:number}>}
 */
export function catalogRows() {
  let order = 0;
  return Object.entries(ITEMS).map(([id, it]) => ({
    id,
    name: it.name,
    slot: it.slot,
    rarity: it.rarity,
    role: it.role,
    bonuses: it.bonuses,
    set: setForItemId(id),
    order: order++,
  }));
}

/**
 * Upsert the whole item catalog into `items/` so the site's Compendium and the
 * game engine share ONE source. Idempotent — item ids are the keys, so re-seeding
 * overwrites in place and catalog removals are pruned (nothing else writes items/).
 * @returns {Promise<{count:number}>}
 */
export async function seedCatalog() {
  const ref = database().ref(PATHS.items());
  const existing = (await ref.get()).val() || {};
  const updates = {};
  for (const { id, ...rest } of catalogRows()) {
    updates[id] = rest;
  }
  // Prune ids no longer in the catalog.
  for (const key of Object.keys(existing)) {
    if (!(key in updates)) updates[key] = null;
  }
  await ref.update(updates);
  return { count: Object.keys(ITEMS).length };
}
