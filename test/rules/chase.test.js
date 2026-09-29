// CHASE DETECTION — the offline suite. The whole point of putting the model in
// a pure evaluator is that a police chase cannot be scheduled: every case here
// is hand-built samples against a fixed `now`, so the grouping, the discount,
// dwell, hysteresis, the cooldowns and the cold start are all exact.
//
// The failures that matter are the ones that would be embarrassing in chat:
// announcing a chopper-class source's permanently-titled cam, announcing a
// recap clip, announcing twice for one chase, or announcing on the first poll
// after a restart because no baseline existed yet.
//
// THE ROSTER IS PRIVATE (CLAUDE.md), so the orgs below are INVENTED. What is
// real — and what the evaluator actually branches on — is the STREAM CLASS and
// the per-org cap; every other number (threshold, weights, dwell, the discount,
// the windows) still comes from config.chase, so these cases keep guarding the
// real tuning.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateChase, matchesAny, median } from '../../src/rules/chase.js';
import { config } from '../../src/config.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = Date.parse('2026-09-28T19:00:00Z');

/**
 * The fixture roster: one org per shape the logic distinguishes — a chopper-class
 * cam with a permanent title, three always-live newscasts, a chopper-class org
 * whose groupCap sits BELOW the threshold, and one episodic channel that is dark
 * until it matters.
 */
const ORGS = [
  { id: 'org1', name: 'Org One', channelId: 'UC-org1', streamClass: 'chopper' },
  { id: 'org2', name: 'Org Two', channelId: 'UC-org2', streamClass: 'newscast' },
  { id: 'org3', name: 'Org Three', channelId: 'UC-org3', streamClass: 'newscast', articleFeed: 'https://example.test/org3/feed' },
  { id: 'org4', name: 'Org Four', channelId: 'UC-org4', streamClass: 'newscast' },
  { id: 'org5', name: 'Org Five', channelId: 'UC-org5', streamClass: 'chopper', groupCap: 7 },
  { id: 'org6', name: 'Org Six', channelId: 'UC-org6', streamClass: 'episodic' },
];

/** The real tuning, with the fixture roster standing in for the private one. */
const cfg = { ...config.chase, orgs: ORGS };

/** Opaque ids, like the real ones — so "the text leaks no internals" can be asserted. */
const VIDEO = {
  org1: 'eeee3333fff', org2: 'cccc2222ddd', org3: 'gggg4444hhh',
  org4: 'iiii5555jjj', org5: 'kkkk6666lll', org6: 'aaaa1111bbb',
};
/** A chopper-class cam carries this forever — the title that must never score. */
const CHOPPER_CAM = '🔴LIVE: Chopper Camera';
const meta = (org) => cfg.orgs.find((o) => o.id === org);
const restingTitle = (org) => `LIVE: ${meta(org).name} News`;

/** One live observation of an org's stream, with that org's stream class. */
function sample(org, over = {}) {
  return {
    org,
    videoId: VIDEO[org],
    streamClass: meta(org).streamClass,
    live: true,
    title: restingTitle(org),
    viewers: null,
    at: NOW,
    ...over,
  };
}

/** State that already knows the stream, so a title change is measurable. */
function knows(org, over = {}) {
  return {
    [VIDEO[org]]: {
      title: restingTitle(org), live: true, wentLiveAt: NOW - 6 * 3600_000, seenAt: NOW - MIN, ...over,
    },
  };
}

/** `count` readings of `viewers`, a minute apart, all inside the 30-min window. */
function ring(count, viewers, now = NOW) {
  return Array.from({ length: count }, (_, i) => [now - (count - i) * MIN, viewers]);
}

/** A state where each org is known and has a full, quiet baseline. */
function baselined(orgs, { viewers = 200, count = 20, ...rest } = {}) {
  const streams = {};
  const baselines = {};
  for (const org of orgs) {
    Object.assign(streams, knows(org));
    baselines[VIDEO[org]] = ring(count, viewers);
  }
  return { streams, baselines, ...rest };
}

const evalAt = (now, samples, state, over = {}, articles = []) => evaluateChase({
  samples, articles, state, now, cfg: { ...cfg, ...over },
});

/** Drive N consecutive polls a minute apart, threading state through. */
function drive(state, makeSamples, { polls, from = NOW, stepMs = MIN, over = {} } = {}) {
  const results = [];
  let st = state;
  for (let i = 0; i < polls; i += 1) {
    const now = from + i * stepMs;
    const r = evalAt(now, makeSamples(now, i), st, over);
    st = r.state;
    results.push(r);
  }
  return results;
}

// ── the design's worked-cases table (§2.4) ───────────────────────────────────

