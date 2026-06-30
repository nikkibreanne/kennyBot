// Pure, seeded combat engine (spec §5.8 / IMPLEMENTATION §L). The weekly raid is
// an automated, turn-based battle that is a PURE FUNCTION of
// (roster snapshot, boss, seed) → an append-only combat-event log the website
// replays. No I/O, no clock, no Math.random — deterministic, unit-testable,
// auditable, reproducible. Round-based (D&D-style) logging.
//
// INITIATIVE: each round, heroes and affix CRITTERS act in a SHUFFLED, seeded
// order (interleaved — not a fixed party-then-enemy block), and the boss acts at
// the END of the round. Actors choose by CONTEXT (healers heal the hurt, dps
// swing their hardest hit or clear adds; the boss favors AoE when grouped and
// spreads its single-target hits across the party — not just the tank). An
// ENRAGE timer escalates enemy damage so fights end in a real victory or wipe.
// Affixes (content/affixes.js) add real mechanics: critters, party DoT, reduced
// healing, attack recoil, frost skips, and boss cleave.

import { abilitiesFor, DEFAULT_BOSS_ABILITIES, iconFor } from '../content/abilities.js';
import { affixFor } from '../content/affixes.js';

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
 * @param {{name:string, hp:number, atk:number, abilities?:Array, affix?:string}} boss
 * @param {number} seed
 * @param {object} config
 * @returns {{ events: object[], result: { downed:boolean, bossHpRemaining:number, mvp:(string|null), survivors:string[] },
 *            bossMaxHp:number }}
 */
