// Season progression: a season is a FIXED-LENGTH arc that ends on its finale.
//
// The bug these lock down cost eight weeks of prod: `bossFor` clamps an
// out-of-range week to the last boss, so `!boss next` — which derives the week
// from a COUNT of already-scheduled bosses — happily scheduled week 7, 8 and 9
// and got the week-6 finale back every time. The season never ended, gear never
// reset, and chat fought the Scarecrow King three times in a row.
//
// The clamp itself is correct for a lookup (never return undefined); the fix is
// that schedulers must ask `weeksInSeason` first. These tests pin both halves.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SEASONS, SEASON_COUNT, weeksInSeason, bossFor, seasonBoss } from '../../src/content/bosses.js';
import { SEASON_LOOT } from '../../src/content/items.js';
import { config } from '../../src/config.js';

test('every season has the number of weeks the config promises', () => {
  assert.equal(SEASON_COUNT, SEASONS.length);
  for (let s = 1; s <= SEASON_COUNT; s++) {
    assert.equal(weeksInSeason(s), config.raid.seasonWeeks,
      `season ${s} must have config.raid.seasonWeeks bosses — the season record written to RTDB says so`);
  }
});

test('bossFor CLAMPS past the finale — the trap schedulers must guard against', () => {
  const finale = bossFor(1, weeksInSeason(1));
  assert.equal(finale.id, 's1w6');
  // This is the exact prod failure: weeks 7 and 8 resolved to the week-6 finale.
  assert.equal(bossFor(1, 7).id, finale.id, 'week 7 clamps to the finale');
  assert.equal(bossFor(1, 8).id, finale.id, 'week 8 clamps to the finale');
  assert.equal(bossFor(1, 99).id, finale.id);
  // …so a scheduler MUST compare against weeksInSeason instead of trusting the lookup.
  assert.equal(7 > weeksInSeason(1), true, 'the guard that !boss next now applies');
});

test('weeksInSeason clamps its own input rather than throwing', () => {
  assert.equal(weeksInSeason(0), config.raid.seasonWeeks);
  assert.equal(weeksInSeason(99), config.raid.seasonWeeks);
  assert.equal(weeksInSeason(undefined), config.raid.seasonWeeks);
});

test('each season is six DISTINCT bosses — no accidental repeats in the content', () => {
  for (let s = 1; s <= SEASON_COUNT; s++) {
    const names = [];
    for (let w = 1; w <= weeksInSeason(s); w++) names.push(bossFor(s, w).name);
    assert.equal(new Set(names).size, names.length, `season ${s} repeats a boss name`);
  }
});

test('the next tier has content and its own loot table to roll over into', () => {
  // !boss next points at `!season rollover t<tier+1>`; that has to lead somewhere.
  assert.equal(seasonBoss(2, 1).id, 's2w1');
  assert.equal(SEASON_LOOT.length, SEASON_COUNT, 'one loot table per season');
  for (let s = 1; s <= SEASON_COUNT; s++) {
    assert.ok(SEASON_LOOT[s - 1].length > 0, `season ${s} has no loot table`);
  }
});

test('seasonBoss resolves abilities and a recommended roster for every week', () => {
  for (let s = 1; s <= SEASON_COUNT; s++) {
    for (let w = 1; w <= weeksInSeason(s); w++) {
      const b = seasonBoss(s, w);
      assert.ok(Array.isArray(b.abilities) && b.abilities.length > 0, `${b.id} has no abilities`);
      assert.ok(b.recommended > 0, `${b.id} has no recommended count`);
    }
  }
});
