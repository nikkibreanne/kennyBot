// OKRAMARKET — parimutuel binary YES/NO prediction markets staked in credits.
// Bot-owned (Admin SDK only). MANY markets run concurrently, each at
// `markets/open/<id>` keyed by its atomic numeric id (the easy chat target);
// resolved / cancelled markets are removed from `open` and archived to
// `markets/history/<id>`. Betting DEBITS the wallet into the chosen side's pool;
// on resolve the winning side's backers split the WHOLE pool proportional to
// their stake (parimutuel, no rake) — so credits are conserved, never minted.
// There is no resolution timer: a market lives until a mod resolves/cancels it,
// so short- and long-horizon markets can coexist. Rules are enforced here.

import { database, PATHS, SERVER_TIMESTAMP } from './firebase.js';
import { debit, credit } from './wallet.js';
import { config } from '../config.js';

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 16);

// Viewer market-suggestion limits (mirrors the fact-suggestion shape).
const SUG_Q_MIN = 5;
const SUG_Q_MAX = 140;

// Every market is a binary YES/NO proposition (Polymarket-style prediction
// market, not an arbitrary poll). Options are fixed so both chat and the site
// speak the same two outcomes.
const BINARY_OPTIONS = { yes: { label: 'Yes' }, no: { label: 'No' } };
const BINARY_ORDER = ['yes', 'no'];

/** Max markets open at once (config-tunable). */
const maxOpen = () => config.economy.maxOpenMarkets || 8;

/** Normalize suggested text: collapse whitespace, trim. */
export function cleanMarketText(raw) {
  return String(raw || '').replace(/\s+/g, ' ').trim();
}

/** Resolve a user-typed outcome token to a canonical option key (yes/no, 1/2, or label). */
function resolveOptionKey(market, token) {
  const key = String(token || '').toLowerCase().trim();
  if (!key) return null;
  if (key === 'y') return 'yes';
  if (key === 'n') return 'no';
  if (market.options?.[key]) return key;
  if (/^\d+$/.test(key)) return (market.optionOrder || [])[parseInt(key, 10) - 1] || null;
  return (market.optionOrder || []).find(
    (k) => slug(market.options[k].label) === slug(key) || String(market.options[k].label).toLowerCase() === key,
  ) || null;
}

/** Read a single open market by id (null if not open). */
export async function getMarket(id) {
  return (await database().ref(PATHS.marketOpen(id)).get()).val();
}

/** All currently open/closed markets, oldest id first. */
export async function listOpenMarkets() {
  const val = (await database().ref(PATHS.marketsOpen()).get()).val() || {};
  return Object.values(val).filter(Boolean).sort((a, b) => a.id - b.id);
}

/**
 * Open a new binary YES/NO market. Fails if the concurrent-market cap is hit.
 * @returns {Promise<{ok:true,market:object}|{ok:false,reason:string}>}
 */
export async function openMarket({ question }) {
  const q = String(question || '').trim();
  if (!q) return { ok: false, reason: 'need-question' };

  const openCount = Object.keys((await database().ref(PATHS.marketsOpen()).get()).val() || {}).length;
  if (openCount >= maxOpen()) return { ok: false, reason: 'too-many-open', max: maxOpen() };

  const counter = await database().ref(PATHS.marketCounter()).transaction((n) => (n || 0) + 1);
  const id = counter.snapshot.val();
  const market = {
    id,
    question: q,
    options: { ...BINARY_OPTIONS },
    optionOrder: [...BINARY_ORDER],
    status: 'open',
    pools: { yes: 0, no: 0 },
    betCount: 0,
    totalPool: 0,
    openedAt: Date.now(),
  };
  await database().ref(PATHS.marketOpen(id)).set(market);
  return { ok: true, market };
}

/** Stop accepting bets on a market (open → closed). */
export async function closeMarket(id) {
  let outcome = null;
  await database().ref(PATHS.marketOpen(id)).transaction((m) => {
    if (m === null) return null; // empty local cache → fetch & retry (NOT abort)
    if (m.status !== 'open') { outcome = { ok: false, reason: 'not-open' }; return; } // abort
    outcome = { ok: true, question: m.question };
    return { ...m, status: 'closed', closedAt: Date.now() };
  });
  return outcome || { ok: false, reason: 'no-market' };
}

/**
 * Place/append a bet on a market. Debits the wallet into the option pool. A user
 * backs ONE side per market (accumulates on the same one — no hedging). Saga:
 * wallet debit → market pool add, with compensation (refund) if the write can't proceed.
 */
