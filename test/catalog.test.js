// Behavioral tests for the item-catalog Firebase seed (src/db/catalog.js): the
// seed faithfully mirrors src/content/items.js, is idempotent (item ids are the
// keys), and prunes ids no longer in the catalog. Plus a pure check of the set
// bucket derivation. Run via `npm run test:emulator` (the seed test is skipped
// without the emulator host, same as the other emulator tests).
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { initFirebase, database, closeFirebase } from '../src/db/firebase.js';
import { seedCatalog, catalogRows, setForItemId } from '../src/db/catalog.js';
import { ITEMS } from '../src/content/items.js';

const host = process.env.FIREBASE_DATABASE_EMULATOR_HOST;
const runOrSkip = host ? test : test.skip;

async function wipe() { await database().ref('items').remove().catch(() => {}); }

before(async () => { if (host) initFirebase(); });
after(async () => { if (host) { await wipe(); await closeFirebase(); } });
beforeEach(async () => { if (host) await wipe(); });

test('catalog: set bucket derives from the immutable item id', () => {
  assert.equal(setForItemId('itm_starter_tank_weapon_01'), 'Starter');
  assert.equal(setForItemId('itm_s1_cinder_spade'), 'Season 1');
  assert.equal(setForItemId('itm_s2_leviathans_edge'), 'Season 2');
  assert.equal(setForItemId('itm_s3_eclipse_edge'), 'Season 3');
});

test('catalog: rows project every catalog item with display fields', () => {
  const rows = catalogRows();
  assert.equal(rows.length, Object.keys(ITEMS).length, 'one row per item');
  assert.ok(rows.every((r) => r.id && r.name && r.slot && r.rarity && r.role && r.set && typeof r.order === 'number'));
  // order is a dense 0..n-1 sequence in authored order.
  assert.deepEqual(rows.map((r) => r.order), rows.map((_, i) => i));
});

runOrSkip('catalog: seed mirrors the catalog, idempotent, prunes orphans', async () => {
  const r = await seedCatalog();
  assert.equal(r.count, Object.keys(ITEMS).length, 'seeds the whole catalog');

  await seedCatalog(); // re-run must not duplicate (ids are the keys)
  const all = (await database().ref('items').get()).val() || {};
  assert.equal(Object.keys(all).length, Object.keys(ITEMS).length, 'no duplication on re-seed');
  assert.ok(
    Object.values(all).every((it) => it.name && it.slot && it.rarity && it.role && it.set),
    'every seeded item carries display fields',
  );

  // A stray id not in the current catalog is pruned on the next seed.
  await database().ref('items/itm_bogus_legacy').set({ name: 'Gone', slot: 'weapon', rarity: 'common', role: 'dps' });
  await seedCatalog();
  assert.equal((await database().ref('items/itm_bogus_legacy').get()).val(), null, 'orphaned id pruned');
});
