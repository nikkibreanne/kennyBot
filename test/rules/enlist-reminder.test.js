// Who gets reminded that they never joined the season — and, mostly, who doesn't.
// Pure selection rules, so the politeness constraints are testable without a DB.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickReminderTarget } from '../../src/db/enlistReminder.js';
import { config } from '../../src/config.js';

const NOW = 1_800_000_000_000;
const cfg = config.enlistReminder;
const DAY = 24 * 60 * 60 * 1000;

/** A hero who SHOULD be reminded, unless a field is overridden. */
const hero = (over = {}) => ({
  displayName: 'Hero', class: 'Ranger', role: 'dps', level: 9,
  createdAt: NOW - 30 * DAY,        // long past the grace period
  lastExpAt: NOW - 60_000,          // chatting a minute ago
  ...over,
});

const pick = (players, signups = {}) =>
  pickReminderTarget({ players, signups, seasonId: 't2', now: NOW });

test('a lapsed hero who is around right now gets picked', () => {
  const got = pick({ u1: hero() });
  assert.equal(got?.uid, 'u1');
});

test('nobody is chased during their first week', () => {
  // A brand-new character has not had a chance to raid yet.
  assert.equal(pick({ u1: hero({ createdAt: NOW - 3 * DAY }) }), null);
  assert.equal(pick({ u1: hero({ createdAt: NOW - (cfg.graceMs - 1) }) }), null);
  assert.ok(pick({ u1: hero({ createdAt: NOW - (cfg.graceMs + 1) }) }), 'just past the week, fair game');
});

test('someone already on the roster is never reminded', () => {
  assert.equal(pick({ u1: hero() }, { u1: { displayName: 'Hero' } }), null);
});

test('nobody is asked twice in the same season', () => {
  assert.equal(pick({ u1: hero({ invitedSeason: 't2' }) }), null);
  // …but a NEW season is a fresh ask.
  assert.ok(pick({ u1: hero({ invitedSeason: 't1' }) }), 'last season\'s invite must not silence this one');
});

test('an @-mention only goes to someone actually present', () => {
  // Mentioning a lurker who left hours ago is noise nobody reads.
  assert.equal(pick({ u1: hero({ lastExpAt: NOW - 3 * 60 * 60 * 1000 }) }), null);
  assert.equal(pick({ u1: hero({ lastExpAt: 0 }) }), null);
  assert.equal(pick({ u1: hero({ lastExpAt: undefined }) }), null);
});

test('an account with no character is not a lapsed hero', () => {
  assert.equal(pick({ u1: { displayName: 'Lurker', createdAt: NOW - 30 * DAY, lastExpAt: NOW } }), null);
});

test('exactly ONE hero is returned, never a batch', () => {
  const many = { a: hero(), b: hero(), c: hero(), d: hero() };
  const got = pick(many);
  assert.ok(got && typeof got.uid === 'string', 'a single target, so reminders cannot clump');
});

test('the longest-lapsed hero is asked first', () => {
  const got = pick({
    recent: hero({ createdAt: NOW - 8 * DAY }),
    ancient: hero({ createdAt: NOW - 200 * DAY }),
    middling: hero({ createdAt: NOW - 60 * DAY }),
  });
  assert.equal(got.uid, 'ancient', 'someone who drifted off months ago is the better ask');
});

test('an empty patch produces no reminder rather than an error', () => {
  assert.equal(pick({}), null);
  assert.equal(pick(null), null);
  assert.equal(pickReminderTarget({ players: null, signups: null, seasonId: null, now: NOW }), null);
});

test('the grace period is at least a week, and gaps are not chatty', () => {
  // Guards the config itself: these are the politeness promises.
  assert.ok(cfg.graceMs >= 7 * DAY, 'a week of grace after !create');
  assert.ok(cfg.minGapMs >= 30 * 60 * 1000, 'reminders must not clump');
  assert.ok(cfg.presentWithinMs <= 60 * 60 * 1000, 'only @ people who are actually here');
});