export async function placeBet({ userId, login, displayName, marketId, optionKey, amount }) {
  const amt = Math.floor(Number(amount));
  if (!Number.isFinite(amt) || amt < config.economy.minBet) return { ok: false, reason: 'bad-amount' };

  const market = await getMarket(marketId);
  if (!market) return { ok: false, reason: 'no-market' };
  if (market.status !== 'open') return { ok: false, reason: 'closed' };

  const optKey = resolveOptionKey(market, optionKey);
  if (!optKey) return { ok: false, reason: 'bad-option', options: market.options };

  const existingBet = market.bets?.[userId];
  if (existingBet && existingBet.option !== optKey) {
    return { ok: false, reason: 'already-other-side', option: existingBet.option, optionLabel: market.options[existingBet.option]?.label };
  }

  // 1) Debit the wallet (atomic balance check).
  const deb = await debit(userId, amt);
  if (!deb.ok) return { ok: false, reason: deb.reason, balance: deb.balance };

  // 2) Add to the pool + record the bet (transaction on the market).
  let marketOk = false;
  await database().ref(PATHS.marketOpen(marketId)).transaction((m) => {
    if (m === null) return null; // empty local cache → fetch & retry (NOT abort)
    if (m.status !== 'open' || !m.options?.[optKey]) return; // abort → compensate below
    const pools = { ...(m.pools || {}) };
    pools[optKey] = (pools[optKey] || 0) + amt;
    const bets = { ...(m.bets || {}) };
    const prev = bets[userId];
    bets[userId] = { option: optKey, amount: (prev?.amount || 0) + amt, displayName: displayName || login || 'anon', at: Date.now() };
    marketOk = true;
    return { ...m, pools, bets, betCount: prev ? m.betCount || 0 : (m.betCount || 0) + 1, totalPool: (m.totalPool || 0) + amt };
  });

  if (!marketOk) {
    await credit(userId, amt, { login, displayName }); // compensate — market moved under us
    return { ok: false, reason: 'closed' };
  }

  return { ok: true, marketId, question: market.question, option: optKey, optionLabel: market.options[optKey].label, staked: (existingBet?.amount || 0) + amt, balance: deb.balance };
}

/**
 * Resolve a market to a winning option and pay out parimutuel. Winners split the
 * whole pool proportional to stake. If nobody backed the winner, all bets are
 * refunded. Double-resolve safe: atomically CLAIMS the market (→ 'resolving')
 * before paying, then archives to history and removes it from `open`.
 */
export async function resolveMarket(id, winningOption) {
  const ref = database().ref(PATHS.marketOpen(id));
  const peek = (await ref.get()).val();
  if (!peek) {
    // Not open — distinguish "already resolved/cancelled" from "never existed".
    const archived = (await database().ref(PATHS.marketHistory(id)).get()).val();
    return { ok: false, reason: archived ? 'already-resolved' : 'no-market' };
  }
  const winKey = resolveOptionKey(peek, winningOption);
  if (!winKey) return { ok: false, reason: 'bad-option', options: peek.options };

  const claim = await ref.transaction((m) => {
    if (m === null) return null; // empty local cache → fetch & retry (NOT abort)
    if (m.status === 'resolved' || m.status === 'resolving' || m.status === 'cancelling' || m.status === 'cancelled') return; // abort
    return { ...m, status: 'resolving', resolvedOption: winKey };
  });
  if (!claim.committed || !claim.snapshot.exists()) return { ok: false, reason: 'already-resolved' };

  const market = claim.snapshot.val();
  const bets = market.bets || {};
  const pools = market.pools || {};
  const totalPool = Object.values(pools).reduce((s, v) => s + (v || 0), 0);
  const winnersPool = pools[winKey] || 0;

  const payouts = [];
  if (winnersPool <= 0) {
    for (const [uid, b] of Object.entries(bets)) {
      await credit(uid, b.amount, { displayName: b.displayName });
      payouts.push({ uid, displayName: b.displayName, refund: b.amount });
    }
  } else {
    const factor = totalPool / winnersPool; // stake back + share of the losing pool
    for (const [uid, b] of Object.entries(bets)) {
      if (b.option !== winKey) continue;
      const payout = Math.floor(b.amount * factor);
      await credit(uid, payout, { displayName: b.displayName });
      payouts.push({ uid, displayName: b.displayName, stake: b.amount, payout });
    }
  }

  const record = {
    ...market,
    status: 'resolved', resolvedOption: winKey, resolvedLabel: market.options[winKey].label,
    resolvedAt: Date.now(), refunded: winnersPool <= 0,
  };
  await database().ref(PATHS.marketHistory(id)).set(record);
  await ref.remove();

  const winners = payouts.filter((p) => p.payout);
  winners.sort((a, b) => b.payout - a.payout);
  return { ok: true, id, question: market.question, winKey, winLabel: market.options[winKey].label, totalPool, winnersPool, refunded: winnersPool <= 0, winners, top: winners[0] || null };
}

