// Raid balance regression. Runs the REAL combat engine, so a tuning change that
// makes the game unplayable fails CI instead of shipping.
//
// These assert BEHAVIOUR, not exact percentages: win rates move whenever content
// or the engine is tuned, and a test that pins them to the point would just be
// noise. What must not break is the shape — the reference roster can clear the
// season, a small raid can both win and lose, and being stronger helps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { winRate, buildParty, CLASS_FOR } from '../../scripts/balance-sim.mjs';
import { scaleBossAtk, scaleBossHp, ATK_EXPONENT, SEASONS } from '../../src/content/bosses.js';
import { abilitiesFor } from '../../src/content/abilities.js';

const SEEDS = 60; // enough to separate "impossible" from "unlikely"; keeps CI quick
const WEEKS = SEASONS[0].length;

test('the sim builds parties the engine can actually read', () => {
  // Abilities are keyed by CLASS. A party without one silently degrades to a
  // single generic Strike — healers never heal — and every number below becomes
  // meaningless. This exact mistake invalidated a full round of tuning analysis.
  const party = buildParty({ n: 6 });
  for (const p of party) {
    assert.ok(p.class, `${p.uid} has no class — abilitiesFor() would fall back to Strike`);
    assert.equal(p.class, CLASS_FOR[p.role]);
    assert.ok(abilitiesFor(p.class).length > 1, `${p.class} resolved to the fallback ability set`);
  }
  const healers = party.filter((p) => p.role === 'healer');
  assert.ok(healers.length > 0, 'a reference roster must contain a healer');
  for (const h of healers) {
    assert.ok(abilitiesFor(h.class).some((a) => a.kind === 'heal'), 'the healer must have a heal');
    assert.ok(h.heal > 0, 'and non-zero healing power');
  }
});

test('the reference roster can clear its season', () => {
  // The 15-hero reference is what the bosses are calibrated against. If this
  // drops, the content itself has regressed.
  for (const season of [1, 2, 3]) {
    const level = { 1: 10, 2: 16, 3: 22 }[season];
    for (let week = 1; week <= WEEKS; week++) {
      const rate = winRate({ n: 15, season, week, level, seeds: SEEDS });
      assert.ok(rate >= 40, `S${season}W${week} at the reference roster is only ${rate}% — content regression`);
    }
  }
});

test('a small raid is not doomed before the fight starts', () => {
  // The bug this guards: boss HP scaled to headcount but ATK did not, so a
  // 4-hero raid took ~4x the per-hero damage and lost EVERY week at every gear
  // level. Failure should be a risk, never a certainty.
  const winnable = [];
  for (let week = 1; week <= WEEKS; week++) {
    winnable.push(winRate({ n: 4, season: 1, week, level: 10, seeds: SEEDS }));
  }
  assert.ok(
    winnable.filter((r) => r > 10).length >= 4,
    `a 4-hero raid should have a real shot at most weeks, got ${winnable.join('/')}`,
  );
});

test('…but a small raid can still lose — failure is the point', () => {
  // "We wiped" is a story. A season a thin raid always clears has no stakes.
  const rates = [];
  for (let week = 1; week <= WEEKS; week++) {
    rates.push(winRate({ n: 4, season: 1, week, level: 10, seeds: SEEDS }));
  }
  assert.ok(rates.some((r) => r < 80), `every week is a walkover for 4 heroes: ${rates.join('/')}`);
});

test('mustering more heroes improves the finale', () => {
  // If turnout doesn't change the outcome, there is no reason to recruit.
  const thin = winRate({ n: 4, season: 1, week: WEEKS, level: 10, seeds: SEEDS });
  const full = winRate({ n: 12, season: 1, week: WEEKS, level: 10, seeds: SEEDS });
  assert.ok(full > thin, `12 heroes (${full}%) should beat 4 (${thin}%) on the finale`);
});

test('a better-geared raid wins more', () => {
  // If gear doesn't change the outcome, loot is pointless.
  const bare = winRate({ n: 6, season: 1, week: WEEKS, level: 10, gear: 'starter', seeds: SEEDS });
  const geared = winRate({ n: 6, season: 1, week: WEEKS, level: 19, gear: 'rare', seeds: SEEDS });
  assert.ok(geared >= bare, `rare-geared (${geared}%) should not do worse than starter (${bare}%)`);
});

// ── the scaling functions themselves ───────────────────────────────────────

test('boss ATK scales with roster size, monotonically and within clamps', () => {
  const base = 200;
  let prev = 0;
  for (const n of [1, 2, 4, 8, 15, 30, 60]) {
    const v = scaleBossAtk(base, n);
    assert.ok(v >= prev, `atk must not fall as the roster grows (${n} heroes gave ${v} after ${prev})`);
    assert.ok(v >= Math.round(base * 0.35), `${v} is below the floor`);
    assert.ok(v <= Math.round(base * 1.5), `${v} is above the ceiling`);
    prev = v;
  }
  assert.equal(scaleBossAtk(base, 15), base, 'the reference roster faces the authored value');
});

test('ATK scales more gently than HP, so a thin raid is still harder', () => {
  // Matching HP's exponent exactly made a 6-hero raid win every week; this keeps
  // a small raid genuinely disadvantaged without making it hopeless.
  assert.ok(ATK_EXPONENT < 0.92, 'ATK must scale below HP to keep thin raids harder');
  assert.ok(ATK_EXPONENT > 0.5, 'but not so far below that small raids become impossible');
  const n = 4;
  assert.ok(scaleBossAtk(200, n) / 200 > scaleBossHp(200, n) / 200, 'a thin raid faces relatively more damage than HP');
});

test('scaling handles nonsense input rather than producing NaN', () => {
  for (const n of [0, -5, undefined, null, NaN]) {
    assert.ok(Number.isFinite(scaleBossAtk(100, n)), `atk went non-finite at n=${n}`);
    assert.ok(Number.isFinite(scaleBossHp(100, n)), `hp went non-finite at n=${n}`);
  }
  assert.equal(scaleBossAtk(0, 10), 0);
});
