// Offline tests for the subathon engine (node --test, no Firebase, no Twitch).
//
// EVERY NUMBER BELOW IS INVENTED. The real rate card is private (see the header
// of src/rules/subathon.js) and must never appear here — a test fixture is still
// a file in a public repository. These values are chosen to be obviously
// synthetic and to make the arithmetic easy to check by eye.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ratesFrom, bandFor, creditFor, worthOf, planToProduct, normalizeSchedule,
  noteGiftBomb, consumeGiftSub, GIFT_WINDOW_MS,
  elapsedMs, remainingMs, endsAt, ledgerSeconds, currentBand, bandTimeline,
  ledgerBreakdown, seSecondsFor, outstandingCorrection, seMatchesOpeningBand,
  formatDuration, parseSeconds, describeSe,
} from '../../src/rules/subathon.js';

const HOUR = 3_600_000;
const at = (hours) => hours * HOUR;

// A made-up rate card. Products are worth round numbers and the bands halve, so
// every expected value below can be checked mentally.
const RATES = {
  values: { t1: 2, t2: 4, t3: 10, bit: 0.01, dollar: 1 },
  bands: { alpha: 100, beta: 50, gamma: 25 },
  schedule: [
    { fromHours: 0, band: 'alpha' },
    { fromHours: 2, band: 'beta' },
    { fromHours: 5, band: 'gamma' },
  ],
  se: 100, // the external timer parked on the opening band
};
const rates = ratesFrom({ rates: RATES });

test('a price is the worth of the product times the band rate', () => {
  assert.equal(creditFor({ product: 't1' }, at(0), rates).seconds, 200); // 2 × 100
  assert.equal(creditFor({ product: 't3' }, at(0), rates).seconds, 1000); // 10 × 100
  assert.equal(creditFor({ product: 't3' }, at(2), rates).seconds, 500); // 10 × 50
  assert.equal(creditFor({ product: 't3' }, at(5), rates).seconds, 250); // 10 × 25
  assert.equal(creditFor({ product: 'bits', bits: 1000 }, at(0), rates).seconds, 1000); // 10 × 100
  assert.equal(creditFor({ product: 'dollars', dollars: 3 }, at(2), rates).seconds, 150);
});

test('an unconfigured event prices at zero and says so, rather than guessing', () => {
  const empty = ratesFrom({});
  assert.equal(empty.configured, false);
  const r = creditFor({ product: 't1' }, at(0), empty);
  assert.deepEqual(r, { seconds: 0, band: null, worth: 0, configured: false });
});

test('bands advance on ELAPSED uptime, and the last one is terminal', () => {
  assert.equal(bandFor(at(0), rates.schedule), 'alpha');
  assert.equal(bandFor(at(1.99), rates.schedule), 'alpha');
  assert.equal(bandFor(at(2), rates.schedule), 'beta');
  assert.equal(bandFor(at(4.99), rates.schedule), 'beta');
  assert.equal(bandFor(at(5), rates.schedule), 'gamma');
  assert.equal(bandFor(at(500), rates.schedule), 'gamma', 'no hard cap — the last band runs forever');
});

test('a contribution never splits across a band boundary', () => {
  const before = creditFor({ product: 't3', count: 10 }, at(2) - 1000, rates);
  const after = creditFor({ product: 't3', count: 10 }, at(2), rates);
  assert.equal(before.seconds, 10_000, 'whole bundle at the outgoing band');
  assert.equal(after.seconds, 5_000, 'whole bundle at the incoming band');
});

test('Prime pays as tier 1; an unknown plan is priced as the lowest tier', () => {
  assert.equal(planToProduct('Prime'), 't1');
  assert.equal(planToProduct('1000'), 't1');
  assert.equal(planToProduct('2000'), 't2');
  assert.equal(planToProduct('3000'), 't3');
  assert.equal(planToProduct('9000'), 't1');
});

