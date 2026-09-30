// !equip refuses off-role gear. Run via `npm run test:emulator`.
//
// Gear pays out only through `bonuses[wearer.role]` (rules/rating.js#gearBonus),
// so wearing another role's item was always worth exactly zero — and nothing
// said so. In prod, 9 pieces were equipped off-role and 52 sat in bags; one
// healer had all three slots filled with tank gear, running on no gear rating at
// all. Refusing the equip turns that silent dead end into a trade.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { initFirebase, database, closeFirebase, PATHS } from '../src/db/firebase.js';
import { equipItem } from '../src/db/players.js';
import equipCmd from '../src/commands/equip.js';
import bagCmd from '../src/commands/bag.js';

const host = process.env.FIREBASE_DATABASE_EMULATOR_HOST;
const runOrSkip = host ? test : test.skip;
const noopLogger = { info() {}, warn() {}, error() {}, debug() {} };

const UID = 'u_equip_test';
const TANK_ITEM = 'itm_s1_cinder_spade';        // tank weapon
const DPS_ITEM = 'itm_s1_thornnettle_dirk';     // dps weapon

const user = { id: UID, displayName: 'Equipper' };

async function seedHero(role, inventory) {
  await database().ref(PATHS.player(UID)).set({
    displayName: 'Equipper', class: role === 'tank' ? 'Guardian' : 'Ranger', role,
    level: 10, renown: 0, equipped: {}, inventory, stats: {},
  });
}

const run = async (cmd, ...args) => {
  let said = '';
  await cmd.run({ user, args, reply: (t) => { said = t; }, logger: noopLogger });
  return said;
};

before(async () => { if (host) initFirebase(); });
beforeEach(async () => { if (host) await database().ref(PATHS.player(UID)).remove(); });
after(async () => {
  if (!host) return;
  await database().ref(PATHS.player(UID)).remove().catch(() => {});
  await closeFirebase();
});

runOrSkip('a hero can equip gear for its own role', async () => {
  await seedHero('dps', [DPS_ITEM]);
  const res = await equipItem(UID, DPS_ITEM);
  assert.equal(res.ok, true);
  const p = (await database().ref(PATHS.player(UID)).get()).val();
  assert.equal(p.equipped.weapon.id, DPS_ITEM);
  assert.equal((p.inventory || []).length, 0, 'it left the bag');
});

runOrSkip('a hero CANNOT equip another role’s gear', async () => {
  await seedHero('dps', [TANK_ITEM]);
  const res = await equipItem(UID, TANK_ITEM);
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'wrong-role');
  const p = (await database().ref(PATHS.player(UID)).get()).val();
  assert.equal(p.equipped?.weapon ?? null, null, 'nothing was equipped');
  assert.deepEqual(p.inventory, [TANK_ITEM], 'and the item stayed in the bag, tradeable');
});

runOrSkip('the refusal names the classes it IS for, so it gets traded on', async () => {
  await seedHero('dps', [TANK_ITEM]);
  const said = await run(equipCmd, '1');
  assert.match(said, /tank gear/i, `should say what it is: ${said}`);
  assert.match(said, /Guardian/, 'and which class wants it');
  assert.match(said, /!give|!trade/, 'and how to pass it on');
});

runOrSkip('!bag flags what this hero cannot use', async () => {
  await seedHero('dps', [DPS_ITEM, TANK_ITEM]);
  const said = await run(bagCmd);
  assert.match(said, /⛔/, `unusable gear should be marked: ${said}`);
  assert.match(said, /not for a dps/i, 'and explained');
  const marks = (said.match(/⛔/g) || []).length;
  assert.equal(marks, 2, 'one mark on the item, one in the legend');
});

runOrSkip('a bag of only usable gear carries no warning noise', async () => {
  await seedHero('dps', [DPS_ITEM]);
  const said = await run(bagCmd);
  assert.equal(said.includes('⛔'), false, `clean bag should read clean: ${said}`);
});

runOrSkip('a hero with no role yet is not blocked by the lock', async () => {
  // Defensive: a record mid-creation has no role. The lock must not strand it.
  await database().ref(PATHS.player(UID)).set({ displayName: 'New', inventory: [DPS_ITEM], equipped: {} });
  const res = await equipItem(UID, DPS_ITEM);
  assert.equal(res.ok, true, 'no role means no role restriction to apply');
});
