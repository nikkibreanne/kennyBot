// Weekly raid: muster → raid night → automated battle (spec §5.8, IMPL §L).
// Phase machine in config/raid (signup → locked → live → done), driven by stored
// timestamps compared at boot + on a timer (never an in-memory timer that a
// restart loses, §H.5). The battle is the pure seeded engine (rules/combat);
// this layer freezes the roster at lock, runs it, and writes the append-only
// combat-event log the website replays.

import { database, increment, PATHS, SERVER_TIMESTAMP } from './firebase.js';
import { getRaidPointer, setRaidPointer, getSeason } from './configStore.js';
import { roleRating } from '../rules/rating.js';
import { combatStats, simulateBattle } from '../rules/combat.js';
import { getItem, DEFAULT_LOOT_TABLE } from '../content/items.js';
import { pickDrop } from '../rules/loot.js';
import { addLoot } from './players.js';
import { config } from '../config.js';

// ── snapshots ───────────────────────────────────────────────────────────────

/** Build a signup loadout snapshot from a player record (UI contract shapes). */
export function buildSnapshot(player) {
  const role = player.role;
  const rr = roleRating(player, config, getItem);
  const cs = combatStats(rr, role, config);
  return {
    displayName: player.displayName || 'Hero',
    class: player.class,
    role,
    level: player.level || 1,
    roleRating: rr,
    maxHp: cs.maxHp,
    power: cs.atk, // offense tile
    defense: cs.maxHp, // bulk/mitigation tile
    healing: cs.heal, // healing tile
    equipped: player.equipped || {},
  };
}

/** Aggregate team stats from the signup roster (written at lock; UI also recomputes). */
export function computeTeam(signups) {
  const team = {
    count: 0,
    byRole: { tank: 0, healer: 0, dps: 0 },
    roleRating: { tank: 0, healer: 0, dps: 0 },
    power: 0,
    defense: 0,
    healing: 0,
  };
  for (const s of Object.values(signups || {})) {
    team.count += 1;
    if (team.byRole[s.role] != null) team.byRole[s.role] += 1;
    if (team.roleRating[s.role] != null) team.roleRating[s.role] += s.roleRating || 0;
    team.power += s.power || 0;
    team.defense += s.defense || 0;
    team.healing += s.healing || 0;
  }
  return team;
}

// ── week setup + muster ─────────────────────────────────────────────────────

/**
 * Stand up a raid week: write the boss, the config/raid pointer (signup phase +
 * schedule), and reset the raid node. The website's muster page lights up off
 * config/raid.
 * @param {{ seasonId: string, weekId: string, boss: object, locksAt: number, startsAt: number }} args
 */
export async function setupRaidWeek({ seasonId, weekId, boss, locksAt, startsAt }) {
  const bossRecord = {
    name: boss.name,
    hp: boss.hp,
    atk: boss.atk,
    thresholds: boss.thresholds,
    affix: boss.affix ?? null,
    abilities: boss.abilities ?? null,
    status: 'signup',
  };
  await database().ref().update({
    [PATHS.boss(seasonId, weekId)]: bossRecord,
    [PATHS.raid(seasonId, weekId)]: { signups: {}, team: computeTeam({}) },
    [PATHS.configRaid()]: { seasonId, weekId, phase: 'signup', locksAt, startsAt, doneAt: null },
  });
  return { seasonId, weekId, boss: bossRecord };
}

/** Enlist a hero into the muster (a live preview snapshot, frozen again at lock). */
export async function enlist({ seasonId, weekId, userId, player }) {
  await database().ref(PATHS.signup(seasonId, weekId, userId)).set(buildSnapshot(player));
}

/** Resolve the active raid (pointer + boss + team), or null. */
export async function getActiveRaid() {
  const p = getRaidPointer();
  if (!p?.seasonId || !p?.weekId) return null;
  const [bossSnap, teamSnap] = await Promise.all([
    database().ref(PATHS.boss(p.seasonId, p.weekId)).get(),
    database().ref(PATHS.team(p.seasonId, p.weekId)).get(),
  ]);
  return { seasonId: p.seasonId, weekId: p.weekId, phase: p.phase, pointer: p, boss: bossSnap.val(), team: teamSnap.val() };
}

