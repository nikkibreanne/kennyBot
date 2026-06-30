// Player persistence (IMPLEMENTATION §G). All mutations go through RTDB
// transactions so a duplicated/echoed chat message can never double-award
// (idempotency, spec §6). The pure rules engine decides the math; this layer
// applies it atomically.

import { database, increment, PATHS } from './firebase.js';
import { roleForClass, CLASSES } from '../content/classes.js';
import { rollStarterEquipped, itemObject, getItem, SLOTS } from '../content/items.js';
import { applyChatExp } from '../rules/leveling.js';
import { engagementMultiplier, roleRating, contribution } from '../rules/rating.js';
import { config } from '../config.js';

/** Read a player record (or null). */
export async function getPlayer(userId) {
  const snap = await database().ref(PATHS.player(userId)).get();
  return snap.val();
}

/**
 * Create a character if one doesn't exist (spec §5.5). Atomic: a racing double
 * !create commits exactly one record. Also writes the usernames index (UI
 * contract refinement #2) so the site can map login → id.
 *
 * @param {{ userId: string, login: string, displayName: string, className: string }} args
 * @returns {Promise<{ created: boolean, player: object }>}
 */
export async function createPlayer({ userId, login, displayName, className, isSubscriber }) {
  if (!CLASSES[className]) throw new Error(`unknown class: ${className}`);
  const role = roleForClass(className);
  const now = Date.now();

  const fresh = {
    displayName,
    login: String(login).toLowerCase(),
    createdAt: now,
    class: className,
    role,
    level: 1,
    exp: 0,
    levelPressure: 0,
    subTier: isSubscriber ? 1 : 0, // exact 2/3 refined by sub events / Helix lookup
    subMonths: 0,
    renown: 0, // veteran reputation (persists across seasons; §5.6)
    lastExpAt: 0,
    equipped: rollStarterEquipped(role),
    inventory: [],
    stats: { messages: 0, lootClaimed: 0, raidsParticipated: 0, seasonsPlayed: 0 },
  };

  const ref = database().ref(PATHS.player(userId));
  const res = await ref.transaction((curr) => (curr == null ? fresh : undefined));

  if (res.committed) {
    // Maintain the login → id index under the same client-read-only rules.
    await database().ref(PATHS.username(fresh.login)).set(userId);
    return { created: true, player: res.snapshot.val() };
  }
  // Aborted because the player already existed.
  return { created: false, player: res.snapshot.val() };
}

/**
 * Apply one qualifying chat message: grant EXP and roll a level-up,
 * atomically. Returns null if the user has no character (non-players don't
 * accrue). The cooldown is enforced by the caller (in-memory, single instance).
 *
 * @param {string} userId
 * @param {{ rng?: () => number }} [opts]
 * @returns {Promise<null | { player: object, leveledUp: boolean, fromLevel: number, toLevel: number }>}
 */
export async function applyChatTick(userId, { rng = Math.random, isSubscriber } = {}) {
  const ref = database().ref(PATHS.player(userId));
  let result = null;

  const res = await ref.transaction((curr) => {
    // RTDB calls the handler with null first (empty local cache). Return null
    // (NOT undefined) so it fetches server data and retries; a truly-absent
    // player commits a null no-op and is filtered out below.
    if (curr == null) return null;
    // Keep subTier current from live chat status: any active sub gets at least
    // tier 1 (preserving a higher exact tier learned from a sub event); a lapsed
    // sub drops to 0. `undefined` (status unknown this call) leaves it untouched.
    const subTier =
      isSubscriber === undefined
        ? curr.subTier || 0
        : isSubscriber
          ? Math.max(curr.subTier || 0, 1)
          : 0;
    const mult = engagementMultiplier({ ...curr, subTier }, config);
    const rolled = applyChatExp(
      { level: curr.level, exp: curr.exp, levelPressure: curr.levelPressure },
      { engagementMult: mult, rng, config },
    );
    result = {
      leveledUp: rolled.leveledUp,
      fromLevel: rolled.fromLevel,
      toLevel: rolled.toLevel,
    };
    const stats = curr.stats || { messages: 0, lootClaimed: 0, raidsParticipated: 0 };
    return {
      ...curr,
      subTier,
      level: rolled.level,
      exp: rolled.exp,
      levelPressure: rolled.levelPressure,
      lastExpAt: Date.now(),
      stats: { ...stats, messages: (stats.messages || 0) + 1 },
    };
  });

  if (!res.committed || !res.snapshot.exists()) return null;
  return { player: res.snapshot.val(), ...result };
}

/**
 * Equip an item from the player's inventory into its slot (spec §11). Validates
 * ownership and slot (untrusted input — IMPLEMENTATION §G). Atomic swap: any
 * previously-equipped item returns to the inventory.
 *
 * @returns {Promise<{ ok: boolean, reason?: string, player?: object, item?: object }>}
 */
