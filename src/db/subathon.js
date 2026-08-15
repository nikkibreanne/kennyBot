// SUBATHON persistence. Two rules shape everything here, both learned from
// production logs rather than guessed at:
//
//   1. EVERY CREDIT IS AN APPEND. `push().set()` on the ledger, never a
//      transaction and never a read-modify-write on a running total. The host's
//      network blips several times a day (production logs show `transaction at
//      … failed: disconnect`), and a transaction that fails mid-event is a
//      contribution nobody gets credited for. Plain writes buffer in the SDK and
//      flush on reconnect; transactions don't.
//
//   2. THE DEADLINE IS DERIVED FROM THE LEDGER (see src/rules/subathon.js), so
//      the bot and the operator's CLI can both write concurrently without either
//      clobbering the other's total.
//
// The ledger is append-only in spirit as well as mechanism: an undo appends a
// compensating negative entry rather than deleting anything, because the point
// of the log is to survive being reconciled against Twitch's numbers the next
// morning, and a deletion is exactly what makes that impossible.

import { database, PATHS } from './firebase.js';
import {
  ratesFrom, creditFor, seSecondsFor, outstandingCorrection,
  elapsedMs, remainingMs, endsAt, currentBand, ledgerSeconds, planToProduct,
} from '../rules/subathon.js';

/** Read the whole subathon node once (the CLI path — the bot uses the mirror). */
export async function readSubathon() {
  const snap = await database().ref(PATHS.subathon()).get();
  return snap.val() || null;
}

/**
 * Begin a subathon. `baseHours` is the starting clock and `rates` is the card it
 * runs on — both supplied by the operator, neither with a default in this repo.
 */
export async function startSubathon({ baseHours, rates, softCapHours = null, now = Date.now() } = {}) {
  if (!ratesFrom({ rates }).configured) {
    throw new Error('no rate card — supply one (see the private runbook); none ships in this repo');
  }
  const state = {
    active: true,
    startedAt: now,
    baseSeconds: Math.round(baseHours * 3600),
    paused: false,
    pausedAt: null,
    pausedMs: 0,
    softCapHours, // display only — nothing enforces it, she calls the end
    // The rate card, stored WITH the event so retuning it later can never
    // retroactively reprice a run that already happened. Supplied at start time
    // from a private file; no values ship in this repository.
    rates,
    ledger: null,
  };
  await database().ref(PATHS.subathon()).set(state);
  return state;
}

/** End it. Keeps the record (and the ledger) for reconciliation; stops the clock. */
export async function stopSubathon() {
  await database().ref(PATHS.subathon()).update({ active: false, endedAt: Date.now() });
}

/** Wipe the record entirely — for clearing a test run, not for ending an event. */
export async function clearSubathon() {
  await database().ref(PATHS.subathon()).remove();
}

/**
 * Freeze the clock. Both the countdown and the elapsed-uptime band hold still,
 * so a technical break costs neither time nor a price increase.
 */
export async function pauseSubathon(state, now = Date.now()) {
  if (!state?.active || state.paused) return state;
  await database().ref(PATHS.subathon()).update({ paused: true, pausedAt: now });
  return { ...state, paused: true, pausedAt: now };
}

export async function resumeSubathon(state, now = Date.now()) {
  if (!state?.active || !state.paused) return state;
  const pausedMs = Math.max(0, Number(state.pausedMs) || 0) + Math.max(0, now - (Number(state.pausedAt) || now));
  await database().ref(PATHS.subathon()).update({ paused: false, pausedAt: null, pausedMs });
  return { ...state, paused: false, pausedAt: null, pausedMs };
}

/**
 * Price a contribution at the band in force now and append it to the ledger.
 *
 * `contribution` is `{ product, count?, months?, bits?, dollars? }` where product
 * is one of the keys in PRODUCTS — see src/rules/subathon.js.
 *
 * @returns {{ id: string, seconds: number, band: string, worth: number }}
 */
export async function creditSubathon(state, contribution, meta = {}, now = Date.now()) {
  const rates = ratesFrom(state);
  const { seconds, band, worth, configured } = creditFor(contribution, elapsedMs(state, now), rates);
  if (!configured) throw new Error('subathon has no usable rate card — refusing to credit zero silently');
  // `seenBySe: false` is for money the external timer never saw — an
  // off-platform donation, say. Everything on Twitch it sees for itself.
  const seSeconds = meta.seenBySe === false ? 0 : seSecondsFor(contribution, rates.se, rates.values);
  return appendLedger({
    at: now,
    seconds,
    seSeconds,
    band,
    worth,
    kind: meta.kind || contribution.product,
    who: meta.who ?? null,
    note: meta.note ?? null,
    source: meta.source || 'chat',
    ...(contribution.count > 1 ? { count: contribution.count } : {}),
    ...(contribution.months > 1 ? { months: contribution.months } : {}),
    ...(contribution.bits ? { bits: contribution.bits } : {}),
  });
}

