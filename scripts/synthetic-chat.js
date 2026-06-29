// Automated no-stream end-to-end (IMPLEMENTATION §H.4 / §L.5): drives the full
// active-combat loop — create heroes → muster (!raid) → force raid night →
// automated battle → resolve — directly against the persistence + engine, no
// Twitch. Asserts the combat log matches the website's replay contract.
//
//   npx firebase emulators:exec --only database --project okrafans \
//     "node scripts/synthetic-chat.js"

import assert from 'node:assert/strict';
import { initFirebase, closeFirebase, database, PATHS } from '../src/db/firebase.js';
import { startConfigMirror, setSeason } from '../src/db/configStore.js';
import { createPlayer, getPlayer, applyChatTick } from '../src/db/players.js';
import { setupRaidWeek, enlist, forceRaidNight, finishBattle, getCombat } from '../src/db/raid.js';
import { defaultBoss } from '../src/content/bosses.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ROSTER = [
  { id: 'sim_guardian', login: 'sim_guardian', name: 'SimGuardian', class: 'Guardian' },
  { id: 'sim_mender', login: 'sim_mender', name: 'SimMender', class: 'Mender' },
  { id: 'sim_zerk', login: 'sim_zerk', name: 'SimZerk', class: 'Berserker' },
  { id: 'sim_arcanist', login: 'sim_arcanist', name: 'SimArcanist', class: 'Arcanist' },
  { id: 'sim_ranger', login: 'sim_ranger', name: 'SimRanger', class: 'Ranger' },
];

async function main() {
  if (!process.env.FIREBASE_DATABASE_EMULATOR_HOST && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    console.error('Set FIREBASE_DATABASE_EMULATOR_HOST (run under `firebase emulators:exec`).');
    process.exit(1);
  }
  initFirebase();
  await startConfigMirror({ info: () => {} });

  const seasonId = 't1', weekId = 'w1';
  await setSeason({ id: seasonId, name: 'Tier 1', startsAt: Date.now() });

  console.log('— creating heroes —');
  for (const m of ROSTER) {
    const { player } = await createPlayer({ userId: m.id, login: m.login, displayName: m.name, className: m.class });
    console.log(`  ${m.name}: ${player.class} (${player.role}) HP→${player.equipped.weapon?.name}`);
  }

  console.log('— heroes grow over the week (chat EXP → levels) —');
  for (const m of ROSTER) {
    for (let i = 0; i < 200; i++) await applyChatTick(m.id);
    const p = await getPlayer(m.id);
    console.log(`  ${m.name} → Lv ${p.level}`);
  }

  console.log('— scheduling boss + muster —');
  const boss = defaultBoss('The Ashen Warden', { hp: 4000, atk: 80 });
  const now = Date.now();
  await setupRaidWeek({ seasonId, weekId, boss, locksAt: now + 60_000, startsAt: now + 120_000 });
  await sleep(150);

  console.log('— heroes muster (!raid) —');
  for (const m of ROSTER) {
    await enlist({ seasonId, weekId, userId: m.id, player: await getPlayer(m.id) });
    console.log(`  ${m.name} mustered`);
  }

  console.log('— FORCE RAID NIGHT (lock + simulate) —');
  const combat = await forceRaidNight(seasonId, weekId, { seed: 20260629 });
  const events = Object.keys(combat.log).map(Number).sort((a, b) => a - b).map((k) => combat.log[k]);

  // Verify the combat-event log matches the UI replay contract.
  assert.equal(events[0].type, 'start', 'first event is start');
  assert.equal(events.at(-1).type, 'end', 'last event is end');
  assert.ok(events.some((e) => e.type === 'turn'), 'has turns');
  assert.ok(events.some((e) => e.type === 'action' && e.target === 'boss'), 'has boss damage');
  assert.equal(typeof combat.bossMaxHp, 'number');
  assert.ok(['live', 'done'].includes(combat.status));
  console.log(`  ✓ ${events.length} events, contract OK · seed ${combat.seed}`);

  // Verify the website-contract shapes (raid.html / live.html consume these).
  const cfgRaid = (await database().ref(PATHS.configRaid()).get()).val();
  for (const k of ['seasonId', 'weekId', 'phase', 'startsAt']) assert.ok(cfgRaid?.[k] != null, `config/raid.${k}`);
  const sample = (await database().ref(PATHS.signup(seasonId, weekId, ROSTER[0].id)).get()).val();
  for (const k of ['displayName', 'class', 'role', 'level', 'roleRating', 'maxHp', 'power', 'defense', 'healing', 'equipped']) {
    assert.ok(k in sample, `signup.${k} present`);
  }
  assert.ok(sample.equipped.weapon?.name && sample.equipped.weapon?.rarity, 'equipped.weapon is {name,rarity}');
  console.log('  ✓ config/raid + signup + equipped shapes match the UI contract');

  const turns = events.filter((e) => e.type === 'turn').length;
  console.log(`  battle: ${turns} turns → ${combat.result.downed ? 'VICTORY 💀' : 'DEFEAT 🪦'} · HP left ${combat.result.bossHpRemaining} · MVP ${combat.result.mvp}`);
  console.log('  sample log:');
  for (const e of events.slice(0, 6)) console.log('    ' + (e.text || `[${e.type}${e.n ? ' ' + e.n : ''}]`));

  console.log('— closing out (loot + leaderboard) —');
  const fin = await finishBattle(seasonId, weekId);
  console.log(`  done: ${fin.downed ? 'victory' : 'defeat'} · mvp ${fin.mvp}`);

  const after = await getCombat(seasonId, weekId);
  assert.equal(after.status, 'done');
  console.log('done. Open the site at /raid/ and /live/ (pointed at the emulator) to watch it.');

  await closeFirebase();
  process.exit(0);
}

main().catch(async (err) => {
  console.error('synthetic harness failed:', err);
  await closeFirebase().catch(() => {});
  process.exit(1);
});
