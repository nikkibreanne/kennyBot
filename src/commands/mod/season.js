// !season start <id> [name] (mod) — start a new 6-week raid tier (spec §5.6).
// Sets the season pointer + loot table and opens week 1's muster with the first
// boss scheduled for the next raid night. Gear reset / prestige carryover on
// season rollover is a later phase (§5.6) — flagged, not silently done.
import { setSeason, getSeason, getRaidPointer } from '../../db/configStore.js';
import { setupRaidWeek, computeNextRaidNight, weeksInSeasonDb } from '../../db/raid.js';
import { rolloverAllPlayers } from '../../db/players.js';
import { inviteToSeason } from '../../db/notices.js';
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
  // Week 1 starts with an empty roster, so invite every existing hero exactly
  // ONCE — said to each of them the next time they speak, never broadcast on a
  // timer (config.seasonInvite).
  if (config.seasonInvite.enabled) {
    const invited = await inviteToSeason(id, name);
    return { boss, invited };
  }
  return { boss, invited: 0 };
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
      // Refuse to reopen a season that already has weeks. `openSeason` writes
      // week 1 unconditionally, so re-running it on a live id overwrites that
      // week's boss AND replaces its raid node — destroying the roster and the
      // recorded result. Rolling to a NEW tier is `!season rollover`.
      const existing = await weeksInSeasonDb(id);
      if (existing > 0) {
        reply(
          `⚠️ Season "${id}" already exists with ${existing} week${existing === 1 ? '' : 's'} — ` +
          `starting it again would wipe week 1's boss and roster. Use !season rollover <newId> for the next tier.`,
        );
        return;
      }
      const { boss, invited } = await openSeason(id, name);
      reply(`🌱 Season started: ${name} (${id}, ${config.raid.seasonWeeks} weeks). Week 1 boss: ${boss.name}. Players: !muster to join!${invited ? ` (${invited} heroes will be invited as they chat)` : ''}`);
      return;
    }

    if (sub === 'rollover') {
      // Rolling over mid-battle would pay the finishing raid out of the new
      // season's table into bags the rollover just emptied. Make the operator
      // wait out the reveal (minutes), rather than silently corrupting a payout.
      const active = getRaidPointer();
      if (active && (active.phase === 'live' || active.phase === 'locked')) {
        reply(`⏳ A raid is ${active.phase} right now — wait for it to finish paying out, then roll over.`);
        return;
      }
      // New tier: RESET everyone's gear (fresh start, newcomers aren't behind),
      // KEEP level + renown, and grant prestige renown to the heroes who actually
      // raided the OUTGOING season (§5.6 awards it to veterans). Read that season
      // before openSeason() overwrites the pointer.
      if (!/^[a-zA-Z0-9_-]{1,32}$/.test(id)) {
        reply('Usage: !season rollover <id> [name]');
        return;
      }
      const outgoing = getSeason();
      const { reset, prestiged, granted, best } = await rolloverAllPlayers({ seasonId: outgoing?.id });
      const { boss, invited } = await openSeason(id, name);
      const from = outgoing?.name || outgoing?.id || 'the last season';
      const prestigeLine = prestiged
        ? `${prestiged} veteran${prestiged === 1 ? '' : 's'} of ${from} earned ${granted} prestige renown ` +
          `(+${config.raid.prestigePerRaid} per raid attended, best ${best})`
        : `no veterans of ${from} to reward`;
      reply(
        `🔄 Season rolled over to ${name} (${id}). ${reset} heroes' gear reset (levels & renown kept) · ` +
        `${prestigeLine}. Week 1: ${boss.name} — !muster to join!`,
      );
      return;
    }

    reply('Usage: !season start <id> [name] | !season rollover <id> [name]');
  },
};