/**
 * Record that a correction was applied in the external timer — `seconds` is what
 * was typed into its add-time field (negative to subtract). kennyBot's own clock
 * is already right, so this moves only the external side of the comparison.
 */
export async function recordCorrection(seconds, { note = null, who = null } = {}, now = Date.now()) {
  return appendLedger({
    at: now,
    seconds: 0,
    seSeconds: Math.round(seconds),
    band: null,
    kind: 'correction',
    who,
    note,
    source: 'cli',
  });
}

/**
 * Force kennyBot's clock to a stated remaining time. For after a restart that
 * lost events, or a bug fixed mid-stream — the ledger is authoritative right up
 * until it demonstrably isn't, and then this is how you say so.
 *
 * The difference is applied to BOTH sides, so realigning the clock does not
 * silently invent a correction for her to apply externally.
 */
export async function alignSubathon(state, targetRemainingMs, { note = null } = {}, now = Date.now()) {
  const deltaSeconds = Math.round((targetRemainingMs - remainingMs(state, now)) / 1000);
  return appendLedger({
    at: now,
    seconds: deltaSeconds,
    seSeconds: deltaSeconds,
    band: null,
    kind: 'align',
    who: null,
    note,
    source: 'cli',
  });
}

/**
 * Add or remove raw seconds with no pricing — the manual path (a donation the
 * bot can't see, a correction, a bonus). Always carries a note: an unexplained
 * ±20 minutes in the ledger is worse than no ledger at all.
 */
export async function adjustSubathon(seconds, { who = null, note = null, source = 'manual', seenBySe = true } = {}, now = Date.now()) {
  const rounded = Math.round(seconds);
  return appendLedger({
    at: now,
    seconds: rounded,
    // A raw adjustment is normally typed into BOTH systems, so it creates no gap.
    // `seenBySe: false` says it went into kennyBot only, and should be reported
    // as still owed externally.
    seSeconds: seenBySe ? rounded : 0,
    band: null, // unpriced by definition
    kind: 'adjust',
    who,
    note,
    source,
  });
}

/**
 * Reverse one ledger entry by appending its negation. Nothing is deleted, so the
 * original mistake and its correction both stay visible the next morning.
 */
export async function undoLedgerEntry(state, id, { who = null } = {}, now = Date.now()) {
  const entry = state?.ledger?.[id];
  if (!entry) return null;
  if (entry.undoes) return null; // don't undo an undo — that's an add, spell it out
  const already = Object.values(state.ledger || {}).some((e) => e?.undoes === id);
  if (already) return null;
  return appendLedger({
    at: now,
    seconds: -Math.round(Number(entry.seconds) || 0),
    // Reverse BOTH sides: undoing a double-credit must not leave a phantom
    // correction owed for the half that was never real.
    seSeconds: -Math.round(Number(entry.seSeconds) || 0),
    band: null,
    kind: 'undo',
    undoes: id,
    who,
    note: `reversed ${entry.kind}${entry.who ? ` from ${entry.who}` : ''}`,
    source: 'manual',
  });
}

/** The single write everything above funnels through. Append-only, no transaction. */
async function appendLedger(entry) {
  const ref = database().ref(PATHS.subathonLedger()).push();
  await ref.set(entry);
  return { id: ref.key, ...entry };
}

/**
 * Everything a caller needs to render the clock, derived in one place so chat,
 * the overlay and the CLI can never disagree about what time it is.
 */
export function subathonStatus(state, now = Date.now()) {
  if (!state?.active) return { active: false };
  return {
    active: true,
    paused: Boolean(state.paused),
    startedAt: state.startedAt,
    endsAt: endsAt(state),
    remainingMs: remainingMs(state, now),
    elapsedMs: elapsedMs(state, now),
    band: currentBand(state, now),
    grantedSeconds: ledgerSeconds(state.ledger),
    baseSeconds: Number(state.baseSeconds) || 0,
    softCapHours: state.softCapHours ?? null,
    entries: Object.keys(state.ledger || {}).length,
    // The headline number: what to tell her to add in SE (negative = subtract).
    owedSeconds: outstandingCorrection(state.ledger),
    se: ratesFrom(state).se,
  };
}

export { planToProduct };
