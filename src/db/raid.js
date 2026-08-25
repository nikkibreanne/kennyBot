// Weekly raid: muster → raid night → automated battle (spec §5.8, IMPL §L).
// Phase machine in config/raid (signup → locked → live → done), driven by stored
// timestamps compared at boot + on a timer (never an in-memory timer that a
// restart loses, §H.5). The battle is the pure seeded engine (rules/combat);
// this layer freezes the roster at lock, runs it, and writes the append-only
// combat-event log the website replays.

import { database, increment, PATHS, SERVER_TIMESTAMP } from './firebase.js';
import { getRaidPointer, setRaidPointer, getSeason } from './configStore.js';
import { roleRating, engagementMultiplier } from '../rules/rating.js';
import { combatStats, simulateBattle } from '../rules/combat.js';
import { scaleBossHp, scaleBossAtk } from '../content/bosses.js';
import { getItem, DEFAULT_LOOT_TABLE } from '../content/items.js';
import { pickDrop } from '../rules/loot.js';
import { addLoot } from './players.js';
import { setNotice } from './notices.js';
import { config } from '../config.js';

// ── snapshots ───────────────────────────────────────────────────────────────

/** Build a signup loadout snapshot from a player record (UI contract shapes). */
export function buildSnapshot(player) {
  const role = player.role;
  // Engagement-scaled at raid time (spec §4): sub tier boosts combat power.
  const rr = Math.round(roleRating(player, config, getItem) * engagementMultiplier(player, config));
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

/**
 * Are two roster snapshots equivalent? Compares the rendered fields, normalizing
 * `equipped` (RTDB drops an empty object on write, so a stored gearless card has
 * no `equipped` key while a fresh snapshot carries `{}`). Used to skip redundant
 * writes during the signup-phase refresh.
 */
function sameSnapshot(a, b) {
  if (!a || !b) return false;
  return (
    a.displayName === b.displayName &&
    a.class === b.class &&
    a.role === b.role &&
    a.level === b.level &&
    a.roleRating === b.roleRating &&
    a.maxHp === b.maxHp &&
    a.power === b.power &&
    a.defense === b.defense &&
    a.healing === b.healing &&
    JSON.stringify(a.equipped || {}) === JSON.stringify(b.equipped || {})
  );
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
 * schedule), and seed the raid node. Within a season, participation is
 * season-long: a newly scheduled boss inherits the previous active roster.
 * Starting/rolling over a season opens week 1 without carry-over.
 * @param {{ seasonId: string, weekId: string, boss: object, locksAt: number, startsAt: number }} args
 */
export async function setupRaidWeek({ seasonId, weekId, boss, locksAt, startsAt }) {
  const db = database();
  const previous = getRaidPointer();
  let signups = {};
  if (previous?.seasonId === seasonId && previous?.weekId && previous.weekId !== weekId && weekId !== 'w1') {
    const prevSnap = await db.ref(PATHS.signups(previous.seasonId, previous.weekId)).get();
    signups = prevSnap.val() || {};

    const refreshed = {};
    await Promise.all(
      Object.keys(signups).map(async (uid) => {
        const playerSnap = await db.ref(PATHS.player(uid)).get();
        const player = playerSnap.val();
        refreshed[uid] = player ? buildSnapshot(player) : signups[uid];
      }),
    );
    signups = refreshed;
  }

  const baseHp = boss.baseHp ?? boss.hp ?? config.raid.defaultBossHp;
  const bossRecord = {
    name: boss.name,
    baseHp,
    hp: baseHp, // placeholder; scaled to the mustered roster at lock
    baseAtk: boss.atk ?? config.raid.defaultBossAtk,
    atk: boss.atk ?? config.raid.defaultBossAtk, // placeholder; scaled at lock too
    thresholds: boss.thresholds,
    affix: boss.affix ?? null,
    abilities: boss.abilities ?? null,
    abilitySet: boss.abilitySet ?? null,
    recommended: boss.recommended ?? null,
    status: 'signup',
  };
  // Stamp the season's loot table onto the WEEK. finishBattle used to read
  // `getSeason().lootTable` at payout time, so rolling the season over during a
  // battle's reveal window paid the finishing raid out of the NEW season's table
  // into bags the rollover had just emptied. The raid now carries its own.
  const season = getSeason();
  const lootTable = season?.id === seasonId && season?.lootTable?.length ? season.lootTable : null;

  await db.ref().update({
    [PATHS.boss(seasonId, weekId)]: bossRecord,
    // Do NOT seed a zeros `team` — the website computes team stats from
    // `signups` until lock writes the real aggregate; a zeros object is truthy
    // and would shadow that fallback (showing 0s).
    [PATHS.raid(seasonId, weekId)]: { signups, ...(lootTable ? { lootTable } : {}) },
    [PATHS.configRaid()]: { seasonId, weekId, phase: 'signup', locksAt, startsAt, doneAt: null },
  });
  return { seasonId, weekId, boss: bossRecord };
}

/** Enlist a hero into the muster (a live preview snapshot, frozen again at lock). */
export async function enlist({ seasonId, weekId, userId, player }) {
  await database().ref(PATHS.signup(seasonId, weekId, userId)).set(buildSnapshot(player));
}

/**
 * Keep mustered heroes' roster cards current during the SIGNUP phase: re-snapshot
 * each signee from their live player record so leveling / gearing up between
 * muster and lock shows on the site without a manual re-!muster. Driven by a
 * coarse timer (it needn't be real-time). Strictly a no-op outside the signup
 * phase — once the roster LOCKS the snapshot is frozen for determinism and must
 * not be rewritten. Only rewrites entries that actually changed (cheap, and it
 * deliberately leaves the `team` aggregate alone so the site keeps recomputing
 * it from the fresh signups until lock writes the real one).
 * @returns {Promise<number>} how many roster cards were refreshed
 */
export async function refreshMusteredRoster() {
  const p = getRaidPointer();
  if (!p?.seasonId || !p?.weekId || p.phase !== 'signup') return 0;
  const db = database();
  const signupsSnap = await db.ref(PATHS.signups(p.seasonId, p.weekId)).get();
  const signups = signupsSnap.val();
  if (!signups) return 0;

  const updates = {};
  await Promise.all(
    Object.keys(signups).map(async (uid) => {
      const playerSnap = await db.ref(PATHS.player(uid)).get();
      const player = playerSnap.val();
      if (!player) return; // hero record gone — leave the existing card as-is
      const fresh = buildSnapshot(player);
      if (!sameSnapshot(fresh, signups[uid])) {
        updates[PATHS.signup(p.seasonId, p.weekId, uid)] = fresh;
      }
    }),
  );

  const n = Object.keys(updates).length;
  if (n) await db.ref().update(updates);
  return n;
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
  const count = Object.keys(frozen).length;

  // Scale boss HP to the mustered roster so the fight lasts ~12–20 turns whether
  // 8 or 40 show up (boss ATK stays absolute, so a thin/underpowered raid can
  // still genuinely fail the harder bosses — owner decision).
  const bossSnap = await db.ref(PATHS.boss(seasonId, weekId)).get();
  const boss = bossSnap.val() || {};
  const scaledHp = scaleBossHp(boss.baseHp ?? boss.hp ?? config.raid.defaultBossHp, count);
  // ATK scales too (see scaleBossAtk): the boss lands ~one single-target hit per
  // turn, so at 4 heroes each is hit ~4x as often as at the 15-hero reference.
  // Leaving ATK flat made small raids lose to arithmetic rather than to the
  // fight. `baseAtk` is preserved so re-locking never compounds the scaling.
  const baseAtk = boss.baseAtk ?? boss.atk ?? config.raid.defaultBossAtk;
  const scaledAtk = scaleBossAtk(baseAtk, count);

  await db.ref(PATHS.raid(seasonId, weekId)).update({ signups: frozen, team: computeTeam(frozen) });
  await db.ref(PATHS.boss(seasonId, weekId)).update({ status: 'locked', hp: scaledHp, atk: scaledAtk, baseAtk });
  await setRaidPointer({ phase: 'locked' });
  return { count };
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

  // boss.hp was scaled to the roster at lock; fall back defensively.
  const effectiveHp = boss.hp ?? scaleBossHp(boss.baseHp ?? config.raid.defaultBossHp, party.length);
  const effectiveAtk = boss.atk ?? scaleBossAtk(boss.baseAtk ?? config.raid.defaultBossAtk, party.length);
  const theSeed = seed ?? deriveSeed(seasonId, weekId, now);
  const { events, result, bossMaxHp } = simulateBattle(party, { ...boss, hp: effectiveHp, atk: effectiveAtk }, theSeed, config);

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

/**
 * Per-uid contribution, summed from the combat log. Three numbers, because one
 * board can't rank three jobs: a healer never damages the boss and a tank's
 * whole contribution is absorbing hits, so a single damage column ranked them
 * against DPS for work they don't do.
 *   damage  — dealt to the boss (the DPS job)
 *   healing — restored to the party (the healer job)
 *   taken   — single-target enemy damage absorbed (the tank job; AoE is excluded
 *             because it hits everyone equally and so ranks nobody)
 * @param {Record<string, object>} log
 * @returns {{damage: Record<string,number>, healing: Record<string,number>, taken: Record<string,number>}}
 */
export function statsByUid(log) {
  const damage = {};
  const healing = {};
  const taken = {};
  for (const e of Object.values(log || {})) {
    if (e.type !== 'action') continue;
    const amount = e.amount || 0;
    // Damage AT the boss and healing can only come from the party, so neither
    // needs a `side` check — and not requiring one keeps older stored combat
    // logs (which predate the field) readable.
    if (e.kind === 'damage' && e.target === 'boss') {
      damage[e.actor] = (damage[e.actor] || 0) + amount;
    } else if (e.kind === 'heal') {
      healing[e.actor] = (healing[e.actor] || 0) + amount;
    } else if (e.side === 'enemy' && e.kind === 'damage' && e.target && e.target !== 'party') {
      // `side` IS required here: the party also deals single-target damage to
      // critter adds, and that must not count as damage the hero absorbed.
      taken[e.target] = (taken[e.target] || 0) + amount;
    }
  }
  return { damage, healing, taken };
}

/**
 * Close out a finished battle: flip phase to done, distribute loot + leaderboard,
 * bump participation. Idempotent.
 */
export async function finishBattle(seasonId, weekId, { now = Date.now() } = {}) {
  const db = database();
  const p = getRaidPointer();
  if (p?.phase === 'done') return null; // cheap short-circuit; NOT the real guard

  // ATOMIC CLAIM (same shape as processDrops' draw claim). The pointer check
  // above reads the in-memory config mirror, which two overlapping callers can
  // both see as 'live' — two instances, or a payout that outruns the 30s phase
  // tick. Without this, every award below runs twice: doubled loot rolls,
  // doubled leaderboard damage, doubled renown. Flipping combat status
  // live→done in a transaction lets exactly one caller through.
  //
  // Claiming BEFORE paying out means a crash mid-payout leaves it partially
  // awarded rather than retried — deliberately preferred over a silent,
  // compounding double-award, and recoverable by hand.
  let claimed = false;
  const claim = await db.ref(`${PATHS.combat(seasonId, weekId)}/status`).transaction((status) => {
    if (status == null) return null; // no combat to finish (or empty cache → refetch)
    if (status === 'done') return undefined; // already paid out → abort
    claimed = true;
    return 'done';
  });
  if (!claimed || !claim.committed) return null;

  const [combatSnap, signupSnap] = await Promise.all([
    db.ref(PATHS.combat(seasonId, weekId)).get(),
    db.ref(PATHS.signups(seasonId, weekId)).get(),
  ]);
  const combat = combatSnap.val();
  if (!combat) return null;
  const signups = signupSnap.val() || {};
  const downed = combat.result?.downed;
  const contrib = statsByUid(combat.log);

  // Leaderboard + participation (atomic increments). A clear also grants +1
  // renown (veteran reputation that persists across seasons, §5.6).
  const updates = {};
  for (const uid of Object.keys(signups)) {
    const entry = PATHS.leaderboardEntry(seasonId, uid);
    updates[`${entry}/damage`] = increment(contrib.damage[uid] || 0);
    updates[`${entry}/healing`] = increment(contrib.healing[uid] || 0);
    updates[`${entry}/taken`] = increment(contrib.taken[uid] || 0);
    // The hero's role is stamped (not incremented) so the board can rank each
    // job on its own metric instead of ranking healers by boss damage.
    updates[`${entry}/role`] = signups[uid]?.role || null;
    updates[`${entry}/raids`] = increment(1);
    updates[`${PATHS.player(uid)}/stats/raidsParticipated`] = increment(1);
    if (downed) updates[`${PATHS.player(uid)}/renown`] = increment(1);
  }
  if (Object.keys(updates).length) await db.ref().update(updates);

  // LOOT ON VICTORY — one line to explain: clear the boss and every hero on the
  // roster gets ONE piece of gear, in their own role. Surviving raises the
  // rarity floor; being MVP raises it further. Not tied to sub tier.
  //
  // It used to be three stacking rolls (participation + survivor + MVP), which
  // paid a surviving MVP three items a week, filled bags with duplicates, and
  // could not be described without a paragraph. Same generosity at the top end,
  // expressed as quality instead of quantity.
  const awards = [];
  const bossName = (await db.ref(`${PATHS.boss(seasonId, weekId)}/name`).get()).val() || 'the boss';
  if (downed) {
    // The table the raid was SET UP with, not whatever season is current now.
    const raidSnap = await db.ref(`${PATHS.raid(seasonId, weekId)}/lootTable`).get();
    const stamped = raidSnap.val();
    const season = getSeason();
    const lootTable = stamped?.length
      ? stamped
      : (season?.id === seasonId && season?.lootTable?.length ? season.lootTable : DEFAULT_LOOT_TABLE);
    const weights = config.loot.bossRarityWeights;
    const survivors = new Set(combat.result?.survivors || []);
    const mvp = combat.result?.mvp;
    const floors = config.loot.raidRewardFloors;

    for (const uid of Object.keys(signups)) {
      // Role-aware: the item lands directly in ONE named hero's bag with no
      // lottery and no choice, and gear only pays out via bonuses[player.role].
      const minRarity = uid === mvp ? floors.mvp : survivors.has(uid) ? floors.survivor : undefined;
      const id = pickDrop(lootTable, getItem, Math.random, config, weights, { role: signups[uid]?.role, minRarity });
      if (!id) continue;
      await addLoot(uid, id);
      const item = getItem(id);
      awards.push({ uid, name: signups[uid]?.displayName || null, itemId: id, item, mvp: uid === mvp });
      // Park a notice: the payout happens with nobody required to be present, so
      // the announcement at resolve time reaches only whoever is in chat right
      // then. This reaches the person who actually earned it (src/db/notices.js).
      await setNotice(uid, {
        kind: 'raidReward',
        itemId: id,
        itemName: item?.name || id,
        rarity: item?.rarity || null,
        bossName,
        seasonId,
        weekId,
        mvp: uid === mvp,
        survived: survivors.has(uid),
      });
    }
  }

  // combat/status was already set to 'done' by the claim above.
  await db.ref(`${PATHS.raid(seasonId, weekId)}/result/status`).set('done');
  await db.ref(`${PATHS.boss(seasonId, weekId)}/status`).set(downed ? 'downed' : 'wiped');
  await db.ref(`${PATHS.raid(seasonId, weekId)}/result/resolvedAt`).set(SERVER_TIMESTAMP);
  await setRaidPointer({ phase: 'done' });
  return {
    downed,
    mvp: combat.result?.mvp ?? null,
    mvpName: signups[combat.result?.mvp]?.displayName ?? null,
    bossName,
    roster: Object.keys(signups).length,
    survivors: (combat.result?.survivors || []).length,
    awards,
  };
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
    // Pass the payout summary up so the caller can ANNOUNCE it — a cleared boss
    // used to pay gear into bags with nothing said in chat.
    const result = await finishBattle(seasonId, weekId, { now });
    return { transition: 'done', seasonId, weekId, result };
  }
  return null;
}

/** Mod/dev: force raid night NOW — lock, simulate, and reveal immediately (§L.5). */
export async function forceRaidNight(seasonId, weekId, { now = Date.now(), seed } = {}) {
  await lockRaid(seasonId, weekId);
  return runBattle(seasonId, weekId, { now, seed });
}

// ── scheduling helpers ──────────────────────────────────────────────────────

// ── timezone-aware raid-night scheduling ─────────────────────────────────────

const WEEKDAY = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Wall-clock parts of an instant as seen in a given IANA time zone. */
function zoneParts(epoch, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', weekday: 'short',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = {};
  for (const part of dtf.formatToParts(new Date(epoch))) p[part.type] = part.value;
  return { year: +p.year, month: +p.month, day: +p.day, weekday: WEEKDAY[p.weekday], hour: +p.hour, minute: +p.minute, second: +p.second };
}

/** Zone offset (ms) at an instant: (its wall-clock read as UTC) − instant. */
function zoneOffsetMs(epoch, timeZone) {
  const p = zoneParts(epoch, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - epoch;
}

/** Epoch ms for a wall-clock time in a zone (DST-correct, one-step refined). */
function zonedWallTimeToEpoch(year, month, day, hour, minute, timeZone) {
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0); // normalizes day overflow
  const offset = zoneOffsetMs(guess, timeZone);
  let epoch = guess - offset;
  const offset2 = zoneOffsetMs(epoch, timeZone);
  if (offset2 !== offset) epoch = guess - offset2; // correct across a DST edge
  return epoch;
}

/**
 * Next weekly raid-night timestamp strictly after `now`, at the configured
 * wall-clock time in config.raidNight.timeZone (DST-aware).
 */
export function computeNextRaidNight(now = Date.now()) {
  const { timeZone = 'America/Los_Angeles', dayOfWeek, hour, minute } = config.raidNight;
  const p = zoneParts(now, timeZone);
  const add = (dayOfWeek - p.weekday + 7) % 7;
  let epoch = zonedWallTimeToEpoch(p.year, p.month, p.day + add, hour, minute, timeZone);
  if (epoch <= now) epoch = zonedWallTimeToEpoch(p.year, p.month, p.day + add + 7, hour, minute, timeZone);
  return epoch;
}

/**
 * Who has a hero but isn't on this season's roster.
 *
 * Enlistment is SEASON-LONG (§5.3), so this is not "who forgot to sign up this
 * week" — it's people who never opted into the season at all, which is the group
 * a nudge can actually convert. Returns null when there's no raid to join.
 * @returns {Promise<{enlisted:number, unenlisted:number, recommended:number|null, bossName:string|null}|null>}
 */
export async function enlistmentGap() {
  const p = getRaidPointer();
  if (!p?.seasonId || !p?.weekId) return null;
  const db = database();
  const [signupSnap, playerSnap, bossSnap] = await Promise.all([
    db.ref(PATHS.signups(p.seasonId, p.weekId)).get(),
    db.ref('players').get(),
    db.ref(PATHS.boss(p.seasonId, p.weekId)).get(),
  ]);
  const signups = signupSnap.val() || {};
  const players = playerSnap.val() || {};
  const enlisted = Object.keys(signups).length;
  const unenlisted = Object.entries(players).filter(([uid, pl]) => pl?.role && !signups[uid]).length;
  const boss = bossSnap.val();
  return { enlisted, unenlisted, recommended: boss?.recommended ?? null, bossName: boss?.name ?? null };
}

/** How many weeks a season already has scheduled in the DB (0 if it's new). */
export async function weeksInSeasonDb(seasonId) {
  const snap = await database().ref(PATHS.bossesForSeason(seasonId)).get();
  return Object.keys(snap.val() || {}).length;
}

/**
 * Next sequential week id for a season ("w1", "w2", …).
 *
 * Takes the MAX existing week rather than counting children: with a count,
 * deleting any week (a mis-scheduled boss, a cleanup) makes the next id collide
 * with a week that already exists, silently overwriting its boss and roster.
 */
export async function nextWeekId(seasonId) {
  const snap = await database().ref(PATHS.bossesForSeason(seasonId)).get();
  const weeks = Object.keys(snap.val() || {});
  const highest = weeks.reduce((max, id) => {
    const n = parseInt(String(id).replace(/\D/g, ''), 10);
    return Number.isFinite(n) && n > max ? n : max;
  }, 0);
  return `w${highest + 1}`;
}
