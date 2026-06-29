// !exp on|off|auto|status (mod) — control the EXP gate (spec §5.1, §11).
// The single most important test affordance: `!exp on` bypasses the live gate so
// the whole loop can be exercised offline (IMPLEMENTATION §H.1).
import { setExpMode, getConfig } from '../../db/configStore.js';

export default {
  names: ['exp'],
  mod: true,
  cooldownMs: 0,
  help: '!exp on|off|auto|status — mod-only EXP gate control',
  async run({ args, reply }) {
    const sub = (args[0] || 'status').toLowerCase();
    if (sub === 'status') {
      const cfg = getConfig();
      reply(`EXP mode: ${cfg.expMode} · stream live: ${cfg.live ? 'yes' : 'no'}`);
      return;
    }
    if (!['on', 'off', 'auto'].includes(sub)) {
      reply('Usage: !exp on | off | auto | status');
      return;
    }
    await setExpMode(sub);
    const note = sub === 'auto' ? ' (follows live status)' : '';
    reply(`EXP mode set to ${sub}${note}.`);
  },
};
