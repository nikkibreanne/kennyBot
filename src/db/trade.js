// TRADES — player-to-player swaps of items and/or credits, settled by a short
// negotiation. Because a player can't see another's bag, each side only ever
// stakes items from its OWN inventory: the opener puts something on the table,
// the target accepts / declines / COUNTERS (puts up their own stuff, flipping
// whose turn it is to respond), and so on until someone accepts or it expires.
//
// Bot-owned (Admin SDK only). One active trade per player (as either party), so
// accept/counter/decline need no target. Settlement is all-or-nothing and
// race-safe: per-player inventory TRANSACTIONS move items, the wallet API moves
// credits, and any failure reverses every step already applied. Credits are
// conserved — never minted (same stance as the market/duel).

import { database, PATHS } from './firebase.js';
import { getPlayer } from './players.js';
import { resolveOwnedItem, getItem } from '../content/items.js';
import { ensureWallet, debit, credit, getBalance } from './wallet.js';

// A trade stays open this long since its last activity (lazy TTL — checked on
// read/accept, never a timer). Longer than a duel: trades are a negotiation.
export const TRADE_TTL_MS = 5 * 60 * 1000;

/** Normalize a target token ("@Bob", "bob") to a bare lowercase login. */
export function cleanLogin(raw) {
  return String(raw || '').trim().replace(/^@+/, '').toLowerCase();
}

/** A trade is stale once older than the TTL since its last activity. */
function isExpired(trade, now) {
  return !trade || now - (trade.at || 0) >= TRADE_TTL_MS;
}

/** Empty stake (nothing on the table for a side yet). */
const emptyStake = () => ({ itemId: null, itemName: null, credits: 0 });

/** True if a stake actually puts something up. */
function stakeIsEmpty(s) {
  return !s || (!s.itemId && !(s.credits > 0));
}

/**
 * Validate + normalize one side's proposed stake against that player's CURRENT
 * inventory/balance. Reads the staker's live record.
 * @returns {Promise<{ok:true,stake:object}|{ok:false,reason:string,[k:string]:any}>}
 */
async function buildStake({ userId, login, name, itemRef, credits }) {
  const stake = emptyStake();

  const amt = credits == null ? 0 : Math.floor(Number(credits));
  if (credits != null && (!Number.isFinite(amt) || amt < 0)) return { ok: false, reason: 'bad-amount' };
  if (amt > 0) {
    const wallet = await ensureWallet({ userId, login, displayName: name });
    if ((wallet.balance || 0) < amt) return { ok: false, reason: 'insufficient', balance: wallet.balance || 0 };
    stake.credits = amt;
  }

  if (itemRef) {
    const player = await getPlayer(userId);
    if (!player) return { ok: false, reason: 'no-character' };
    const itemId = resolveOwnedItem(player.inventory, itemRef);
    if (!itemId) return { ok: false, reason: 'not-owned' };
    stake.itemId = itemId;
    stake.itemName = getItem(itemId)?.name || itemId;
  }

  if (stakeIsEmpty(stake)) return { ok: false, reason: 'empty' };
  return { ok: true, stake };
}

/** Remove both index pointers + the trade record in one atomic write. */
async function clearTrade(trade) {
  await database().ref().update({
    [PATHS.trade(trade.id)]: null,
    [PATHS.tradeIndex(trade.from.login)]: null,
    [PATHS.tradeIndex(trade.to.login)]: null,
  });
}

/**
 * The caller's live trade (or null; also null + tidied if expired).
 * @param {string} login
 */
export async function getTradeFor(login) {
  const key = cleanLogin(login);
  const id = (await database().ref(PATHS.tradeIndex(key)).get()).val();
  if (!id) return null;
  const trade = (await database().ref(PATHS.trade(id)).get()).val();
  if (isExpired(trade, Date.now())) {
    if (trade) await clearTrade(trade);
    return null;
  }
  return trade;
}

/**
 * Open an exchange: `from` puts `itemRef`/`credits` on the table for `toRaw`.
 * `kind` decides the settlement rule (see acceptTrade):
 *   - 'offer' — one-way GIFT: the target may accept with nothing in return.
 *   - 'trade' — a SWAP: the target must stake an item/credits back before it
 *               can settle (they can't just accept).
 * Fails if either party is already busy.
 * @returns {Promise<{ok:true,trade:object}|{ok:false,reason:string,[k:string]:any}>}
 */
