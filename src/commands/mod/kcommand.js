// !kcommand off|on <name> · !kcommand list (mod) — switch a command off for THIS
// channel without a deploy.
//
// The reason this exists: the same bot image runs on more than one channel, and a
// channel may already have another bot answering `!song` or `!duel`. Two bots
// answering one command is noise, so a mod turns ours off here. It is stored in
// the channel's own database (config/disabledCommands), so it is per-channel by
// construction — no channel names appear in code, and a dev/test channel keeps
// every command.
//
// A disabled command is ignored silently (see events/chat.js). Aliases follow
// their command: `!kcommand off np` switches off `!song`, `!nowplaying` and `!np`.
// The controls themselves (`alwaysOn`) can never be disabled, so a mod can never
// lock themselves out.
//
// Named `kcommand`, not `command`: StreamElements and Nightbot already own
// `!command` for managing THEIR custom commands, and this channel runs them.
import { setCommandDisabled, isCommandDisabled, listDisabledCommands } from '../../db/configStore.js';

export default {
  names: ['kcommand', 'kcmd'],
  mod: true,
  alwaysOn: true,
  cooldownMs: 0,
  help: '!kcommand off|on <name> · !kcommand list — mod-only: switch a command off for this channel',
  async run({ args, reply }) {
    const sub = (args[0] || 'list').toLowerCase();

    if (sub === 'list' || sub === 'status') {
      const off = listDisabledCommands();
      reply(off.length ? `🚫 Switched off here: ${off.map((n) => `!${n}`).join(' ')}` : '✅ Every command is on.');
      return;
    }

    if (sub !== 'off' && sub !== 'on') {
      reply('Usage: !kcommand off <name> | on <name> | list');
      return;
    }

    // Lazy: the registry imports THIS module, so a top-level import would be a cycle.
    const { getCommand } = await import('../registry.js');
    const typed = String(args[1] || '').toLowerCase().replace(/^!/, '');
    const def = typed ? getCommand(typed) : undefined;
    if (!def) {
      reply(typed ? `No command called !${typed}.` : `Usage: !kcommand ${sub} <name>`);
      return;
    }
    const name = def.names[0];
    if (def.alwaysOn) {
      reply(`!${name} can't be switched off — it's how you switch the others back on.`);
      return;
    }

    const off = sub === 'off';
    if (isCommandDisabled(name) === off) {
      reply(`!${name} is already ${off ? 'off' : 'on'}.`);
      return;
    }
    await setCommandDisabled(name, off);
    reply(off ? `🚫 !${name} is now off in this channel.` : `✅ !${name} is back on.`);
  },
};
