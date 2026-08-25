// !salvage and !respec. Run via `npm run test:emulator`.
//
// Both exist to unstick things the role lock exposed: gear nobody wants (52 dead
// items sat in prod bags with no buyer, because a trade needs someone who
// actively wants the piece), and a role you can't leave (class was permanent, so
// a season short on healers had no way to fix itself).
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { initFirebase, database, closeFirebase, PATHS } from '../src/db/firebase.js';
import { getBalance, credit } from '../src/db/wallet.js';
import salvageCmd, { salvageValue, needsConfirm } from '../src/commands/salvage.js';
import respecCmd, { resolveClass } from '../src/commands/respec.js';
import { config } from '../src/config.js';

const host = process.env.FIREBASE_DATABASE_EMULATOR_HOST;
const runOrSkip = host ? test : test.skip;
const noopLogger = { info() {}, warn() {}, error() {}, debug() {} };

const UID = 'u_sv_test';
const user = { id: UID, login: 'svtester', displayName: 'SvTester', isSubscriber: true };

const TANK_COMMON = 'itm_s1_cinder_spade';       // tank weapon, common
const DPS_COMMON = 'itm_s1_thornnettle_dirk';    // dps weapon, common
const DPS_LEGENDARY = 'itm_s1_final_knell_reaper';

async function seed(role, inventory, balance = 1000) {
  await database().ref(PATHS.player(UID)).set({
    displayName: 'SvTester', class: role === 'tank' ? 'Guardian' : 'Ranger', role,
    level: 14, renown: 5, exp: 40, equipped: {}, inventory, stats: { seasonsPlayed: 1 },
  });
  await database().ref(PATHS.wallet(UID)).set({ login: 'svtester', displayName: 'SvTester', balance, createdAt: Date.now() });
}

const run = async (cmd, ...args) => {
  let said = '';
  await cmd.run({ user, args, reply: (t) => { said = t; }, logger: noopLogger });
  return said;
};
const player = async () => (await database().ref(PATHS.player(UID)).get()).val();

before(() => { if (host) initFirebase(); });
beforeEach(async () => { if (host) await database().ref(PATHS.player(UID)).remove(); });
after(async () => {
  if (!host) return;
  await database().ref(PATHS.player(UID)).remove().catch(() => {});
  await database().ref(PATHS.wallet(UID)).remove().catch(() => {});
  await closeFirebase();
});

// ── salvage ────────────────────────────────────────────────────────────────

runOrSkip('salvage values rise with rarity and never exceed the trade incentive', () => {
  const v = config.loot.salvage;
  assert.ok(v.common < v.uncommon && v.uncommon < v.rare && v.rare < v.epic && v.epic < v.legendary);
  assert.equal(salvageValue(DPS_COMMON), v.common);
  assert.equal(salvageValue(DPS_LEGENDARY), v.legendary);
  assert.equal(salvageValue('itm_not_real'), 0, 'an unknown id is worth nothing, never NaN');
});

runOrSkip('melting one item pays credits and removes exactly that item', async () => {
  await seed('dps', [DPS_COMMON, TANK_COMMON], 100);
  const said = await run(salvageCmd, '1');
  assert.match(said, /melted/i, said);
  const p = await player();
  assert.deepEqual(p.inventory, [TANK_COMMON], 'only the named item left the bag');
  assert.equal(await getBalance(UID), 100 + config.loot.salvage.common);
});

runOrSkip('epic and better need an explicit confirm', async () => {
  assert.equal(needsConfirm('rare'), false);
  assert.equal(needsConfirm('epic'), true);
  assert.equal(needsConfirm('legendary'), true);

  await seed('dps', [DPS_LEGENDARY], 0);
  const warned = await run(salvageCmd, '1');
  assert.match(warned, /permanent/i, `should warn, got: ${warned}`);
  assert.deepEqual((await player()).inventory, [DPS_LEGENDARY], 'nothing melted without confirm');
  assert.equal(await getBalance(UID), 0);

  const done = await run(salvageCmd, '1', 'confirm');
  assert.match(done, /melted/i, done);
  assert.equal((await player()).inventory ?? null, null);
  assert.equal(await getBalance(UID), config.loot.salvage.legendary);
});