export async function openTrade({ fromId, fromLogin, fromName, toRaw, itemRef, credits, kind = 'trade' }) {
  const from = cleanLogin(fromLogin);
  const to = cleanLogin(toRaw);
  if (!to) return { ok: false, reason: 'need-target' };
  if (to === from) return { ok: false, reason: 'self' };

  // Neither side may already be mid-trade (one active trade per person).
  if (await getTradeFor(from)) return { ok: false, reason: 'you-busy' };
  if (await getTradeFor(to)) return { ok: false, reason: 'target-busy' };

  const built = await buildStake({ userId: fromId, login: from, name: fromName, itemRef, credits });
  if (!built.ok) return built;

  const id = database().ref(PATHS.tradesActive()).push().key;
  const now = Date.now();
  const trade = {
    id,
    kind: kind === 'offer' ? 'offer' : 'trade',
    from: { id: String(fromId), login: from, name: fromName || from },
    to: { login: to, name: to }, // to.id filled in when they first act
    fromStake: built.stake,
    toStake: emptyStake(),
    turn: to, // the target responds next
    at: now,
    createdAt: now,
  };
  await database().ref().update({
    [PATHS.trade(id)]: trade,
    [PATHS.tradeIndex(from)]: id,
    [PATHS.tradeIndex(to)]: id,
  });
  return { ok: true, trade };
}

/**
 * The current turn-holder revises THEIR side of the table and flips the turn to
 * the other player. Validates the new stake against the counter-er's own bag.
 * @returns {Promise<{ok:true,trade:object}|{ok:false,reason:string,[k:string]:any}>}
 */
export async function counterTrade({ byId, byLogin, byName, itemRef, credits }) {
  const by = cleanLogin(byLogin);
  const trade = await getTradeFor(by);
  if (!trade) return { ok: false, reason: 'none' };
  if (trade.turn !== by) return { ok: false, reason: 'not-your-turn', waitingOn: trade.turn };

  const iAmFrom = trade.from.login === by;
  const other = iAmFrom ? trade.to.login : trade.from.login;

  const built = await buildStake({ userId: byId, login: by, name: byName, itemRef, credits });
  if (!built.ok) return built;

  const updates = { at: Date.now(), turn: other };
  const next = { ...trade, at: updates.at, turn: other };
  if (iAmFrom) {
    updates.fromStake = built.stake;
    next.fromStake = built.stake;
  } else {
    updates.toStake = built.stake;
    updates['to/id'] = String(byId);
    updates['to/name'] = byName || by;
    next.toStake = built.stake;
    next.to = { ...trade.to, id: String(byId), name: byName || by };
  }
  await database().ref(PATHS.trade(trade.id)).update(updates);
  return { ok: true, trade: next };
}

/** Decline / cancel — either participant can end the trade at any time. */
export async function declineTrade({ byLogin }) {
  const by = cleanLogin(byLogin);
  const trade = await getTradeFor(by);
  if (!trade) return { ok: false, reason: 'none' };
  await clearTrade(trade);
  const otherName = trade.from.login === by ? trade.to.name : trade.from.name;
  return { ok: true, trade, otherName };
}

/**
 * Atomically remove `giveId` from a player's bag (if any) and append `takeId`
 * (if any). Transactional, so a concurrent equip/loot is respected. Returns true
 * iff it committed (aborts if giveId isn't there or the player is gone).
 */
async function giveTake(userId, giveId, takeId) {
  let ok = false;
  const res = await database().ref(PATHS.player(userId)).transaction((p) => {
    if (p == null) return null; // null cache → refetch; truly absent → abort as no-op
    const inv = Array.isArray(p.inventory) ? [...p.inventory] : [];
    if (giveId) {
      const i = inv.indexOf(giveId);
      if (i === -1) { ok = false; return; } // item gone → abort
      inv.splice(i, 1);
    }
    if (takeId) inv.push(takeId);
    ok = true;
    return { ...p, inventory: inv };
  });
  return ok && res.committed;
}

/**
 * Settle the trade awaiting the caller. Atomically claims it, re-validates BOTH
 * sides (items still owned, credits still covered, item recipients have a
 * character), then swaps items and moves credits — reversing every applied step
 * if anything downstream fails.
 * @returns {Promise<{ok:true,...}|{ok:false,reason:string,[k:string]:any}>}
 */
