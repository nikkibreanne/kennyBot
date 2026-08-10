// REMINDER SCHEDULING — the pure evaluator. Clock, live state, channel and RNG
// are all injected, so every case below is exact and instant: no waiting for an
// hour to pass, no flaky "close enough" timing. Runs offline in CI (`npm test`).
//
// The failures that matter here are the ones a live stream would show first:
// a reminder firing on the wrong channel, Ghosty's 8am ping arriving at noon
// because the bot restarted, a hydration ping repeating every tick, or the meal
// times silently drifting an hour when Pacific time changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateReminder, describeSchedule, zonedNow, parseClock, formatClock, normalizeChannel,
} from '../../src/rules/reminders.js';
import { DEFAULT_REMINDERS } from '../../src/content/reminders.js';
import { config } from '../../src/config.js';

const MIN = 60_000;
const PT = 'America/Los_Angeles';
const byId = (id) => structuredClone(DEFAULT_REMINDERS.find((r) => r.id === id));

/** ctx with the defaults a live nikkibreanne stream would have. */
function ctx(overrides = {}) {
  return {
    now: Date.parse('2026-08-09T18:00:00Z'),
    live: true,
    liveSince: Date.parse('2026-08-09T17:00:00Z'),
    channel: 'nikkibreanne',
    config: config.reminders,
    ...overrides,
  };
}

/** An instant expressed as PACIFIC wall-clock, so the test reads like the schedule. */
const pacific = (isoLocal, offset) => Date.parse(`${isoLocal}${offset}`);

// ── gates that apply to every kind ───────────────────────────────────────────

test('a channel-specific reminder never fires on another channel', () => {
  const r = byId('ghosty');
  const at8 = pacific('2026-08-09T08:00:30', '-07:00');
  const mine = evaluateReminder(r, ctx({ now: at8, channel: 'nikkibreanne' }));
  const theirs = evaluateReminder(r, ctx({ now: at8, channel: 'someoneelse' }));
  assert.ok(mine.due, 'fires on its own channel');
  assert.equal(theirs.due, null, 'a Nikki reminder must stay off other channels');
  assert.equal(theirs.changed, false, 'and must not even record state there');
});

test('channel matching ignores the leading # and case', () => {
  const r = { ...byId('ghosty'), channel: 'NikkiBreanne' };
  const at8 = pacific('2026-08-09T08:00:30', '-07:00');
  assert.ok(evaluateReminder(r, ctx({ now: at8, channel: '#nikkibreanne' })).due);
  assert.equal(normalizeChannel('#NikkiBreanne '), 'nikkibreanne');
});

test('a null channel fires wherever the bot is running', () => {
  const c = ctx({ channel: 'anyone-at-all' });
  const r = { ...byId('hydration'), state: { nextAt: c.now - 1000 } }; // just came due
  assert.ok(evaluateReminder(r, c).due, 'hydration is not Nikki-specific');
});

test('nothing fires while the channel is offline, and no state is touched', () => {
  for (const id of ['wallpaper', 'ghosty', 'hydration']) {
    const r = byId(id);
    const res = evaluateReminder(r, ctx({ live: false, liveSince: null, now: pacific('2026-08-09T08:00:30', '-07:00') }));
    assert.deepEqual([res.due, res.changed], [null, false], `${id} must stay quiet while offline`);
  }
});

test('a disabled reminder is inert', () => {
  const r = { ...byId('hydration'), enabled: false, state: { nextAt: 1 } };
  assert.equal(evaluateReminder(r, ctx()).due, null);
});

// ── afterLive: the Wallpaper Engine check ────────────────────────────────────

