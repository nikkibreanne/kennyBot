// !season (mod) — run the season lifecycle (spec §5.6).
//
// `!season next` is the one to use: it works out the tier and the name itself.
// Both were already in the code — the tier is just the current one plus one, and
// the name is in SEASON_THEMES — so making the operator retype
// `!season rollover t2 The Sweltering Patch` was asking them to memorise data the
// bot already has, with a typo silently creating a season called "Tier t2".
//
// `start` and `rollover` remain for the off-script cases (a custom tier id or
// name, or re-running a tier); `next` is the everyday path.
import { setSeason, getSeason, getRaidPointer } from '../../db/configStore.js';
import { setupRaidWeek, computeNextRaidNight, weeksInSeasonDb } from '../../db/raid.js';
import { rolloverAllPlayers } from '../../db/players.js';
import { seasonBoss, SEASON_THEMES, SEASON_COUNT } from '../../content/bosses.js';
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
  // Week 1 starts empty. Heroes who don't re-enlist are invited later, one at a
  // time, by the background pass in src/db/enlistReminder.js — never all at once
  // and never the instant they speak.
  return { boss, invited: 0 };
}

/**
 * What `!season next` would do, derived from the current season. Pure enough to
 * test: the tier is the current one + 1 (or 1 from a cold start) and the name
 * comes from the authored SEASON_THEMES rather than from the operator's memory.
 * @param {{id?: string, tier?: number, name?: string}|null} current
 * @returns {{ok: true, id: string, name: string, tier: number, rollover: boolean}
 *          |{ok: false, reason: string, tier: number}}
 */
export function nextSeasonPlan(current) {
  const tier = (current?.tier || 0) + 1;
  if (tier > SEASON_COUNT) return { ok: false, reason: 'no-more-content', tier };
  const theme = SEASON_THEMES[tier - 1];
  return {
    ok: true,
    id: `t${tier}`,
    name: theme?.title || `Tier ${tier}`,
    tier,
    rollover: Boolean(current?.id), // nothing to roll over from on a cold start
  };
}

export default {
  names: ['season'],
  mod: true,
  cooldownMs: 0,
  help: '!season next — advance to the next tier (works out the id + name) | !season start <id> [name] | !season rollover <id> [name]',
  async run({ args, reply }) {
    const sub = (args[0] || '').toLowerCase();
    let id = (args[1] || '').trim();
    let name = args.slice(2).join(' ').trim() || `Tier ${id}`;

    // `!season next` resolves the tier and name, then runs the same path the
    // explicit commands do — so there is one implementation, not two.
    let planned = null;
    if (sub === 'next') {
      const current = getSeason();
      planned = nextSeasonPlan(current);
      if (!planned.ok) {
        reply(
          `🏁 There's no scripted tier ${planned.tier} — ${SEASON_COUNT} seasons of content exist. ` +
          `Use !season start <id> <name> to run a custom one.`,
        );
        return;
      }
      id = planned.id;
      name = planned.name;
    }

    if (sub === 'start' || (planned && !planned.rollover)) {
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
          `starting it again would wipe week 1's boss and roster. Use !season next to advance a tier.`,
        );
        return;
      }
      const { boss } = await openSeason(id, name);
      reply(`🌱 Season started: ${name} (${id}, ${config.raid.seasonWeeks} weeks). Week 1 boss: ${boss.name}. Players: !muster to join!`);
      return;
    }

    if (sub === 'rollover' || (planned && planned.rollover)) {
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
      const { boss } = await openSeason(id, name);
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

    reply('Usage: !season next (recommended — picks the tier + name for you) | !season start <id> [name] | !season rollover <id> [name]');
  },
};