runOrSkip('the confirm warning calls out gear you CAN actually wear', async () => {
  await seed('dps', [DPS_LEGENDARY], 0);
  const said = await run(salvageCmd, '1');
  assert.match(said, /can wear/i, `melting usable gear deserves a louder warning: ${said}`);
});

runOrSkip('salvage offrole melts only what this hero can never use', async () => {
  await seed('dps', [DPS_COMMON, TANK_COMMON, TANK_COMMON], 0);
  const preview = await run(salvageCmd, 'offrole');
  assert.match(preview, /2 off-role items/, `should preview, got: ${preview}`);
  assert.match(preview, /!give first/i, 'and point at trading before melting');
  assert.equal((await player()).inventory.length, 3, 'preview melts nothing');

  const done = await run(salvageCmd, 'offrole', 'confirm');
  assert.match(done, /melted 2/i, done);
  assert.deepEqual((await player()).inventory, [DPS_COMMON], 'the usable item survived');
  assert.equal(await getBalance(UID), config.loot.salvage.common * 2);
});

runOrSkip('salvage offrole on a clean bag says so instead of melting', async () => {
  await seed('dps', [DPS_COMMON], 0);
  const said = await run(salvageCmd, 'offrole', 'confirm');
  assert.match(said, /nothing.*off-role/i, said);
  assert.equal((await player()).inventory.length, 1);
});

// ── respec ─────────────────────────────────────────────────────────────────

runOrSkip('resolveClass is case-insensitive and rejects nonsense', () => {
  assert.equal(resolveClass('mender'), 'Mender');
  assert.equal(resolveClass('  GUARDIAN '), 'Guardian');
  assert.equal(resolveClass('Okra Wizard'), null);
});

runOrSkip('respec changes class and role, keeps level and renown, costs credits', async () => {
  await seed('dps', [], 1000);
  const said = await run(respecCmd, 'Mender');
  assert.match(said, /respecced/i, said);
  const p = await player();
  assert.equal(p.class, 'Mender');
  assert.equal(p.role, 'healer');
  assert.equal(p.level, 14, 'level survives');
  assert.equal(p.renown, 5, 'renown survives');
  assert.equal(await getBalance(UID), 1000 - config.respec.cost);
  assert.ok(p.equipped.weapon.id.startsWith('itm_starter_'), 'fresh starter gear for the new role');
  assert.equal(p.equipped.weapon.bonuses.healer > 0, true, 'and it is HEALER starter gear');
});

runOrSkip('respec returns old gear to the bag rather than destroying it', async () => {
  await seed('dps', [], 1000);
  await database().ref(PATHS.player(UID)).update({
    equipped: { weapon: { id: DPS_LEGENDARY, name: 'Reaper', slot: 'weapon', rarity: 'legendary', role: 'dps', bonuses: { dps: 104 } } },
  });
  await run(respecCmd, 'Mender');
  const p = await player();
  assert.ok((p.inventory || []).includes(DPS_LEGENDARY), 'the legendary went to the bag, not the bin');
});

runOrSkip('respec refuses without the credits, and charges nothing', async () => {
  await seed('dps', [], 10);
  const said = await run(respecCmd, 'Mender');
  assert.match(said, /credits/i, said);
  assert.equal((await player()).class, 'Ranger', 'class unchanged');
  assert.equal(await getBalance(UID), 10, 'not charged');
});

runOrSkip('respec to your current class is a no-op that costs nothing', async () => {
  await seed('dps', [], 1000);
  const said = await run(respecCmd, 'Ranger');
  assert.match(said, /already a Ranger/i, said);
  assert.equal(await getBalance(UID), 1000, 'no charge for a non-change');
});

runOrSkip('an unknown class lists the options and charges nothing', async () => {
  await seed('dps', [], 1000);
  const said = await run(respecCmd, 'Okra', 'Wizard');
  assert.match(said, /Guardian/, said);
  assert.equal(await getBalance(UID), 1000);
});
