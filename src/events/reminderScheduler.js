// Reminder tick — walks every stored reminder against the pure evaluator
// (src/rules/reminders.js) and says whatever came due. All the scheduling
// judgement lives in that evaluator; this file only supplies the clock, the
// channel, and the writes.
//
// Two invariants worth keeping in mind when editing:
//   * state is persisted BEFORE the announcement, so a crash between the two
//     costs a reminder rather than repeating one forever;
//   * one reminder blowing up must not stop the others — each is independent.
import { getConfig, getLiveSince } from '../db/configStore.js';
import { listReminders, setReminderState } from '../db/reminders.js';
import { evaluateReminder } from '../rules/reminders.js';
import { config } from '../config.js';

/**
 * @param {{
 *   send: { say: (t: string) => Promise<void> },
 *   channel: string,
 *   logger: any,
 *   rng?: () => number,
 * }} deps
 *   `send` is the mute-aware wrapper — a muted bot stays quiet while schedules
 *   keep advancing, so unmuting doesn't unleash a backlog.
 * @returns {() => void} stop function
 */
export function startReminderScheduler({ send, channel, logger, rng = Math.random }) {
  let busy = false;

  async function tick() {
    if (busy) return; // a slow RTDB write must not overlap the next tick
    busy = true;
    try {
      const ctx = {
        now: Date.now(),
        live: Boolean(getConfig().live),
        liveSince: getLiveSince(),
        channel,
        config: config.reminders,
      };
      for (const reminder of listReminders()) {
        try {
          const { due, state, changed } = evaluateReminder(reminder, ctx, rng);
          if (changed) await setReminderState(reminder.id, state);
          if (due) {
            send.say(due.text);
            logger.info?.('reminder fired', { id: reminder.id, kind: due.kind });
          }
        } catch (err) {
          logger.error?.('reminder failed', { id: reminder?.id, err: String(err?.stack || err) });
        }
      }
    } finally {
      busy = false;
    }
  }

  const interval = setInterval(() => { tick().catch(() => {}); }, config.reminders.tickMs);
  interval.unref?.();
  return () => clearInterval(interval);
}
