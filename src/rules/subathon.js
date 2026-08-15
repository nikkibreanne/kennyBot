// SUBATHON — the pure clock-and-price engine. Like the rest of rules/*, it takes
// the clock as an argument and touches no I/O, so a day-long event is testable in
// milliseconds (see test/rules/subathon.test.js, which runs offline in CI).
//
// ─────────────────────────────────────────────────────────────────────────────
// NO RATES LIVE IN THIS REPOSITORY. THIS IS DELIBERATE — DO NOT ADD ANY.
//
// The repo is public. The payout figures, the per-band rates and the band
// thresholds are together enough to reconstruct the channel's revenue from
// publicly visible sub counts, and the streamer has asked that this stay
// private. So this module defines only the SHAPE of a rate card; the values are
// supplied at runtime from `config/subathon/rates` in RTDB, seeded from a
// gitignored file outside the repo.
//
// That means no defaults, no examples, and no illustrative arithmetic in
// comments or tests. Anything unconfigured prices at zero and says so, which is
// a loud, safe failure rather than a wrong number nobody questions.
// ─────────────────────────────────────────────────────────────────────────────
//
// The rate card is one number per band. Each product is worth some amount, each
// band grants some number of seconds per unit of that worth, and every price is
// the product of the two — so the card is a handful of numbers rather than a
// grid somebody has to keep internally consistent, and a new product prices
// itself with no new entry.
//
// BANDS ARE KEYED ON ELAPSED UPTIME, not on time banked. The band reflects how
// long she has been awake, not how big the pot is. Elapsed excludes paused time,
// so an outage never silently changes the price.
//
// THERE IS NO HARD CAP. The terminal band extends forever; where the event
// actually ends is her call on the night.

const HOUR_MS = 3_600_000;
const num = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback);

/** Product keys a rate card may price. Names only — never values. */
export const PRODUCTS = ['t1', 't2', 't3', 'bits', 'dollars'];

/** Used when nothing is configured: one unnamed band worth nothing. */
const EMPTY_RATES = { values: {}, bands: {}, schedule: [], se: null };

/**
 * Pull the rate card off a stored subathon record. Always returns the full
 * shape, so callers never branch on missing config — they check `configured`.
 */
export function ratesFrom(state) {
  const r = state?.rates;
  if (!r) return { ...EMPTY_RATES, configured: false };
  const values = r.values && typeof r.values === 'object' ? r.values : {};
  const bands = r.bands && typeof r.bands === 'object' ? r.bands : {};
  return {
    values,
    bands,
    schedule: normalizeSchedule(r.schedule, bands),
    se: r.se ?? null,
    configured: Object.keys(values).length > 0 && Object.keys(bands).length > 0,
  };
}

/** Twitch plan id → product key. Prime and tier 1 are paid identically. */
export function planToProduct(plan) {
  switch (String(plan)) {
    case '3000': return 't3';
    case '2000': return 't2';
    case '1000':
    case 'Prime':
    case 'prime': return 't1';
    default: return 't1'; // unknown plan: price it as the lowest tier rather than drop it
  }
}

/**
 * Ordered elapsed-hour thresholds → band name. The LAST entry is terminal: it
 * applies from its threshold to forever, which is what makes "past the target is
 * still the top band" fall out without needing a cap.
 *
 * RTDB stores arrays as numeric-keyed objects, so both shapes are accepted.
 */
export function normalizeSchedule(schedule, bands = {}) {
  const list = Array.isArray(schedule)
    ? schedule
    : schedule && typeof schedule === 'object' ? Object.values(schedule) : [];
  return list
    .map((e) => ({ fromHours: num(e?.fromHours, NaN), band: String(e?.band || '') }))
    .filter((e) => Number.isFinite(e.fromHours) && e.band && bands[e.band] != null)
    .sort((a, b) => a.fromHours - b.fromHours);
}

/**
 * Which band is in force after `elapsedMs` of uptime, or null if the schedule is
 * unusable. Never guesses — an unconfigured event must not quietly pick a price.
 */
export function bandFor(elapsedMs, schedule) {
  const entries = Array.isArray(schedule) ? schedule : [];
  if (!entries.length) return null;
  const hours = Math.max(0, num(elapsedMs, 0)) / HOUR_MS;
  let band = null;
  for (const entry of entries) {
    if (hours >= entry.fromHours) band = entry.band;
    else break;
  }
  return band ?? entries[0].band; // below the lowest threshold → the first band
}

/**
 * What one contribution is worth, in the rate card's own units.
 * `count` multiplies gift bundles; `months` multiplies multi-month gifts, since
 * those are that many separate payouts.
 */
