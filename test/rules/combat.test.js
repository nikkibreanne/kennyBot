import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simulateBattle, combatStats, mulberry32 } from '../../src/rules/combat.js';
import { config } from '../../src/config.js';

function roster() {
  return [
    { uid: 'u1', name: 'Tanky', class: 'Guardian', role: 'tank', maxHp: 520, atk: 26, heal: 0 },
    { uid: 'u2', name: 'Healy', class: 'Mender', role: 'healer', maxHp: 360, atk: 18, heal: 70 },
    { uid: 'u3', name: 'Smashy', class: 'Berserker', role: 'dps', maxHp: 400, atk: 64, heal: 0 },
    { uid: 'u4', name: 'Casty', class: 'Arcanist', role: 'dps', maxHp: 300, atk: 70, heal: 0 },
    { uid: 'u5', name: 'Shooty', class: 'Ranger', role: 'dps', maxHp: 330, atk: 52, heal: 0 },
  ];
}
const boss = (hp) => ({ name: 'The Ashen Warden', hp, atk: 90 });

test('combatStats derives hp/atk/heal per role from role rating', () => {
  const tank = combatStats(200, 'tank', config);
  const dps = combatStats(200, 'dps', config);
  const heal = combatStats(200, 'healer', config);
  assert.ok(tank.maxHp > dps.maxHp, 'tanks have more HP');
  assert.ok(dps.atk > tank.atk, 'dps hit harder');
  assert.ok(heal.heal > 0 && dps.heal === 0, 'only healers heal');
  assert.ok(dps.atk >= 1, 'atk floored at 1');
});

test('a battle is deterministic for a fixed seed', () => {
  const a = simulateBattle(roster(), boss(4000), 12345, config);
  const b = simulateBattle(roster(), boss(4000), 12345, config);
  assert.deepEqual(a.events, b.events);
  assert.deepEqual(a.result, b.result);
});

test('different seeds generally differ', () => {
  const a = simulateBattle(roster(), boss(4000), 1, config);
  const b = simulateBattle(roster(), boss(4000), 2, config);
  assert.notDeepEqual(a.events, b.events);
});

test('event log matches the UI replay contract (start/turn/action/end)', () => {
  const { events } = simulateBattle(roster(), boss(4000), 7, config);
  assert.equal(events[0].type, 'start');
  assert.equal(events.at(-1).type, 'end');
  assert.ok(events.some((e) => e.type === 'turn'));
  const action = events.find((e) => e.type === 'action');
  for (const k of ['side', 'actor', 'kind', 'target', 'text']) assert.ok(k in action, `action has ${k}`);
  // damage to the boss must carry an amount and stamp running HP
  const hit = events.find((e) => e.kind === 'damage' && e.target === 'boss');
  assert.equal(typeof hit.amount, 'number');
  assert.equal(typeof hit.bossHpAfter, 'number');
});

test('a strong roster vs low HP → victory; HP fully burned', () => {
  const { result, events } = simulateBattle(roster(), boss(800), 3, config);
  assert.equal(result.downed, true);
  assert.equal(result.bossHpRemaining, 0);
  assert.equal(events.at(-1).outcome, 'victory');
  assert.ok(result.mvp, 'an MVP is named');
});

test('a huge-HP boss → enrage forces a real wipe, not a cap cutoff', () => {
  const { result, events } = simulateBattle(roster(), boss(10_000_000), 3, config);
  assert.equal(result.downed, false);
  assert.ok(result.bossHpRemaining > 0);
  assert.equal(events.at(-1).outcome, 'defeat');
  // The fight ends by an actual wipe well before the hard backstop cap…
  const lastTurn = events.filter((e) => e.type === 'turn').at(-1).n;
  assert.ok(lastTurn < config.combat.turnCap, 'enrage ends it before the backstop cap');
  // …and the boss did enrage at some point.
  assert.ok(events.some((e) => e.enraged === true), 'boss enraged');
});

test('healers heal hurt allies, not the boss (context-aware)', () => {
  const { events } = simulateBattle(roster(), boss(200_000), 5, config);
  const heals = events.filter((e) => e.kind === 'heal');
  assert.ok(heals.length > 0, 'the Mender heals during the fight');
  assert.ok(heals.every((e) => e.target !== 'boss'), 'heals target allies');
});

test('turn count never exceeds the configured cap', () => {
  const { events } = simulateBattle(roster(), boss(10_000_000), 9, config);
  const lastTurn = events.filter((e) => e.type === 'turn').at(-1);
  assert.ok(lastTurn.n <= config.combat.turnCap);
});

test('ability cooldowns are respected (no back-to-back high-cd ability per actor)', () => {
  const { events } = simulateBattle(roster(), boss(50_000), 11, config);
  // Track Arcanist Meteor (cd 4): consecutive Meteor casts must be > 4 turns apart.
  let lastMeteorTurn = -Infinity, turn = 0;
  for (const e of events) {
    if (e.type === 'turn') turn = e.n;
    if (e.type === 'action' && e.ability === 'Meteor') {
      // cd 4 → reusable no sooner than 4 turns later (one tick per round).
      assert.ok(turn - lastMeteorTurn >= 4, `Meteor reused too soon (turn ${turn} vs ${lastMeteorTurn})`);
      lastMeteorTurn = turn;
    }
  }
});

test('empty roster cannot win', () => {
  const { result, events } = simulateBattle([], boss(1000), 1, config);
  assert.equal(result.downed, false);
  assert.equal(events.at(-1).outcome, 'defeat');
});

test('mulberry32 is stable for a seed', () => {
  const r1 = mulberry32(42), r2 = mulberry32(42);
  assert.equal(r1(), r2());
});
