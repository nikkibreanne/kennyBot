// Local dev console (IMPLEMENTATION §H.4): drive the bot's game logic by typing
// chat commands — no Twitch, no stream. Routes every line through the SAME
// command registry + handler the live bot uses, writing to the Firebase
// emulator. Open the website (pointed at the emulator) in a browser alongside
// this to watch /raid/ and /live/ react in real time.
//
//   npx firebase emulators:exec --only database --project okrafans \
//     "node scripts/dev-console.js"
//
// Lines starting with "!" are chat commands from the current identity.
// Lines starting with "/" are console meta-commands (see /help).

import { createInterface } from 'node:readline';
import { initFirebase, closeFirebase, database, PATHS } from '../src/db/firebase.js';
import { startConfigMirror, setExpMode, getRaidPointer, setSeason } from '../src/db/configStore.js';
import { createMessageHandler } from '../src/events/chat.js';
import { listCommands } from '../src/commands/registry.js';
import { applyChatTick, createPlayer, getPlayer } from '../src/db/players.js';
import { getActiveRaid, advanceRaidPhases, setupRaidWeek, enlist, computeNextRaidNight } from '../src/db/raid.js';
import { seasonBoss } from '../src/content/bosses.js';
import { SEASON_LOOT } from '../src/content/items.js';
import { config } from '../src/config.js';

const CHANNEL = process.env.TWITCH_CHANNEL || 'scasplte2';
const quietLogger = { debug() {}, info() {}, warn() {}, error: (m, x) => console.error('[err]', m, x?.err || '') };

// A fake chat client: prints what the bot would say.
const chat = {
  say: async (_ch, text) => { console.log(`  🤖 ${text}`); },
  action: async (_ch, text) => { console.log(`  🤖 *${text}*`); },
};

// Current chat identity (start as the broadcaster so mod commands work).
let me = { id: 'dev_nikki', login: 'nikki', displayName: 'Nikki', isBroadcaster: true, isMod: true, isSubscriber: true };

function fakeMsg(text) {
  return {
    userInfo: {
      userId: me.id, userName: me.login, displayName: me.displayName,
      isMod: me.isMod, isBroadcaster: me.isBroadcaster, isSubscriber: me.isSubscriber,
    },
    text,
  };
}

const HELP = `
Console meta-commands:
  /as <name> [sub] [mod] [bc]   switch identity (flags grant sub/mod/broadcaster)
  /whoami                       show current identity
  /grind [n]                    grant EXP n times to current user (bypass cooldown)
  /scenario list                list preset scenarios
  /scenario <name>              load a preset (season + boss + a mustered roster)
  /commands                     list all ! chat commands
  /advance                      tick the SCHEDULED phase machine (only acts when a
                                lock/start/close time has passed; for on-demand
                                testing use !raidnight instead)
  /state                        show the active raid pointer + phase
  /help                         this help (+ the ! command list)
  /quit                         exit

To run a raid NOW: load a roster (/scenario winnable) then !raidnight as a mod.
`;

/** Print every registered ! command with a [mod]/[sub] tag (from the registry). */
function printCommands() {
  console.log('\nChat commands (prefix with !):');
  for (const def of listCommands()) {
    const tag = def.mod ? '[mod]' : def.subOnly ? '[sub]' : '     ';
    console.log(`  ${tag} ${def.help}`);
  }
}

// Preset scenarios so you don't rebuild setup each run. Each loads a season +
// boss and a roster of created/leveled/mustered heroes — then type !raidnight.
const DPS = ['Berserker', 'Arcanist', 'Ranger'];
// Build a [class, level] roster: t tanks, h healers, rest dps, all at `level`.
function roster({ tanks = 0, healers = 0, dps = 0, level = 10 }) {
  const out = [];
  for (let i = 0; i < tanks; i++) out.push(['Guardian', level]);
  for (let i = 0; i < healers; i++) out.push(['Mender', level]);
  for (let i = 0; i < dps; i++) out.push([DPS[i % 3], level]);
  return out;
}

// Scenarios use the REAL calibrated season bosses (HP scales to the roster), so
// outcomes reflect actual content. Reference roster is ~15 heroes at season level.
const SCENARIOS = {
  winnable: { desc: '12 heroes ~Lv10 vs an early-season boss → victory',
    season: 1, week: 2, heroes: roster({ tanks: 3, healers: 2, dps: 7, level: 10 }) },
  wipe: { desc: 'undermanned 5 heroes ~Lv8 vs the SEASON FINALE → wipe',
    season: 1, week: 6, heroes: roster({ tanks: 1, healers: 1, dps: 3, level: 8 }) },
  nohealer: { desc: 'no healer vs an AoE caster boss → wipe (readiness flags it)',
    season: 1, week: 5, heroes: roster({ tanks: 2, healers: 0, dps: 4, level: 10 }) },
  big: { desc: '25 heroes ~Lv10 → big-raid stress test (HP scales up)',
    season: 1, week: 3, heroes: roster({ tanks: 5, healers: 4, dps: 16, level: 10 }) },
};