export function worthOf(contribution, values = {}) {
  const product = String(contribution?.product || '');
  if (product === 'bits') return Math.max(0, num(contribution.bits, 0)) * num(values.bit, 0);
  if (product === 'dollars') return Math.max(0, num(contribution.dollars, 0)) * num(values.dollar, 0);
  const unit = num(values[product], NaN);
  if (!Number.isFinite(unit)) return 0;
  const count = Math.max(1, Math.floor(num(contribution?.count, 1)));
  const months = Math.max(1, Math.floor(num(contribution?.months, 1)));
  return unit * count * months;
}

/**
 * Price one contribution at the band in force RIGHT NOW.
 *
 * A contribution never splits across a boundary: whatever band is live when it
 * lands prices the whole thing. Splitting would be marginally fairer and much
 * harder to explain in chat or audit afterwards.
 *
 * @returns {{ seconds: number, band: string|null, worth: number, configured: boolean }}
 */
export function creditFor(contribution, elapsedMs, rates) {
  const r = rates?.configured != null ? rates : ratesFrom({ rates });
  const band = bandFor(elapsedMs, r.schedule);
  if (!band || !r.configured) return { seconds: 0, band: null, worth: 0, configured: false };
  const worth = worthOf(contribution, r.values);
  // Round rather than floor: unit values below 1 can land a hair under an exact
  // result in floating point.
  return {
    seconds: Math.round(worth * num(r.bands[band], 0)),
    band,
    worth: Math.round(worth * 100) / 100,
    configured: true,
  };
}

// ── Gift-bomb dedupe ────────────────────────────────────────────────────────
//
// A gift bundle arrives as ONE `onCommunitySub` carrying the count, followed by
// a separate `onSubGift` for every recipient. Credit both and every bundle pays
// double — the most common subathon-timer bug, and the one EventSub's `isGift`
// flag would have settled for us if a broadcaster token were available.
//
// So we count the bundle and swallow exactly that many individual gifts from the
// same gifter. A lone gift still pays, which is the case the naive "ignore all
// gift subs" fix gets wrong.
//
// State in, state out — no closure, so a test can assert on it directly.

const ANON_GIFTER = '__anon__';
/** Pending bundles expire so a stale count can't swallow a genuine gift later. */
export const GIFT_WINDOW_MS = 10 * 60_000;

export function gifterKey(gifter) {
  const s = String(gifter ?? '').trim().toLowerCase();
  return s || ANON_GIFTER;
}

/** Record a bundle; the next `count` individual gifts from them are its parts. */
export function noteGiftBomb(pending, gifter, count, now) {
  const key = gifterKey(gifter);
  const n = Math.max(0, Math.floor(num(count, 0)));
  if (!n) return pending;
  const prev = pending?.[key];
  // A second bundle before the first drained ADDS to it rather than replacing
  // it — a gifter can fire two back to back.
  const carry = prev && now - prev.at < GIFT_WINDOW_MS ? prev.count : 0;
  return { ...pending, [key]: { count: carry + n, at: now } };
}

/**
 * Should this individual gift sub be credited?
 * @returns {{ credit: boolean, pending: object }}
 */
export function consumeGiftSub(pending, gifter, now) {
  const key = gifterKey(gifter);
  const entry = pending?.[key];
  if (!entry || entry.count <= 0 || now - entry.at >= GIFT_WINDOW_MS) {
    return { credit: true, pending: dropExpired(pending, now) };
  }
  const next = { ...pending, [key]: { count: entry.count - 1, at: entry.at } };
  if (next[key].count <= 0) delete next[key];
  return { credit: false, pending: next };
}

/** Keep the pending map from growing across a long event. */
function dropExpired(pending, now) {
  if (!pending) return {};
  const out = {};
  for (const [key, entry] of Object.entries(pending)) {
    if (now - entry.at < GIFT_WINDOW_MS) out[key] = entry;
  }
  return out;
}

// ── Clock ───────────────────────────────────────────────────────────────────
//
// THE DEADLINE IS DERIVED, NEVER STORED. It is
//
//     startedAt + (baseSeconds + Σ ledger.seconds) × 1000 + pausedMs
//
// which matters because two processes write here: the bot crediting events from
// chat, and the operator's CLI crediting by hand. If both did read-modify-write
// on a stored `endsAt`, concurrent writes would silently lose one. A transaction
// would fix that — except production logs show transactions are exactly what
// fails when the host's network blips, while plain writes buffer and flush on
// reconnect. So every credit is an APPEND, the deadline is recomputed from the
// sum, and there is nothing for two writers to clobber.

/** Total seconds granted so far. RTDB hands the ledger back as an object. */
export function ledgerSeconds(ledger) {
  if (!ledger) return 0;
  const rows = Array.isArray(ledger) ? ledger : Object.values(ledger);
  return rows.reduce((sum, e) => sum + num(e?.seconds, 0), 0);
}

