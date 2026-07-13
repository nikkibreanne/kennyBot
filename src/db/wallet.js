// Credits wallet — the viewer points ledger for OKRAMARKET wagering. Bot-owned
// (Admin SDK only) so points can NEVER be minted client-side (same anti-cheat
// stance as the EXP/loot ledgers, spec §7). Keyed by Twitch user id so any
// chatter can play — no hero (players/) required. Every mutation is an RTDB
// transaction (idempotent under duplicated/echoed messages).

import { database, PATHS } from './firebase.js';
import { config } from '../config.js';

/** Raw wallet record (or null). */
export async function getWallet(userId) {
  return (await database().ref(PATHS.wallet(userId)).get()).val();
}

/** Balance only (0 if no wallet yet). */
export async function getBalance(userId) {
  const w = await getWallet(userId);
  return w ? w.balance || 0 : 0;
}

/**
 * Create the wallet with a starting grubstake on first touch (idempotent), keeping
 * the display identity fresh on later touches. Returns the wallet record.
 */
export async function ensureWallet({ userId, login, displayName }) {
  const res = await database().ref(PATHS.wallet(userId)).transaction((curr) => {
    if (curr) {
      return { ...curr, login: login || curr.login || null, displayName: displayName || curr.displayName || null };
    }
    return {
      login: login || null,
      displayName: displayName || login || 'anon',
      balance: config.economy.grubstake,
      createdAt: Date.now(),
      grubstaked: true,
    };
  });
  return res.snapshot.val();
}

/** Credit points (winnings / daily / buy-in). Creates a bare wallet if absent. */
export async function credit(userId, amount, { login, displayName } = {}) {
  if (!(amount > 0)) return null;
  const res = await database().ref(PATHS.wallet(userId)).transaction((curr) => {
    const base = curr || { login: login || null, displayName: displayName || login || 'anon', balance: 0, createdAt: Date.now() };
    return { ...base, balance: (base.balance || 0) + amount };
  });
  return res.snapshot.val()?.balance ?? null;
}

/**
 * Debit points iff the balance covers it (atomic).
 * @returns {Promise<{ok:true,balance:number}|{ok:false,reason:string,balance?:number}>}
 */
export async function debit(userId, amount) {
  if (!(amount > 0)) return { ok: false, reason: 'bad-amount' };
  let outcome = null;
  await database().ref(PATHS.wallet(userId)).transaction((curr) => {
    if (curr === null) return null; // empty local cache → fetch server data & retry (NOT abort)
    const bal = curr.balance || 0;
    if (bal < amount) { outcome = { ok: false, reason: 'insufficient', balance: bal }; return; } // abort
    outcome = { ok: true, balance: bal - amount };
    return { ...curr, balance: bal - amount };
  });
  return outcome || { ok: false, reason: 'no-wallet' }; // null committed → wallet truly absent
}

/**
 * Claim the daily allowance if the cooldown has elapsed (bootstraps the wallet +
 * grubstake for a first-timer). Atomic.
 */
export async function claimDaily({ userId, login, displayName }) {
  const { amount, cooldownMs } = config.economy.daily;
  const now = Date.now();
  let outcome = { ok: false, reason: 'unknown' };
  await database().ref(PATHS.wallet(userId)).transaction((curr) => {
    const firstTime = !curr;
    const base = curr || {
      login: login || null, displayName: displayName || login || 'anon',
      balance: config.economy.grubstake, createdAt: now, grubstaked: true,
    };
    const since = now - (base.lastDailyAt || 0);
    if (!firstTime && since < cooldownMs) {
      outcome = { ok: false, reason: 'cooldown', retryMs: cooldownMs - since, balance: base.balance || 0 };
      return; // abort
    }
    const balance = (base.balance || 0) + amount;
    outcome = { ok: true, amount, balance, firstTime };
    return { ...base, balance, lastDailyAt: now, displayName: displayName || base.displayName, login: login || base.login || null };
  });
  return outcome;
}