test('a multi-month gift pays once per month of money', () => {
  assert.equal(worthOf({ product: 't1', months: 6 }, RATES.values), 12);
  assert.equal(worthOf({ product: 't3', count: 2, months: 3 }, RATES.values), 60);
});

test('sub-unit values do not land a rounding step low', () => {
  // 0.01 × 100 × 25 is 24.999… in float; the result must still be 25.
  assert.equal(creditFor({ product: 'bits', bits: 100 }, at(5), rates).seconds, 25);
  assert.equal(creditFor({ product: 'bits', bits: 1 }, at(5), rates).seconds, 0);
});

// ── Gift-bundle dedupe — the bug that would double every gifted sub ─────────

test('a bundle of 20 pays once, not twenty-one times', () => {
  const now = 1_000_000;
  let pending = noteGiftBomb({}, 'GifterA', 20, now);
  let credited = 0;
  for (let i = 0; i < 20; i += 1) {
    const r = consumeGiftSub(pending, 'GifterA', now + i * 100);
    pending = r.pending;
    if (r.credit) credited += 1;
  }
  assert.equal(credited, 0, 'every individual gift belongs to the bundle');
});

test('a lone gift sub with no bundle before it still pays', () => {
  assert.equal(consumeGiftSub({}, 'GifterB', 1_000_000).credit, true);
});

test('a gifter who sends two bundles back to back has both absorbed', () => {
  const now = 1_000_000;
  let pending = noteGiftBomb({}, 'GifterC', 5, now);
  pending = noteGiftBomb(pending, 'GifterC', 5, now + 500);
  let credited = 0;
  for (let i = 0; i < 10; i += 1) {
    const r = consumeGiftSub(pending, 'GifterC', now + 1000 + i);
    pending = r.pending;
    if (r.credit) credited += 1;
  }
  assert.equal(credited, 0);
  assert.equal(consumeGiftSub(pending, 'GifterC', now + 2000).credit, true, 'the next one is genuinely new');
});

test('anonymous gifters share one bucket and still dedupe', () => {
  const now = 1_000_000;
  let pending = noteGiftBomb({}, null, 3, now);
  let credited = 0;
  for (let i = 0; i < 3; i += 1) {
    const r = consumeGiftSub(pending, undefined, now + i);
    pending = r.pending;
    if (r.credit) credited += 1;
  }
  assert.equal(credited, 0);
});

test('a stale bundle cannot swallow a real gift much later', () => {
  const now = 1_000_000;
  const pending = noteGiftBomb({}, 'GifterD', 5, now);
  assert.equal(consumeGiftSub(pending, 'GifterD', now + GIFT_WINDOW_MS + 1).credit, true);
});

test('gifter matching is case-insensitive', () => {
  const pending = noteGiftBomb({}, 'GifterE', 1, 1_000_000);
  assert.equal(consumeGiftSub(pending, 'gIfTeRe', 1_000_010).credit, false);
});

// ── Clock ───────────────────────────────────────────────────────────────────

const baseState = (over = {}) => ({
  active: true, startedAt: 0, baseSeconds: 4 * 3600, paused: false,
  pausedAt: null, pausedMs: 0, rates: RATES, ledger: null, ...over,
});

test('the deadline is derived from base + ledger, not stored', () => {
  const state = baseState({ ledger: { a: { seconds: 600 }, b: { seconds: 300 } } });
  assert.equal(endsAt(state), (4 * 3600 + 900) * 1000);
  assert.equal(remainingMs(state, 0), (4 * 3600 + 900) * 1000);
});

test('the ledger sums whether RTDB hands it back as an object or an array', () => {
  assert.equal(ledgerSeconds({ a: { seconds: 10 }, b: { seconds: 5 } }), 15);
  assert.equal(ledgerSeconds([{ seconds: 10 }, { seconds: 5 }]), 15);
  assert.equal(ledgerSeconds(null), 0);
});

