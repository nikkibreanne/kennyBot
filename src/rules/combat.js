// Pure, seeded combat engine (spec §5.8 / IMPLEMENTATION §L). The weekly raid is
// an automated, turn-based battle that is a PURE FUNCTION of
// (roster snapshot, boss, seed) → an append-only combat-event log the website
// replays. No I/O, no clock, no Math.random — deterministic, unit-testable,
// auditable, reproducible. The event shapes match `_includes/live.html`.
//
// Actors choose abilities by CONTEXT (healers heal the hurt, dps swing their
// hardest available hit, the boss favors AoE when the party is grouped) via
// seeded weighted choice — intelligent but not robotic. An ENRAGE timer
// escalates boss damage so every fight ends in a real victory or wipe; the hard
// turn cap is only a far backstop against a pathological infinite loop.

import { abilitiesFor, DEFAULT_BOSS_ABILITIES } from '../content/abilities.js';

/** Seeded PRNG (mulberry32) — same family the UI demo uses. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Seeded weighted pick over [{ value, weight }]; falls back to uniform/first. */
function weightedPick(options, rng) {
  const total = options.reduce((s, o) => s + Math.max(0, o.weight), 0);
  if (total <= 0) return options[Math.floor(rng() * options.length)]?.value ?? options[0]?.value;
  let r = rng() * total;
  for (const o of options) {
    r -= Math.max(0, o.weight);
    if (r < 0) return o.value;
  }
  return options[options.length - 1].value;
}

/**
 * Derive a hero's combat stats from its role rating (= class+level+gear,
 * engagement-scaled; computed by rules/rating). Tunable per role via config.
 * @returns {{ maxHp: number, atk: number, heal: number }}
 */
export function combatStats(roleRating, role, config) {
  const s = config.combat.stats;
  const rr = Math.max(0, roleRating || 0);
  return {
    maxHp: Math.round(s.hpBase + rr * (s.hpPerRating[role] ?? 1)),
    atk: Math.max(1, Math.round(rr * (s.atkPerRating[role] ?? 0))),
    heal: Math.round(rr * (s.healPerRating[role] ?? 0)),
  };
}

/**
 * Simulate the full battle. Deterministic for a given seed.
 *
 * @param {Array<{uid:string,name:string,class:string,role:string,maxHp:number,atk:number,heal:number}>} roster
 * @param {{name:string, hp:number, atk:number, abilities?:Array}} boss
 * @param {number} seed
 * @param {object} config
 * @returns {{ events: object[], result: { downed:boolean, bossHpRemaining:number, mvp:(string|null) },
 *            bossMaxHp:number }}
 */
