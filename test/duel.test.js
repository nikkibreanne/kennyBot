// Behavioral tests for DUELS: challenge → accept/deny, the coin-flip payout
// (pot conserved, winner takes all), and the guards (self, bad amount, broke
// challenger/accepter with refund, target-busy, expiry, double-accept). Run via
// `npm run test:emulator` (skipped without the emulator host).
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { initFirebase, database, closeFirebase, PATHS } from '../src/db/firebase.js';
import { ensureWallet, getBalance, debit } from '../src/db/wallet.js';
import { challenge, accept, deny, getPendingFor, DUEL_TTL_MS } from '../src/db/duel.js';

const host = process.env.FIREBASE_DATABASE_EMULATOR_HOST;
const runOrSkip = host ? test : test.skip;

async function wipe() {
  await Promise.all(['duels', 'wallets', 'counters'].map((p) => database().ref(p).remove().catch(() => {})));
}

before(async () => { if (host) initFirebase(); });
after(async () => { if (host) { await wipe(); await closeFirebase(); } });
beforeEach(async () => { if (host) await wipe(); });

const seed = async (id, name) => ensureWallet({ userId: id, login: name.toLowerCase(), displayName: name });

runOrSkip('duel: accept pays the whole pot to the winner and conserves credits', async () => {
  await seed('A', 'Alice'); // 500
  await seed('B', 'Bob'); // 500

  const c = await challenge({ fromId: 'A', fromLogin: 'alice', fromName: 'Alice', toRaw: '@Bob', amount: 100 });
  assert.deepEqual([c.ok, c.toLogin, c.amount], [true, 'bob', 100]);

  // rng < 0.5 → challenger (Alice) wins.
  const r = await accept({ toId: 'B', toLogin: 'bob', toName: 'Bob', rng: () => 0 });
  assert.deepEqual([r.ok, r.winnerName, r.pot], [true, 'Alice', 200]);
  assert.equal(await getBalance('A'), 600, 'winner: 500 - 100 stake + 200 pot');
  assert.equal(await getBalance('B'), 400, 'loser: 500 - 100');
  assert.equal(await getPendingFor('bob'), null, 'challenge cleared');
});

runOrSkip('duel: the coin flip can pick the target too', async () => {
  await seed('A', 'Alice');
  await seed('B', 'Bob');
  await challenge({ fromId: 'A', fromLogin: 'alice', fromName: 'Alice', toRaw: 'bob', amount: 100 });
  const r = await accept({ toId: 'B', toLogin: 'bob', toName: 'Bob', rng: () => 0.9 }); // target wins
  assert.equal(r.winnerName, 'Bob');
  assert.deepEqual([await getBalance('A'), await getBalance('B')], [400, 600]);
});

runOrSkip('duel: deny cancels with no credits moved', async () => {
  await seed('A', 'Alice');
  await seed('B', 'Bob');
  await challenge({ fromId: 'A', fromLogin: 'alice', fromName: 'Alice', toRaw: '@bob', amount: 250 });
  const d = await deny({ toLogin: 'bob' });
  assert.deepEqual([d.ok, d.fromName], [true, 'Alice']);
  assert.equal(await getPendingFor('bob'), null);
  assert.deepEqual([await getBalance('A'), await getBalance('B')], [500, 500], 'nothing staked');
  assert.equal((await deny({ toLogin: 'bob' })).reason, 'none', 'nothing left to deny');
});

runOrSkip('duel: challenge guards (self, bad amount, insufficient, target-busy)', async () => {
  await seed('A', 'Alice');
  assert.equal((await challenge({ fromId: 'A', fromLogin: 'alice', fromName: 'Alice', toRaw: '@alice', amount: 10 })).reason, 'self');
  assert.equal((await challenge({ fromId: 'A', fromLogin: 'alice', fromName: 'Alice', toRaw: '@bob', amount: 0 })).reason, 'bad-amount');
  assert.equal((await challenge({ fromId: 'A', fromLogin: 'alice', fromName: 'Alice', toRaw: '@bob', amount: 'lots' })).reason, 'bad-amount');
  assert.equal((await challenge({ fromId: 'A', fromLogin: 'alice', fromName: 'Alice', toRaw: '@bob', amount: 99999 })).reason, 'insufficient');

  assert.equal((await challenge({ fromId: 'A', fromLogin: 'alice', fromName: 'Alice', toRaw: '@bob', amount: 100 })).ok, true);
  const busy = await challenge({ fromId: 'C', fromLogin: 'carol', fromName: 'Carol', toRaw: '@bob', amount: 50 });
  assert.deepEqual([busy.reason, busy.challenger], ['target-busy', 'Alice'], 'one pending challenge per target');
});

runOrSkip('duel: accepter who cannot cover the wager → challenger refunded, no pot', async () => {
  await seed('A', 'Alice'); // 500
  await seed('B', 'Bob');
  await debit('B', 450); // Bob down to 50
  await challenge({ fromId: 'A', fromLogin: 'alice', fromName: 'Alice', toRaw: '@bob', amount: 100 });

  const r = await accept({ toId: 'B', toLogin: 'bob', toName: 'Bob', rng: () => 0 });
  assert.deepEqual([r.ok, r.reason], [false, 'insufficient']);
  assert.equal(await getBalance('A'), 500, 'challenger fully refunded (net zero)');
  assert.equal(await getBalance('B'), 50, 'accepter untouched');
  assert.equal(await getPendingFor('bob'), null, 'dead challenge cleared');
});

runOrSkip('duel: expired challenge cannot be accepted', async () => {
  await seed('A', 'Alice');
  await seed('B', 'Bob');
  await challenge({ fromId: 'A', fromLogin: 'alice', fromName: 'Alice', toRaw: '@bob', amount: 100 });
  // Age the challenge past the TTL.
  await database().ref(PATHS.duelPending('bob')).child('at').set(Date.now() - DUEL_TTL_MS - 1);
  assert.equal(await getPendingFor('bob'), null, 'reads as expired');
  assert.equal((await accept({ toId: 'B', toLogin: 'bob', toName: 'Bob', rng: () => 0 })).reason, 'none');
  assert.deepEqual([await getBalance('A'), await getBalance('B')], [500, 500], 'no credits moved');
});

runOrSkip('duel: a second accept after settlement pays nothing (no double payout)', async () => {
  await seed('A', 'Alice');
  await seed('B', 'Bob');
  await challenge({ fromId: 'A', fromLogin: 'alice', fromName: 'Alice', toRaw: '@bob', amount: 100 });
  assert.equal((await accept({ toId: 'B', toLogin: 'bob', toName: 'Bob', rng: () => 0 })).ok, true);
  assert.equal((await accept({ toId: 'B', toLogin: 'bob', toName: 'Bob', rng: () => 0 })).reason, 'none', 'nothing left to accept');
  assert.deepEqual([await getBalance('A'), await getBalance('B')], [600, 400], 'balances unchanged by the 2nd accept');
});