test('a chopper-class source retitles to "pursuit" AND spikes 8x — two channels, one org, fires at 8', () => {
  const state = baselined([]);
  state.streams = knows('org1', { title: CHOPPER_CAM });
  state.baselines = { [VIDEO.org1]: ring(20, 200) };

  const r = evalAt(NOW, [sample('org1', { title: 'LIVE: Police pursuit in progress', viewers: 1600 })], state);
  assert.deepEqual(r.groups.org1.channels, { title: 5, audience: 5 });
  assert.equal(r.groups.org1.score, 8, 'highest + 0.6 * the rest');
  assert.equal(r.score, 8);
});

test('an episodic source goes live, titles it "pursuit", and spikes — 5 + 0.6*(5+5) = 11, capped to 10', () => {
  const state = {
    streams: knows('org6', { title: 'Org Six News at 11', live: false, wentLiveAt: null }),
    baselines: { [VIDEO.org6]: ring(20, 200) },
  };
  const r = evalAt(NOW, [sample('org6', { title: 'LIVE: Police pursuit on the freeway', viewers: 1600 })], state);
  assert.deepEqual(r.groups.org6.channels, { title: 5, audience: 5, liveness: 5 });
  assert.equal(r.score, 10, 'all three channels come to 11, and groupCap clamps it to 10');
});

// The case above needs a SEEDED baseline, which the real world does not supply: an
// episodic channel going live mints a NEW videoId, so `audience` is disabled for
// ~minSamples*pollMs (~20 min). This is what that class actually scores, and it is
// why L1 is 5 — at 3 it came to 6.8 and the whole class could never open an incident.
test('an episodic source on a BRAND-NEW broadcast (no baseline) still reaches the threshold', () => {
  const state = {
    streams: knows('org6', { title: '', live: false, wentLiveAt: null }),
    baselines: {}, // a new videoId has no history and cannot have any
  };
  const r = evalAt(NOW, [sample('org6', { title: 'LIVE: Police pursuit on the freeway', viewers: 4000 })], state);
  assert.deepEqual(r.groups.org6.channels, { title: 5, liveness: 5 }, 'audience is correctly disabled');
  assert.equal(r.score, 8);
  assert.ok(r.score >= config.chase.threshold, 'an episodic source must be able to fire on its own');
});

test('two orgs, one channel each, are fully additive — 5 + 5 = 10', () => {
  const state = baselined(['org2', 'org1']);
  const r = evalAt(NOW, [
    sample('org2', { title: 'LIVE: Police pursuit downtown' }),
    sample('org1', { title: restingTitle('org1'), viewers: 1600 }),
  ], state);
  assert.deepEqual(r.groups.org2.channels, { title: 5 });
  assert.deepEqual(r.groups.org1.channels, { audience: 5 });
  assert.equal(r.score, 10, 'no discount ACROSS orgs — two newsrooms are two decisions');
});

test('a 60x spike with an unchanged title is only 5 — a spike alone is a fire or a protest', () => {
  const state = baselined(['org1']);
  state.streams = knows('org1', { title: CHOPPER_CAM });
  const r = evalAt(NOW, [sample('org1', { title: CHOPPER_CAM, viewers: 12_000 })], state);
  assert.deepEqual(r.groups.org1.channels, { audience: 5 });
  assert.equal(r.score, 5);
  assert.equal(r.opened, false);
});

test('a "pursuit" retitle with only a 3x audience move stays below threshold — 6.2', () => {
  const state = baselined(['org2']);
  const r = evalAt(NOW, [sample('org2', { title: 'LIVE: Police pursuit on surface streets', viewers: 600 })], state);
  assert.deepEqual(r.groups.org2.channels, { title: 5, audience: 2 });
  assert.equal(r.score, 6.2);
});

test('the stacking attack is defused: live + a static "chopper" title + 3x scores 2, not 9', () => {
  const state = baselined(['org1']);
  state.streams = knows('org1', { title: CHOPPER_CAM });
  const r = evalAt(NOW, [sample('org1', { title: CHOPPER_CAM, viewers: 600 })], state);
  assert.equal(r.groups.org1.channels.title, undefined, 'a title that never changed is not evidence');
  assert.equal(r.groups.org1.channels.liveness, undefined, '"it is live" is not a channel for a 24/7 cam');
  assert.equal(r.score, 2);
});

test('a retrospective clip vetoes its org outright', () => {
  const state = { streams: knows('org6', { title: 'Org Six News' }), baselines: {} };
  const r = evalAt(NOW, [sample('org6', { title: 'Raw video: chase ends in crash' })], state);
  assert.equal(r.groups.org6.vetoed, true);
  assert.equal(r.groups.org6.score, 0);
  assert.equal(r.groups.org6.channels.title, 5, 'the evidence is kept in the breakdown, just not counted');
  assert.equal(r.score, 0);
});

