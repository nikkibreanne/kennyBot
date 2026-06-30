// Auto chat-drop scheduler (spec §5.2). While the stream is live and the
// scheduler is enabled, drops a loot item into chat roughly every N minutes
// (mod-configurable via !drops / config/dropScheduler). The dropped item's
// rarity is rolled off the chat ladder, so rarer items appear far less often.
// Self-rescheduling timer — no long-lived state to lose on restart.
import { getDropScheduler, getConfig, getSeason } from '../db/configStore.js';
import { setDrop } from '../db/drops.js';
import { pickDrop } from '../rules/loot.js';
import { getItem, DEFAULT_LOOT_TABLE } from '../content/items.js';
import { config, shouldGrantExp } from '../config.js';

/**
 * @param {{ chat: { say: Function }, channel: string, logger: any }} deps
 * @returns {() => void} stop function
 */
export function startDropScheduler({ chat, channel, logger }) {
  let timer = null;
  let stopped = false;

  function nextDelayMs() {
    const sched = getDropScheduler() || {};
    const sec = Math.max(60, sched.intervalSec || config.loot.scheduler.intervalSec);
    const jitter = config.loot.scheduler.jitter || 0;
    const factor = 1 + (Math.random() * 2 - 1) * jitter; // ±jitter
    return Math.round(sec * 1000 * factor);
  }

  async function tick() {
    if (stopped) return;
    try {
      const sched = getDropScheduler() || {};
      // Drop only while enabled AND the gate is open (live, or expMode=on).
      if (sched.enabled && shouldGrantExp(getConfig())) {
        const lootTable = getSeason()?.lootTable?.length ? getSeason().lootTable : DEFAULT_LOOT_TABLE;
        const itemId = pickDrop(lootTable, getItem, Math.random, config); // chat ladder (rarity-weighted)
        if (itemId) {
          const drop = await setDrop(itemId);
          const secs = Math.round(config.loot.windowMs / 1000);
          chat.say(channel, `🎁 A ${drop.rarity} ${drop.name} dropped! Type !grab within ${secs}s to enter the draw — one winner!`).catch(() => {});
          logger.info?.('auto drop', { item: itemId, rarity: drop.rarity });
        }
      }
    } catch (err) {
      logger.error?.('drop scheduler tick failed', { err: String(err) });
    }
    schedule();
  }

  function schedule() {
    if (stopped) return;
    timer = setTimeout(tick, nextDelayMs());
    timer.unref?.();
  }

  schedule();
  return () => { stopped = true; if (timer) clearTimeout(timer); };
}
