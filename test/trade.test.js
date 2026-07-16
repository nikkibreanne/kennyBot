// Behavioral tests for player-to-player trades (src/db/trade.js): gifts, item↔item
// swaps, item↔credits sales, sweeteners, the negotiation guards (self/ownership/
// funds/busy/turn), race-safe settlement (re-validates and cancels cleanly when a
// staked item has vanished), and TTL expiry. Proves items AND credits are
// conserved — never duplicated or minted. Run via `npm run test:emulator`.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { initFirebase, database, closeFirebase } from '../src/db/firebase.js';
import { createPlayer, getPlayer, addLoot } from '../src/db/players.js';
import { ensureWallet, getBalance } from '../src/db/wallet.js';
import { openTrade, counterTrade, acceptTrade, declineTrade, getTradeFor, TRADE_TTL_MS } from '../src/db/trade.js';

const host = process.env.FIREBASE_DATABASE_EMULATOR_HOST;
const runOrSkip = host ? test : test.skip;

const EDGE = 'itm_s1_stormcaller_edge'; // dps rare
const TOKEN = 'itm_s1_ember_token';     // dps uncommon
const AEGIS = 'itm_s1_ashbark_aegis';   // tank rare

async function wipe() {
  await Promise.all(['trades', 'players', 'usernames', 'wallets', 'counters'].map((p) => database().ref(p).remove().catch(() => {})));
}
async function seedA() {
  await createPlayer({ userId: 'A', login: 'alice', displayName: 'Alice', className: 'Berserker' });
  await addLoot('A', EDGE);  // bag #1
  await addLoot('A', TOKEN); // bag #2
}
async function seedB() {
  await createPlayer({ userId: 'B', login: 'bob', displayName: 'Bob', className: 'Guardian' });
  await addLoot('B', AEGIS); // bag #1
}

before(async () => { if (host) initFirebase(); });
after(async () => { if (host) { await wipe(); await closeFirebase(); } });
beforeEach(async () => { if (host) await wipe(); });

runOrSkip('offer: one-way gift — taker accepts with nothing back', async () => {
  await seedA(); await seedB();
  const o = await openTrade({ fromId: 'A', fromLogin: 'alice', fromName: 'Alice', toRaw: '@bob', itemRef: '1', credits: 0, kind: 'offer' });
  assert.equal(o.ok, true);
  assert.equal(o.trade.kind, 'offer');
  assert.equal(o.trade.turn, 'bob', 'target responds next');

  const a = await acceptTrade({ byId: 'B', byLogin: 'bob', byName: 'Bob' });
  assert.equal(a.ok, true, 'an offer settles with an empty responder side');
  const A = await getPlayer('A'); const B = await getPlayer('B');
  assert.ok(!A.inventory.includes(EDGE), 'A lost the item');
  assert.ok(B.inventory.includes(EDGE), 'B gained the item');
  assert.equal(await getTradeFor('alice'), null, 'cleared for both');
  assert.equal(await getTradeFor('bob'), null);
});

runOrSkip('trade: a SWAP cannot settle until the responder stakes something', async () => {
  await seedA(); await seedB();
  await openTrade({ fromId: 'A', fromLogin: 'alice', fromName: 'Alice', toRaw: 'bob', itemRef: '1', credits: 0, kind: 'trade' });
  // Bob tries to just take it — rejected, and the trade survives for him to counter.
  const bare = await acceptTrade({ byId: 'B', byLogin: 'bob', byName: 'Bob' });
  assert.deepEqual([bare.ok, bare.reason], [false, 'need-counter']);
  assert.ok(await getTradeFor('bob'), 'trade still open after a rejected bare accept');
  assert.ok((await getPlayer('A')).inventory.includes(EDGE), 'nothing moved');

  // He counters with his aegis; now Alice can accept and it swaps.
  await counterTrade({ byId: 'B', byLogin: 'bob', byName: 'Bob', itemRef: '1', credits: 0 });
  const done = await acceptTrade({ byId: 'A', byLogin: 'alice', byName: 'Alice' });
  assert.equal(done.ok, true);
  assert.ok((await getPlayer('A')).inventory.includes(AEGIS) && (await getPlayer('B')).inventory.includes(EDGE));
});

runOrSkip('trade: counter swaps item-for-item (name lookup is case-insensitive)', async () => {
  await seedA(); await seedB();
  await openTrade({ fromId: 'A', fromLogin: 'alice', fromName: 'Alice', toRaw: 'bob', itemRef: 'stormcaller edge', credits: 0 });
  const c = await counterTrade({ byId: 'B', byLogin: 'bob', byName: 'Bob', itemRef: '1', credits: 0 });
  assert.equal(c.ok, true);
  assert.equal(c.trade.toStake.itemId, AEGIS);
  assert.equal(c.trade.turn, 'alice', 'ball back to the opener');

  const a = await acceptTrade({ byId: 'A', byLogin: 'alice', byName: 'Alice' });
  assert.equal(a.ok, true);
  const A = await getPlayer('A'); const B = await getPlayer('B');
  assert.ok(A.inventory.includes(AEGIS) && !A.inventory.includes(EDGE), 'A traded edge for aegis');
  assert.ok(B.inventory.includes(EDGE) && !B.inventory.includes(AEGIS), 'B traded aegis for edge');
});