/** Void a market and refund every bet. Atomically claims (→ 'cancelling') first. */
export async function cancelMarket(id) {
  const ref = database().ref(PATHS.marketOpen(id));
  const peek = (await ref.get()).val();
  if (!peek) return { ok: false, reason: 'no-market' };

  const claim = await ref.transaction((m) => {
    if (m === null) return null; // empty local cache → fetch & retry (NOT abort)
    if (m.status === 'resolving' || m.status === 'cancelling' || m.status === 'resolved') return; // abort
    return { ...m, status: 'cancelling' };
  });
  if (!claim.committed || !claim.snapshot.exists()) return { ok: false, reason: 'busy' };

  const market = claim.snapshot.val();
  const bets = market.bets || {};
  let refunded = 0;
  let count = 0;
  for (const [uid, b] of Object.entries(bets)) {
    await credit(uid, b.amount, { displayName: b.displayName });
    refunded += b.amount;
    count += 1;
  }
  await database().ref(PATHS.marketHistory(id)).set({ ...market, status: 'cancelled', cancelledAt: Date.now() });
  await ref.remove();
  return { ok: true, id, question: market.question, refunded, count };
}

// ── Viewer-proposed markets ────────────────────────────────────────────────
// Anyone can `!market suggest <yes/no question>`; the proposal lands in an
// admin-only queue keyed by a short atomic counter. A mod reviews the queue and
// `!market approve <#>` opens it as a live market (subject to the concurrent-market
// cap). This mirrors facts.js.

/**
 * Queue a viewer's market proposal (a YES/NO question) for moderation.
 * @returns {Promise<{ok:true,id:number}|{ok:false,reason:string}>}
 */
export async function suggestMarket({ userId, login, displayName, question }) {
  const q = cleanMarketText(question);
  if (q.length < SUG_Q_MIN) return { ok: false, reason: 'too-short' };
  if (q.length > SUG_Q_MAX) return { ok: false, reason: 'too-long' };

  const counter = await database().ref(PATHS.marketSuggestionCounter()).transaction((n) => (n || 0) + 1);
  const id = counter.snapshot.val();
  await database().ref(PATHS.marketSuggestion(id)).set({
    question: q,
    by: displayName || login || 'anon',
    byId: String(userId),
    login: login || null,
    status: 'pending',
    at: SERVER_TIMESTAMP,
  });
  return { ok: true, id };
}

/** Pending market suggestions (oldest first), for the mod queue. */
export async function listPendingMarketSuggestions(limit = 6) {
  const snap = await database().ref(PATHS.marketSuggestions()).get();
  const val = snap.val() || {};
  return Object.entries(val)
    .filter(([, s]) => s && s.status === 'pending')
    .map(([id, s]) => ({ id: Number(id), question: s.question, by: s.by }))
    .sort((a, b) => a.id - b.id)
    .slice(0, limit);
}

/**
 * Approve a pending suggestion: open it as a live market and mark the queue entry.
 * If the concurrent cap is hit, openMarket returns 'too-many-open' and the
 * suggestion is LEFT pending (approve again after resolving one).
 * @returns {Promise<{ok:true,market:object}|{ok:false,reason:string}>}
 */
export async function approveMarketSuggestion(id) {
  const ref = database().ref(PATHS.marketSuggestion(id));
  const sub = (await ref.get()).val();
  if (!sub) return { ok: false, reason: 'not-found' };
  if (sub.status === 'approved') return { ok: false, reason: 'already-approved' };

  const res = await openMarket({ question: sub.question });
  if (!res.ok) return res; // e.g. 'too-many-open' — leave it pending for later
  await ref.update({ status: 'approved', marketId: res.market.id });
  return { ok: true, market: res.market };
}

/** Reject a pending suggestion (kept as audit, status flipped). */
export async function rejectMarketSuggestion(id) {
  const ref = database().ref(PATHS.marketSuggestion(id));
  const sub = (await ref.get()).val();
  if (!sub) return { ok: false, reason: 'not-found' };
  await ref.update({ status: 'rejected' });
  return { ok: true, question: sub.question };
}
