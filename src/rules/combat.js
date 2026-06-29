// Pure, seeded combat engine (spec §5.8 / IMPLEMENTATION §L). The weekly raid is
// an automated, turn-based battle that is a PURE FUNCTION of
// (roster snapshot, boss, seed) → an append-only combat-event log the website
// replays. No I/O, no clock, no Math.random — deterministic, unit-testable,
// auditable, reproducible. The event shapes match `_includes/live.html` exactly.

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
  const rng = mulberry32(seed);
  const pick = (arr) => arr[Math.floor(rng() * arr.length)];
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

    // ── party acts (in roster order) ──
    for (const p of party) {
      if (hp[p.uid] <= 0) continue;
      if (bossHp <= 0) break;
      const abil = pick(abilitiesFor(p.class).filter((a) => ready(p.uid, a))) || abilitiesFor(p.class)[0];
      cd[p.uid + abil.name] = abil.cooldown;

      if (abil.kind === 'heal') {
        const ally = aliveParty().sort((a, b) => hp[a.uid] / a.maxHp - hp[b.uid] / b.maxHp)[0];
        const amount = Math.max(1, vary((p.heal || 0) * abil.power));
        hp[ally.uid] = Math.min(ally.maxHp, hp[ally.uid] + amount);
        events.push({
          type: 'action', side: 'party', actor: p.uid, actorName: p.name, ability: abil.name,
          kind: 'heal', target: ally.uid, targetName: ally.name, amount, crit: false,
          targetHpAfter: hp[ally.uid],
          text: `✚ ${p.name} casts ${abil.name} on ${ally.name} (+${amount} HP)`,
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

    // ── boss acts ──
    tickCd();
    const babil = pick(bossAbilities.filter((a) => ready('boss', a))) || bossAbilities[0];
    cd['boss' + babil.name] = babil.cooldown;

    if (babil.kind === 'aoe') {
      const amount = Math.max(1, vary(bossAtk * babil.power));
      const fallen = [];
      party.forEach((q) => {
        if (hp[q.uid] > 0) {
          hp[q.uid] = Math.max(0, hp[q.uid] - amount);
          if (hp[q.uid] <= 0) fallen.push(q);
        }
      });
      events.push({
        type: 'action', side: 'enemy', actor: 'boss', actorName: boss.name, ability: babil.name,
        kind: 'aoe', target: 'party', targetName: 'the party', amount, crit: false,
        text: `💥 ${boss.name} unleashes ${babil.name} — ${amount} to ALL heroes!`,
      });
      for (const q of fallen) {
        events.push({ type: 'action', side: 'enemy', actor: 'boss', kind: 'buff', target: q.uid, targetName: q.name, text: `☠️ ${q.name} has fallen!` });
      }
    } else {
      const alive = aliveParty();
      const tank = alive.find((q) => q.role === 'tank');
      const tgt = tank && rng() < c.bossTankTargetChance ? tank : pick(alive);
      let amount = Math.max(1, vary(bossAtk * babil.power));
      const crit = rng() < c.crit.boss;
      if (crit) amount = Math.round(amount * c.crit.bossMult);
      hp[tgt.uid] = Math.max(0, hp[tgt.uid] - amount);
      events.push({
        type: 'action', side: 'enemy', actor: 'boss', actorName: boss.name, ability: babil.name,
        kind: 'damage', target: tgt.uid, targetName: tgt.name, amount, crit, targetHpAfter: hp[tgt.uid],
        text: `🔥 ${boss.name} hits ${tgt.name} with ${babil.name}${crit ? ' — CRIT!' : ''} for ${amount}!`,
      });
      if (hp[tgt.uid] <= 0) {
        events.push({ type: 'action', side: 'enemy', actor: 'boss', kind: 'buff', target: tgt.uid, targetName: tgt.name, text: `☠️ ${tgt.name} has fallen!` });
      }
    }
  }

  const downed = bossHp <= 0;
  events.push({
    type: 'end',
    outcome: downed ? 'victory' : 'defeat',
    text: downed ? `🌱 The raid is victorious — ${boss.name} falls!` : `${boss.name} stands triumphant…`,
  });

  // MVP = most damage dealt to the boss.
  let mvp = null, best = -1;
  for (const [uid, d] of Object.entries(dmgByUid)) if (d > best) { best = d; mvp = uid; }

  return { events, result: { downed, bossHpRemaining: Math.max(0, bossHp), mvp }, bossMaxHp };
}
