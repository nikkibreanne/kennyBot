// DUELS — head-to-head credit wagers between viewers. A challenger stakes an
// amount against a target; the target accepts or denies. On accept BOTH sides are
// debited into a pot and a fair 50/50 coin flip picks the winner, who takes the
// whole pot — so credits are conserved, never minted (same stance as the market).
// Bot-owned (Admin SDK only). Pending challenges are keyed by the TARGET's login
// so the target can accept/deny with just `!duel accept`; they expire after
// DUEL_TTL_MS and are cleared on resolve/deny. No history is kept.

import { database, PATHS } from './firebase.js';
import { ensureWallet, debit, credit, getBalance } from './wallet.js';
import { config } from '../config.js';

// How long a challenge stays open before it's treated as expired (lazy — checked
// on read/accept, never a timer). Keeps stale challenges from lingering forever.
export const DUEL_TTL_MS = 3 * 60 * 1000;

const minBet = () => config.economy.minBet || 1;

/** Normalize a target token ("@Bob", "bob") to a bare lowercase login. */
export function cleanLogin(raw) {
  return String(raw || '').trim().replace(/^@+/, '').toLowerCase();
}

/** A pending challenge is stale once older than the TTL. */
function isExpired(duel, now) {
  return !duel || now - (duel.at || 0) >= DUEL_TTL_MS;
}

/**
 * Issue a challenge: `<from>` wagers `amount` against `<toLogin>`. Validates the
 * challenger can currently cover it (no escrow — both sides are debited only on
 * accept). Fails if the target already has a live challenge pending.
 * @returns {Promise<{ok:true,toLogin:string,amount:number}|{ok:false,reason:string,[k:string]:any}>}
 */
export async function challenge({ fromId, fromLogin, fromName, toRaw, amount }) {
  const toLogin = cleanLogin(toRaw);
  if (!toLogin) return { ok: false, reason: 'need-target' };
  if (toLogin === cleanLogin(fromLogin)) return { ok: false, reason: 'self' };

  const amt = Math.floor(Number(amount));
  if (!Number.isFinite(amt) || amt < minBet()) return { ok: false, reason: 'bad-amount', min: minBet() };

  // Challenger must currently have the funds (final check is at accept time).
  const wallet = await ensureWallet({ userId: fromId, login: fromLogin, displayName: fromName });
  if ((wallet.balance || 0) < amt) return { ok: false, reason: 'insufficient', balance: wallet.balance || 0 };

  const now = Date.now();
  const ref = database().ref(PATHS.duelPending(toLogin));
  const existing = (await ref.get()).val();
  if (!isExpired(existing, now)) {
    return { ok: false, reason: 'target-busy', challenger: existing.fromName };
  }

  await ref.set({ fromId: String(fromId), fromLogin: cleanLogin(fromLogin), fromName: fromName || fromLogin, toLogin, amount: amt, at: now });
  return { ok: true, toLogin, amount: amt };
}

/** The live challenge awaiting `toLogin`, or null (also null if expired). */
export async function getPendingFor(toLogin) {
  const login = cleanLogin(toLogin);
  const duel = (await database().ref(PATHS.duelPending(login)).get()).val();
  return isExpired(duel, Date.now()) ? null : duel;
}

/**
 * Accept the challenge awaiting `toLogin`: atomically claim it, debit both sides
 * into a pot, flip a fair coin, and pay the whole pot to the winner. Refunds the
 * challenger if the accepter can't cover the stake.
 * @returns {Promise<{ok:true,...}|{ok:false,reason:string,[k:string]:any}>}
 */
export async function accept({ toId, toLogin, toName, rng = Math.random }) {
  const login = cleanLogin(toLogin);
  const ref = database().ref(PATHS.duelPending(login));
  const now = Date.now();

  // Atomic claim so a double-accept can't pay out twice.
  let claimed = null;
  const res = await ref.transaction((c) => {
    if (c === null) return null; // empty cache → refetch (or truly absent → abort as no-op)
    if (isExpired(c, now)) return null; // stale → delete
    if (c.claimed) return; // already being settled → abort
    claimed = c;
    return { ...c, claimed: true };
  });
  if (!res.committed || !claimed) return { ok: false, reason: 'none' };

  const { fromId, fromName, fromLogin, amount } = claimed;
  const toDisplay = toName || login;

  // Both sides stake into the pot. Debit challenger first; if that fails the
  // challenge is void. Debit accepter next; if THAT fails, refund the challenger.
  await ensureWallet({ userId: fromId, login: fromLogin, displayName: fromName });
  await ensureWallet({ userId: toId, login, displayName: toDisplay });

  const dFrom = await debit(fromId, amount);
  if (!dFrom.ok) {
    await ref.remove();
    return { ok: false, reason: 'challenger-broke', fromName };
  }
  const dTo = await debit(toId, amount);
  if (!dTo.ok) {
    await credit(fromId, amount, { login: fromLogin, displayName: fromName }); // undo the challenger's stake
    await ref.remove();
    return { ok: false, reason: 'insufficient', balance: dTo.balance || 0 };
  }

  const pot = amount * 2;
  const challengerWins = rng() < 0.5;
  const winnerId = challengerWins ? fromId : toId;
  const winnerName = challengerWins ? fromName : toDisplay;
  const loserName = challengerWins ? toDisplay : fromName;
  const winnerLogin = challengerWins ? fromLogin : login;

  await credit(winnerId, pot, { login: winnerLogin, displayName: winnerName });
  await ref.remove();

  const winnerBalance = await getBalance(winnerId);
  return { ok: true, winnerId, winnerName, loserName, fromName, toName: toDisplay, amount, pot, winnerBalance };
}

/** Decline the challenge awaiting `toLogin`. */
export async function deny({ toLogin }) {
  const login = cleanLogin(toLogin);
  const ref = database().ref(PATHS.duelPending(login));
  const duel = (await ref.get()).val();
  if (isExpired(duel, Date.now())) {
    if (duel) await ref.remove(); // tidy up an expired one
    return { ok: false, reason: 'none' };
  }
  await ref.remove();
  return { ok: true, fromName: duel.fromName };
}
