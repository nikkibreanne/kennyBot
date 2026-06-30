import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  levelThreshold,
  xpForMessage,
  rollLevelUp,
  applyChatExp,
} from '../../src/rules/leveling.js';
import { config } from '../../src/config.js';

// A seeded, deterministic RNG (mulberry32) so level-up rolls are reproducible.
function seeded(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('levelThreshold grows geometrically and is rounded', () => {
  assert.equal(levelThreshold(1, config), config.exp.threshold.base);
  assert.equal(levelThreshold(2, config), Math.round(config.exp.threshold.base * config.exp.threshold.growth));
  assert.ok(levelThreshold(10, config) > levelThreshold(9, config));
});

test('xpForMessage scales with engagement and rounds', () => {
  assert.equal(xpForMessage(1, config), config.exp.perMessage);
  assert.equal(xpForMessage(1.5, config), Math.round(config.exp.perMessage * 1.5));
  assert.equal(xpForMessage(0, config), 0);
});

test('rollLevelUp is not eligible below threshold', () => {
  const state = { level: 1, exp: 50, levelPressure: 0 };
  const out = rollLevelUp(state, { rng: () => 0, config });
  assert.equal(out.eligible, false);
  assert.equal(out.leveledUp, false);
  assert.deepEqual({ level: out.level, exp: out.exp }, { level: 1, exp: 50 });
});

test('the threshold-crossing message never pops (no lucky early level)', () => {
  const state = { level: 1, exp: 130, levelPressure: 0 }; // over threshold 100, fresh
  const out = rollLevelUp(state, { rng: () => 0, config }); // even rng 0 cannot pop at pressure 0
  assert.equal(out.eligible, true);
  assert.equal(out.leveledUp, false);
  assert.equal(out.levelPressure, 1); // chance accumulates instead of popping
});

test('rollLevelUp pops once the accumulated chance clears, carrying remainder', () => {
  const state = { level: 1, exp: 130, levelPressure: 1 }; // p = k*1 = 0.34
  const out = rollLevelUp(state, { rng: () => 0, config }); // 0 < 0.34 → pops
  assert.equal(out.leveledUp, true);
  assert.equal(out.level, 2);
  assert.equal(out.exp, 30); // 130 - 100 carried
  assert.equal(out.levelPressure, 0);
});

test('rollLevelUp accrues pressure when the chance does not clear', () => {
  const state = { level: 1, exp: 130, levelPressure: 1 }; // p = 0.34
  const out = rollLevelUp(state, { rng: () => 0.999, config }); // 0.999 > 0.34 → no pop
  assert.equal(out.leveledUp, false);
  assert.equal(out.levelPressure, 2);
});

test('pressureCap guarantees an eventual pop regardless of rng', () => {
  const atCap = config.exp.levelUp.pressureCap - 1;
  const state = { level: 5, exp: levelThreshold(5, config) + 1, levelPressure: atCap };
  const out = rollLevelUp(state, { rng: () => 1, config }); // rng=1 would never pop on probability
  assert.equal(out.leveledUp, true, 'forced pop at pressureCap');
  assert.equal(out.level, 6);
  assert.equal(out.levelPressure, 0);
});

test('a chatter who keeps chatting always levels within pressureCap messages', () => {
  const rng = () => 1; // worst case: probability never pops; only the cap saves them
  let state = { level: 1, exp: 0, levelPressure: 0 };
  let leveled = false;
  for (let i = 0; i < config.exp.levelUp.pressureCap + 200; i++) {
    const out = applyChatExp(state, { engagementMult: 1, rng, config });
    state = { level: out.level, exp: out.exp, levelPressure: out.levelPressure };
    if (out.leveledUp) {
      leveled = true;
      break;
    }
  }
  assert.ok(leveled, 'must eventually level up even with the worst possible rolls');
});

test('applyChatExp reports gainedExp and from/to levels', () => {
  // Already eligible with accumulated pressure, so this message can pop.
  const out = applyChatExp({ level: 1, exp: 130, levelPressure: 1 }, {
    engagementMult: 1,
    rng: () => 0,
    config,
  });
  assert.equal(out.gainedExp, config.exp.perMessage);
  assert.equal(out.fromLevel, 1);
  assert.equal(out.leveledUp, true);
  assert.equal(out.toLevel, 2);
});

test('seeded rng makes the whole sequence reproducible', () => {
  const run = () => {
    const rng = seeded(42);
    let state = { level: 1, exp: 0, levelPressure: 0 };
    const levels = [];
    for (let i = 0; i < 500; i++) {
      const out = applyChatExp(state, { engagementMult: 1, rng, config });
      state = { level: out.level, exp: out.exp, levelPressure: out.levelPressure };
      if (out.leveledUp) levels.push(i);
    }
    return levels;
  };
  assert.deepEqual(run(), run(), 'same seed → identical level-up message indices');
});
