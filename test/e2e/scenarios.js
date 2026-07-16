// E2E scenarios — one per command, each driven end-to-end through the real chat
// dispatcher (see harness.js) against the Firebase emulator. `fixtures` (fx) set
// up the minimal game state a command's happy path needs; each scenario then
// sends the chat line(s) and asserts on the reply text and/or resulting state.
//
// To add a command: append a { command, title, run } entry keyed by the command's
// PRIMARY registry name. commands.e2e.test.js's coverage test enforces this.
import assert from 'node:assert/strict';
import { database } from '../../src/db/firebase.js';
import { createPlayer, getPlayer, addLoot } from '../../src/db/players.js';
import { ensureWallet } from '../../src/db/wallet.js';
import { openMarket } from '../../src/db/market.js';
import { setDrop } from '../../src/db/drops.js';
import { setupRaidWeek, enlist } from '../../src/db/raid.js';
import { seedCuratedFacts } from '../../src/db/facts.js';
import { getRaidPointer } from '../../src/db/configStore.js';
import { defaultBoss } from '../../src/content/bosses.js';
import { until } from './harness.js';

// A few catalog item ids used as loot (see src/content/items.js).
const DPS_ITEM = 'itm_s1_thornnettle_dirk'; // dps common weapon
const DPS_RARE = 'itm_s1_stormcaller_edge'; // dps rare weapon
const TANK_RARE = 'itm_s1_ashbark_aegis';   // tank rare armor
const DROP_ITEM = 'itm_starter_dps_weapon_01';

// ── fixtures: establish pre-state via the db layer directly ──────────────────
async function player(u, className = 'Berserker') {
  const { player: p } = await createPlayer({
    userId: u.id, login: u.login, displayName: u.name, className, isSubscriber: u.sub !== false,
  });
  return p;
}
async function loot(u, itemId) { return addLoot(u.id, itemId); }
async function wallet(u) { return ensureWallet({ userId: u.id, login: u.login, displayName: u.name }); }
async function market(question = 'Will we clear the boss tonight?') {
  const r = await openMarket({ question });
  return r.market.id;
}
async function drop(itemId = DROP_ITEM) { return setDrop(itemId); }
async function facts() { return seedCuratedFacts(); }
async function leaderboard(u, damage) {
  await player(u);
  await database().ref(`leaderboard/e2e/${u.id}`).set({ damage });
}
/** Stand up a signup-phase raid week and wait for the config mirror to see it. */
async function raidWeek({ bossName = 'The Test Warden', enlistUsers = [] } = {}) {
  const seasonId = 'e2e';
  const weekId = 'w1';
  const now = Date.now();
  await setupRaidWeek({ seasonId, weekId, boss: defaultBoss(bossName), locksAt: now + 3_600_000, startsAt: now + 7_200_000 });
  for (const u of enlistUsers) {
    const p = await player(u, u.className || 'Berserker');
    await enlist({ seasonId, weekId, userId: u.id, player: p });
  }
  await until(() => getRaidPointer()?.seasonId === seasonId && getRaidPointer()?.phase === 'signup');
  return { seasonId, weekId };
}

export const fixtures = { player, loot, wallet, market, drop, facts, leaderboard, raidWeek };