test('wallpaper check fires once, 30 minutes into the stream', () => {
  const r = byId('wallpaper');
  const liveSince = Date.parse('2026-08-09T17:00:00Z');

  const early = evaluateReminder(r, ctx({ liveSince, now: liveSince + 29 * MIN }));
  assert.equal(early.due, null, 'not a minute early');

  const on = evaluateReminder(r, ctx({ liveSince, now: liveSince + 30 * MIN }));
  assert.match(on.due.text, /Wallpaper Engine/);
  assert.equal(on.state.firedSession, liveSince, 'the session is marked so it cannot repeat');

  const again = evaluateReminder({ ...r, state: on.state }, ctx({ liveSince, now: liveSince + 45 * MIN }));
  assert.deepEqual([again.due, again.changed], [null, false], 'once per stream, not once per tick');
});

test('wallpaper check fires again on the NEXT stream, not on a bot restart', () => {
  const r = byId('wallpaper');
  const first = Date.parse('2026-08-09T17:00:00Z');
  const fired = evaluateReminder(r, ctx({ liveSince: first, now: first + 30 * MIN })).state;

  // Same session (a restart keeps liveSince) → still silent.
  const restart = evaluateReminder({ ...r, state: fired }, ctx({ liveSince: first, now: first + 31 * MIN }));
  assert.equal(restart.due, null, 'a restart mid-stream must not re-announce');

  // A genuinely new stream has a new liveSince → it fires again.
  const second = first + 20 * 60 * MIN;
  const next = evaluateReminder({ ...r, state: fired }, ctx({ liveSince: second, now: second + 30 * MIN }));
  assert.ok(next.due, 'a new stream gets its own check');
});

test('wallpaper check goes quiet — but marks the session — if the bot booted hours late', () => {
  const r = byId('wallpaper');
  const liveSince = Date.parse('2026-08-09T17:00:00Z');
  const late = liveSince + 30 * MIN + config.reminders.afterLiveWindowMs + MIN;
  const res = evaluateReminder(r, ctx({ liveSince, now: late }));
  assert.equal(res.due, null, 'a check three hours late is noise');
  assert.equal(res.state.firedSession, liveSince, 'still marked, so it cannot fire on the next tick either');
});

test('afterLive waits for the live stamp rather than guessing', () => {
  const res = evaluateReminder(byId('wallpaper'), ctx({ liveSince: null }));
  assert.deepEqual([res.due, res.changed], [null, false]);
});

// ── daily: Ghosty's meals ────────────────────────────────────────────────────

test("Ghosty's meal fires at 08:00 and 17:00 Pacific, with a 20-minute heads-up", () => {
  const r = byId('ghosty');
  const cases = [
    ['2026-08-09T07:40:05', 'lead', /20 minutes/],
    ['2026-08-09T08:00:05', 'main', /meal time/i],
    ['2026-08-09T16:40:05', 'lead', /20 minutes/],
    ['2026-08-09T17:00:05', 'main', /meal time/i],
  ];
  for (const [local, kind, text] of cases) {
    const res = evaluateReminder(r, ctx({ now: pacific(local, '-07:00') }));
    assert.equal(res.due?.kind, kind, `${local} should fire the ${kind}`);
    assert.match(res.due.text, text);
  }
});

test('a meal slot fires once, then not again for the rest of that day', () => {
  const r = byId('ghosty');
  const first = evaluateReminder(r, ctx({ now: pacific('2026-08-09T08:00:05', '-07:00') }));
  const second = evaluateReminder({ ...r, state: first.state }, ctx({ now: pacific('2026-08-09T08:02:00', '-07:00') }));
  assert.equal(second.due, null, 'still inside the grace window, but already said');

  // …and the same clock time TOMORROW is a different slot, so it fires again.
  const tomorrow = evaluateReminder({ ...r, state: first.state }, ctx({ now: pacific('2026-08-10T08:00:05', '-07:00') }));
  assert.equal(tomorrow.due?.kind, 'main');
});

test('a meal slot missed while offline is skipped, not announced late', () => {
  const r = byId('ghosty');
  // Bot comes up (or the stream starts) well after 08:00 — outside the grace.
  const res = evaluateReminder(r, ctx({ now: pacific('2026-08-09T11:30:00', '-07:00') }));
  assert.deepEqual([res.due, res.changed], [null, false], 'an 8am meal ping at 11:30 helps nobody');
});