// Presence, not truthiness: `startedAt` is an epoch and 0 is a legal one.
const startOf = (state) => num(state?.startedAt, NaN);

/**
 * The instant the clock is measured against. A paused subathon is frozen at the
 * moment it paused, which holds both "time left" and "elapsed uptime" still
 * without either being stored.
 */
function effectiveNow(state, now) {
  return state?.paused ? num(state.pausedAt, now) : now;
}

/** Absolute deadline, recomputed from the ledger. */
export function endsAt(state) {
  const start = startOf(state);
  if (!Number.isFinite(start)) return 0;
  const granted = (num(state.baseSeconds, 0) + ledgerSeconds(state.ledger)) * 1000;
  return start + granted + Math.max(0, num(state.pausedMs, 0));
}

/**
 * Uptime so far, EXCLUDING every paused stretch. This is what picks the band, so
 * an outage must not make the next hour more expensive.
 */
export function elapsedMs(state, now) {
  const start = startOf(state);
  if (!Number.isFinite(start)) return 0;
  return Math.max(0, effectiveNow(state, now) - start - Math.max(0, num(state.pausedMs, 0)));
}

/** Time left on the clock. Zero once it runs out — it never goes negative. */
export function remainingMs(state, now) {
  if (!state?.active) return 0;
  return Math.max(0, endsAt(state) - effectiveNow(state, now));
}

/** The band a contribution landing right now would be priced at. */
export function currentBand(state, now) {
  return bandFor(elapsedMs(state, now), ratesFrom(state).schedule);
}

/**
 * When each band starts, in wall-clock terms — the operator's cross-check.
 *
 * kennyBot advances bands automatically at fixed elapsed-uptime marks; the
 * external timer widget has to be switched by hand, and in this setup it isn't
 * switched at all. That gap is what the correction ledger measures, and this is
 * where the operator sees it coming.
 *
 * Future marks are PROJECTIONS — they assume no further pauses, because a pause
 * that hasn't happened yet can't be accounted for.
 */
export function bandTimeline(state, now) {
  const { schedule, bands } = ratesFrom(state);
  const start = startOf(state);
  if (!Number.isFinite(start) || !schedule.length) return [];
  const pausedTotal = Math.max(0, num(state?.pausedMs, 0));
  const elapsedHours = elapsedMs(state, now) / HOUR_MS;

  return schedule.map((entry, i) => {
    const next = schedule[i + 1] ?? null;
    return {
      band: entry.band,
      rate: num(bands[entry.band], 0),
      fromHours: entry.fromHours,
      untilHours: next ? next.fromHours : null, // null = terminal
      // Exact for marks already crossed (every pause so far is in pausedTotal);
      // a projection for the ones ahead.
      at: start + entry.fromHours * HOUR_MS + pausedTotal,
      active: elapsedHours >= entry.fromHours && (!next || elapsedHours < next.fromHours),
      past: Boolean(next) && elapsedHours >= next.fromHours,
      projected: elapsedHours < entry.fromHours,
    };
  });
}

// ── The correction ledger ───────────────────────────────────────────────────
//
// THIS IS THE POINT OF THE WHOLE FEATURE. The external timer grants time at ONE
// fixed rate; it does not step through the bands. So from the first band change
// onward it is wrong — and because bands only get more expensive, it is wrong in
// the generous direction.
//
// kennyBot therefore stores TWO numbers per contribution: what the rate card
// says (`seconds`) and what the external timer granted (`seSeconds`). The
// difference, summed, is the running amount to correct by — negative meaning
// subtract, which the widget's add-time field supports.
//
// Applying a correction is recorded as an entry with `seconds: 0` and
// `seSeconds` set to what was applied: it moves the external side without
// touching kennyBot's, which is what closes the gap.
//
// kennyBot never sees the external timer's clock and does not need to. The
// correction is a function of events BOTH systems observed, so both clocks —
// and the start time, and the base — cancel out entirely. The blind spot is the
// inverse: money the widget saw that chat did not surface, which is why
// donations are entered by hand.

/**
 * What the external timer granted for a contribution.
 *
 * `se` is EITHER a flat seconds-per-unit-of-worth number (the whole column, if
 * the widget was filled in consistently) OR a per-product map of the actual
 * seconds in its fields, keyed `t1`/`t2`/`t3`/`bits100`/`dollar`.
 *
 * The map exists because the widget has a separate box per product and nothing
 * forces those boxes to agree. Assuming they do would make every correction
 * wrong in a way nobody would notice until the numbers were compared at the end.
 */