async function loadScenario(name) {
  if (name === 'list' || !name) {
    for (const [k, v] of Object.entries(SCENARIOS)) console.log(`  ${k.padEnd(10)} — ${v.desc}`);
    return;
  }
  const sc = SCENARIOS[name];
  if (!sc) { console.log(`  unknown scenario "${name}" (try /scenario list)`); return; }
  const seasonId = 't1', weekId = 'w1';
  const boss = seasonBoss(sc.season, sc.week);
  await setSeason({ id: seasonId, name: 'Tier 1', tier: 1, startsAt: Date.now(), weeks: config.raid.seasonWeeks, lootTable: SEASON_LOOT[0] });
  const startsAt = computeNextRaidNight();
  await setupRaidWeek({ seasonId, weekId, boss, locksAt: startsAt - config.raid.lockLeadMs, startsAt });
  let i = 0;
  for (const [cls, lvl] of sc.heroes) {
    const id = `scn_${name}_${i}`;
    await createPlayer({ userId: id, login: id, displayName: `${cls}${i}`, className: cls });
    await database().ref(`${PATHS.player(id)}/level`).set(lvl); // set level directly (fast test data)
    await enlist({ seasonId, weekId, userId: id, player: await getPlayer(id) });
    i++;
  }
  console.log(`  loaded "${name}": ${sc.heroes.length} heroes mustered vs ${boss.name} (rec ~${boss.recommended}).`);
  console.log('  → type !raidnight (you start as Nikki/mod) or open http://localhost:4000/raid/');
}

async function main() {
  if (!process.env.FIREBASE_DATABASE_EMULATOR_HOST && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    console.error('Set FIREBASE_DATABASE_EMULATOR_HOST (run under `firebase emulators:exec`).');
    process.exit(1);
  }
  initFirebase();
  await startConfigMirror(quietLogger);
  await setExpMode('on'); // bypass the live gate for local testing

  const onMessage = createMessageHandler({ chat, channel: CHANNEL, botUserId: 'devbot', logger: quietLogger });

  console.log(`kennyBot dev console — channel #${CHANNEL}, EXP gate bypassed (expMode=on).`);
  console.log(`You are ${me.displayName} (broadcaster+mod+sub). Type /help. Try: !season start t1, then /as alice sub, !create Berserker, !raid, /as nikki, !raidnight`);

  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' });
  rl.prompt();

  // Serialize line handling so each command fully completes before the next —
  // makes both interactive use AND piped scripts (`... < session.txt`) reliable.
  let chain = Promise.resolve();
  rl.on('line', (line) => {
    chain = chain.then(async () => {
      const input = line.trim();
      try {
        if (!input) { /* noop */ }
        else if (input.startsWith('/')) await meta(input);
        else await onMessage(CHANNEL, me.login, input, fakeMsg(input));
      } catch (err) {
        console.error('error:', err?.message || err);
      }
      rl.prompt();
    });
  });

  rl.on('close', () => { chain.then(() => closeFirebase().catch(() => {})).then(() => process.exit(0)); });
}

async function meta(input) {
  const [cmd, ...args] = input.slice(1).split(/\s+/);
  switch (cmd) {
    case 'as': {
      const name = args[0] || 'alice';
      const flags = args.slice(1).map((f) => f.toLowerCase());
      me = {
        id: `dev_${name.toLowerCase()}`, login: name.toLowerCase(), displayName: name,
        isSubscriber: flags.includes('sub'), isMod: flags.includes('mod'),
        isBroadcaster: flags.includes('bc') || flags.includes('broadcaster'),
      };
      console.log(`  now acting as ${me.displayName} ${JSON.stringify({ sub: me.isSubscriber, mod: me.isMod, bc: me.isBroadcaster })}`);
      break;
    }
    case 'whoami':
      console.log(`  ${me.displayName} (${me.id})`, { sub: me.isSubscriber, mod: me.isMod, bc: me.isBroadcaster });
      break;
    case 'grind': {
      const n = Math.max(1, parseInt(args[0] || '20', 10));
      let levels = 0;
      for (let i = 0; i < n; i++) {
        const t = await applyChatTick(me.id);
        if (!t) { console.log('  (no character — !create first)'); break; }
        if (t.leveledUp) { levels++; console.log(`  ${me.displayName} → level ${t.toLevel}`); }
      }
      console.log(`  granted ${n} ticks (${levels} level-ups)`);
      break;
    }
    case 'scenario':
      await loadScenario((args[0] || 'list').toLowerCase());
      break;
    case 'advance': {
      const t = await advanceRaidPhases();
      console.log(t ? `  advanced → ${t.transition}` : '  (no transition due yet)');
      break;
    }
    case 'state': {
      const p = getRaidPointer();
      const active = await getActiveRaid();
      console.log('  config/raid:', p || '(none)');
      if (active?.boss) console.log(`  boss: ${active.boss.name} (${active.boss.hp} HP) · phase ${active.phase} · heroes ${active.team?.count ?? 0}`);
      break;
    }
    case 'help': console.log(HELP); printCommands(); break;
    case 'commands': printCommands(); break;
    case 'quit': case 'exit': process.exit(0); break;
    default: console.log(`  unknown meta-command: /${cmd} (try /help)`);
  }
}

main().catch(async (err) => { console.error('dev-console failed:', err); await closeFirebase().catch(() => {}); process.exit(1); });