test('the grace window is respected exactly at its edges', () => {
  const r = byId('ghosty');
  const grace = config.reminders.dailyGraceMs;
  const slot = pacific('2026-08-09T08:00:00', '-07:00');
  assert.ok(evaluateReminder(r, ctx({ now: slot + grace - 1000 })).due, 'inside the window');
  assert.equal(evaluateReminder(r, ctx({ now: slot + grace + 1000 })).due, null, 'past it');
  assert.equal(evaluateReminder(r, ctx({ now: slot - 1000 })).due, null, 'never early');
});

test('meal times follow Pacific WALL CLOCK across the DST change', () => {
  const r = byId('ghosty');
  // Same local 08:00, one in PDT (UTC-7) and one in PST (UTC-8): both must fire,
  // which a naive fixed-offset schedule would get wrong by an hour half the year.
  assert.ok(evaluateReminder(r, ctx({ now: pacific('2026-08-09T08:00:05', '-07:00') })).due, 'PDT summer');
  assert.ok(evaluateReminder(r, ctx({ now: pacific('2026-01-09T08:00:05', '-08:00') })).due, 'PST winter');
  // 08:00 UTC is the middle of the night in Pacific — nothing is due.
  assert.equal(evaluateReminder(r, ctx({ now: Date.parse('2026-08-09T08:00:05Z') })).due, null);
});

test('daily reminders honour a different time zone', () => {
  const r = { ...byId('ghosty'), timeZone: 'Europe/London', times: ['09:00'], leadMs: 0 };
  assert.ok(evaluateReminder(r, ctx({ now: Date.parse('2026-08-09T08:00:05Z') })).due, '09:00 BST = 08:00 UTC');
  assert.equal(evaluateReminder(r, ctx({ now: Date.parse('2026-08-09T09:00:05Z') })).due, null);
});

test('the fired-key list stays bounded as days go by', () => {
  let state;
  for (let day = 1; day <= 12; day++) {
    const now = pacific(`2026-08-${String(day).padStart(2, '0')}T08:00:05`, '-07:00');
    const res = evaluateReminder({ ...byId('ghosty'), state }, ctx({ now }));
    state = res.state;
  }
  assert.ok(state.firedKeys.length <= 8, `dedupe keys must not grow forever (${state.firedKeys.length})`);
});

test('a lead that lands before local midnight keeps its own day key', () => {
  const r = { ...byId('ghosty'), times: ['00:10'], leadMs: 20 * MIN, leadText: 'soon' };
  const res = evaluateReminder(r, ctx({ now: pacific('2026-08-09T23:50:05', '-07:00') }));
  assert.equal(res.due?.kind, 'lead');
  assert.ok(res.state.firedKeys[0].startsWith('2026-08-09'), 'keyed to the day it actually fires');
});

test('a daily reminder with no leadText still warns in plain English', () => {
  const r = { ...byId('ghosty'), leadText: null };
  const res = evaluateReminder(r, ctx({ now: pacific('2026-08-09T07:40:05', '-07:00') }));
  assert.match(res.due.text, /In 20 min/);
});

// ── interval: hydration ──────────────────────────────────────────────────────

test('hydration schedules its first ping an hour out instead of firing at once', () => {
  const r = byId('hydration');
  const now = Date.parse('2026-08-09T17:00:00Z');
  const res = evaluateReminder(r, ctx({ now }), () => 0.5);
  assert.equal(res.due, null, 'nobody needs a hydration ping two seconds into the stream');
  assert.equal(res.state.nextAt, now + 60 * MIN, 'rng 0.5 = no jitter');
});

