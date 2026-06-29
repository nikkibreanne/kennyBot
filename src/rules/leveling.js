// Pure leveling engine (spec §5.1). No I/O, no Date, no Math.random — the RNG
// and config are injected so every curve is deterministic and unit-testable.
// The DB layer calls these inside a transaction to apply the result atomically.

/**
 * EXP needed to become *eligible* to pity-roll out of `level`.
 * threshold(level) = round(base * growth^(level-1)).
 * @param {number} level  current level (>=1)
 * @param {{ exp: { threshold: { base: number, growth: number } } }} config
 * @returns {number}
 */
export function levelThreshold(level, config) {
  const { base, growth } = config.exp.threshold;
  return Math.round(base * growth ** (Math.max(1, level) - 1));
}

/**
 * EXP granted for one qualifying chat message, after engagement scaling.
 * @param {number} engagementMult  >= 1 (see rating.engagementMultiplier)
 * @param {{ exp: { perMessage: number } }} config
 * @returns {number}
 */
export function xpForMessage(engagementMult, config) {
  return Math.round(config.exp.perMessage * Math.max(0, engagementMult));
}

/**
 * The pity roll. Given the current progress state, decide whether this message
 * triggers a level-up. Climbing probability p = min(base + k*pressure, cap);
 * a hard pressureCap guarantees an eventual pop so a player is never stuck.
 *
 * Pure: returns a NEW state object, never mutates the input.
 *
 * @param {{ level: number, exp: number, levelPressure: number }} state
 * @param {{ rng: () => number, config: object }} deps  rng in [0,1)
 * @returns {{ level: number, exp: number, levelPressure: number,
 *            eligible: boolean, leveledUp: boolean }}
 */
export function rollLevelUp(state, { rng, config }) {
  const level = Math.max(1, Math.floor(state.level || 1));
  const exp = Math.max(0, state.exp || 0);
  const pressure = Math.max(0, state.levelPressure || 0);

  const threshold = levelThreshold(level, config);
  if (exp < threshold) {
    // Not yet eligible to roll — keep accumulating EXP.
    return { level, exp, levelPressure: pressure, eligible: false, leveledUp: false };
  }

  const { base, k, cap, pressureCap } = config.exp.pity;
  const p = Math.min(base + k * pressure, cap);
  const forced = pressure + 1 >= pressureCap; // guarantee an eventual pop
  const popped = forced || rng() < p;

  if (!popped) {
    return { level, exp, levelPressure: pressure + 1, eligible: true, leveledUp: false };
  }

  // Level up: carry the remainder EXP into the next level, reset pressure.
  return {
    level: level + 1,
    exp: exp - threshold,
    levelPressure: 0,
    eligible: true,
    leveledUp: true,
  };
}

/**
 * Composite applied per qualifying chat message: grant EXP, then pity-roll.
 * This is what the player-update transaction runs.
 *
 * @param {{ level: number, exp: number, levelPressure: number }} state
 * @param {{ engagementMult: number, rng: () => number, config: object }} deps
 * @returns {{ level: number, exp: number, levelPressure: number,
 *            gainedExp: number, leveledUp: boolean, fromLevel: number, toLevel: number }}
 */
export function applyChatExp(state, { engagementMult, rng, config }) {
  const gainedExp = xpForMessage(engagementMult, config);
  const withExp = {
    level: Math.max(1, Math.floor(state.level || 1)),
    exp: Math.max(0, state.exp || 0) + gainedExp,
    levelPressure: Math.max(0, state.levelPressure || 0),
  };
  const fromLevel = withExp.level;
  const rolled = rollLevelUp(withExp, { rng, config });
  return {
    level: rolled.level,
    exp: rolled.exp,
    levelPressure: rolled.levelPressure,
    gainedExp,
    leveledUp: rolled.leveledUp,
    fromLevel,
    toLevel: rolled.level,
  };
}
