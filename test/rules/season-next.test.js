// `!season next` works the tier and name out for itself.
//
// The old path was `!season rollover t2 The Sweltering Patch` — which asked the
// operator to remember two things the bot already knows (the tier is the current
// one plus one; the name is in SEASON_THEMES), and quietly accepted a typo as a
// season literally called "Tier t2".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextSeasonPlan } from '../../src/commands/mod/season.js';
import { SEASON_THEMES, SEASON_COUNT } from '../../src/content/bosses.js';

test('from a cold start it opens tier 1, with no rollover', () => {
  for (const cold of [null, undefined, {}]) {
    const p = nextSeasonPlan(cold);
    assert.equal(p.ok, true);
    assert.equal(p.tier, 1);
    assert.equal(p.id, 't1');
    assert.equal(p.rollover, false, 'there is no previous season to reset gear from');
  }
});

test('it advances one tier and rolls over', () => {
  const p = nextSeasonPlan({ id: 't1', tier: 1 });
  assert.equal(p.tier, 2);
  assert.equal(p.id, 't2');
  assert.equal(p.rollover, true, 'an existing season means gear resets and prestige is paid');
});

test('the name comes from the authored themes, not from the operator', () => {
  for (let tier = 1; tier <= SEASON_COUNT; tier++) {
    const p = nextSeasonPlan(tier === 1 ? null : { id: `t${tier - 1}`, tier: tier - 1 });
    assert.equal(p.name, SEASON_THEMES[tier - 1].title, `tier ${tier} should be named by its theme`);
    assert.doesNotMatch(p.name, /^Tier /, 'never the placeholder name a typo used to produce');
  }
  assert.equal(nextSeasonPlan({ id: 't1', tier: 1 }).name, 'The Sweltering Patch');
});

test('it refuses to invent a tier there is no content for', () => {
  const p = nextSeasonPlan({ id: `t${SEASON_COUNT}`, tier: SEASON_COUNT });
  assert.equal(p.ok, false);
  assert.equal(p.reason, 'no-more-content');
  assert.equal(p.tier, SEASON_COUNT + 1);
});

test('ids are sequential and match the tier they carry', () => {
  // tierFromId parses the digits back out, so id and tier must not disagree.
  for (let tier = 1; tier < SEASON_COUNT; tier++) {
    const p = nextSeasonPlan({ id: `t${tier}`, tier });
    assert.equal(p.id, `t${p.tier}`);
    assert.equal(p.tier, tier + 1);
  }
});

test('a season record missing its tier is treated as a cold start, not a crash', () => {
  const p = nextSeasonPlan({ id: 'weird-custom-season' });
  assert.equal(p.ok, true);
  assert.equal(p.tier, 1, 'no tier recorded → start from the beginning rather than guess');
});
