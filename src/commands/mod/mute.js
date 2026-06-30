// !mute on|off|status (mod) — silence the bot's OUTBOUND chat when things get
// noisy, without taking it offline. While muted the bot stays fully connected:
// it keeps listening, granting EXP, processing loot drops, advancing raid
// phases, and holding the single-instance lease — it just stops talking.
// Bare `!mute` toggles; the ack always states the resulting state.
//
// `bypassMute` lets THIS command's replies reach chat even while muted, so mods
// always get confirmation (otherwise unmuting would feel like shouting into the
// void). Every other command and announcement is gated by the mute flag.
import { setChatMuted, getConfig } from '../../db/configStore.js';

export default {
  names: ['mute', 'silence'],
  mod: true,
  bypassMute: true,
  cooldownMs: 0,
  help: '!mute on|off|status — mod-only: silence kennyBot’s chat output (it keeps listening + tracking)',
  async run({ args, reply }) {
    const sub = (args[0] || 'toggle').toLowerCase();
    const muted = Boolean(getConfig().chatMuted);

    if (sub === 'status') {
      reply(muted ? '🤫 Muted — still listening + tracking EXP, just not talking. !mute off to bring me back.' : '🔊 Live — chat output is on.');
      return;
    }

    let next;
    if (['on', 'mute'].includes(sub)) next = true;
    else if (['off', 'unmute'].includes(sub)) next = false;
    else if (sub === 'toggle') next = !muted;
    else {
      reply('Usage: !mute on | off | status');
      return;
    }

    await setChatMuted(next);
    reply(next
      ? '🤫 Muted — I’ll keep listening and tracking EXP, but I’ll stop talking. !mute off to bring me back.'
      : '🔊 Unmuted — back to chatting. 🌱');
  },
};
