// !boss set <name> (mod) — schedule the next week's boss + muster (spec §5.8/§11).
// Roster locks `lockLeadMs` before raid night; the battle then plays out
// automatically (or force it early with !raidnight).
import { setupRaidWeek, nextWeekId, computeNextRaidNight } from '../../db/raid.js';
import { defaultBoss } from '../../content/bosses.js';
import { getSeason, setSeason } from '../../db/configStore.js';
import { DEFAULT_LOOT_TABLE } from '../../content/items.js';
import { config } from '../../config.js';

async function ensureSeason() {
  let season = getSeason();
  if (!season?.id) {
    season = { id: 't1', name: 'Tier 1', startsAt: Date.now(), weeks: config.raid.seasonWeeks, lootTable: DEFAULT_LOOT_TABLE };
    await setSeason(season);
  }
  return season;
}

export default {
  names: ['boss'],
  mod: true,
  cooldownMs: 0,
  help: '!boss set <name> — schedule the next boss + open muster',
  async run({ args, reply }) {
    const sub = (args[0] || '').toLowerCase();
    if (sub !== 'set') {
      reply('Usage: !boss set <name>  (then players !raid to muster; !raidnight to fight now)');
      return;
    }
    const name = args.slice(1).join(' ').trim();
    if (!name) {
      reply('Usage: !boss set <name>');
      return;
    }
    const season = await ensureSeason();
    const weekId = await nextWeekId(season.id);
    const startsAt = computeNextRaidNight();
    const locksAt = startsAt - config.raid.lockLeadMs;
    await setupRaidWeek({ seasonId: season.id, weekId, boss: defaultBoss(name), locksAt, startsAt });

    const when = new Date(startsAt).toLocaleString();
    reply(`📣 Muster open for ${name} (${season.id}/${weekId}). Raid night: ${when}. Players: !raid to join.`);
  },
};