test('two orgs both weak is 4 — corroboration, but not enough of it', () => {
  const state = baselined(['org2', 'org3']);
  const r = evalAt(NOW, [
    sample('org2', { viewers: 600 }),
    sample('org3', { viewers: 600 }),
  ], state);
  assert.equal(r.score, 4);
});

// ── one signal per evidence channel ──────────────────────────────────────────

test('V1 and V2 can never both count — a 60x spike scores V1 alone', () => {
  const state = baselined(['org1']);
  const r = evalAt(NOW, [sample('org1', { viewers: 12_000 })], state);
  assert.deepEqual(r.groups.org1.channels, { audience: cfg.weights.V1 });
  assert.notEqual(r.groups.org1.score, cfg.weights.V1 + cfg.weights.V2);
});

test('T1 and T2 can never both count — a strong retitle scores T1 alone', () => {
  const state = { streams: knows('org2'), baselines: {} };
  const r = evalAt(NOW, [sample('org2', { title: 'LIVE: High-speed pursuit of a fleeing suspect' })], state);
  assert.deepEqual(r.groups.org2.channels, { title: cfg.weights.T1 });
});

test('two streams in one org still yield one score per channel, the highest', () => {
  const state = {
    streams: { ...knows('org2'), 'org2-second': { title: 'Org Two 24/7', live: true, wentLiveAt: NOW - HOUR, seenAt: NOW } },
    baselines: {},
  };
  const r = evalAt(NOW, [
    sample('org2', { title: 'LIVE: Fleeing suspect on foot' }), // weak — T2
    sample('org2', { videoId: 'org2-second', title: 'LIVE: Police pursuit heads for the freeway' }), // strong — T1
  ], state);
  assert.deepEqual(r.groups.org2.channels, { title: 5 }, 'one title score for the org, not one per stream');
});

// ── the title channel ────────────────────────────────────────────────────────

test('an unchanged title scores 0 forever, however many polls go by', () => {
  const state = { streams: knows('org1', { title: CHOPPER_CAM }), baselines: {} };
  const results = drive(state, () => [sample('org1', { title: CHOPPER_CAM })], { polls: 5 });
  for (const r of results) assert.equal(r.groups.org1.channels.title, undefined);
  assert.equal(results.at(-1).score, 0);
});

test('a retitle keeps scoring while the chase title stands, and stops when it is put back', () => {
  const state = { streams: knows('org2'), baselines: {} };
  const chase = 'LIVE: Police pursuit in progress';
  const [first, second, third] = drive(state, (now, i) => [
    sample('org2', { title: i < 2 ? chase : restingTitle('org2') }),
  ], { polls: 3 });

  assert.equal(first.groups.org2.channels.title, 5, 'the retitle is the editorial act');
  assert.equal(second.groups.org2.channels.title, 5, 'and it has to survive the dwell, or nothing can ever fire');
  assert.equal(third.groups.org2.channels.title, undefined, 'back to the resting title — no longer evidence');
});

test('a first sighting is seeded in silence unless the stream is also newly live', () => {
  const dark = evalAt(NOW, [sample('org4', { live: false, title: 'Org Four: Police pursuit rerun' })], {});
  assert.equal(dark.groups.org4.channels.title, undefined, 'a stream we have never seen is seeded, not scored');

  const fresh = evalAt(NOW, [sample('org4', { title: 'LIVE: Police pursuit heads east' })], {});
  assert.equal(fresh.groups.org4.channels.title, 5, 'a broadcast that just appeared IS news');
});

test('a not-live stream never contributes a title score', () => {
  const state = { streams: knows('org4'), baselines: {} };
  const r = evalAt(NOW, [sample('org4', { live: false, title: 'Police pursuit special' })], state);
  assert.deepEqual(r.groups.org4.channels, {});
});

// ── the audience channel ─────────────────────────────────────────────────────

test('cold start disables the audience channel — a restart must never fire', () => {
  const state = { streams: knows('org1', { title: CHOPPER_CAM }), baselines: { [VIDEO.org1]: ring(19, 200) } };
  const r = evalAt(NOW, [sample('org1', { title: CHOPPER_CAM, viewers: 50_000 })], state);
  assert.deepEqual(r.groups.org1.channels, {}, `under minSamples (${cfg.minSamples}) the channel is off, not defaulted on`);
});

test('the absolute viewer floor must clear too — 3 to 24 viewers is 8x and means nothing', () => {
  const state = { streams: knows('org5'), baselines: { [VIDEO.org5]: ring(20, 3) } };
  const r = evalAt(NOW, [sample('org5', { viewers: 24 })], state);
  assert.deepEqual(r.groups.org5.channels, {});
});