test('a negative entry subtracts, and the clock floors at zero', () => {
  assert.equal(remainingMs(baseState({ baseSeconds: 60, ledger: { a: { seconds: -600 } } }), 0), 0);
});

test('pausing freezes BOTH the countdown and the elapsed-uptime band', () => {
  // 4h on the clock, paused one hour in: 3h left, 1h of uptime. Distinct numbers
  // so neither assertion can pass by coincidence.
  const state = baseState({ paused: true, pausedAt: at(1) });
  assert.equal(remainingMs(state, at(4)), at(3), 'clock held at 3h left');
  assert.equal(elapsedMs(state, at(4)), at(1), 'uptime held at 1h');
});

test('resuming preserves the remainder and does not advance the band', () => {
  const remainingAtPause = remainingMs(baseState({ paused: true, pausedAt: at(2) }), at(2));
  const resumed = baseState({ pausedMs: at(3) }); // a 3h outage, absorbed
  assert.equal(remainingMs(resumed, at(5)), remainingAtPause, 'no time lost or gained');
  assert.equal(elapsedMs(resumed, at(5)), at(2), 'the outage did not raise the price');
});

test('an outage does not push the band up', () => {
  assert.equal(currentBand(baseState(), at(2)), 'beta');
  assert.equal(currentBand(baseState({ pausedMs: at(1) }), at(2)), 'alpha', 'only 1h of real uptime');
});

// ── Reconciliation against the external timer ───────────────────────────────

test('nothing is owed while the external timer matches the live band', () => {
  const ledger = {};
  for (const [i, c] of [{ product: 't1' }, { product: 't3' }, { product: 'bits', bits: 500 }].entries()) {
    ledger[i] = {
      seconds: creditFor(c, at(0), rates).seconds,
      seSeconds: seSecondsFor(c, RATES.se, RATES.values),
    };
  }
  assert.equal(outstandingCorrection(ledger), 0);
  assert.equal(seMatchesOpeningBand(rates), true);
});

test('the external timer over-grants once the band moves past it', () => {
  const c = { product: 't3' };
  assert.equal(seSecondsFor(c, RATES.se, RATES.values), 1000, 'what it gives, always');
  assert.equal(creditFor(c, at(2), rates).seconds, 500, 'what the card says now');
  assert.equal(outstandingCorrection({ a: { seconds: 500, seSeconds: 1000 } }), -500, 'subtract');
});

test('applying a correction closes the gap exactly', () => {
  const ledger = { a: { seconds: 500, seSeconds: 1000 } };
  assert.equal(outstandingCorrection(ledger), -500);
  const closed = { ...ledger, fix: { kind: 'correction', seconds: 0, seSeconds: -500 } };
  assert.equal(outstandingCorrection(closed), 0);
});

test('money the external timer never saw is owed in full', () => {
  assert.equal(outstandingCorrection({ a: { seconds: 777, seSeconds: 0 } }), 777);
});

test('per-field external config is honoured when the fields disagree', () => {
  // t3 left on a different column from the rest.
  const se = { t1: 200, t2: 400, t3: 1500, bits100: 100, dollar: 100 };
  assert.equal(seSecondsFor({ product: 't1' }, se, RATES.values), 200);
  assert.equal(seSecondsFor({ product: 't3' }, se, RATES.values), 1500);
  assert.equal(seSecondsFor({ product: 't3', count: 4 }, se, RATES.values), 6000);
  assert.equal(seSecondsFor({ product: 'bits', bits: 500 }, se, RATES.values), 500);
  assert.equal(seSecondsFor({ product: 'dollars', dollars: 3 }, se, RATES.values), 300);
  assert.equal(seMatchesOpeningBand(ratesFrom({ rates: { ...RATES, se } })), null, 'no single rate to compare');
});

test('an unset per-field value falls back to the flat rate', () => {
  const se = { t1: 200, perUnit: 100 };
  assert.equal(seSecondsFor({ product: 't3' }, se, RATES.values), 1000);
});

