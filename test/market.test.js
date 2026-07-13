// Behavioral tests for the OKRAMARKET economy: the credit wallet (grubstake,
// daily, atomic debit), fact moderation, and the parimutuel market (betting
// guards, pool conservation on payout, double-resolve safety, refunds). Proves
// points are conserved and can't be over-paid. Run via `npm run test:emulator`
// (skipped without the emulator host, same as the other emulator tests).
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { initFirebase, database, closeFirebase } from '../src/db/firebase.js';
import { ensureWallet, claimDaily, getBalance, credit } from '../src/db/wallet.js';
import { suggestFact, listPendingFacts, approveFact, rejectFact, randomApprovedFact } from '../src/db/facts.js';
import { openMarket, placeBet, closeMarket, resolveMarket, cancelMarket, getMarket, listOpenMarkets } from '../src/db/market.js';
import { suggestMarket, listPendingMarketSuggestions, approveMarketSuggestion, rejectMarketSuggestion } from '../src/db/market.js';
import { config } from '../src/config.js';

const host = process.env.FIREBASE_DATABASE_EMULATOR_HOST;
const runOrSkip = host ? test : test.skip;

async function wipe() {
  await Promise.all(
    ['wallets', 'markets', 'marketSuggestions', 'facts', 'factSubmissions', 'counters'].map((p) => database().ref(p).remove().catch(() => {})),
  );
}

before(async () => { if (host) initFirebase(); });
after(async () => { if (host) { await wipe(); await closeFirebase(); } });
beforeEach(async () => { if (host) await wipe(); });

runOrSkip('facts: suggest → moderate → publish', async () => {
  const s1 = await suggestFact({ userId: 'u1', displayName: 'Alice', text: '  nikki   is okra  ' });
  const s2 = await suggestFact({ userId: 'u2', displayName: 'Bob', text: 'okra is a fruit (legally)' });
  assert.deepEqual([s1.ok, s1.id, s2.id], [true, 1, 2], 'short ids assigned 1,2');
  assert.equal((await suggestFact({ userId: 'u3', text: 'ab' })).reason, 'too-short');

  const pending = await listPendingFacts();
  assert.equal(pending.length, 2);
  assert.equal(pending[0].text, 'nikki is okra', 'whitespace collapsed');

  assert.equal((await approveFact(1)).ok, true);
  assert.equal((await approveFact(1)).reason, 'already-approved', 'no double-approve');
  await rejectFact(2);
  assert.equal((await listPendingFacts()).length, 0, 'queue clears');
  assert.equal((await randomApprovedFact()).text, 'nikki is okra');
});

runOrSkip('wallet: grubstake, daily, cooldown', async () => {
  assert.equal((await ensureWallet({ userId: 'A', displayName: 'A' })).balance, 500, 'grubstake');
  const d = await claimDaily({ userId: 'A', displayName: 'A' });
  assert.equal(d.balance, 700, 'daily +200');
  assert.equal((await claimDaily({ userId: 'A', displayName: 'A' })).reason, 'cooldown');
  assert.equal((await getBalance('A')), 700);
});

runOrSkip('wallet: debit on a non-existent wallet reports no-wallet (not a false abort)', async () => {
  // Regression: the RTDB null-cache first call must fetch+retry, not abort.
  await ensureWallet({ userId: 'W', displayName: 'W' }); // balance 500
  await credit('W', 0); // no-op
  const { debit } = await import('../src/db/wallet.js');
  assert.equal((await debit('W', 100)).ok, true, 'existing wallet debits');
  assert.equal((await debit('ghost', 100)).reason, 'no-wallet', 'absent wallet → no-wallet');
});

runOrSkip('market: parimutuel payout conserves the pool', async () => {
  const om = await openMarket({ question: 'Will Nikki beat the boss?' });
  assert.deepEqual(om.market.optionOrder, ['yes', 'no']);
  const id = om.market.id;

  await ensureWallet({ userId: 'A', displayName: 'A' });
  await claimDaily({ userId: 'A', displayName: 'A' }); // A = 700
  await ensureWallet({ userId: 'B', displayName: 'B' }); // B = 500

  assert.equal((await placeBet({ userId: 'A', displayName: 'A', marketId: id, optionKey: 'yes', amount: 300 })).balance, 400);
  assert.equal((await placeBet({ userId: 'B', displayName: 'B', marketId: id, optionKey: '2', amount: 200 })).optionLabel, 'No');

  // guards
  assert.equal((await placeBet({ userId: 'A', displayName: 'A', marketId: id, optionKey: 'no', amount: 10 })).reason, 'already-other-side');
  assert.equal((await placeBet({ userId: 'A', displayName: 'A', marketId: id, optionKey: 'yes', amount: 99999 })).reason, 'insufficient');
  assert.equal((await placeBet({ userId: 'B', displayName: 'B', marketId: id, optionKey: 'maybe', amount: 10 })).reason, 'bad-option');

  const m = await getMarket(id);
  assert.deepEqual([m.pools.yes, m.pools.no, m.totalPool], [300, 200, 500], 'pools tallied');

  const r = await resolveMarket(id, 'yes');
  assert.equal(r.winLabel, 'Yes');
  assert.equal((await resolveMarket(id, 'no')).reason, 'already-resolved', 'no double-resolve');
  assert.equal(await getMarket(id), null, 'resolved market leaves the open board');
  // A backed the winner: stake 300 of a 500 pool → gets the whole 500. Total paid == pool.
  assert.equal(await getBalance('A'), 900, 'winner: 400 + 500');
  assert.equal(await getBalance('B'), 300, 'loser unchanged');
});

