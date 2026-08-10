// Mod-timer countdown (`!timer`). Ticks once a second against the in-memory
// config mirror — no RTDB traffic until something actually fires — and does two
// things: announce the heads-up marks as the clock CROSSES them, and call
// "time's up" when it runs out (clearing config/timer so the state is gone once
// it's been announced).
//
// "Crossing" is tracked in memory rather than persisted: the first tick that
// sees a given timer only records where it stands, so a bot restart mid-timer
// resumes the countdown WITHOUT re-announcing marks it already passed. What a
// restart must not lose is the deadline itself, and that lives in RTDB.
//
// Not gated on live status: a mod setting a pre-stream countdown is the point.
import { getTimer } from '../db/configStore.js';
import { clearTimer, remainingMs, formatDuration } from '../db/timer.js';
import { config } from '../config.js';

/**
 * @param {{ send: { say: (t: string) => Promise<void> }, logger: any }} deps
 *   `send` is the mute-aware wrapper — a muted bot stays quiet, and the timer
 *   still expires and clears on schedule.
 * @returns {() => void} stop function
 */
export function startTimerScheduler({ send, logger }) {
  // Marks are checked longest-first so a single slow tick can only fire the
  // nearest one that matters, not a burst of "5 minutes… 1 minute" together.
  const marks = [...config.timer.warnAtMs].sort((a, b) => b - a);
  let seen = { id: null, remaining: Infinity };
  let busy = false;

  async function tick() {
    if (busy) return; // an expiry write is in flight — don't double-fire it
    const timer = getTimer();
    if (!timer) { seen = { id: null, remaining: Infinity }; return; }

    // A paused timer neither counts down nor warns; remember where it froze so
    // resuming doesn't look like a crossing.
    if (timer.paused) { seen = { id: timer.setAt, remaining: remainingMs(timer) }; return; }

    const remaining = remainingMs(timer);
    if (seen.id !== timer.setAt) seen = { id: timer.setAt, remaining }; // first sight: no back-warning

    if (remaining <= 0) {
      busy = true;
      const overdue = Date.now() - (timer.endsAt || 0);
      try {
        await clearTimer();
        seen = { id: null, remaining: Infinity };
        if (overdue <= config.timer.graceMs) {
          send.say(`⏰ Time's up${timer.label ? ` — ${timer.label}` : ''}!`);
          logger.info?.('timer fired', { label: timer.label || null, by: timer.by || null });
        } else {
          // Expired while the bot was down; shouting about it now is just noise.
          logger.info?.('stale timer cleared without announcing', { label: timer.label || null, overdueMs: overdue });
        }
      } catch (err) {
        logger.error?.('timer expiry failed', { err: String(err) });
      } finally {
        busy = false;
      }
      return;
    }

    for (const mark of marks) {
      // Skip a mark the timer was never comfortably longer than — a 5-minute
      // timer shouldn't open with "5 minutes left".
      if (timer.durationMs < mark * 1.5) continue;
      if (remaining <= mark && seen.remaining > mark) {
        send.say(`⏳ ${timer.label ? `${timer.label}: ` : ''}${formatDuration(mark)} left.`);
        break;
      }
    }
    seen.remaining = remaining;
  }

  const interval = setInterval(() => { tick().catch(() => {}); }, config.timer.tickMs);
  interval.unref?.();
  return () => clearInterval(interval);
}