export function seSecondsFor(contribution, se, values = {}) {
  if (se == null) return 0;
  if (typeof se === 'number') return Math.round(worthOf(contribution, values) * se);

  const flat = num(se.perUnit, NaN);
  const product = String(contribution?.product || '');
  const count = Math.max(1, Math.floor(num(contribution?.count, 1)));
  const months = Math.max(1, Math.floor(num(contribution?.months, 1)));

  if (product === 'bits') {
    const per100 = num(se.bits100, NaN);
    if (Number.isFinite(per100)) return Math.round((Math.max(0, num(contribution.bits, 0)) / 100) * per100);
  } else if (product === 'dollars') {
    const perDollar = num(se.dollar, NaN);
    if (Number.isFinite(perDollar)) return Math.round(Math.max(0, num(contribution.dollars, 0)) * perDollar);
  } else {
    const configured = num(se[product], NaN);
    if (Number.isFinite(configured)) return Math.round(configured * count * months);
  }
  if (!Number.isFinite(flat)) return 0;
  return Math.round(worthOf(contribution, values) * flat);
}

/**
 * How far the external timer is out, right now, in seconds.
 * Negative = it has granted too much and time should be SUBTRACTED there.
 */
export function outstandingCorrection(ledger) {
  const rows = !ledger ? [] : Array.isArray(ledger) ? ledger : Object.values(ledger);
  return rows.reduce((sum, e) => sum + num(e?.seconds, 0) - num(e?.seSeconds, 0), 0);
}

/** Whether the external timer's config matches the band the schedule opens on. */
export function seMatchesOpeningBand(rates) {
  const r = rates?.configured != null ? rates : ratesFrom({ rates });
  if (!r.configured || !r.schedule.length || r.se == null) return null;
  const opening = num(r.bands[r.schedule[0].band], NaN);
  const se = typeof r.se === 'number' ? r.se : num(r.se.perUnit, NaN);
  if (!Number.isFinite(opening) || !Number.isFinite(se)) return null;
  return opening === se;
}

/**
 * Ledger totals grouped by kind — where the number came from, so a disagreement
 * can be localised instead of just noticed.
 */
export function ledgerBreakdown(ledger) {
  const rows = !ledger ? [] : Array.isArray(ledger) ? ledger : Object.values(ledger);
  const by = new Map();
  for (const e of rows) {
    const kind = String(e?.kind || 'other');
    const acc = by.get(kind) || { kind, count: 0, seconds: 0, worth: 0 };
    acc.count += 1;
    acc.seconds += num(e?.seconds, 0);
    acc.worth += num(e?.worth, 0);
    by.set(kind, acc);
  }
  return [...by.values()]
    .map((a) => ({ ...a, worth: Math.round(a.worth * 100) / 100 }))
    .sort((a, b) => b.seconds - a.seconds);
}

/** `4h 07m 12s` — long-form, because this clock is read at a glance. */
export function formatDuration(ms) {
  const total = Math.max(0, Math.floor(num(ms, 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return `${h}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`;
  if (m) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

/**
 * Parse an operator duration into SECONDS: `300`, `5m`, `1h30m`, `-10m`. Reuses
 * nothing from src/db/timer.js on purpose — that one is minutes-by-default
 * (`!timer 10` means ten minutes), and silently reading `-10` as ten minutes off
 * this clock is not a mistake worth risking. Here a bare number is SECONDS and a
 * unit is required for anything longer.
 * @returns {number|null} seconds, or null if it isn't a duration
 */
export function parseSeconds(text) {
  const t = String(text ?? '').trim().toLowerCase();
  if (!t) return null;
  const sign = t.startsWith('-') ? -1 : 1;
  const body = t.replace(/^[+-]/, '');
  if (/^\d+$/.test(body)) return sign * Number(body);

  const parts = body.match(/(\d+(?:\.\d+)?)(h|m|s)/g);
  if (!parts || parts.join('') !== body) return null;
  const unit = { h: 3600, m: 60, s: 1 };
  let total = 0;
  for (const part of parts) {
    const [, n, u] = /(\d+(?:\.\d+)?)(h|m|s)/.exec(part);
    total += Number(n) * unit[u];
  }
  return sign * Math.round(total);
}

/** Human-readable summary of the external timer's assumed config. */
export function describeSe(se) {
  if (se == null) return 'not configured';
  if (typeof se === 'number') return `flat ${se}s per unit`;
  const parts = ['t1', 't2', 't3', 'bits100', 'dollar']
    .filter((k) => Number.isFinite(Number(se[k])))
    .map((k) => `${k}=${se[k]}s`);
  return parts.length ? parts.join('  ') : `flat ${num(se.perUnit, 0)}s per unit`;
}