runOrSkip('trade: item for credits — credits conserved, item moves', async () => {
  await seedA(); await seedB();
  await ensureWallet({ userId: 'A', login: 'alice', displayName: 'Alice' }); // 500
  await ensureWallet({ userId: 'B', login: 'bob', displayName: 'Bob' });     // 500
  await openTrade({ fromId: 'A', fromLogin: 'alice', fromName: 'Alice', toRaw: 'bob', itemRef: '1', credits: 0 });
  await counterTrade({ byId: 'B', byLogin: 'bob', byName: 'Bob', itemRef: null, credits: 150 });
  const a = await acceptTrade({ byId: 'A', byLogin: 'alice', byName: 'Alice' });
  assert.equal(a.ok, true);
  assert.equal(await getBalance('A'), 650, 'seller +150');
  assert.equal(await getBalance('B'), 350, 'buyer -150 (conserved)');
  const A = await getPlayer('A'); const B = await getPlayer('B');
  assert.ok(!A.inventory.includes(EDGE) && B.inventory.includes(EDGE), 'item delivered');
});

runOrSkip('offer: opener sweetens a gift with item + credits', async () => {
  await seedA();
  await createPlayer({ userId: 'B', login: 'bob', displayName: 'Bob', className: 'Guardian' });
  await ensureWallet({ userId: 'A', login: 'alice', displayName: 'Alice' }); // 500
  await ensureWallet({ userId: 'B', login: 'bob', displayName: 'Bob' });     // 500
  await openTrade({ fromId: 'A', fromLogin: 'alice', fromName: 'Alice', toRaw: 'bob', itemRef: '1', credits: 100, kind: 'offer' });
  const a = await acceptTrade({ byId: 'B', byLogin: 'bob', byName: 'Bob' });
  assert.equal(a.ok, true);
  assert.equal(await getBalance('A'), 400, 'A paid the sweetener');
  assert.equal(await getBalance('B'), 600, 'B received it');
  assert.ok((await getPlayer('B')).inventory.includes(EDGE), 'and the item');
});

runOrSkip('trade: guards — self, target, ownership, funds, busy', async () => {
  await seedA(); await seedB();
  assert.equal((await openTrade({ fromId: 'A', fromLogin: 'alice', fromName: 'Alice', toRaw: 'alice', itemRef: '1' })).reason, 'self');
  assert.equal((await openTrade({ fromId: 'A', fromLogin: 'alice', fromName: 'Alice', toRaw: '', itemRef: '1' })).reason, 'need-target');
  assert.equal((await openTrade({ fromId: 'A', fromLogin: 'alice', fromName: 'Alice', toRaw: 'bob', itemRef: '99' })).reason, 'not-owned');
  assert.equal((await openTrade({ fromId: 'A', fromLogin: 'alice', fromName: 'Alice', toRaw: 'bob', itemRef: null, credits: 99999 })).reason, 'insufficient');

  assert.equal((await openTrade({ fromId: 'A', fromLogin: 'alice', fromName: 'Alice', toRaw: 'bob', itemRef: '1' })).ok, true);
  assert.equal((await openTrade({ fromId: 'A', fromLogin: 'alice', fromName: 'Alice', toRaw: 'carol', itemRef: '2' })).reason, 'you-busy');
  assert.equal((await openTrade({ fromId: 'C', fromLogin: 'carol', fromName: 'Carol', toRaw: 'bob', itemRef: null, credits: 10 })).reason, 'target-busy');
});

runOrSkip('trade: only the turn-holder can accept', async () => {
  await seedA(); await seedB();
  await openTrade({ fromId: 'A', fromLogin: 'alice', fromName: 'Alice', toRaw: 'bob', itemRef: '1' });
  const a = await acceptTrade({ byId: 'A', byLogin: 'alice', byName: 'Alice' }); // opener can't accept own offer
  assert.deepEqual([a.ok, a.reason], [false, 'not-your-turn']);
});

runOrSkip('trade: decline calls it off for both, nothing moves', async () => {
  await seedA(); await seedB();
  await openTrade({ fromId: 'A', fromLogin: 'alice', fromName: 'Alice', toRaw: 'bob', itemRef: '1' });
  const d = await declineTrade({ byLogin: 'bob' });
  assert.equal(d.ok, true);
  assert.equal(await getTradeFor('alice'), null);
  assert.equal(await getTradeFor('bob'), null);
  assert.ok((await getPlayer('A')).inventory.includes(EDGE), 'A keeps the item');
});

runOrSkip('settlement re-validates — a vanished item cancels cleanly', async () => {
  await seedA(); await seedB();
  await openTrade({ fromId: 'A', fromLogin: 'alice', fromName: 'Alice', toRaw: 'bob', itemRef: '1', kind: 'offer' });
  // The staked item leaves A's bag before Bob accepts (equipped/traded elsewhere).
  await database().ref('players/A/inventory').set([TOKEN]);
  const a = await acceptTrade({ byId: 'B', byLogin: 'bob', byName: 'Bob' });
  assert.deepEqual([a.ok, a.reason], [false, 'from-missing-item']);
  assert.ok(!(await getPlayer('B')).inventory.includes(EDGE), 'B gained nothing');
  assert.equal(await getTradeFor('alice'), null, 'trade cleared, no stuck claim');
});

runOrSkip('trade: an offer expires after the TTL', async () => {
  await seedA(); await seedB();
  const o = await openTrade({ fromId: 'A', fromLogin: 'alice', fromName: 'Alice', toRaw: 'bob', itemRef: '1' });
  await database().ref(`trades/active/${o.trade.id}/at`).set(Date.now() - (TRADE_TTL_MS + 1000));
  assert.equal(await getTradeFor('bob'), null, 'expired offer is gone on read');
  assert.equal((await acceptTrade({ byId: 'B', byLogin: 'bob', byName: 'Bob' })).reason, 'none');
});