// ── scenarios (one per command primary name) ─────────────────────────────────
export const SCENARIOS = [
  {
    command: 'create', title: 'a subscriber makes a hero',
    run: async ({ bot, u }) => {
      const alice = u('e2e_create', { login: 'alice', name: 'Alice' });
      const reply = await bot.send(alice, '!create Berserker');
      assert.match(reply, /you are a Berserker \(dps\)/i);
      assert.ok(await getPlayer(alice.id), 'player persisted');
    },
  },
  {
    command: 'char', title: 'shows your character sheet',
    run: async ({ bot, u, fx }) => {
      const alice = u('e2e_char', { login: 'alice', name: 'Alice' });
      await fx.player(alice);
      const reply = await bot.send(alice, '!char');
      assert.match(reply, /Berserker \(dps\)/);
      assert.match(reply, /Lv 1/);
    },
  },
  {
    command: 'bag', title: 'lists numbered unequipped loot',
    run: async ({ bot, u, fx }) => {
      const alice = u('e2e_bag', { login: 'alice', name: 'Alice' });
      await fx.player(alice);
      await fx.loot(alice, DPS_ITEM);
      const reply = await bot.send(alice, '!bag');
      assert.match(reply, /bag: 1\. /);
    },
  },
  {
    command: 'equip', title: 'equips a bag item by number',
    run: async ({ bot, u, fx }) => {
      const alice = u('e2e_equip', { login: 'alice', name: 'Alice' });
      await fx.player(alice);
      await fx.loot(alice, DPS_ITEM);
      const reply = await bot.send(alice, '!equip 1');
      assert.match(reply, /equipped .* \(weapon\)/);
    },
  },
  {
    command: 'unequip', title: 'returns an equipped slot to the bag',
    run: async ({ bot, u, fx }) => {
      const alice = u('e2e_unequip', { login: 'alice', name: 'Alice' });
      await fx.player(alice); // starter weapon is equipped
      const reply = await bot.send(alice, '!unequip weapon');
      assert.match(reply, /unequipped/i);
      const p = await getPlayer(alice.id);
      assert.ok((p.inventory || []).length > 0, 'item returned to bag');
    },
  },
  {
    command: 'grab', title: 'enters the active loot drop',
    run: async ({ bot, u, fx }) => {
      const alice = u('e2e_grab', { login: 'alice', name: 'Alice' });
      await fx.player(alice);
      await fx.drop();
      const reply = await bot.send(alice, '!grab');
      assert.match(reply, /you're entered for/i);
    },
  },
  {
    command: 'muster', title: 'enlists your hero in the signup-phase raid',
    run: async ({ bot, u, fx }) => {
      const alice = u('e2e_muster', { login: 'alice', name: 'Alice' });
      await fx.raidWeek();
      await fx.player(alice);
      const reply = await bot.send(alice, '!muster');
      assert.match(reply, /mustered/i);
    },
  },
  {
    command: 'top', title: 'shows the season damage leaderboard',
    run: async ({ bot, u, fx }) => {
      const hero = u('e2e_top', { login: 'topper', name: 'Topper' });
      await fx.leaderboard(hero, 500);
      const reply = await bot.send(u('e2e_top_viewer', { login: 'viewer' }), '!top');
      assert.match(reply, /Season damage/);
      assert.match(reply, /Topper/);
    },
  },
  {
    command: 'fact', title: 'returns a random fun fact',
    run: async ({ bot, u, fx }) => {
      await fx.facts();
      const reply = await bot.send(u('e2e_fact', { login: 'viewer' }), '!fact');
      assert.match(reply, /FUN FACT/i);
    },
  },
  {
    command: 'kennycommands', title: 'links the command reference',
    run: async ({ bot, u }) => {
      const reply = await bot.send(u('e2e_kc', { login: 'viewer' }), '!kennycommands');
      assert.match(reply, /\/commands\//);
    },
  },
  {
    command: 'credits', title: 'reports your credit balance',
    run: async ({ bot, u }) => {
      const reply = await bot.send(u('e2e_credits', { login: 'viewer', name: 'Viewer' }), '!credits');
      assert.match(reply, /\d+ credits/);
    },
  },
  {
    command: 'daily', title: 'claims the daily allowance',
    run: async ({ bot, u }) => {
      const reply = await bot.send(u('e2e_daily', { login: 'viewer', name: 'Viewer' }), '!daily');
      assert.match(reply, /\+200 credits/);
    },
  },
  {
    command: 'bet', title: 'wagers credits on the only open market',
    run: async ({ bot, u, fx }) => {
      const alice = u('e2e_bet', { login: 'alice', name: 'Alice' });
      await fx.wallet(alice);
      await fx.market();
      const reply = await bot.send(alice, '!bet yes 100');
      assert.match(reply, /bet on #/i);
    },
  },
  {
    command: 'duel', title: 'challenge → accept settles a coin-flip pot',
    run: async ({ bot, u, fx }) => {
      const alice = u('e2e_duel_a', { login: 'alice', name: 'Alice' });
      const bob = u('e2e_duel_b', { login: 'bob', name: 'Bob' });
      await fx.wallet(alice); await fx.wallet(bob);
      const challenge = await bot.send(alice, '!duel @bob 50');
      assert.match(challenge, /challenges you/i);
      const settle = await bot.send(bob, '!duel accept');
      assert.match(settle, /pot!/);
    },
  },
  {
    command: 'trade', title: 'swap requires a counter, then settles',
    run: async ({ bot, u, fx }) => {
      const alice = u('e2e_trade_a', { login: 'alice', name: 'Alice' });
      const bob = u('e2e_trade_b', { login: 'bob', name: 'Bob' });
      await fx.player(alice); await fx.loot(alice, DPS_RARE);
      await fx.player(bob, 'Guardian'); await fx.loot(bob, TANK_RARE);
      assert.match(await bot.send(alice, '!trade @bob 1'), /wants to trade/i);
      assert.match(await bot.send(bob, '!trade counter 1'), /counters/i);
      assert.match(await bot.send(alice, '!trade accept'), /Trade done/i);
    },
  },
  {
    command: 'offer', title: 'one-way gift is accepted',
    run: async ({ bot, u, fx }) => {
      const alice = u('e2e_offer_a', { login: 'alice', name: 'Alice' });
      const bob = u('e2e_offer_b', { login: 'bob', name: 'Bob' });
      await fx.player(alice); await fx.loot(alice, DPS_RARE);
      await fx.player(bob, 'Guardian');
      assert.match(await bot.send(alice, '!offer @bob 1'), /offers you/i);
      assert.match(await bot.send(bob, '!offer accept'), /received/i);
    },
  },
  {
    command: 'market', title: 'lists the open OKRAMARKETs',
    run: async ({ bot, u, fx }) => {
      await fx.market();
      const reply = await bot.send(u('e2e_market', { login: 'viewer' }), '!market');
      assert.match(reply, /OKRAMARKET/);
    },
  },
  {
    command: 'todo', title: 'mod adds a to-do item',
    run: async ({ bot, u }) => {
      const reply = await bot.send(u('e2e_todo', { login: 'mod', name: 'Mod', mod: true }), '!todo add Water the okra');
      assert.match(reply, /To-do #\d+ added/i);
    },
  },
  {
    command: 'exp', title: 'mod sets the EXP gate',
    run: async ({ bot, u }) => {
      const reply = await bot.send(u('e2e_exp', { login: 'mod', name: 'Mod', mod: true }), '!exp on');
      assert.match(reply, /EXP mode set to on/i);
    },
  },
  {
    command: 'mute', title: 'mod mutes (ack bypasses the mute)',
    run: async ({ bot, u }) => {
      const reply = await bot.send(u('e2e_mute', { login: 'mod', name: 'Mod', mod: true }), '!mute on');
      assert.match(reply, /Muted/i);
    },
  },
  {
    command: 'drop', title: 'mod forces a specific loot drop',
    run: async ({ bot, u }) => {
      const reply = await bot.send(u('e2e_drop', { login: 'mod', name: 'Mod', mod: true }), `!drop ${DPS_ITEM}`);
      assert.match(reply, /dropped/i);
      assert.match(reply, /!grab/);
    },
  },
  {
    command: 'drops', title: 'mod toggles the auto-drop scheduler',
    run: async ({ bot, u }) => {
      const reply = await bot.send(u('e2e_drops', { login: 'mod', name: 'Mod', mod: true }), '!drops on');
      assert.match(reply, /Auto-drops ON/i);
    },
  },
  {
    command: 'boss', title: 'mod opens muster with a custom boss',
    run: async ({ bot, u }) => {
      const reply = await bot.send(u('e2e_boss', { login: 'mod', name: 'Mod', mod: true }), '!boss set Grumblehoof');
      assert.match(reply, /Grumblehoof/);
    },
  },
  {
    command: 'raidnight', title: 'mod locks the roster and runs the battle',
    run: async ({ bot, u, fx }) => {
      await fx.raidWeek({ enlistUsers: [u('e2e_rn_hero', { login: 'hero', name: 'Hero' })] });
      const reply = await bot.send(u('e2e_rn_mod', { login: 'mod', name: 'Mod', mod: true }), '!raidnight');
      assert.match(reply, /RAID NIGHT/i);
    },
  },
  {
    command: 'season', title: 'mod starts a new season',
    run: async ({ bot, u }) => {
      const reply = await bot.send(u('e2e_season', { login: 'mod', name: 'Mod', mod: true }), '!season start t2');
      assert.match(reply, /Season started/i);
      assert.match(reply, /t2/);
    },
  },
];