test('null viewers (no API key) disable the audience channel rather than scoring 0x', () => {
  const state = baselined(['org1']);
  const r = evalAt(NOW, [sample('org1', { viewers: null })], state);
  assert.deepEqual(r.groups.org1.channels, {});
  assert.equal(r.state.baselines[VIDEO.org1].length, 20, 'and nothing is appended to the baseline');
});

test('this tick\'s reading is judged against the TRAILING baseline, not one including itself', () => {
  const state = baselined(['org1']);
  const r = evalAt(NOW, [sample('org1', { viewers: 1600 })], state);
  assert.equal(r.groups.org1.channels.audience, 5);
  assert.deepEqual(r.state.baselines[VIDEO.org1].at(-1), [NOW, 1600], 'and only then recorded');
});

test('baselines are trimmed to the window and capped, so state cannot grow forever', () => {
  const stale = [[NOW - 90 * MIN, 900], ...ring(20, 200)];
  const state = { streams: knows('org1'), baselines: { [VIDEO.org1]: stale, 'gone-for-hours': ring(3, 7, NOW - 4 * HOUR) } };
  const r = evalAt(NOW, [sample('org1', { viewers: 200 })], state);
  assert.equal(r.state.baselines[VIDEO.org1].length, 21, 'the 90-minute-old reading is gone');
  assert.equal(r.state.baselines['gone-for-hours'], undefined, 'and an empty ring is dropped, not kept');

  // 400 readings four seconds apart: all inside the window, so it is the ring
  // cap doing the work here and not the trim.
  const dense = Array.from({ length: 400 }, (_, i) => [NOW - (400 - i) * 4000, 200]);
  const capped = evalAt(NOW, [sample('org1', { viewers: 200 })], { streams: {}, baselines: { [VIDEO.org1]: dense } });
  assert.equal(capped.state.baselines[VIDEO.org1].length, 200);
});

// ── liveness and editorial ───────────────────────────────────────────────────

test('L1 needs a WITNESSED off->on transition, not a stream class', () => {
  // We watched it while it was off, and now it is on. That is the signal.
  const justLive = evalAt(NOW, [sample('org6')], { streams: knows('org6', { live: false, wentLiveAt: null }), baselines: {} });
  assert.equal(justLive.groups.org6.channels.liveness, 5);

  const stale = evalAt(NOW, [sample('org6')], { streams: knows('org6', { wentLiveAt: NOW - 11 * MIN }), baselines: {} });
  assert.equal(stale.groups.org6.channels.liveness, undefined, 'going live stops being news after 10 minutes');

  // A chopper cam is not a 24/7 stream — it goes up BECAUSE something is happening —
  // so it MUST count. The original gate was `episodic` only and excluded exactly this.
  const chopper = evalAt(NOW, [sample('org1')], { streams: knows('org1', { live: false, wentLiveAt: null }), baselines: {} });
  assert.equal(chopper.groups.org1.channels.liveness, 5, 'a chopper going up is the whole point');

  // A newscast going live is the 5pm bulletin, not an event. Scoring it is what let
  // two unrelated newsrooms announce a chase between them — see the test below.
  const newscast = evalAt(NOW, [sample('org2')], { streams: knows('org2', { live: false, wentLiveAt: null }), baselines: {} });
  assert.equal(newscast.groups.org2?.channels?.liveness, undefined, 'a scheduled bulletin is not an event');
});

test('two newsrooms starting routine bulletins together do NOT announce a chase', () => {
  // The false positive this gate exists to stop, at the REAL threshold. Both go live in
  // the same minute with ordinary titles and no chase vocabulary anywhere. Before the
  // gate this scored 5 + 5 = 10 and announced.
  const bulletin = (org, title, at) => ({ ...sample(org), videoId: `${org}-news`, title, viewers: 900, startedAt: at, at });
  let state = { streams: { 'org2-off': { title: '', live: false, wentLiveAt: null, seenAt: NOW, org: 'org2' },
                           'org4-off': { title: '', live: false, wentLiveAt: null, seenAt: NOW, org: 'org4' } }, baselines: {} };
  for (let i = 0; i < 6; i += 1) {
    const at = NOW + i * MIN;
    const r = evaluateChase({
      samples: [bulletin('org2', 'Eyewitness News at 5', NOW), bulletin('org4', 'Evening Edition', NOW)],
      articles: [], state, now: at, cfg,
    });
    state = r.state;
    assert.equal(r.score, 0, `poll ${i}: a scheduled bulletin is not evidence of a chase`);
    assert.equal(r.announce, null, `poll ${i}: must not announce`);
  }
});

