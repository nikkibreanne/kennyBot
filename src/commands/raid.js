// !muster — muster command (spec §5.8). During the signup phase it ENLISTS your
// hero into this week's raid; otherwise it reports the current phase + your
// status and links to the site. Enlisting requires an ACTIVE sub (owner
// decision: joining a season's raid is subscriber-only, same as !create) — a
// lapsed sub keeps their hero and keeps earning EXP, but must re-sub to muster.
// Checking status/links stays open to everyone.
import { getActiveRaid, getSignup, enlist } from '../db/raid.js';
import { getPlayer } from '../db/players.js';
import { config } from '../config.js';

function whenHtmlSafe(ts) {
  if (!ts) return 'soon';
  const ms = ts - Date.now();
  if (ms <= 0) return 'now';
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export default {
  names: ['muster', 'raid'],
  mod: false,
  cooldownMs: 3_000,
  help: '!muster — sign up for this week’s raid / see status',
  async run({ user, reply }) {
    const active = await getActiveRaid();
    if (!active || !active.boss) {
      reply(`No raid is scheduled yet. Watch ${config.siteUrl} for raid night!`);
      return;
    }
    const { seasonId, weekId, phase, boss, pointer } = active;

    if (phase === 'live') {
      reply(`⚔️ ${boss.name}: the battle is happening NOW — watch it at ${config.siteUrl}/arena/`);
      return;
    }
    if (phase === 'done') {
      reply(`This week’s raid is over — see the replay + result at ${config.siteUrl}/arena/`);
      return;
    }
    if (phase === 'locked') {
      reply(`🔒 The roster is locked — ${boss.name} battle begins in ${whenHtmlSafe(pointer.startsAt)}. Watch at ${config.siteUrl}/arena/`);
      return;
    }

    // signup phase → enlist (active-sub gated, like !create)
    const player = await getPlayer(user.id);
    if (!player) {
      reply(`@${user.displayName} you need a hero first — !create <class> (subscribers).`);
      return;
    }
    if (!user.isSubscriber && !user.isBroadcaster) {
      reply(`@${user.displayName} mustering for the raid is subscriber-only — resub to join the fight! Your hero keeps its level + gear. 🌱`);
      return;
    }
    const already = await getSignup(seasonId, weekId, user.id);
    await enlist({ seasonId, weekId, userId: user.id, player });
    const when = whenHtmlSafe(pointer.startsAt);
    const rec = boss.recommended ? ` ${boss.name} wants ~${boss.recommended} heroes —` : '';
    reply(
      already
        ? `@${user.displayName} your ${player.class} is mustered (updated).${rec} raid night in ${when} → ${config.siteUrl}/raid/`
        : `@${user.displayName} ✅ mustered as ${player.class} (${player.role}, Lv ${player.level})!${rec} raid night in ${when} → ${config.siteUrl}/raid/`,
    );
  },
};