export async function acceptTrade({ byId, byLogin, byName }) {
  const by = cleanLogin(byLogin);
  const trade = await getTradeFor(by);
  if (!trade) return { ok: false, reason: 'none' };
  if (trade.turn !== by) return { ok: false, reason: 'not-your-turn', waitingOn: trade.turn };
  // A 'trade' is a SWAP: it can't settle until BOTH sides have staked something
  // (an offer is one-way, so it may settle with an empty responder side). Checked
  // before the claim so the exchange survives for the responder to counter.
  if (trade.kind === 'trade' && (stakeIsEmpty(trade.fromStake) || stakeIsEmpty(trade.toStake))) {
    return { ok: false, reason: 'need-counter' };
  }
  if (stakeIsEmpty(trade.fromStake) && stakeIsEmpty(trade.toStake)) return { ok: false, reason: 'empty' };

  // Fill in the accepter's id/name if they never countered (accepted the opener's
  // gift outright), so downstream credit/item ops have their user id.
  const iAmFrom = trade.from.login === by;
  if (!iAmFrom && !trade.to.id) trade.to.id = String(byId);
  if (!iAmFrom) trade.to.name = byName || trade.to.name;

  // Atomic claim so a double-accept can't settle twice.
  let claimed = false;
  const claim = await database().ref(PATHS.trade(trade.id)).transaction((c) => {
    if (c == null) return null;
    if (isExpired(c, Date.now())) return null; // stale → delete
    if (c.claimed) return; // already settling → abort
    claimed = true;
    return { ...c, claimed: true };
  });
  if (!claim.committed || !claimed) return { ok: false, reason: 'none' };

  const { from, to, fromStake, toStake } = trade;

  // Clear the (claimed) trade and report a reason. Item/credit paths reverse
  // their own applied work BEFORE calling this, so clearing leaves no residue.
  const fail = async (reason) => { await clearTrade(trade); return { ok: false, reason }; };
  // Undo a completed item swap (used only if a later credit step fails).
  const reverseItems = async () => {
    if (fromStake.itemId || toStake.itemId) {
      await giveTake(from.id, toStake.itemId, fromStake.itemId);
      await giveTake(to.id, fromStake.itemId, toStake.itemId);
    }
  };

  // ── Pre-validate everything BEFORE mutating (no partial state on a bad trade) ──
  const fromP = await getPlayer(from.id);
  const toP = to.id ? await getPlayer(to.id) : null;

  if (fromStake.itemId && !(fromP?.inventory || []).includes(fromStake.itemId)) return fail('from-missing-item');
  if (toStake.itemId && !(toP?.inventory || []).includes(toStake.itemId)) return fail('to-missing-item');
  if (fromStake.itemId && !toP) return fail('to-no-character'); // recipient needs a bag
  if (toStake.itemId && !fromP) return fail('from-no-character');

  await ensureWallet({ userId: from.id, login: from.login, displayName: from.name });
  if (to.id) await ensureWallet({ userId: to.id, login: to.login, displayName: to.name });
  if (fromStake.credits > 0 && (await getBalance(from.id)) < fromStake.credits) return fail('from-broke');
  if (toStake.credits > 0 && (!to.id || (await getBalance(to.id)) < toStake.credits)) return fail('to-broke');

  // ── Move ITEMS first (race-safe transactions, clean reversal) ──
  if (fromStake.itemId || toStake.itemId) {
    const okFrom = await giveTake(from.id, fromStake.itemId, toStake.itemId);
    if (!okFrom) return fail('from-missing-item');
    const okTo = await giveTake(to.id, toStake.itemId, fromStake.itemId);
    if (!okTo) {
      await giveTake(from.id, toStake.itemId, fromStake.itemId); // reverse from's move
      return fail('to-missing-item');
    }
  }

  // ── Move CREDITS last (reverse the item swap if a debit unexpectedly fails) ──
  if (fromStake.credits > 0) {
    const d = await debit(from.id, fromStake.credits);
    if (!d.ok) { await reverseItems(); return fail('from-broke'); }
  }
  if (toStake.credits > 0) {
    const d = await debit(to.id, toStake.credits);
    if (!d.ok) {
      if (fromStake.credits > 0) await credit(from.id, fromStake.credits, { login: from.login, displayName: from.name });
      await reverseItems();
      return fail('to-broke');
    }
  }
  if (fromStake.credits > 0) await credit(to.id, fromStake.credits, { login: to.login, displayName: to.name });
  if (toStake.credits > 0) await credit(from.id, toStake.credits, { login: from.login, displayName: from.name });

  await clearTrade(trade);
  return { ok: true, kind: trade.kind, from, to, fromStake, toStake };
}