test('an always-live stream never scores L1, because it never transitions', () => {
  // What the old class gate was really protecting against — and this holds without it.
  let state = { streams: knows('org2', { live: true, wentLiveAt: null }), baselines: {} };
  for (let i = 0; i < 20; i += 1) {
    const r = evalAt(NOW + i * MIN, [sample('org2')], state);
    assert.equal(r.groups.org2?.channels?.liveness, undefined, `poll ${i}: continuously live is not an event`);
    state = r.state;
  }
});

test('a stream found ALREADY running does not score L1 — no cold-start firing', () => {
  // A restart must not read every standing stream as freshly live and light up the
  // whole roster. With no prior observation there is no transition to witness.
  const first = evalAt(NOW, [sample('org6')], { streams: {}, baselines: {} });
  assert.equal(first.groups.org6?.channels?.liveness, undefined, 'first sighting is not a transition');
  const next = evalAt(NOW + MIN, [sample('org6')], first.state);
  assert.equal(next.groups.org6?.channels?.liveness, undefined, 'and it does not appear a poll later either');
});

test('A1 needs a fresh, present-tense article', () => {
  const article = (over) => [{ org: 'org3', title: 'Deputies chase a speeding motorcyclist', publishedAt: NOW - 5 * MIN, ...over }];
  assert.equal(evalAt(NOW, [], {}, {}, article()).groups.org3.channels.editorial, 2);
  assert.equal(evalAt(NOW, [], {}, {}, article({ publishedAt: NOW - 20 * MIN })).groups.org3.channels.editorial, undefined);
  assert.equal(
    evalAt(NOW, [], {}, {}, article({ title: 'Raw video: chase ends in crash' })).groups.org3.channels.editorial,
    undefined,
    'a recap is not present-tense evidence',
  );
});

// ── the group cap ────────────────────────────────────────────────────────────

test('a capped org cannot fire alone — its cap sits below the threshold', () => {
  const state = baselined(['org5']);
  const results = drive(state, () => [
    sample('org5', { title: 'LIVE: Police pursuit on the freeway', viewers: 1600 }),
  ], { polls: 5 });
  const last = results.at(-1);
  assert.equal(last.groups.org5.score, 7, 'capped from 8 by the org groupCap');
  assert.equal(last.score, 7);
  assert.ok(results.every((r) => !r.opened), 'five polls of its best evidence and it still cannot announce');
});

test('an uncapped org carries the full cap, so one org CAN fire with two channels', () => {
  const state = baselined(['org1']);
  state.streams = knows('org1', { title: CHOPPER_CAM });
  const results = drive(state, () => [
    sample('org1', { title: 'LIVE: Police pursuit in progress', viewers: 1600 }),
  ], { polls: cfg.dwell });
  assert.equal(results.at(-1).opened, true);
});

// ── dwell, hysteresis, cooldowns ─────────────────────────────────────────────

const twoOrgSpike = () => [sample('org2', { viewers: 1600 }), sample('org3', { viewers: 1600 })];
const twoOrgQuiet = () => [sample('org2', { viewers: 200 }), sample('org3', { viewers: 200 })];

test('two orgs at 5 each clear the threshold — but only after `dwell` polls', () => {
  const results = drive(baselined(['org2', 'org3']), twoOrgSpike, { polls: cfg.dwell });
  assert.equal(results[0].score, 10);
  assert.deepEqual(results.map((r) => r.opened), [false, false, true], 'a title glitch lasts one poll; a chase does not');
  assert.deepEqual(results.map((r) => r.state.overCount), [1, 2, 0], 'the dwell counter resets once it has acted');

  const opened = results.at(-1);
  assert.equal(opened.announce.incident.id, `org2-${NOW + 2 * MIN}`);
  assert.equal(opened.state.incident.openedAt, NOW + 2 * MIN);
  assert.equal(opened.state.incident.announcedAt, null, 'the sender stamps that, not the evaluator');
});

test('a score that drops below threshold resets the dwell instead of banking it', () => {
  const state = baselined(['org2', 'org3']);
  const results = drive(state, (now, i) => (i === 1 ? twoOrgQuiet() : twoOrgSpike()), { polls: 4 });
  assert.deepEqual(results.map((r) => r.state.overCount), [1, 0, 1, 2]);
  assert.ok(results.every((r) => !r.opened), 'two polls either side of a gap is not three consecutive');
});

test('an open incident announces once, not once per poll', () => {
  const results = drive(baselined(['org2', 'org3']), twoOrgSpike, { polls: 8 });
  assert.equal(results.filter((r) => r.announce).length, 1);
  assert.equal(results.filter((r) => r.opened).length, 1);
  assert.equal(results.at(-1).state.incident.peakScore, 10, 'it just tracks the peak from then on');
});

