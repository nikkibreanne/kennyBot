// !season start <id> [name] (mod) — start a new 6-week raid tier (spec §5.6).
// Sets the season pointer + loot table and opens week 1's muster with the first
// boss scheduled for the next raid night. Gear reset / prestige carryover on
// season rollover is a later phase (§5.6) — flagged, not silently done.
import { setSeason } from '../../db/configStore.js';
import { setupRaidWeek, computeNextRaidNight } from '../../db/raid.js';
import { rolloverAllPlayers } from '../../db/players.js';
import { seasonBoss } from '../../content/bosses.js';
import { SEASON_LOOT } from '../../content/items.js';
import { config } from '../../config.js';

/** Map a season id like "t2"/"s3" to a 1-based content tier (1–3). */
function tierFromId(id) {
  const m = String(id).match(/(\d+)/);
  const n = m ? parseInt(m[1], 10) : 1;
  return Math.max(1, Math.min(SEASON_LOOT.length, n));
}

async function openSeason(id, name) {
  const tier = tierFromId(id);
  await setSeason({ id, name, tier, startsAt: Date.now(), weeks: config.raid.seasonWeeks, lootTable: SEASON_LOOT[tier - 1] });
  const startsAt = computeNextRaidNight();
  const boss = seasonBoss(tier, 1);
  await setupRaidWeek({ seasonId: id, weekId: 'w1', boss, locksAt: startsAt - config.raid.lockLeadMs, startsAt });
  return boss;
}

export default {
  names: ['season'],
  mod: true,
  cooldownMs: 0,
  help: '!season start <id> [name] | !season rollover <id> [name]',
  async run({ args, reply }) {
    const sub = (args[0] || '').toLowerCase();
    const id = (args[1] || '').trim();
    const name = args.slice(2).join(' ').trim() || `Tier ${id}`;

    if (sub === 'start') {
      if (!/^[a-zA-Z0-9_-]{1,32}$/.test(id)) {
        reply('Usage: !season start <id> [name] — id is alphanumeric (e.g. t2).');
        return;
      }
      const boss = await openSeason(id, name);
      reply(`🌱 Season started: ${name} (${id}, ${config.raid.seasonWeeks} weeks). Week 1 boss: ${boss.name}. Players: !raid to muster!`);
      return;
    }

    if (sub === 'rollover') {
      // New tier: RESET everyone's gear (fresh start, newcomers aren't behind),
      // KEEP level + renown, and grant prestige renown for the season cleared (§5.6).
      if (!/^[a-zA-Z0-9_-]{1,32}$/.test(id)) {
        reply('Usage: !season rollover <id> [name]');
        return;
      }
      const count = await rolloverAllPlayers();
      const boss = await openSeason(id, name);
      reply(`🔄 Season rolled over to ${name} (${id}). ${count} heroes' gear reset — levels & veteran renown kept, prestige granted. Week 1: ${boss.name}.`);
      return;
    }

    reply('Usage: !season start <id> [name] | !season rollover <id> [name]');
  },
};
