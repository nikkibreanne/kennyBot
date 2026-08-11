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
import { seedCuratedFacts, orderedFacts } from '../../src/db/facts.js';
import { seedReminders, listReminders } from '../../src/db/reminders.js';
import { getRaidPointer, getConfig, setLive, setClipMode } from '../../src/db/configStore.js';
import { initClipsWith } from '../../src/twitch/clips.js';
import { initCaptureWith } from '../../src/integrations/capture.js';
import { initMediaWith } from '../../src/integrations/obsMedia.js';
import { clearMediaSlot, listSlots } from '../../src/db/media.js';
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

/** Seed the default reminders and wait for the config mirror to see them. */
async function reminders() {
  const res = await seedReminders();
  await until(() => listReminders().length >= res.seeded.length + res.kept.length);
  return res;
}

export const fixtures = { player, loot, wallet, market, drop, facts, leaderboard, raidWeek, reminders };

// ── scenarios (one per command primary name) ─────────────────────────────────
export const SCENARIOS = [
  {
    command: 'clip', title: 'saves a full-quality local capture (and a Twitch clip in "both" mode)',
    run: async ({ bot, u }) => {
      const alice = u('e2e_clip', { login: 'alice', name: 'Alice' });
      const bob = u('e2e_clip2', { login: 'bob', name: 'Bob' }); // !clip is per-user cooldowned
      initClipsWith(async () => 'TestClipId123'); // fake Helix Create Clip
      initCaptureWith(async () => ({ path: 'D:/rec/Replay.mkv' })); // fake OBS
      try {
        // Default mode is local: the streamer's OBS saves the moment at full
        // recording quality and nothing is posted to Twitch.
        // The reply is a bare confirmation — chat learns nothing about the rig.
        const local = await bot.send(alice, '!clip');
        assert.match(local, /clipped it/i);
        assert.doesNotMatch(local, /clips\.twitch\.tv/, 'the default must not make a Twitch clip');

        // 'both' puts the Twitch clip back alongside it (needs live). The mode is
        // RTDB-only — there is no env var — so switch it the way a mod does.
        await setClipMode('both');
        await setLive(true, 'test');
        await until(() => getConfig().live === true); // mirror is async
        assert.match(await bot.send(bob, '!clip'), /clips\.twitch\.tv\/TestClipId123/);
      } finally {
        await setClipMode('local'); // reset shared config for later scenarios
        initCaptureWith(null);
        await setLive(false, 'test'); // reset shared live state for later scenarios
      }
    },
  },
  {
    command: 'clipmode', title: 'a mod switches what !clip does, and it persists',
    run: async ({ bot, u }) => {
      const mod = u('e2e_clipmode', { login: 'nikki', name: 'Nikki', mod: true });
      const viewer = u('e2e_clipmode_v', { login: 'carl', name: 'Carl' });
      initCaptureWith(async () => ({ path: 'D:/rec/Replay.mkv' }));
      try {
        assert.match(await bot.send(mod, '!clipmode status'), /!clip mode: \w+/);

        // Switching to twitch must take effect for the very next !clip, without
        // waiting on an RTDB round-trip — that's why setClipMode writes the mirror first.
        await bot.send(mod, '!clipmode twitch');
        assert.equal(getConfig().clipMode, 'twitch', 'mirror updated synchronously');
        const snap = await database().ref('config/clipMode').get();
        assert.equal(snap.val(), 'twitch', 'and persisted, so it survives a restart');

        // Not live → the twitch half is impossible, and local is switched off.
        assert.match(await bot.send(viewer, '!clip'), /only clip while the stream is live/i);

        // Aliases expand to the canonical target list on the way in.
        await bot.send(mod, '!clipmode local');
        assert.equal(getConfig().clipMode, 'horizontal,vertical');

        // The combinations the old local|twitch|both presets could not express.
        await bot.send(mod, '!clipmode horizontal');
        assert.equal(getConfig().clipMode, 'horizontal');
        await bot.send(mod, '!clipmode vertical twitch');
        assert.equal(getConfig().clipMode, 'vertical,twitch', 'order-normalised');

        // All-or-nothing: one bad token must reject the whole line, not part of it.
        assert.match(await bot.send(mod, '!clipmode horizontal nonsense'), /Usage: !clipmode/);
        assert.equal(getConfig().clipMode, 'vertical,twitch', 'a bad value changes nothing');
      } finally {
        // Scenarios share one emulator DB — leave the mode as the next one expects.
        await setClipMode('local');
        initCaptureWith(null);
      }
    },
  },
  {
    command: 'start', title: 'a mod drops a clip-sync anchor',
    run: async ({ bot, u }) => {
      const mod = u('e2e_start', { login: 'nikki', name: 'Nikki', mod: true });
      const reply = await bot.send(mod, '!start'); // not live → anchor only, no marker
      assert.match(reply, /sync point set/i);
      const snap = await database().ref('clipSync').get();
      assert.ok(snap.exists(), 'a clipSync anchor was written');
    },
  },
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
    command: 'fact', title: 'random fact, and a specific one by its /info/ number',
    run: async ({ bot, u, fx }) => {
      await fx.facts();
      const viewer = u('e2e_fact', { login: 'viewer' });

      // Bare !fact — random, but it reports which number it is so the numbering
      // is discoverable from chat.
      const random = await bot.send(viewer, '!fact');
      assert.match(random, /FUN FACT #\d+:/i);

      // !fact <n> must return the fact the /info/ page shows at position n. The
      // page numbers positionally, so assert against the same ordering the site
      // uses rather than against a hardcoded string.
      const ordered = await orderedFacts();
      assert.ok(ordered.length >= 2, 'need at least two facts to test numbering');
      const third = await bot.send(u('e2e_fact3', { login: 'v3' }), '!fact 2');
      assert.match(third, /FUN FACT #2:/);
      assert.ok(third.includes(ordered[1].text), 'must be the SAME fact the page numbers 2');

      // Out of range says what the range is, rather than silently answering with
      // some other fact — a typo must not look like a successful lookup.
      const oor = await bot.send(u('e2e_fact4', { login: 'v4' }), `!fact ${ordered.length + 5}`);
      assert.match(oor, new RegExp(`only ${ordered.length} facts`, 'i'));
      assert.doesNotMatch(oor, /FUN FACT #/, 'must not fall back to a random fact');
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
    command: 'reminder', title: 'mod lists and re-times a scheduled reminder',
    run: async ({ bot, u, fx }) => {
      await fx.reminders();
      const mod = u('e2e_rem', { login: 'mod', name: 'Mod', mod: true });
      assert.match(await bot.send(mod, '!reminder'), /ghosty.*daily 08:00, 17:00/i);

      // Re-time Ghosty's meals from chat — the point of keeping schedules in the DB.
      assert.match(await bot.send(mod, '!reminder at ghosty 09:30 18:30'), /09:30, 18:30/);
      assert.deepEqual((await database().ref('config/reminders/ghosty/times').get()).val(), ['09:30', '18:30']);

      assert.match(await bot.send(mod, '!reminder at ghosty half-past-nine'), /isn't a time/i);
      assert.match(await bot.send(mod, '!reminder off hydration'), /hydration off/i);
      assert.match(await bot.send(mod, '!reminder test wallpaper'), /Wallpaper Engine/i);
      assert.match(await bot.send(mod, '!reminder every hydration 45'), /every 45m/);
      assert.match(await bot.send(mod, '!reminder nope ghosty'), /Usage/i);
      // A non-mod gets nothing at all (the whole command is mod-gated).
      assert.equal(await bot.send(u('e2e_rem_v', { login: 'viewer' }), '!reminder'), '');
    },
  },
  {
    command: 'timer', title: 'mod sets/extends the stream timer; anyone can read it',
    run: async ({ bot, u }) => {
      const mod = u('e2e_timer', { login: 'mod', name: 'Mod', mod: true });
      const viewer = u('e2e_timer_v', { login: 'viewer', name: 'Viewer' });
      try {
        assert.match(await bot.send(mod, '!timer 10m Coffee break'), /Timer set — Coffee break: 10m/i);
        assert.match(await bot.send(mod, '!timer +5'), /\+5m/, 'extends without restarting');
        // A viewer can ask how long is left…
        const status = await bot.send(viewer, '!timer');
        assert.match(status, /Coffee break: 1[45]m/, '~15m left');
        // …but cannot touch the clock: no reply, and the timer is untouched.
        assert.equal(await bot.send(viewer, '!timer stop'), '', 'a non-mod control is ignored');
        assert.ok((await database().ref('config/timer').get()).exists(), 'still running');

        assert.match(await bot.send(mod, '!timer pause'), /Paused/i);
        assert.match(await bot.send(mod, '!timer resume'), /Resumed/i);
        assert.match(await bot.send(mod, '!timer stop'), /dismissed/i);
        assert.equal((await database().ref('config/timer').get()).exists(), false, 'cleared from RTDB');
      } finally {
        await bot.send(mod, '!timer stop'); // never leak a timer into the next scenario
      }
    },
  },
  {
    command: 'media', title: 'a mod maps an OBS source to a number and fires it',
    run: async ({ bot, u }) => {
      const mod = u('e2e_media', { login: 'nikki', name: 'Nikki', mod: true });
      const fired = [];
      // Stands in for the whole obs-websocket round trip — what matters here is
      // that the SLOT the command resolved is the one handed to OBS.
      initMediaWith(async ({ slot }) => { fired.push(slot); return { played: true, shown: Boolean(slot.scene) }; });
      try {
        assert.match(await bot.send(mod, '!media'), /no media slots mapped/i);
        assert.match(await bot.send(mod, '!media 1'), /slot 1 is not mapped/i);

        // Source names are the rest of the line — real OBS sources have spaces.
        assert.match(await bot.send(mod, '!media set 1 Airhorn SFX'), /"Airhorn SFX"/);
        assert.equal((await database().ref('config/media/1').get()).val().input, 'Airhorn SFX', 'persisted');

        // Firing is silent in chat by contract; the slot reaching OBS is the proof.
        assert.equal(await bot.send(mod, '!media 1'), '', 'a successful play says nothing');
        assert.equal(fired.length, 1);
        assert.equal(fired[0].input, 'Airhorn SFX');
        assert.equal(fired[0].action ?? 'restart', 'restart', 'the alert-shaped default');

        // Mapping a scene and an action edits the same slot rather than replacing it.
        assert.match(await bot.send(mod, '!media scene 1 Alerts'), /in "Alerts"/);
        assert.match(await bot.send(mod, '!media action 1 stop'), /\(stop\)/);
        await bot.send(mod, '!media 1');
        assert.equal(fired[1].input, 'Airhorn SFX', 'input survived both edits');
        assert.equal(fired[1].scene, 'Alerts');
        assert.equal(fired[1].action, 'stop');

        // A typo'd action must not write a slot that throws at play time.
        assert.match(await bot.send(mod, '!media action 1 restrat'), /action must be one of/);
        assert.equal(listSlots()[0].action, 'stop', 'the bad edit changed nothing');

        assert.match(await bot.send(mod, '!media scene 1 none'), /"Airhorn SFX"/);
        assert.equal(listSlots()[0].scene ?? null, null, 'scene cleared, slot kept');

        assert.match(await bot.send(mod, '!media'), /Airhorn SFX/);
        assert.match(await bot.send(mod, '!media clear 1'), /cleared/i);
        assert.equal(listSlots().length, 0);
      } finally {
        // Scenarios share one emulator DB — leave no slots behind.
        await clearMediaSlot(1);
        initMediaWith(null);
      }
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