test('a missing external config owes nothing rather than inventing a number', () => {
  assert.equal(seSecondsFor({ product: 't3' }, null, RATES.values), 0);
  assert.equal(describeSe(null), 'not configured');
});

test('the band timeline marks which band is live and projects the rest', () => {
  const rows = bandTimeline(baseState(), at(3));
  assert.deepEqual(rows.map((r) => r.band), ['alpha', 'beta', 'gamma']);
  assert.equal(rows[1].at, at(2));
  assert.equal(rows[1].active, true);
  assert.equal(rows[0].past, true);
  assert.equal(rows[2].projected, true);
  assert.equal(rows[2].untilHours, null, 'terminal');
});

test('a pause pushes every band mark later on the wall clock', () => {
  assert.equal(bandTimeline(baseState(), at(1))[1].at, at(2));
  assert.equal(bandTimeline(baseState({ pausedMs: at(2) }), at(1))[1].at, at(4));
});

test('the breakdown localises where the time came from and stays signed', () => {
  const rows = ledgerBreakdown({
    a: { kind: 'sub', seconds: 200 },
    b: { kind: 'sub', seconds: 100 },
    c: { kind: 'bits', seconds: 700 },
    d: { kind: 'adjust', seconds: -300 },
  });
  assert.deepEqual(rows.map((r) => r.kind), ['bits', 'sub', 'adjust'], 'largest first');
  assert.equal(rows.find((r) => r.kind === 'sub').count, 2);
  assert.equal(rows.find((r) => r.kind === 'sub').seconds, 300);
  assert.equal(rows.find((r) => r.kind === 'adjust').seconds, -300);
});

// ── Operator input ──────────────────────────────────────────────────────────

test('durations parse as SECONDS by default, unlike !timer', () => {
  assert.equal(parseSeconds('300'), 300, 'a bare number is seconds here');
  assert.equal(parseSeconds('5m'), 300);
  assert.equal(parseSeconds('90s'), 90);
  assert.equal(parseSeconds('1h30m'), 5400);
  assert.equal(parseSeconds('-10m'), -600);
  assert.equal(parseSeconds('+2h'), 7200);
});

test('anything that is not a duration is rejected rather than guessed at', () => {
  for (const bad of ['', '  ', 'abc', '5x', '5m30', 'm', '1h30', null, undefined]) {
    assert.equal(parseSeconds(bad), null, `rejects ${JSON.stringify(bad)}`);
  }
});

test('a malformed stored schedule yields no band rather than a wrong one', () => {
  assert.deepEqual(normalizeSchedule([{ fromHours: 'x', band: 'nope' }], RATES.bands), []);
  assert.equal(bandFor(at(50), []), null);
  assert.equal(ratesFrom({ rates: { values: RATES.values, bands: RATES.bands, schedule: null } }).schedule.length, 0);
});

test('a schedule naming an unknown band is dropped, not priced at zero', () => {
  const s = normalizeSchedule([{ fromHours: 0, band: 'alpha' }, { fromHours: 3, band: 'ghost' }], RATES.bands);
  assert.deepEqual(s.map((e) => e.band), ['alpha']);
});

test('RTDB numeric-keyed schedule objects are accepted', () => {
  const stored = { 0: { fromHours: 0, band: 'alpha' }, 1: { fromHours: 5, band: 'gamma' } };
  const s = normalizeSchedule(stored, RATES.bands);
  assert.equal(bandFor(at(1), s), 'alpha');
  assert.equal(bandFor(at(6), s), 'gamma');
});

test('durations format for a glance on stream', () => {
  assert.equal(formatDuration(0), '0s');
  assert.equal(formatDuration(45_000), '45s');
  assert.equal(formatDuration(605_000), '10m 05s');
  assert.equal(formatDuration(4 * HOUR + 7 * 60_000 + 12_000), '4h 07m 12s');
  assert.equal(formatDuration(-5), '0s');
});