runOrSkip('market: nobody backs the winner → all bets refunded', async () => {
  const { market } = await openMarket({ question: 'An edge case here?' });
  await ensureWallet({ userId: 'A', displayName: 'A' }); // 500
  await placeBet({ userId: 'A', displayName: 'A', marketId: market.id, optionKey: 'no', amount: 100 }); // A → 400
  const r = await resolveMarket(market.id, 'yes'); // nobody bet yes
  assert.equal(r.refunded, true);
  assert.equal(await getBalance('A'), 500, 'refunded to full');
});

runOrSkip('market: cancel refunds every bet', async () => {
  const { market } = await openMarket({ question: 'Cancel this one?' });
  await ensureWallet({ userId: 'A', displayName: 'A' }); // 500
  await placeBet({ userId: 'A', displayName: 'A', marketId: market.id, optionKey: '1', amount: 100 }); // → 400
  const c = await cancelMarket(market.id);
  assert.deepEqual([c.ok, c.refunded, c.count], [true, 100, 1]);
  assert.equal(await getBalance('A'), 500, 'refunded');
  assert.equal(await getMarket(market.id), null, 'cancelled market leaves the open board');
});

runOrSkip('market: multiple markets run concurrently and independently', async () => {
  const a = await openMarket({ question: 'First concurrent market?' });
  const b = await openMarket({ question: 'Second concurrent market?' });
  assert.notEqual(a.market.id, b.market.id, 'distinct ids');
  assert.equal((await listOpenMarkets()).length, 2, 'both open');

  await ensureWallet({ userId: 'A', displayName: 'A' }); // 500
  // same user can back a different side on each market (no-hedging is per-market)
  await placeBet({ userId: 'A', displayName: 'A', marketId: a.market.id, optionKey: 'yes', amount: 50 });
  await placeBet({ userId: 'A', displayName: 'A', marketId: b.market.id, optionKey: 'no', amount: 30 });
  assert.equal((await getMarket(a.market.id)).pools.yes, 50);
  assert.equal((await getMarket(b.market.id)).pools.no, 30);
  assert.equal(await getBalance('A'), 420, '500 - 50 - 30');

  // resolving one leaves the other untouched
  await resolveMarket(a.market.id, 'yes');
  const open = await listOpenMarkets();
  assert.deepEqual([open.length, open[0].id], [1, b.market.id], 'only the other remains');
});

runOrSkip('market: respects the concurrent-market cap', async () => {
  const cap = config.economy.maxOpenMarkets;
  for (let i = 0; i < cap; i += 1) {
    assert.equal((await openMarket({ question: `Market number ${i} here?` })).ok, true);
  }
  const over = await openMarket({ question: 'One market too many?' });
  assert.deepEqual([over.reason, over.max], ['too-many-open', cap], 'cap enforced');
  assert.equal((await listOpenMarkets()).length, cap);
});

runOrSkip('market suggestions: suggest → queue → approve opens a live market', async () => {
  const s1 = await suggestMarket({ userId: 'u1', displayName: 'Alice', question: '  Will we clear   the boss?  ' });
  const s2 = await suggestMarket({ userId: 'u2', displayName: 'Bob', question: 'Nikki dies to trash pull?' });
  assert.deepEqual([s1.ok, s1.id, s2.id], [true, 1, 2], 'short ids 1,2');

  // validation (question only — options are always Yes/No)
  assert.equal((await suggestMarket({ userId: 'u3', question: 'hi?' })).reason, 'too-short');

  const pending = await listPendingMarketSuggestions();
  assert.equal(pending.length, 2);
  assert.equal(pending[0].question, 'Will we clear the boss?', 'whitespace collapsed');

  const appr = await approveMarketSuggestion(1);
  assert.equal(appr.ok, true);
  assert.deepEqual(appr.market.optionOrder, ['yes', 'no']);
  assert.equal((await getMarket(appr.market.id)).question, 'Will we clear the boss?', 'approved suggestion is now live');

  // both can be approved — markets are concurrent
  const appr2 = await approveMarketSuggestion(2);
  assert.equal(appr2.ok, true);
  assert.equal((await listOpenMarkets()).length, 2, 'both live at once');
  assert.equal((await listPendingMarketSuggestions()).length, 0, 'queue cleared');
});

runOrSkip('market suggestions: reject + no double-approve', async () => {
  await suggestMarket({ userId: 'u1', displayName: 'Alice', question: 'A good question to ask?' });
  assert.equal((await approveMarketSuggestion(1)).ok, true);
  assert.equal((await approveMarketSuggestion(1)).reason, 'already-approved', 'no double-approve');

  await suggestMarket({ userId: 'u2', displayName: 'Bob', question: 'Another one to consider?' });
  assert.equal((await rejectMarketSuggestion(2)).ok, true);
  assert.equal((await listPendingMarketSuggestions()).length, 0, 'queue clears');
  assert.equal((await rejectMarketSuggestion(99)).reason, 'not-found');
});