export function simulateBattle(roster, boss, seed, config) {
  const c = config.combat;
  const ai = c.ai;
  const af = affixFor(boss.affix);
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
  const events = [];

  // ── affix critter "adds" ──
  const adds = [];
  let addSeq = 0;
  const critterName = af.critter || 'Critter';
  const critterIcon = af.icon || '🐛';
  const liveAdds = () => adds.filter((a) => a.hp > 0);
  function spawnAdds(n) {
    const room = c.adds.maxAlive - liveAdds().length;
    const k = Math.max(0, Math.min(n, room));
    for (let i = 0; i < k; i++) {
      addSeq += 1;
      const maxHp = Math.max(1, Math.round(bossAtk * c.adds.hpFactor));
      adds.push({ id: `add_${addSeq}`, name: `${critterName} ${addSeq}`, icon: critterIcon, maxHp, hp: maxHp, atk: Math.max(1, Math.round(bossAtk * c.adds.atkFactor)) });
    }
    return k;
  }

  const fall = (q, by) => events.push({ type: 'action', side: 'enemy', actor: by, kind: 'buff', target: q.uid, targetName: q.name, icon: '☠️', text: `☠️ ${q.name} has fallen!` });

  /** Seeded Fisher–Yates shuffle (in place). */
  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  /** Pick n distinct alive heroes for a boss hit; first favors the tank. */
  function pickBossTargets(n) {
    const pool = aliveParty();
    if (!pool.length) return [];
    const tank = pool.find((q) => q.role === 'tank');
    const first = tank && rng() < c.bossTankTargetChance ? tank : pool[Math.floor(rng() * pool.length)];
    const chosen = [first];
    const remaining = pool.filter((q) => q !== first);
    while (chosen.length < n && remaining.length) {
      chosen.push(remaining.splice(Math.floor(rng() * remaining.length), 1)[0]);
    }
    return chosen;
  }

  /** One hero's action: frost skip, then heal the hurt or strike (boss/add) + recoil. */
  function heroAct(p) {
    if (hp[p.uid] <= 0 || bossHp <= 0) return;
    if (af.frost && rng() < af.frost) {
      events.push({ type: 'action', side: 'enemy', actor: 'affix', kind: 'buff', target: p.uid, targetName: p.name, icon: '❄️', text: `❄️ ${p.name} is frozen solid and loses a turn!` });
      return;
    }
    const avail = abilitiesFor(p.class).filter((a) => ready(p.uid, a));
    const pool = avail.length ? avail : [abilitiesFor(p.class)[0]];
    const allies = aliveParty();
    const lowest = allies.slice().sort((a, b) => hp[a.uid] / a.maxHp - hp[b.uid] / b.maxHp)[0];
    const lowestPct = lowest ? hp[lowest.uid] / lowest.maxHp : 1;
    const heals = pool.filter((a) => a.kind === 'heal');
    const strikes = pool.filter((a) => a.kind !== 'heal');

    let abil;
    if (heals.length && lowestPct < ai.healAt) {
      const critHeal = lowestPct < ai.healCritAt;
      abil = weightedPick(heals.map((a) => ({ value: a, weight: critHeal ? a.power ** 2 : a.power })), rng);
    } else {
      abil = weightedPick((strikes.length ? strikes : pool).map((a) => ({ value: a, weight: a.power ** ai.dpsPowerBias })), rng);
    }
    cd[p.uid + abil.name] = abil.cooldown;

    if (abil.kind === 'heal') {
      let amount = Math.max(1, vary((p.heal || 0) * abil.power));
      if (af.lessHealing) amount = Math.max(1, Math.round(amount * af.lessHealing));
      hp[lowest.uid] = Math.min(lowest.maxHp, hp[lowest.uid] + amount);
      const icon = iconFor(abil.name, 'heal');
      events.push({ type: 'action', side: 'party', actor: p.uid, actorName: p.name, ability: abil.name, kind: 'heal', target: lowest.uid, targetName: lowest.name, amount, crit: false, icon, targetHpAfter: hp[lowest.uid], text: `${icon} ${p.name} casts ${abil.name} on ${lowest.name} (+${amount} HP)` });
      return;
    }

    const targetsAdd = liveAdds().length > 0 && p.role === 'dps' && rng() < c.adds.focusChance;
    let amount = Math.max(1, vary(p.atk * abil.power));
    const crit = rng() < c.crit.party;
    if (crit) amount = Math.round(amount * c.crit.mult);
    const icon = iconFor(abil.name, 'damage', { crit });
    if (targetsAdd) {
      const add = liveAdds().sort((a, b) => a.hp - b.hp)[0];
      add.hp = Math.max(0, add.hp - amount);
      events.push({ type: 'action', side: 'party', actor: p.uid, actorName: p.name, ability: abil.name, kind: 'damage', target: add.id, targetName: add.name, amount, crit, icon, text: `${icon} ${p.name} strikes ${add.name} with ${abil.name}${crit ? ' — CRIT!' : ''} for ${amount}!` });
      if (add.hp <= 0) events.push({ type: 'action', side: 'party', actor: p.uid, kind: 'buff', target: add.id, targetName: add.name, icon: '💥', text: `💥 ${add.name} is crushed!` });
    } else {
      bossHp = Math.max(0, bossHp - amount);
      dmgByUid[p.uid] = (dmgByUid[p.uid] || 0) + amount;
      events.push({ type: 'action', side: 'party', actor: p.uid, actorName: p.name, ability: abil.name, kind: 'damage', target: 'boss', targetName: boss.name, amount, crit, icon, bossHpAfter: bossHp, text: `${icon} ${p.name} uses ${abil.name}${crit ? ' — CRIT!' : ''} on ${boss.name} for ${amount}!` });
    }
    if (af.recoil && hp[p.uid] > 0) {
      const r = Math.max(1, Math.round(p.atk * af.recoil));
      hp[p.uid] = Math.max(0, hp[p.uid] - r);
      events.push({ type: 'action', side: 'enemy', actor: 'affix', kind: 'damage', target: p.uid, targetName: p.name, amount: r, icon: '🥀', text: `🥀 ${af.label || 'Thorns'} rake ${p.name} for ${r}!` });
      if (hp[p.uid] <= 0) fall(p, 'affix');
    }
  }

  /** One critter's action: bite a random alive hero. */
  function addAct(add, enrageMult) {
    if (add.hp <= 0) return;
    const alive = aliveParty();
    if (!alive.length) return;
    const tgt = alive[Math.floor(rng() * alive.length)];
    const amount = Math.max(1, Math.round(vary(add.atk) * enrageMult));
    hp[tgt.uid] = Math.max(0, hp[tgt.uid] - amount);
    events.push({ type: 'action', side: 'enemy', actor: add.id, actorName: add.name, kind: 'damage', target: tgt.uid, targetName: tgt.name, amount, crit: false, icon: add.icon, text: `${add.icon} ${add.name} bites ${tgt.name} for ${amount}!` });
    if (hp[tgt.uid] <= 0) fall(tgt, add.id);
  }

  /** The boss's action (end of round): AoE or a single-target hit that may cleave. */
  function bossAct(enrageMult, enraged) {
    const bossPool = bossAbilities.filter((a) => ready('boss', a));
    const usable = bossPool.length ? bossPool : bossAbilities;
    const aliveFrac = aliveParty().length / Math.max(1, party.length);
    const babil = weightedPick(usable.map((a) => ({ value: a, weight: a.kind === 'aoe' ? a.power * aliveFrac * ai.bossAoeBias + 0.05 : a.power })), rng);
    cd['boss' + babil.name] = babil.cooldown;

    if (babil.kind === 'aoe') {
      const amount = Math.max(1, Math.round(vary(bossAtk * babil.power) * enrageMult));
      const fallen = [];
      party.forEach((q) => { if (hp[q.uid] > 0) { hp[q.uid] = Math.max(0, hp[q.uid] - amount); if (hp[q.uid] <= 0) fallen.push(q); } });
      const icon = iconFor(babil.name, 'aoe', { side: 'enemy' });
      events.push({ type: 'action', side: 'enemy', actor: 'boss', actorName: boss.name, ability: babil.name, kind: 'aoe', target: 'party', targetName: 'the party', amount, crit: false, enraged, icon, text: `${icon} ${boss.name} unleashes ${babil.name}${enraged ? ' (ENRAGED)' : ''} — ${amount} to ALL heroes!` });
      for (const q of fallen) fall(q, 'boss');
    } else {
      const nTargets = Math.max(1, Math.min(af.bossMulti || 1, aliveParty().length));
      const icon = iconFor(babil.name, 'damage', { side: 'enemy' });
      for (const tgt of pickBossTargets(nTargets)) {
        let amount = Math.max(1, Math.round(vary(bossAtk * babil.power) * enrageMult));
        const crit = rng() < c.crit.boss;
        if (crit) amount = Math.round(amount * c.crit.bossMult);
        hp[tgt.uid] = Math.max(0, hp[tgt.uid] - amount);
        events.push({ type: 'action', side: 'enemy', actor: 'boss', actorName: boss.name, ability: babil.name, kind: 'damage', target: tgt.uid, targetName: tgt.name, amount, crit, enraged, icon, targetHpAfter: hp[tgt.uid], text: `${icon} ${boss.name} hits ${tgt.name} with ${babil.name}${crit ? ' — CRIT!' : ''}${enraged ? ' (ENRAGED)' : ''} for ${amount}!` });
        if (hp[tgt.uid] <= 0) fall(tgt, 'boss');
      }
    }
  }

  /** End-of-round affix damage-over-time on the whole party. */
  function affixDot() {
    if (!af.dot || !aliveParty().length) return;
    const amount = Math.max(1, Math.round(bossAtk * af.dot));
    const fallen = [];
    party.forEach((q) => { if (hp[q.uid] > 0) { hp[q.uid] = Math.max(0, hp[q.uid] - amount); if (hp[q.uid] <= 0) fallen.push(q); } });
    events.push({ type: 'action', side: 'enemy', actor: 'affix', actorName: af.label, kind: 'aoe', target: 'party', targetName: 'the party', amount, crit: false, icon: '🍂', text: `🍂 ${af.label} withers the patch — ${amount} to all!` });
    for (const q of fallen) fall(q, 'affix');
  }

  // ── opening ──
  events.push({ type: 'start', text: `${boss.name} awakens — the raid begins!${af.label ? ` [${af.label}]` : ''}` });
  if (af.adds) {
    const k = spawnAdds(af.adds.count);
    if (k) events.push({ type: 'action', side: 'enemy', actor: 'boss', kind: 'summon', icon: critterIcon, text: `${critterIcon} ${k} ${critterName}${k > 1 ? 's' : ''} skitter in!` });
  }

  let turn = 0;
  while (bossHp > 0 && aliveParty().length > 0 && turn < c.turnCap) {
    turn += 1;
    events.push({ type: 'turn', n: turn });
    const enrageMult = turn > c.enrage.startTurn ? c.enrage.perTurnMult ** (turn - c.enrage.startTurn) : 1;
    const enraged = enrageMult > 1.0001;

    // Interleaved initiative: heroes + critters in a shuffled order; boss last.
    const order = shuffle([
      ...aliveParty().map((h) => ({ t: 'hero', h })),
      ...liveAdds().map((a) => ({ t: 'add', a })),
    ]);
    for (const actor of order) {
      if (bossHp <= 0 || aliveParty().length === 0) break;
      if (actor.t === 'hero') heroAct(actor.h);
      else addAct(actor.a, enrageMult);
    }
    if (bossHp <= 0 || aliveParty().length === 0) break;

    bossAct(enrageMult, enraged);
    affixDot();

    if (af.adds?.respawnEvery && turn % af.adds.respawnEvery === 0 && bossHp > 0 && aliveParty().length) {
      const k = spawnAdds(af.adds.count);
      if (k) events.push({ type: 'action', side: 'enemy', actor: 'boss', kind: 'summon', icon: critterIcon, text: `${critterIcon} ${k} more ${critterName}${k > 1 ? 's' : ''} swarm in!` });
    }

    tickCd(); // cooldowns tick once per round
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

  let mvp = null, best = -1;
  for (const [uid, d] of Object.entries(dmgByUid)) if (d > best) { best = d; mvp = uid; }
  const survivors = aliveParty().map((p) => p.uid);
  return { events, result: { downed, bossHpRemaining: Math.max(0, bossHp), mvp, survivors }, bossMaxHp };
}