export function simulateBattle(roster, boss, seed, config) {
  const c = config.combat;
  const ai = c.ai;
  const rng = mulberry32(seed);
  const vary = (x) => Math.round(x * (1 - c.variance + rng() * 2 * c.variance));

  const party = (roster || []).map((h) => ({ ...h }));
  const bossMaxHp = Math.max(1, boss.hp || 1);
  const bossAtk = boss.atk || c.defaultBossAtk;
  const bossAbilities = boss.abilities?.length ? boss.abilities : DEFAULT_BOSS_ABILITIES;

  const hp = {};
  party.forEach((p) => { hp[p.uid] = p.maxHp; });
  let bossHp = bossMaxHp;
  const dmgByUid = {};
  const cd = {};
  const ready = (key, abil) => !cd[key + abil.name] || cd[key + abil.name] <= 0;
  const tickCd = () => { for (const k in cd) if (cd[k] > 0) cd[k]--; };
  const aliveParty = () => party.filter((p) => hp[p.uid] > 0);

  /** @type {object[]} */
  const events = [{ type: 'start', text: `${boss.name} awakens — the raid begins!` }];

  let turn = 0;
  while (bossHp > 0 && aliveParty().length > 0 && turn < c.turnCap) {
    turn++;
    events.push({ type: 'turn', n: turn });

    // ── party acts (in roster order, context-weighted ability choice) ──
    for (const p of party) {
      if (hp[p.uid] <= 0) continue;
      if (bossHp <= 0) break;
      const avail = abilitiesFor(p.class).filter((a) => ready(p.uid, a));
      const pool = avail.length ? avail : [abilitiesFor(p.class)[0]];

      // Decide what this actor wants to do given the fight state.
      const allies = aliveParty();
      const lowest = allies.slice().sort((a, b) => hp[a.uid] / a.maxHp - hp[b.uid] / b.maxHp)[0];
      const lowestPct = lowest ? hp[lowest.uid] / lowest.maxHp : 1;
      const heals = pool.filter((a) => a.kind === 'heal');
      const strikes = pool.filter((a) => a.kind !== 'heal');

      let abil;
      if (heals.length && lowestPct < ai.healAt) {
        // someone's hurt → heal, favoring the strongest heal the more critical it is
        const crit = lowestPct < ai.healCritAt;
        abil = weightedPick(heals.map((a) => ({ value: a, weight: crit ? a.power ** 2 : a.power })), rng);
      } else {
        // contribute damage, favoring higher-power (signature cooldown) hits
        const opts = (strikes.length ? strikes : pool).map((a) => ({ value: a, weight: a.power ** ai.dpsPowerBias }));
        abil = weightedPick(opts, rng);
      }
      cd[p.uid + abil.name] = abil.cooldown;

      if (abil.kind === 'heal') {
        const amount = Math.max(1, vary((p.heal || 0) * abil.power));
        hp[lowest.uid] = Math.min(lowest.maxHp, hp[lowest.uid] + amount);
        events.push({
          type: 'action', side: 'party', actor: p.uid, actorName: p.name, ability: abil.name,
          kind: 'heal', target: lowest.uid, targetName: lowest.name, amount, crit: false,
          targetHpAfter: hp[lowest.uid],
          text: `✚ ${p.name} casts ${abil.name} on ${lowest.name} (+${amount} HP)`,
        });
      } else {
        let amount = Math.max(1, vary(p.atk * abil.power));
        const crit = rng() < c.crit.party;
        if (crit) amount = Math.round(amount * c.crit.mult);
        bossHp = Math.max(0, bossHp - amount);
        dmgByUid[p.uid] = (dmgByUid[p.uid] || 0) + amount;
        events.push({
          type: 'action', side: 'party', actor: p.uid, actorName: p.name, ability: abil.name,
          kind: 'damage', target: 'boss', targetName: boss.name, amount, crit, bossHpAfter: bossHp,
          text: `⚔️ ${p.name} uses ${abil.name}${crit ? ' — CRIT!' : ''} on ${boss.name} for ${amount}!`,
        });
      }
    }
    if (bossHp <= 0) break;

    // ── boss acts (AoE favored when the party is grouped; enrage escalates) ──
    tickCd();
    const bossPool = bossAbilities.filter((a) => ready('boss', a));
    const usable = bossPool.length ? bossPool : bossAbilities;
    const aliveFrac = aliveParty().length / Math.max(1, party.length);
    const babil = weightedPick(
      usable.map((a) => ({ value: a, weight: a.kind === 'aoe' ? a.power * aliveFrac * ai.bossAoeBias + 0.05 : a.power })),
      rng,
    );
    cd['boss' + babil.name] = babil.cooldown;

    // Enrage: after startTurn, boss damage ramps each turn so stalemates break.
    const enrageMult = turn > c.enrage.startTurn ? c.enrage.perTurnMult ** (turn - c.enrage.startTurn) : 1;
    const enraged = enrageMult > 1.0001;

    if (babil.kind === 'aoe') {
      const amount = Math.max(1, Math.round(vary(bossAtk * babil.power) * enrageMult));
      const fallen = [];
      party.forEach((q) => {
        if (hp[q.uid] > 0) {
          hp[q.uid] = Math.max(0, hp[q.uid] - amount);
          if (hp[q.uid] <= 0) fallen.push(q);
        }
      });
      events.push({
        type: 'action', side: 'enemy', actor: 'boss', actorName: boss.name, ability: babil.name,
        kind: 'aoe', target: 'party', targetName: 'the party', amount, crit: false, enraged,
        text: `💥 ${boss.name} unleashes ${babil.name}${enraged ? ' (ENRAGED)' : ''} — ${amount} to ALL heroes!`,
      });
      for (const q of fallen) {
        events.push({ type: 'action', side: 'enemy', actor: 'boss', kind: 'buff', target: q.uid, targetName: q.name, text: `☠️ ${q.name} has fallen!` });
      }
    } else {
      const alive = aliveParty();
      const tank = alive.find((q) => q.role === 'tank');
      const tgt = tank && rng() < c.bossTankTargetChance ? tank : alive[Math.floor(rng() * alive.length)];
      let amount = Math.max(1, Math.round(vary(bossAtk * babil.power) * enrageMult));
      const crit = rng() < c.crit.boss;
      if (crit) amount = Math.round(amount * c.crit.bossMult);
      hp[tgt.uid] = Math.max(0, hp[tgt.uid] - amount);
      events.push({
        type: 'action', side: 'enemy', actor: 'boss', actorName: boss.name, ability: babil.name,
        kind: 'damage', target: tgt.uid, targetName: tgt.name, amount, crit, enraged, targetHpAfter: hp[tgt.uid],
        text: `🔥 ${boss.name} hits ${tgt.name} with ${babil.name}${crit ? ' — CRIT!' : ''}${enraged ? ' (ENRAGED)' : ''} for ${amount}!`,
      });
      if (hp[tgt.uid] <= 0) {
        events.push({ type: 'action', side: 'enemy', actor: 'boss', kind: 'buff', target: tgt.uid, targetName: tgt.name, text: `☠️ ${tgt.name} has fallen!` });
      }
    }
  }

  const downed = bossHp <= 0;
  const wiped = aliveParty().length === 0;
  events.push({
    type: 'end',
    outcome: downed ? 'victory' : 'defeat',
    text: downed
      ? `🌱 The raid is victorious — ${boss.name} falls!`
      : wiped
        ? `${boss.name} wipes the raid.`
        : `${boss.name} outlasts the raid as the enrage peaks…`,
  });

  // MVP = most damage dealt to the boss.
  let mvp = null, best = -1;
  for (const [uid, d] of Object.entries(dmgByUid)) if (d > best) { best = d; mvp = uid; }

  const survivors = aliveParty().map((p) => p.uid);
  return { events, result: { downed, bossHpRemaining: Math.max(0, bossHp), mvp, survivors }, bossMaxHp };
}
