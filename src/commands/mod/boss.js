// !boss set <name> (mod) — schedule the next week's boss + muster (spec §5.8/§11).
// Roster locks `lockLeadMs` before raid night; the battle then plays out
// automatically (or force it early with !raidnight).
import { setupRaidWeek, nextWeekId, computeNextRaidNight } from '../../db/raid.js';
import { defaultBoss, seasonBoss, weeksInSeason, SEASON_COUNT } from '../../content/bosses.js';
import { getSeason, setSeason } from '../../db/configStore.js';
import { SEASON_LOOT } from '../../content/items.js';
import { config } from '../../config.js';

async function ensureSeason() {
  let season = getSeason();
  if (!season?.id) {
    season = { id: 't1', name: 'Tier 1', tier: 1, startsAt: Date.now(), weeks: config.raid.seasonWeeks, lootTable: SEASON_LOOT[0] };
    await setSeason(season);
  }
  return season;
}

async function schedule(seasonId, weekId, boss, reply, lead) {
  const startsAt = computeNextRaidNight();
  await setupRaidWeek({ seasonId, weekId, boss, locksAt: startsAt - config.raid.lockLeadMs, startsAt });
  const when = new Date(startsAt).toLocaleString();
  const rec = boss.recommended ? ` · recommended ~${boss.recommended} heroes` : '';
  reply(`📣 ${lead}: ${boss.name}${rec}. Raid night: ${when}. Players: !muster to join.`);
}

export default {
  names: ['boss'],
  mod: true,
  cooldownMs: 0,
  help: '!boss set <name> (custom) | !boss next (next scripted season boss)',
  async run({ args, reply }) {
    const sub = (args[0] || '').toLowerCase();

    if (sub === 'set') {
      const name = args.slice(1).join(' ').trim();
      if (!name) {
        reply('Usage: !boss set <name>');
        return;
      }
      const season = await ensureSeason();
      const weekId = await nextWeekId(season.id);
      await schedule(season.id, weekId, defaultBoss(name), reply, `Muster open (${season.id}/${weekId})`);
      return;
    }

    if (sub === 'next') {
      const season = getSeason();
      if (!season?.id) {
        reply('Start a season first: !season start <id>');
        return;
      }
      const weekId = await nextWeekId(season.id);
      const weekNum = parseInt(String(weekId).replace(/\D/g, ''), 10) || 1;

      // A season has a FIXED number of scripted bosses and ends on its finale.
      // `seasonBoss` clamps an out-of-range week to that finale, so without this
      // guard `!boss next` re-schedules the same finale every week forever — the
      // season silently never ends. Stop and point at the rollover instead.
      const tier = season.tier || 1;
      const total = weeksInSeason(tier);
      if (weekNum > total) {
        const next = tier + 1;
        const how = next <= SEASON_COUNT
          ? `Start the next tier: !season rollover t${next}`
          : 'No further scripted tier exists — use !season start <id> or !boss set <name>.';
        reply(`🏁 ${season.name || season.id} is complete — all ${total} bosses have been faced. ${how}`);
        return;
      }

      const lead = weekNum === total ? `Week ${weekNum} FINALE` : `Week ${weekNum}`;
      await schedule(season.id, weekId, seasonBoss(tier, weekNum), reply, lead);
      return;
    }

    reply('Usage: !boss set <name> | !boss next');
  },
};
