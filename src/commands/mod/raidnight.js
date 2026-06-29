// !raidnight (mod) — force raid night NOW: lock the roster, simulate the battle,
// and reveal it immediately (IMPLEMENTATION §L.5). The fast path for testing a
// full raid in seconds and for running it live on stream.
import { getActiveRaid, forceRaidNight } from '../../db/raid.js';
import { config } from '../../config.js';

export default {
  names: ['raidnight'],
  mod: true,
  cooldownMs: 0,
  help: '!raidnight — lock the roster and run the battle now',
  async run({ args, reply }) {
    const active = await getActiveRaid();
    if (!active || !active.boss) {
      reply('No raid is scheduled — set one with !boss set <name> first.');
      return;
    }
    if (active.phase === 'live' || active.phase === 'done') {
      reply(`The battle already ran — watch it at ${config.siteUrl}/arena/`);
      return;
    }
    reply(`⚔️ RAID NIGHT! Locking the roster and summoning ${active.boss.name}…`);
    const combat = await forceRaidNight(active.seasonId, active.weekId);
    const outcome = combat?.result?.downed ? `💀 ${active.boss.name} is DOWNED!` : `🪦 the raid was wiped…`;
    reply(`${outcome} Watch it unfold at ${config.siteUrl}/arena/`);
  },
};