test('hysteresis: the incident closes only after `clearPolls` polls under clearScore', () => {
  const open = drive(baselined(['org2', 'org3']), twoOrgSpike, { polls: cfg.dwell });
  const quiet = drive(open.at(-1).state, twoOrgQuiet, { polls: cfg.clearPolls, from: NOW + cfg.dwell * MIN });

  assert.deepEqual(quiet.map((r) => r.closed), [false, false, false, false, true]);
  assert.ok(quiet.slice(0, -1).every((r) => r.state.incident), 'hard to start, easy to continue');
  const last = quiet.at(-1);
  assert.equal(last.state.incident, null);
  assert.equal(last.state.lastClosedAt, NOW + (cfg.dwell + cfg.clearPolls - 1) * MIN);
  assert.equal(last.state.lastIncident.org, 'org2', 'kept so !chase can still describe the most recent one');
});

test('a dip that recovers above clearScore does not close the incident', () => {
  const open = drive(baselined(['org2', 'org3']), twoOrgSpike, { polls: cfg.dwell });
  const wobble = drive(open.at(-1).state, (now, i) => (i === 2 ? twoOrgSpike() : twoOrgQuiet()), {
    polls: 6, from: NOW + cfg.dwell * MIN,
  });
  assert.deepEqual(wobble.map((r) => r.state.underCount), [1, 2, 0, 1, 2, 3]);
  assert.ok(wobble.every((r) => !r.closed));
});

test('the reopen cooldown stops the ragged tail of one chase becoming a second announcement', () => {
  const closedState = {
    ...baselined(['org2', 'org3']),
    lastClosedAt: NOW - 5 * MIN,
  };
  const tooSoon = drive(closedState, twoOrgSpike, { polls: 6 });
  assert.ok(tooSoon.every((r) => !r.opened), 'five minutes after a close is the same chase');

  const later = drive({ ...closedState, lastClosedAt: NOW - cfg.reopenCooldownMs }, twoOrgSpike, { polls: cfg.dwell });
  assert.equal(later.at(-1).opened, true, 'past the lockout a genuinely new one may announce');
});

test('the announcement cap is channel-wide and counts the last hour only', () => {
  const recent = [NOW - 5 * MIN, NOW - 25 * MIN, NOW - 45 * MIN];
  const capped = drive({ ...baselined(['org2', 'org3']), announcedAt: recent }, twoOrgSpike, { polls: 5 });
  assert.ok(capped.every((r) => !r.opened), `maxPerHour ${cfg.maxPerHour} already spent`);

  const aged = drive({ ...baselined(['org2', 'org3']), announcedAt: [NOW - 70 * MIN, ...recent.slice(1)] }, twoOrgSpike, { polls: cfg.dwell });
  assert.equal(aged.at(-1).opened, true, 'the 70-minute-old stamp no longer counts');
  assert.deepEqual(aged.at(-1).state.announcedAt, [NOW - 25 * MIN, NOW - 45 * MIN, NOW + 2 * MIN]);
});

// ── the announcement itself ──────────────────────────────────────────────────

test('the announcement is one line, with a link and nothing about the rig behind it', () => {
  const state = baselined(['org1']);
  state.streams = knows('org1', { title: CHOPPER_CAM });
  const results = drive(state, () => [
    sample('org1', { title: 'LIVE: Police pursuit in progress', viewers: 1600 }),
  ], { polls: cfg.dwell });
  const { text } = results.at(-1).announce;

  assert.equal(
    text,
    `🚨 Police chase live in LA right now — Org One is on it: https://www.youtube.com/watch?v=${VIDEO.org1}`,
  );
  assert.ok(!text.includes('\n'), 'one line');
  // The source's public NAME is the point; nothing behind it belongs in chat.
  for (const leak of ['org1', 'score', 'viewers', 'quota', 'API', 'median', 'baseline', 'chopper']) {
    assert.ok(!text.toLowerCase().includes(leak.toLowerCase()), `must not leak "${leak}"`);
  }
});

test('the link points at the highest-scoring live stream, and is null when nothing is live', () => {
  const state = baselined(['org2', 'org1']);
  const r = evalAt(NOW, [
    sample('org2', { viewers: 600 }), // V2 — 2
    sample('org1', { viewers: 1600 }), // V1 — 5
  ], state);
  assert.deepEqual(r.best, {
    org: 'org1', videoId: VIDEO.org1, url: `https://www.youtube.com/watch?v=${VIDEO.org1}`, title: restingTitle('org1'),
  });

  const dark = evalAt(NOW, [sample('org2', { live: false })], state);
  assert.equal(dark.best, null);
});

test('a vetoed org never supplies the link', () => {
  const state = baselined(['org6', 'org1']);
  const r = evalAt(NOW, [
    sample('org6', { title: 'Raw video: chase ends in crash' }),
    sample('org1', { viewers: 1600 }),
  ], state);
  assert.equal(r.best.org, 'org1');
});

