// Player persistence (IMPLEMENTATION §G). All mutations go through RTDB
// transactions so a duplicated/echoed chat message can never double-award
// (idempotency, spec §6). The pure rules engine decides the math; this layer
// applies it atomically.

import { database, increment, PATHS } from './firebase.js';
import { roleForClass, CLASSES } from '../content/classes.js';
import { starterEquipped, itemObject, getItem, SLOTS } from '../content/items.js';
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
export async function createPlayer({ userId, login, displayName, className }) {
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
    subTier: 0,
    subMonths: 0,
    lastExpAt: 0,
    equipped: starterEquipped(role),
    inventory: [],
    stats: { messages: 0, lootClaimed: 0, raidsParticipated: 0 },
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
 * Apply one qualifying chat message: grant EXP and pity-roll a level-up,
 * atomically. Returns null if the user has no character (non-players don't
 * accrue). The cooldown is enforced by the caller (in-memory, single instance).
 *
 * @param {string} userId
 * @param {{ rng?: () => number }} [opts]
 * @returns {Promise<null | { player: object, leveledUp: boolean, fromLevel: number, toLevel: number }>}
 */
export async function applyChatTick(userId, { rng = Math.random } = {}) {
  const ref = database().ref(PATHS.player(userId));
  let result = null;

  const res = await ref.transaction((curr) => {
    // RTDB calls the handler with null first (empty local cache). Return null
    // (NOT undefined) so it fetches server data and retries; a truly-absent
    // player commits a null no-op and is filtered out below.
    if (curr == null) return null;
    const mult = engagementMultiplier(curr, config);
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