test('hydration fires when due, then re-arms for the next hour', () => {
  const now = Date.parse('2026-08-09T18:00:00Z');
  const r = { ...byId('hydration'), state: { nextAt: now - 1000 } };
  const res = evaluateReminder(r, ctx({ now }), () => 0.5);
  assert.match(res.due.text, /Hydration/);
  assert.equal(res.state.nextAt, now + 60 * MIN);
});

test('hydration jitter stays inside ±10 minutes at both extremes', () => {
  const now = Date.parse('2026-08-09T18:00:00Z');
  const r = { ...byId('hydration'), state: { nextAt: now } };
  const low = evaluateReminder(r, ctx({ now }), () => 0).state.nextAt;
  const high = evaluateReminder(r, ctx({ now }), () => 1).state.nextAt;
  assert.equal(low, now + 50 * MIN, 'earliest = period − jitter');
  assert.equal(high, now + 70 * MIN, 'latest = period + jitter');
});

test('jitter can never exceed half the period, however it is configured', () => {
  const now = Date.parse('2026-08-09T18:00:00Z');
  const r = { ...byId('hydration'), everyMs: 10 * MIN, jitterMs: 60 * MIN, state: { nextAt: now } };
  const earliest = evaluateReminder(r, ctx({ now }), () => 0).state.nextAt;
  assert.ok(earliest > now, 'a runaway jitter must not schedule the next ping in the past');
});

test('a ping missed across a long offline stretch is re-armed, not fired late', () => {
  const now = Date.parse('2026-08-09T18:00:00Z');
  const r = { ...byId('hydration'), state: { nextAt: now - 5 * 60 * MIN } }; // 5h overdue
  const res = evaluateReminder(r, ctx({ now }), () => 0.5);
  assert.equal(res.due, null, 'coming back from an offline day must not dump a backlog');
  assert.equal(res.state.nextAt, now + 60 * MIN);
});

test('a short dropout keeps the cycle rather than restarting it', () => {
  const now = Date.parse('2026-08-09T18:00:00Z');
  const r = { ...byId('hydration'), state: { nextAt: now - 3 * MIN } }; // due during a brief drop
  assert.ok(evaluateReminder(r, ctx({ now }), () => 0.5).due, 'fires just after coming back');
});

// ── helpers ──────────────────────────────────────────────────────────────────

test('clock parsing accepts real times and rejects the rest', () => {
  assert.equal(parseClock('08:00'), 480);
  assert.equal(parseClock('8:05'), 485);
  assert.equal(parseClock('23:59'), 1439);
  for (const bad of ['24:00', '08:60', '8', '0800', 'noon', '']) assert.equal(parseClock(bad), null, bad);
  assert.equal(formatClock(485), '08:05');
});

test('zonedNow reports the wall clock of the named zone', () => {
  const at = Date.parse('2026-08-09T15:04:05Z');
  assert.deepEqual(zonedNow(at, PT), { date: '2026-08-09', minutes: 8 * 60 + 4, seconds: 5 });
  assert.equal(zonedNow(at, 'UTC').minutes, 15 * 60 + 4);
});

test('schedules describe themselves the way the chat list shows them', () => {
  assert.equal(describeSchedule(byId('wallpaper')), '30m after going live');
  assert.equal(describeSchedule(byId('ghosty')), 'daily 08:00, 17:00 Los Angeles +20m heads-up');
  assert.equal(describeSchedule(byId('hydration')), 'every 60m ±10m');
});

test('the shipped defaults are coherent — ids unique, kinds known, text present', () => {
  const ids = DEFAULT_REMINDERS.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate reminder id');
  for (const r of DEFAULT_REMINDERS) {
    assert.ok(['afterLive', 'daily', 'interval'].includes(r.kind), `${r.id}: unknown kind`);
    assert.ok(r.text?.trim(), `${r.id}: nothing to say`);
    if (r.kind === 'daily') for (const t of r.times) assert.ok(parseClock(t) != null, `${r.id}: bad time ${t}`);
  }
});
