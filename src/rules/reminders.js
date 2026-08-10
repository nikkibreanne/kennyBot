// REMINDERS — the pure "is anything due right now?" engine. Like the rest of
// rules/*, it takes a clock and an RNG as arguments and touches no I/O, so every
// schedule below is testable without waiting for a real hour to pass (see
// test/rules/reminders.test.js, which runs offline in CI).
//
// Three schedule kinds cover what's wanted, and each is data — a reminder is a
// record in RTDB (config/reminders/<id>), never a hardcoded rule:
//
//   afterLive  once per live session, N ms after the stream went live
//              (e.g. "is Wallpaper Engine still running?" at +30 min)
//   daily      at wall-clock times in a named time zone, with an optional
//              heads-up lead (e.g. Ghosty eats at 08:00 + 17:00 PT, warned 20
//              min ahead). Skipped outright when the channel isn't live — a meal
//              ping three hours late is worse than none.
//   interval   every N ms of live time, ± jitter (e.g. hydration each hour).
//
// A reminder with a `channel` fires ONLY on that channel; `channel: null` fires
// anywhere. That's what makes "Nikki-specific" a property of the data instead of
// an `if (channel === 'nikkibreanne')` buried in the scheduler.
//
// Each evaluation returns the reminder's next STATE alongside anything due, so
// the caller persists exactly one thing: `{ due, state, changed }`. State is
// what makes firing idempotent across restarts — a bot that comes back up
// mid-stream must not re-announce what it already said.

const DAY_MS = 86_400_000;
const MAX_FIRED_KEYS = 8; // enough to dedupe a day of slots; bounded so it can't grow

export const KINDS = ['afterLive', 'daily', 'interval'];

const num = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
const mod = (n, m) => ((n % m) + m) % m;

