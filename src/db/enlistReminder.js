// "You made a hero and never joined the season" — reminded ONCE, quietly.
//
// Deliberately NOT delivered the moment someone speaks: a bot that answers your
// first message of the night with a nag reads as lying in wait. This instead
// runs in the background, and only ever picks someone who has been chatting
// anyway, so the @-mention lands on a person who is actually present.
//
// Four rules keep it from becoming noise:
//   · a WEEK of grace after `!create` — nobody is chased for not raiding yet;
//   · ONE reminder per hero per season, tracked on the player record so a
//     restart or a re-scan can't repeat it;
//   · one hero at a time, spaced by `minGapMs`, so reminders never clump;
//   · live only — an @-mention into an empty offline channel is wasted.
//
// Enlistment lasts a whole season (spec §5.3), so there is nothing to remind
// anyone about a second time. This is a one-shot invitation, not a campaign.

import { database, PATHS } from './firebase.js';
import { config } from '../config.js';

/**
 * Choose at most one hero to invite. PURE — all state is passed in, so the
 * selection rules are testable without a database.
 *
 * @param {object} args
 * @param {Record<string, object>} args.players   players/ snapshot
 * @param {Record<string, object>} args.signups   this week's roster
 * @param {string} args.seasonId
 * @param {number} args.now
 * @param {object} [args.cfg]                     config.enlistReminder
 * @returns {{uid: string, player: object}|null}
 */
export function pickReminderTarget({ players, signups, seasonId, now, cfg = config.enlistReminder }) {
  const eligible = [];
  for (const [uid, p] of Object.entries(players || {})) {
    if (!p?.role) continue;                                  // no character to enlist
    if (signups?.[uid]) continue;                            // already raiding this season
    if (p.invitedSeason === seasonId) continue;              // already asked, this season
    if (!p.createdAt || now - p.createdAt < cfg.graceMs) continue;  // still new — leave them be
    if (!p.lastExpAt || now - p.lastExpAt > cfg.presentWithinMs) continue; // not around right now
    eligible.push({ uid, player: p });
  }
  if (!eligible.length) return null;
  // Oldest character first: someone who made a hero months ago and drifted off
  // is a better ask than someone who created one eight days ago.
  eligible.sort((a, b) => (a.player.createdAt || 0) - (b.player.createdAt || 0));
  return eligible[0];
}

/**
 * Find one hero worth inviting for the active raid, or null. Reads `players`
 * and the current roster; writes nothing.
 * @param {{seasonId: string, weekId: string}} pointer
 * @param {number} [now]
 */
export async function findLapsedHero(pointer, now = Date.now()) {
  if (!pointer?.seasonId || !pointer?.weekId) return null;
  const db = database();
  const [playerSnap, signupSnap] = await Promise.all([
    db.ref('players').get(),
    db.ref(PATHS.signups(pointer.seasonId, pointer.weekId)).get(),
  ]);
  return pickReminderTarget({
    players: playerSnap.val() || {},
    signups: signupSnap.val() || {},
    seasonId: pointer.seasonId,
    now,
  });
}

/**
 * Record that this hero has had their invitation for the season. Written BEFORE
 * the message goes out, so a send failure costs the invite rather than risking
 * the same person being asked on every subsequent pass.
 */
export async function markInvited(userId, seasonId) {
  await database().ref(`${PATHS.player(userId)}/invitedSeason`).set(seasonId);
}