export async function equipItem(userId, itemId) {
  const item = getItem(itemId);
  if (!item || !SLOTS.includes(item.slot)) return { ok: false, reason: 'unknown-item' };
  const itemObj = itemObject(itemId);

  const ref = database().ref(PATHS.player(userId));
  let outcome = { ok: false, reason: 'unknown' };

  const res = await ref.transaction((curr) => {
    if (curr == null) { outcome = { ok: false, reason: 'no-character' }; return null; }
    const inventory = Array.isArray(curr.inventory) ? [...curr.inventory] : [];
    const idx = inventory.indexOf(itemId);
    if (idx === -1) { outcome = { ok: false, reason: 'not-owned' }; return; } // abort

    inventory.splice(idx, 1);
    const equipped = { ...(curr.equipped || {}) };
    const previous = equipped[item.slot];
    // equipped slots store denormalized item OBJECTS; a previous item returns to
    // the bag as its id.
    if (previous) inventory.push(typeof previous === 'string' ? previous : previous.id);
    equipped[item.slot] = itemObj;

    outcome = { ok: true };
    return { ...curr, inventory, equipped };
  });

  if (outcome.ok && res.committed) {
    return { ok: true, player: res.snapshot.val(), item };
  }
  return outcome;
}

/**
 * Bare an equipped slot — by slot name (weapon/armor/trinket) or by the equipped
 * item's name — returning the item to the bag. Atomic.
 * @returns {Promise<{ ok: boolean, reason?: string, item?: {name:string,slot:string}, player?: object }>}
 */
export async function unequipItem(userId, slotOrName) {
  const input = String(slotOrName || '').trim().toLowerCase();
  const ref = database().ref(PATHS.player(userId));
  let outcome = { ok: false, reason: 'unknown' };

  const res = await ref.transaction((curr) => {
    if (curr == null) { outcome = { ok: false, reason: 'no-character' }; return null; }
    const equipped = { ...(curr.equipped || {}) };
    let slot = SLOTS.includes(input) ? input : null;
    if (!slot) slot = SLOTS.find((s) => equipped[s] && String(equipped[s].name || '').toLowerCase() === input) || null;
    if (!slot) { outcome = { ok: false, reason: 'not-found' }; return; } // abort
    const item = equipped[slot];
    if (!item) { outcome = { ok: false, reason: 'empty' }; return; } // abort

    const inventory = Array.isArray(curr.inventory) ? [...curr.inventory] : [];
    inventory.push(typeof item === 'string' ? item : item.id);
    equipped[slot] = null;
    outcome = { ok: true, item: { name: typeof item === 'string' ? item : item.name, slot } };
    return { ...curr, equipped, inventory };
  });

  if (outcome.ok && res.committed) return { ...outcome, player: res.snapshot.val() };
  return outcome;
}

/**
 * Award a claimed/looted item: append to inventory + bump lootClaimed (atomic).
 * Returns the new lootClaimed count, or null if no character.
 */
export async function addLoot(userId, itemId) {
  const ref = database().ref(PATHS.player(userId));
  let lootClaimed = null;
  const res = await ref.transaction((curr) => {
    if (curr == null) return null; // null (not undefined) → retry on real data
    const inventory = Array.isArray(curr.inventory) ? [...curr.inventory, itemId] : [itemId];
    const stats = curr.stats || { messages: 0, lootClaimed: 0, raidsParticipated: 0 };
    lootClaimed = (stats.lootClaimed || 0) + 1;
    return { ...curr, inventory, stats: { ...stats, lootClaimed } };
  });
  if (!res.committed || !res.snapshot.exists()) return null;
  return lootClaimed;
}

/**
 * Season rollover (spec §5.6): reset every hero's GEAR (re-roll starter, clear
 * the bag) so a new tier starts fresh and newcomers aren't behind — but KEEP
 * level + renown, and award prestige renown for the season cleared. Returns the
 * number of heroes rolled over.
 * @param {{ prestigeRenown?: number }} [opts]
 */
export async function rolloverAllPlayers({ prestigeRenown = 3 } = {}) {
  const snap = await database().ref('players').get();
  const players = snap.val() || {};
  let count = 0;
  for (const [uid, p] of Object.entries(players)) {
    if (!p?.role) continue;
    await database().ref(PATHS.player(uid)).update({
      equipped: rollStarterEquipped(p.role),
      inventory: [],
      renown: (p.renown || 0) + prestigeRenown,
      'stats/seasonsPlayed': (p.stats?.seasonsPlayed || 0) + 1,
    });
    count += 1;
  }
  return count;
}

/**
 * Update a player's sub status so the engagement multiplier (spec §7) reflects
 * reality. Driven by tmi/twurple sub events (Phase 5). No-op if no character.
 * @param {string} userId
 * @param {{ subTier?: number, subMonths?: number }} status
 */
export async function setSubStatus(userId, { subTier, subMonths }) {
  const ref = database().ref(PATHS.player(userId));
  const res = await ref.transaction((curr) => {
    if (curr == null) return null; // null (not undefined) → retry on real data
    return {
      ...curr,
      subTier: typeof subTier === 'number' ? subTier : curr.subTier || 0,
      subMonths: typeof subMonths === 'number' ? subMonths : curr.subMonths || 0,
    };
  });
  return res.committed && res.snapshot.exists() ? res.snapshot.val() : null;
}

/**
 * Convenience: compute a player's current contribution snapshot (role rating +
 * engagement-scaled contribution) for display (!char) and raid writes.
 */
export function playerContribution(player) {
  return contribution(player, config, getItem);
}

/** Current role rating (base+level+gear) for display. */
export function playerRoleRating(player) {
  return roleRating(player, config, getItem);
}