// ── shape, purity and persistence ────────────────────────────────────────────

test('the breakdown covers every configured org, so /chase score can never be partial', () => {
  const r = evalAt(NOW, [sample('org2')], {});
  assert.deepEqual(Object.keys(r.groups).sort(), cfg.orgs.map((o) => o.id).sort());
  for (const g of Object.values(r.groups)) {
    assert.equal(typeof g.score, 'number');
    assert.equal(typeof g.vetoed, 'boolean');
    assert.equal(typeof g.channels, 'object');
  }
});

test('the evaluator never mutates what it was given', () => {
  const state = baselined(['org2', 'org3']);
  const samples = twoOrgSpike();
  const articles = [{ org: 'org3', title: 'Deputies chase a motorcyclist', publishedAt: NOW - MIN }];
  const before = structuredClone({ state, samples, articles });
  deepFreeze(state); deepFreeze(samples); deepFreeze(articles);

  const r = evaluateChase({ samples, articles, state, now: NOW, cfg });
  assert.equal(r.score, 11.2, 'and it still scores — the freeze is not silently swallowing work');
  assert.deepEqual({ state, samples, articles }, before);
});

test('the next state survives a JSON round-trip, because RTDB is where it lives', () => {
  const open = drive(baselined(['org2', 'org3']), twoOrgSpike, { polls: cfg.dwell });
  const closedRun = drive(open.at(-1).state, twoOrgQuiet, { polls: cfg.clearPolls, from: NOW + cfg.dwell * MIN });
  for (const r of [...open, ...closedRun]) {
    assert.deepEqual(JSON.parse(JSON.stringify(r.state)), r.state);
  }
});

test('a missing state, missing samples and a partial state are all survivable', () => {
  const cold = evaluateChase({ now: NOW, cfg });
  assert.deepEqual([cold.score, cold.best, cold.announce, cold.opened, cold.closed], [0, null, null, false, false]);
  assert.deepEqual(cold.state.streams, {});

  const partial = evalAt(NOW, [sample('org2')], { overCount: 'nonsense', announcedAt: { 0: NOW - MIN }, baselines: { x: 'no' } });
  assert.equal(partial.state.overCount, 0);
  assert.deepEqual(partial.state.announcedAt, [NOW - MIN]);
  assert.deepEqual(partial.state.baselines, {});
});

test('a poll that returned nothing does not wipe what is known about the streams', () => {
  const state = baselined(['org2']);
  const r = evalAt(NOW, [], state);
  assert.equal(r.state.streams[VIDEO.org2].title, restingTitle('org2'), 'or the next poll reads every title as new');
  assert.equal(r.state.baselines[VIDEO.org2].length, 20);
});

test('the tracked-stream map is bounded — episodic channels mint a new id per broadcast', () => {
  const streams = {};
  for (let i = 0; i < 260; i += 1) {
    streams[`old-${i}`] = { title: 't', live: false, wentLiveAt: null, seenAt: NOW - (260 - i) * HOUR };
  }
  const r = evalAt(NOW, [sample('org2')], { streams, baselines: {} });
  assert.equal(Object.keys(r.state.streams).length, 200);
  assert.ok(r.state.streams[VIDEO.org2], 'and what was seen this tick is what is kept');
});

// ── the small pure pieces ────────────────────────────────────────────────────

test('vocabulary matching respects word boundaries but allows the feeds\' tenses', () => {
  assert.ok(matchesAny('Deputies chases speeding motorcyclist', ['chase']));
  assert.ok(matchesAny('Suspect chased through the east side', ['chase']));
  assert.ok(matchesAny('LIVE: High-speed pursuit', ['high-speed']));
  assert.ok(!matchesAny('Complete your purchase now', ['chase']), '"purchase" is not a chase');
  assert.ok(!matchesAny('Chasseur wins the third race', ['chase']));
  assert.ok(!matchesAny('', ['chase']));
  assert.ok(!matchesAny('anything', []));
});

test('median handles both parities and an empty window', () => {
  assert.equal(median([5, 1, 3]), 3);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([]), 0);
  assert.equal(median([1, Number.NaN, 3]), 2, 'a junk reading is dropped, not propagated');
});

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

// ── a stuck incident is the worst failure here, so it gets its own guards ─────
//
// An OPEN incident blocks every new one. So an incident that cannot close does not
// merely linger — it silently switches the whole monitor off, with no error anywhere.
// Two independent guards, because one of them is the one we thought of.

