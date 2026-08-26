// Item catalog → Firebase seed. The static gear catalog (src/content/items.js)
// is the SINGLE source of truth; this projects it into `items/<id>` (client-READ,
// Admin-write) on boot so the website's /items/ Compendium renders the exact data
// the raid engine uses (cf. seedCuratedFacts in src/db/facts.js). Idempotent:
// item ids ARE the keys, so writes upsert in place and any id dropped from the
// catalog is pruned. Runs every boot; non-fatal.
//
// This node is the ONLY thing the Compendium reads. The site used to also ship a
// build-time copy of the catalog as a fallback, which meant a site deploy could
// carry a NEWER catalog than the database it rendered — the page then showed the
// older one with no symptom at all (it sat at 72 items after the 699-item
// expansion shipped, looking healthy). One copy, one failure mode you can see.
//
// So: A CATALOG CHANGE IS A BOT DEPLOY. Edit items.js, ship the bot, and the
// page updates live — no site rebuild involved.

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

/** Browse order for the Compendium's default sort. */
const SET_ORDER = ['Starter', 'Season 1', 'Season 2', 'Season 3', 'Other'];
const RARITY_ORDER = ['common', 'uncommon', 'rare', 'epic', 'legendary'];
const ROLE_ORDER = ['tank', 'healer', 'dps'];
const SLOT_ORDER = ['weapon', 'armor', 'trinket'];
const rank = (list, v) => {
  const i = list.indexOf(v);
  return i === -1 ? list.length : i;
};

/**
 * The catalog projected to display rows, in browse order. Pure — no I/O — so
 * seedCatalog() is its only consumer.
 * Each row carries the engine fields ({slot,rarity,role,bonuses}) plus display
 * helpers ({set, order}); `id` lives on the row here (it's the KEY in Firebase).
 * @returns {Array<{id:string,name:string,slot:string,rarity:string,role:string,bonuses:object,set:string,order:number}>}
 */
export function catalogRows() {
  // `order` drives the site's default "Set order" sort, so it is an EXPLICIT
  // browse order (set → rarity → role → slot → name), not the order the catalog
  // object happens to be built in. Otherwise the generated pyramid and the
  // hand-authored entries interleave by construction accident and a season's
  // ladder can't be read top to bottom.
  const rows = Object.entries(ITEMS).map(([id, it]) => ({
    id,
    name: it.name,
    slot: it.slot,
    rarity: it.rarity,
    role: it.role,
    bonuses: it.bonuses,
    set: setForItemId(id),
  }));

  rows.sort((a, b) =>
    rank(SET_ORDER, a.set) - rank(SET_ORDER, b.set) ||
    rank(RARITY_ORDER, a.rarity) - rank(RARITY_ORDER, b.rarity) ||
    rank(ROLE_ORDER, a.role) - rank(ROLE_ORDER, b.role) ||
    rank(SLOT_ORDER, a.slot) - rank(SLOT_ORDER, b.slot) ||
    a.name.localeCompare(b.name));

  return rows.map((r, i) => ({ ...r, order: i }));
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
