// !kennycommands — point chat at the full command reference (like Nightbot's
// !commands). The website hosts the always-current list; this just links to it.
//
// NOTE: no command links the source repo. Chat replies point at okrafans.com and
// nothing else — the same rule that keeps the capture rig out of !clip's replies.
import { config } from '../config.js';

export default {
  names: ['kennycommands', 'kennybot', 'kcommands'],
  mod: false,
  cooldownMs: 10_000,
  help: '!kennycommands — the full list of everything kennyBot can do',
  async run({ reply }) {
    reply(`🤖 Everything I can do → ${config.siteUrl}/commands/`);
  },
};
