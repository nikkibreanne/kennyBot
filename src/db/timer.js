// MOD TIMER (`!timer`) — ONE shared countdown a mod can set from chat ("brb 10",
// "raid starts in 5m"). Deliberately singular: a second `!timer 5m` replaces the
// first rather than growing a list nobody can address in chat.
//
// The record lives at config/timer and stores an ABSOLUTE `endsAt`, never a
// live setTimeout, so a restart resumes the same countdown instead of losing it
// (the rule the raid phases follow — IMPLEMENTATION §H.5). A paused timer drops
// `endsAt` and keeps a frozen `remainingMs`, which is restart-proof for free.
//
// Duration parsing/formatting below is PURE (no clock, no db) so it can be
// unit-tested offline — see test/rules/timer.test.js.

import { getTimer, setTimerState } from './configStore.js';
import { config } from '../config.js';

export { getTimer };

const UNIT_MS = {
  h: 3_600_000, hr: 3_600_000, hrs: 3_600_000, hour: 3_600_000, hours: 3_600_000,
  m: 60_000, min: 60_000, mins: 60_000, minute: 60_000, minutes: 60_000,
  s: 1_000, sec: 1_000, secs: 1_000, second: 1_000, seconds: 1_000,
};

// Longest-first alternation so `1min` reads as "min", never "m" + leftovers.
const UNITS = Object.keys(UNIT_MS).sort((a, b) => b.length - a.length).join('|');
const NUMBER = /^\d+(?:\.\d+)?$/;
const CLOCK = /^\d{1,3}(?::\d{2}){1,2}$/; // mm:ss or hh:mm:ss
const UNIT_RUN = new RegExp(`^(?:\\d+(?:\\.\\d+)?(?:${UNITS}))+$`);
const UNIT_PART = new RegExp(`(\\d+(?:\\.\\d+)?)(${UNITS})`, 'g');

/**
 * Parse ONE duration token to milliseconds, or null if it isn't one.
 * Accepts `10` (a bare number = MINUTES, the common chat case), `90s`, `45m`,
 * `2h`, run-ons like `1h30m`, and clock form `5:30` / `1:05:00`.
 */
export function parseDurationToken(token) {
  const t = String(token || '').trim().toLowerCase();
  if (!t) return null;

  if (CLOCK.test(t)) {
    const parts = t.split(':').map(Number);
    const [h, m, s] = parts.length === 3 ? parts : [0, parts[0], parts[1]];
    if (m > 59 || s > 59) return null; // 5:75 is a typo, not 6:15
    return ((h * 60 + m) * 60 + s) * 1000;
  }
  if (NUMBER.test(t)) return Math.round(parseFloat(t) * 60_000); // bare = minutes
  if (!UNIT_RUN.test(t)) return null; // reject "5x", "soon", "10m!" — no partial credit

  let ms = 0;
  for (const [, n, unit] of t.matchAll(UNIT_PART)) ms += parseFloat(n) * UNIT_MS[unit];
  return Math.round(ms);
}

/**
 * Take the leading duration off a token list, returning the total and the tokens
 * left over (the label). Consumes as many duration tokens as lead — so both
 * `1h30m Break` and `1h 30m Break` work — and also the spaced `10 min break`
 * form, where a bare number is followed by a lone unit word.
 * @returns {{ ms: number, rest: string[] } | null} null when it doesn't start with a duration
 */
export function takeDuration(tokens) {
  const list = Array.isArray(tokens) ? tokens : String(tokens || '').split(/\s+/);
  let ms = 0;
  let i = 0;
  while (i < list.length) {
    const tok = String(list[i] || '').toLowerCase();
    const nextUnit = UNIT_MS[String(list[i + 1] || '').toLowerCase()];
    if (NUMBER.test(tok) && nextUnit) { // "10 min" — number and unit split apart
      ms += Math.round(parseFloat(tok) * nextUnit);
      i += 2;
      continue;
    }
    const one = parseDurationToken(tok);
    if (one == null) break;
    ms += one;
    i += 1;
  }
  return i ? { ms, rest: list.slice(i) } : null;
}

/**
 * Parse a SIGNED adjustment like `+5`, `-90s`, `+1h30m` (bare number = minutes).
 * @returns {number | null} signed ms, or null if it isn't an adjustment
 */
export function parseAdjustment(tokens) {
  const list = Array.isArray(tokens) ? tokens : String(tokens || '').split(/\s+/);
  const first = String(list[0] || '');
  const sign = first.startsWith('-') ? -1 : first.startsWith('+') ? 1 : 0;
  if (!sign) return null;
  const taken = takeDuration([first.slice(1), ...list.slice(1)]);
  if (!taken || !taken.ms) return null;
  return sign * taken.ms;
}