test('a standing chase title cannot hold an incident open once the chase is over', () => {
  // Guard 1: clearScore (6) sits ABOVE a lone standing title (T1=5).
  const state = baselined(['org1']);
  const open = drive(state, () => [
    sample('org1', { title: 'LIVE: Police pursuit', viewers: 1600 }),
  ], { polls: 4 });
  const after = open[open.length - 1];
  assert.ok(after.state.incident, 'an incident opened');

  // The chase ends: viewers fall back to the baseline, but nobody retitles the stream.
  let s = after.state;
  for (let i = 0; i < config.chase.clearPolls + 1; i += 1) {
    const r = evaluateChase({
      samples: [sample('org1', { title: 'LIVE: Police pursuit', viewers: 200 })],
      state: s, now: NOW + (10 + i) * MIN, cfg,
    });
    s = r.state;
  }
  assert.equal(s.incident, null, 'a title left up must not pin the incident open forever');
});

test('maxIncidentMs closes an incident whatever it scores', () => {
  // Guard 2: the backstop for whatever guard 1 does not catch. Feed a score that
  // NEVER drops below clearScore, so only age can end it.
  // Two TITLE-only orgs: a viewer baseline is trimmed to a 30-minute window, so an
  // audience signal cannot survive a three-hour jump and the score would dip for the
  // ordinary reason. Standing titles keep it pinned at 10, so age is the only way out.
  const state = baselined([]);
  const hot = () => [
    sample('org2', { title: 'LIVE: Police pursuit downtown' }),
    sample('org3', { title: 'LIVE: Police pursuit continues' }),
  ];
  const opened = drive(state, hot, { polls: 4 });
  let s = opened[opened.length - 1].state;
  assert.ok(s.incident, 'an incident opened');

  const openedAt = s.incident.openedAt;
  const justUnder = evaluateChase({
    samples: hot(), state: s, now: openedAt + config.chase.maxIncidentMs - MIN, cfg,
  });
  assert.ok(justUnder.score >= config.chase.clearScore, 'score never dipped — only age can close it');
  assert.ok(justUnder.state.incident, 'still open just under the cap');

  const past = evaluateChase({
    samples: hot(), state: s, now: openedAt + config.chase.maxIncidentMs, cfg,
  });
  assert.equal(past.state.incident, null, 'closed on age alone');
  assert.equal(past.closed, true);
});

test('L1 keys on the broadcast START TIME, not on our observation history', () => {
  // A chopper going up mints a NEW videoId beside the org's standing 24/7 stream, so
  // "have we seen this videoId" cannot answer it. But neither can "have we seen this
  // ORG" — that inference fired on three long-running streams discovered in a single
  // search sweep, scored 15, and would have announced a chase that never happened.
  // YouTube reports actualStartTime; that is authoritative and history-free.
  const loop = (at) => ({ ...sample('org1'), videoId: 'loop', title: 'a permanent 24/7 stream', viewers: null, startedAt: at - 400 * 24 * 60 * MIN, at });
  let state = evaluateChase({ samples: [loop(NOW)], state: null, now: NOW, cfg }).state;
  for (let i = 1; i < 5; i += 1) {
    state = evaluateChase({ samples: [loop(NOW + i * MIN)], state, now: NOW + i * MIN, cfg }).state;
  }

  const fresh = { ...sample('org1'), videoId: 'fresh', title: 'LIVE: Police pursuit', viewers: null, startedAt: NOW + 5 * MIN - 2 * MIN, at: NOW + 5 * MIN };
  const r = evaluateChase({ samples: [loop(NOW + 5 * MIN), fresh], state, now: NOW + 5 * MIN, cfg });
  assert.equal(r.groups.org1.channels.liveness, 5, 'a broadcast that began 2 minutes ago IS the event');
});

test('a long-running stream never scores L1, however we came across it', () => {
  // The false positive this replaced: three streams live for HOURS, all discovered in
  // one sweep, each scoring L1. Their start times say plainly that none of them is new.
  const old = (org) => ({ ...sample(org), viewers: null, startedAt: NOW - 400 * 24 * 60 * MIN });
  const r = evaluateChase({ samples: ['org1', 'org2', 'org6'].map(old), state: null, now: NOW, cfg });
  assert.equal(r.score, 0, 'discovering old streams is not three simultaneous events');
  for (const o of ['org1', 'org2', 'org6']) {
    assert.equal(r.groups[o]?.channels?.liveness, undefined, `${o}: live for weeks is not news`);
  }
});

test('a cold start never scores L1, however many streams are already running', () => {
  // The other half of the same rule. With no prior records the org is unknown, so
  // nothing can be called new — otherwise a restart lights up the entire roster.
  const running = ['org1', 'org2', 'org6'].map((o) => ({ ...sample(o), viewers: null }));
  const r = evaluateChase({ samples: running, state: null, now: NOW, cfg });
  for (const o of ['org1', 'org2', 'org6']) {
    assert.equal(r.groups[o]?.channels?.liveness, undefined, `${o}: found running is not a transition`);
  }
});