/** Twitch channels appear as `nikkibreanne`, `#nikkibreanne`, or mixed case. */
export function normalizeChannel(name) {
  return String(name || '').trim().replace(/^#/, '').toLowerCase();
}

/** `HH:MM` → minutes past midnight, or null if it isn't a clock time. */
export function parseClock(text) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(text || '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** minutes past midnight → `HH:MM`. */
export function formatClock(minutes) {
  const t = mod(Math.round(minutes), 1440);
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

/**
 * Where the wall clock stands in `timeZone` at instant `now`. Returned as a
 * calendar date (for dedupe keys) plus minutes/seconds past local midnight, so
 * the daily comparison is a plain subtraction and needs no DST arithmetic: the
 * zone's own offset is already baked into what Intl reports.
 */
export function zonedNow(now, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(now));
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    minutes: Number(get('hour')) * 60 + Number(get('minute')),
    seconds: Number(get('second')),
  };
}

/** Wording for a heads-up when the reminder doesn't carry its own `leadText`. */
function defaultLeadText(reminder, leadMs) {
  const mins = Math.round(leadMs / 60_000);
  return `⏰ In ${mins} min — ${String(reminder.text || '').replace(/^[^\p{L}\p{N}]+/u, '')}`;
}

/**
 * Decide what (if anything) a reminder should say right now.
 * @param {object} reminder the stored record (config/reminders/<id>)
 * @param {{ now: number, live: boolean, liveSince: number|null, channel: string, config: object }} ctx
 * @param {() => number} rng injected for jitter (deterministic in tests)
 * @returns {{ due: {kind:'main'|'lead', text:string}|null, state: object, changed: boolean }}
 */
export function evaluateReminder(reminder, ctx, rng = Math.random) {
  const state = { ...(reminder?.state || {}) };
  const idle = { due: null, state: reminder?.state || {}, changed: false };
  if (!reminder || reminder.enabled === false) return idle;
  if (!KINDS.includes(reminder.kind)) return idle;
  if (reminder.channel && normalizeChannel(reminder.channel) !== normalizeChannel(ctx.channel)) return idle;
  if (reminder.liveOnly !== false && !ctx.live) return idle;
  if (!String(reminder.text || '').trim()) return idle; // nothing to say

  if (reminder.kind === 'afterLive') return dueAfterLive(reminder, ctx, state, idle);
  if (reminder.kind === 'daily') return dueDaily(reminder, ctx, state, idle);
  return dueInterval(reminder, ctx, state, idle, rng);
}

/** Once per live session, `afterMs` into the stream. */
function dueAfterLive(reminder, ctx, state, idle) {
  const since = ctx.liveSince;
  if (!since) return idle; // live but we don't know since when — wait for the stamp
  if (state.firedSession === since) return idle; // already handled this stream
  const elapsed = ctx.now - since;
  const afterMs = Math.max(0, num(reminder.afterMs, 30 * 60_000));
  if (elapsed < afterMs) return idle;

  state.firedSession = since;
  // Bot was down through the whole window (it booted hours into the stream):
  // announce nothing, but mark the session so it can't fire late on the next tick.
  const windowMs = Math.max(0, num(reminder.windowMs, num(ctx.config?.afterLiveWindowMs, 2 * 60 * 60_000)));
  if (elapsed > afterMs + windowMs) return { due: null, state, changed: true };

  state.lastFiredAt = ctx.now;
  return { due: { kind: 'main', text: reminder.text }, state, changed: true };
}

/**
 * At each `times` entry (and its lead) in the reminder's time zone. Fires only
 * inside a short grace after the slot, so a bot that boots at noon never shouts
 * about the 8am one; a slot missed while offline is simply skipped.
 */
function dueDaily(reminder, ctx, state, idle) {
  const timeZone = reminder.timeZone || ctx.config?.defaultTimeZone || 'America/Los_Angeles';
  const graceMs = Math.max(0, num(reminder.graceMs, num(ctx.config?.dailyGraceMs, 5 * 60_000)));
  const leadMs = Math.max(0, num(reminder.leadMs, 0));
  const times = Array.isArray(reminder.times) ? reminder.times : [];
  const fired = Array.isArray(state.firedKeys) ? state.firedKeys : [];

  const { date, minutes, seconds } = zonedNow(ctx.now, timeZone);
  const nowMs = minutes * 60_000 + seconds * 1000;

  for (const time of times) {
    const target = parseClock(time);
    if (target == null) continue;
    const slots = [{ at: target * 60_000, kind: 'main', text: reminder.text }];
    if (leadMs > 0) {
      // A lead can land before local midnight (e.g. 00:10 warned 20 min ahead);
      // wrapping keeps it on the calendar day it actually happens, which is also
      // the day its dedupe key belongs to.
      slots.push({
        at: mod(target * 60_000 - leadMs, DAY_MS),
        kind: 'lead',
        text: reminder.leadText || defaultLeadText(reminder, leadMs),
      });
    }
    for (const slot of slots) {
      const sinceSlot = nowMs - slot.at;
      if (sinceSlot < 0 || sinceSlot > graceMs) continue;
      const key = `${date}|${time}|${slot.kind}`;
      if (fired.includes(key)) continue;
      state.firedKeys = [...fired, key].slice(-MAX_FIRED_KEYS);
      state.lastFiredAt = ctx.now;
      return { due: { kind: slot.kind, text: slot.text }, state, changed: true };
    }
  }
  return idle;
}

/** Every `everyMs` of LIVE time, ± `jitterMs`. */
function dueInterval(reminder, ctx, state, idle, rng) {
  const everyMs = Math.max(60_000, num(reminder.everyMs, 60 * 60_000));
  const jitterMs = Math.min(Math.max(0, num(reminder.jitterMs, 0)), Math.floor(everyMs / 2));
  const roll = () => ctx.now + everyMs + Math.round((rng() * 2 - 1) * jitterMs);

  if (!Number.isFinite(state.nextAt)) { // first live tick — start the cycle
    state.nextAt = roll();
    return { due: null, state, changed: true };
  }
  if (ctx.now < state.nextAt) return idle;

  const overdue = ctx.now - state.nextAt;
  state.nextAt = roll();
  // More than a full period late means the slot passed while the channel was
  // offline (or the bot was down). Pick the cycle back up, quietly.
  if (overdue > everyMs) return { due: null, state, changed: true };

  state.lastFiredAt = ctx.now;
  return { due: { kind: 'main', text: reminder.text }, state, changed: true };
}

/** One-line schedule summary for `!reminder` (pure, so it's covered by tests). */
export function describeSchedule(reminder) {
  const mins = (ms) => Math.round(num(ms, 0) / 60_000);
  if (reminder.kind === 'afterLive') return `${mins(reminder.afterMs)}m after going live`;
  if (reminder.kind === 'daily') {
    const times = (reminder.times || []).join(', ') || '(no times set)';
    const lead = num(reminder.leadMs, 0) > 0 ? ` +${mins(reminder.leadMs)}m heads-up` : '';
    return `daily ${times} ${shortZone(reminder.timeZone)}${lead}`;
  }
  if (reminder.kind === 'interval') {
    const jitter = num(reminder.jitterMs, 0) > 0 ? ` ±${mins(reminder.jitterMs)}m` : '';
    return `every ${mins(reminder.everyMs)}m${jitter}`;
  }
  return 'unscheduled';
}

/** `America/Los_Angeles` → `Los Angeles` — enough to tell zones apart in chat. */
function shortZone(timeZone) {
  return String(timeZone || '').split('/').pop().replace(/_/g, ' ') || 'local';
}
