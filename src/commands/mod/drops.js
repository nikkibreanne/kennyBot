// !drops on|off|every <min>|status (mod) — control the auto chat-drop scheduler
// (spec §5.2). Drops a rarity-weighted loot item into chat on a timer while live.
import { getDropScheduler, setDropScheduler } from '../../db/configStore.js';

export default {
  names: ['drops'],
  mod: true,
  cooldownMs: 0,
  help: '!drops on|off|every <min>|status — auto chat-drop scheduler',
  async run({ args, reply }) {
    const sub = (args[0] || 'status').toLowerCase();
    const cur = getDropScheduler() || {};

    if (sub === 'status') {
      reply(`Auto-drops: ${cur.enabled ? 'ON' : 'off'} · every ~${Math.round((cur.intervalSec || 900) / 60)} min (while live).`);
      return;
    }
    if (sub === 'on' || sub === 'off') {
      const next = await setDropScheduler({ enabled: sub === 'on' });
      reply(`Auto-drops ${next.enabled ? 'ON' : 'off'} (~${Math.round((next.intervalSec || 900) / 60)} min).`);
      return;
    }
    if (sub === 'every') {
      const min = parseInt(args[1], 10);
      if (!Number.isFinite(min) || min < 1 || min > 240) {
        reply('Usage: !drops every <minutes 1–240>');
        return;
      }
      const next = await setDropScheduler({ intervalSec: min * 60, enabled: true });
      reply(`Auto-drops ON, every ~${min} min.`);
      return;
    }
    reply('Usage: !drops on | off | every <min> | status');
  },
};
