// !season start <id> [name] (mod) — start a new 6-week raid tier (spec §5.6).
// Sets the season pointer + loot table and opens week 1's muster with the first
// boss scheduled for the next raid night. Gear reset / prestige carryover on
// season rollover is a later phase (§5.6) — flagged, not silently done.
import { setSeason } from '../../db/configStore.js';
import { setupRaidWeek, computeNextRaidNight } from '../../db/raid.js';
import { bossForWeek } from '../../content/bosses.js';
import { DEFAULT_LOOT_TABLE } from '../../content/items.js';
import { config } from '../../config.js';

export default {
  names: ['season'],
  mod: true,
  cooldownMs: 0,
  help: '!season start <id> [name] — start a new 6-week raid tier',
  async run({ args, reply }) {
    if ((args[0] || '').toLowerCase() !== 'start') {
      reply('Usage: !season start <id> [name]');
      return;
    }
    const id = (args[1] || '').trim();
    if (!/^[a-zA-Z0-9_-]{1,32}$/.test(id)) {
      reply('Usage: !season start <id> [name] — id is alphanumeric (e.g. t2).');
      return;
    }
    const name = args.slice(2).join(' ').trim() || `Tier ${id}`;
    await setSeason({ id, name, startsAt: Date.now(), weeks: config.raid.seasonWeeks, lootTable: DEFAULT_LOOT_TABLE });

    // Open week 1 immediately so muster can begin.
    const startsAt = computeNextRaidNight();
    const locksAt = startsAt - config.raid.lockLeadMs;
    const boss = bossForWeek(1);
    await setupRaidWeek({ seasonId: id, weekId: 'w1', boss, locksAt, startsAt });

    reply(`🌱 Season started: ${name} (${id}, ${config.raid.seasonWeeks} weeks). Week 1 boss: ${boss.name}. Players: !raid to muster!`);
  },
};