export async function getSignup(seasonId, weekId, userId) {
  const snap = await database().ref(PATHS.signup(seasonId, weekId, userId)).get();
  return snap.val();
}

export async function getCombat(seasonId, weekId) {
  const snap = await database().ref(PATHS.combat(seasonId, weekId)).get();
  return snap.val();
}

// ── phase transitions ───────────────────────────────────────────────────────

/** Freeze the roster: re-snapshot every signee from their current record + team aggregate. */
export async function lockRaid(seasonId, weekId) {
  const db = database();
  const snap = await db.ref(PATHS.signups(seasonId, weekId)).get();
  const signups = snap.val() || {};

  const frozen = {};
  for (const uid of Object.keys(signups)) {
    const pSnap = await db.ref(PATHS.player(uid)).get();
    const player = pSnap.val();
    frozen[uid] = player ? buildSnapshot(player) : signups[uid]; // fall back to preview
  }
  await db.ref(PATHS.raid(seasonId, weekId)).update({ signups: frozen, team: computeTeam(frozen) });
  await db.ref(`${PATHS.boss(seasonId, weekId)}/status`).set('locked');
  await setRaidPointer({ phase: 'locked' });
  return { count: Object.keys(frozen).length };
}

/** Deterministic 32-bit seed from the week id + a salt (stored for reproducibility). */
function deriveSeed(seasonId, weekId, salt) {
  let h = 2166136261 >>> 0; // FNV-1a
  for (const ch of `${seasonId}:${weekId}:${salt}`) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Run the battle: simulate from the frozen roster + boss + seed, write the
 * combat-event log, flip phase to live. Idempotent — won't re-run a battle that
 * already exists.
 * @param {string} seasonId @param {string} weekId
 * @param {{ now?: number, seed?: number }} [opts]
 */
export async function runBattle(seasonId, weekId, { now = Date.now(), seed } = {}) {
  const db = database();
  const [signupSnap, bossSnap, combatSnap] = await Promise.all([
    db.ref(PATHS.signups(seasonId, weekId)).get(),
    db.ref(PATHS.boss(seasonId, weekId)).get(),
    db.ref(PATHS.combat(seasonId, weekId)).get(),
  ]);
  if (combatSnap.exists()) return getCombat(seasonId, weekId); // already simulated

  const signups = signupSnap.val() || {};
  const boss = bossSnap.val() || { name: 'Boss', hp: config.raid.defaultBossHp, atk: config.raid.defaultBossAtk };
  const party = Object.entries(signups).map(([uid, s]) => ({
    uid, name: s.displayName, class: s.class, role: s.role, maxHp: s.maxHp, atk: s.power, heal: s.healing,
  }));

  const theSeed = seed ?? deriveSeed(seasonId, weekId, now);
  const { events, result, bossMaxHp } = simulateBattle(party, boss, theSeed, config);

  // Event array → object keyed by ascending integers (UI sorts numerically).
  const log = {};
  events.forEach((e, i) => { log[i] = e; });

  const revealMs = Math.min(events.length * config.combat.msPerEvent, config.raid.maxRevealMs);
  const combat = { seed: theSeed, status: 'live', startsAt: now, bossMaxHp, result, log };

  await db.ref(PATHS.combat(seasonId, weekId)).set(combat);
  await db.ref(`${PATHS.raid(seasonId, weekId)}/result`).set({
    downed: result.downed, bossHpRemaining: result.bossHpRemaining, mvp: result.mvp ?? null, status: 'live',
  });
  await db.ref(`${PATHS.boss(seasonId, weekId)}/status`).set('live');
  await setRaidPointer({ phase: 'live', startsAt: now, doneAt: now + revealMs });
  return combat;
}

/** Per-uid damage to the boss, summed from the combat log (for the leaderboard). */
function damageByUid(log) {
  const dmg = {};
  for (const e of Object.values(log || {})) {
    if (e.type === 'action' && e.kind === 'damage' && e.target === 'boss') {
      dmg[e.actor] = (dmg[e.actor] || 0) + (e.amount || 0);
    }
  }
  return dmg;
}

/**
 * Close out a finished battle: flip phase to done, distribute loot + leaderboard,
 * bump participation. Idempotent.
 */
export async function finishBattle(seasonId, weekId, { now = Date.now() } = {}) {
  const db = database();
  const p = getRaidPointer();
  if (p?.phase === 'done') return null;

  const [combatSnap, signupSnap] = await Promise.all([
    db.ref(PATHS.combat(seasonId, weekId)).get(),
    db.ref(PATHS.signups(seasonId, weekId)).get(),
  ]);
  const combat = combatSnap.val();
  if (!combat) return null;
  const signups = signupSnap.val() || {};
  const downed = combat.result?.downed;
  const dmg = damageByUid(combat.log);

  // Leaderboard + participation (atomic increments).
  const updates = {};
  for (const uid of Object.keys(signups)) {
    updates[`${PATHS.leaderboardEntry(seasonId, uid)}/damage`] = increment(dmg[uid] || 0);
    updates[`${PATHS.player(uid)}/stats/raidsParticipated`] = increment(1);
  }
  if (Object.keys(updates).length) await db.ref().update(updates);

  // Loot distribution: victory rewards every participant; MVP gets a bonus roll.
  if (downed) {
    const lootTable = getSeason()?.lootTable?.length ? getSeason().lootTable : DEFAULT_LOOT_TABLE;
    for (const uid of Object.keys(signups)) {
      const itemId = pickDrop(lootTable, getItem, Math.random, config);
      if (itemId) await addLoot(uid, itemId);
    }
    if (combat.result?.mvp) {
      const bonus = pickDrop(lootTable, getItem, Math.random, config);
      if (bonus) await addLoot(combat.result.mvp, bonus);
    }
  }

  await db.ref(`${PATHS.combat(seasonId, weekId)}/status`).set('done');
  await db.ref(`${PATHS.raid(seasonId, weekId)}/result/status`).set('done');
  await db.ref(`${PATHS.boss(seasonId, weekId)}/status`).set(downed ? 'downed' : 'wiped');
  await db.ref(`${PATHS.raid(seasonId, weekId)}/result/resolvedAt`).set(SERVER_TIMESTAMP);
  await setRaidPointer({ phase: 'done' });
  return { downed, mvp: combat.result?.mvp ?? null };
}

/**
 * PHASE MACHINE (boot + timer). Advance the active raid based on stored
 * timestamps vs `now`: signup→locked at locksAt, locked→live at startsAt (runs
 * the battle), live→done at doneAt. Returns the transition taken, or null.
 */
export async function advanceRaidPhases(now = Date.now()) {
  const p = getRaidPointer();
  if (!p?.seasonId || !p?.weekId) return null;
  const { seasonId, weekId, phase, locksAt, startsAt, doneAt } = p;

  if (phase === 'signup' && locksAt && now >= locksAt) {
    await lockRaid(seasonId, weekId);
    // If raid night is also already due (e.g. resolve-on-boot after downtime),
    // fall through on the next tick to run it.
    return { transition: 'locked', seasonId, weekId };
  }
  if (phase === 'locked' && startsAt && now >= startsAt) {
    await runBattle(seasonId, weekId, { now });
    return { transition: 'live', seasonId, weekId };
  }
  if (phase === 'live' && doneAt && now >= doneAt) {
    await finishBattle(seasonId, weekId, { now });
    return { transition: 'done', seasonId, weekId };
  }
  return null;
}

/** Mod/dev: force raid night NOW — lock, simulate, and reveal immediately (§L.5). */
export async function forceRaidNight(seasonId, weekId, { now = Date.now(), seed } = {}) {
  await lockRaid(seasonId, weekId);
  return runBattle(seasonId, weekId, { now, seed });
}

// ── scheduling helpers ──────────────────────────────────────────────────────

/** Next fixed weekly raid-night timestamp (local time) strictly after `now`. */
export function computeNextRaidNight(now = Date.now()) {
  const { dayOfWeek, hour, minute } = config.raidNight;
  const target = new Date(now);
  target.setHours(hour, minute, 0, 0);
  let add = (dayOfWeek - target.getDay() + 7) % 7;
  if (add === 0 && target.getTime() <= now) add = 7;
  target.setDate(target.getDate() + add);
  return target.getTime();
}

/** Sequential, human-friendly week id for a season ("w1", "w2", …). */
export async function nextWeekId(seasonId) {
  const snap = await database().ref(PATHS.bossesForSeason(seasonId)).get();
  return `w${Object.keys(snap.val() || {}).length + 1}`;
}