/** Human countdown: `1h 05m`, `4m 12s`, `45s`. Rounds to the nearest second. */
export function formatDuration(ms) {
  const total = Math.max(0, Math.round(Number(ms) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return m ? `${h}h ${String(m).padStart(2, '0')}m` : `${h}h`;
  if (m) return s ? `${m}m ${String(s).padStart(2, '0')}s` : `${m}m`;
  return `${s}s`;
}

/**
 * Which heads-up marks a timer of this span should use, longest first.
 *
 * A mark only counts when the timer has `warnMinLeadMs` of runway before it, so
 * a 5-minute timer never opens with "5 minutes left" — but a 6-minute one does
 * warn at 5 minutes, a minute in. (This was a ratio once; because a ratio scales
 * with the mark it demanded a 7.5-minute timer for the 5-minute warning and
 * silently dropped it on anything shorter.)
 *
 * @param {number} spanMs time left when the timer was set or last adjusted
 * @returns {number[]} marks to announce, longest first
 */
export function eligibleWarnMarks(spanMs, cfg = config.timer) {
  const lead = Math.max(0, Number(cfg.warnMinLeadMs) || 0);
  return [...(cfg.warnAtMs || [])]
    .sort((a, b) => b - a)
    .filter((mark) => Number(spanMs) >= mark + lead);
}

/** Milliseconds left on a timer record (0 when expired/absent; frozen when paused). */
export function remainingMs(timer, now = Date.now()) {
  if (!timer) return 0;
  if (timer.paused) return Math.max(0, timer.remainingMs || 0);
  return Math.max(0, (timer.endsAt || 0) - now);
}

/** Trim + clamp a label; empty becomes null (an unlabeled timer is fine). */
export function cleanLabel(raw) {
  const text = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length > config.timer.maxLabelLen
    ? `${text.slice(0, config.timer.maxLabelLen - 1)}…`
    : text;
}

/** Build the stored record. `durationMs` is the span as of this set/adjust — the
 *  heads-up marks use it to skip warnings the timer was never long enough for. */
function record({ durationMs, label, by, setAt, now }) {
  return {
    setAt,
    label: label || null,
    by: by || null,
    durationMs,
    endsAt: now + durationMs,
    paused: false,
    remainingMs: null,
  };
}

/**
 * Start (or replace) the timer.
 * @returns {Promise<{ok:true,timer:object,replaced:object|null}|{ok:false,reason:'too-short'|'too-long'}>}
 */
export async function startTimer({ durationMs, label, by, now = Date.now() }) {
  const ms = Math.round(Number(durationMs) || 0);
  if (ms < config.timer.minMs) return { ok: false, reason: 'too-short' };
  if (ms > config.timer.maxMs) return { ok: false, reason: 'too-long' };
  const replaced = getTimer();
  const timer = record({ durationMs: ms, label: cleanLabel(label), by, setAt: now, now });
  await setTimerState(timer);
  return { ok: true, timer, replaced: replaced || null };
}

/**
 * Add (or subtract) time on the running/paused timer, keeping its identity so
 * the countdown isn't "restarted". Going to zero or below ENDS it: a running
 * timer is left due immediately (the scheduler announces it like any expiry), a
 * paused one is cleared outright since nothing is ticking to notice.
 * @returns {Promise<{ok:true,timer:object|null,remaining:number,ended:boolean}|{ok:false,reason:'none'|'too-long'}>}
 */
export async function addTime(deltaMs, now = Date.now()) {
  const cur = getTimer();
  if (!cur) return { ok: false, reason: 'none' };

  const next = remainingMs(cur, now) + Math.round(Number(deltaMs) || 0);
  if (next > config.timer.maxMs) return { ok: false, reason: 'too-long' };

  if (next <= 0) {
    if (cur.paused) { // nothing is counting down to fire it — clear it here
      await setTimerState(null);
      return { ok: true, timer: null, remaining: 0, ended: true };
    }
    const timer = { ...cur, endsAt: now, remainingMs: null, durationMs: 0 };
    await setTimerState(timer);
    return { ok: true, timer, remaining: 0, ended: true };
  }

  const timer = cur.paused
    ? { ...cur, remainingMs: next, durationMs: next }
    : { ...cur, endsAt: now + next, durationMs: next };
  await setTimerState(timer);
  return { ok: true, timer, remaining: next, ended: false };
}

/** Freeze the countdown where it stands. */
export async function pauseTimer(now = Date.now()) {
  const cur = getTimer();
  if (!cur) return { ok: false, reason: 'none' };
  if (cur.paused) return { ok: false, reason: 'already', remaining: remainingMs(cur, now) };
  const remaining = remainingMs(cur, now);
  const timer = { ...cur, paused: true, remainingMs: remaining, endsAt: null };
  await setTimerState(timer);
  return { ok: true, timer, remaining };
}

/** Un-freeze: the frozen remainder becomes a fresh deadline. */
export async function resumeTimer(now = Date.now()) {
  const cur = getTimer();
  if (!cur) return { ok: false, reason: 'none' };
  if (!cur.paused) return { ok: false, reason: 'already', remaining: remainingMs(cur, now) };
  const remaining = Math.max(0, cur.remainingMs || 0);
  const timer = { ...cur, paused: false, endsAt: now + remaining, remainingMs: null };
  await setTimerState(timer);
  return { ok: true, timer, remaining };
}

/** Dismiss the timer. Returns what was cleared (for the ack), or ok:false. */
export async function clearTimer(now = Date.now()) {
  const cur = getTimer();
  if (!cur) return { ok: false, reason: 'none' };
  await setTimerState(null);
  return { ok: true, timer: cur, remaining: remainingMs(cur, now) };
}
