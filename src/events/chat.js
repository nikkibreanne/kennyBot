// Chat message handler (IMPLEMENTATION §G events/chat.js). Every message:
//   1. ignore the bot's own echoes / unknown users (idempotency, spec §6);
//   2. if it's a command, dispatch via the registry (per-user/per-command cd,
//      mod gate, sub-only gate);
//   3. run the passive tick — gated EXP + level-up — bounded by a per-user
//      in-memory cooldown (single instance, so memory is authoritative for
//      rate-limiting; lastExpAt is persisted for audit).
//
// NOTE (spec §5.8): chat during the week is MUSTER growth (EXP/levels/gear), not
// direct boss damage — the boss is fought in the scheduled raid-night battle.
// A lapsed sub keeps earning EXP on an existing character; only !create and loot
// claims require an active sub (handled by the per-command `subOnly` gate).
import { getCommand } from '../commands/registry.js';
import { getConfig, isChatMuted, getRaidPointer } from '../db/configStore.js';
import { config, shouldGrantExp } from '../config.js';
import { applyChatTick } from '../db/players.js';
import { hasNotice, takeNotice } from '../db/notices.js';
import { getSignup } from '../db/raid.js';

/**
 * @param {{
 *   sender: { say: (t: string) => Promise<void>, action: (t: string) => Promise<void> },
 *   channel: string,
 *   botUserId: string,
 *   logger: any,
 *   onActivity?: () => void,
 * }} deps
 * @returns {(channel: string, user: string, text: string, msg: any) => Promise<void>}
 */
export function createMessageHandler({ sender, channel, botUserId, logger, onActivity }) {
  const expCooldown = new Map(); // userId -> last grant ms
  const cmdCooldown = new Map(); // `${userId}:${cmd}` -> last run ms

  // Transport-only sender (src/twitch/sender.js); it catches its own send errors.
  const rawSay = (t) => sender.say(t);
  const rawAction = (t) => sender.action(t);

  async function dispatchCommand(user, args, name) {
    const def = getCommand(name);
    if (!def) {
      // Staying quiet is deliberate — the channel runs other bots, and answering
      // every stray `!` would be noise. But it must not be INVISIBLE: a viewer
      // typing `!accept` (instead of `!offer accept`) got no reply and left no
      // trace, which is indistinguishable from the bot being broken. Debug-level,
      // so it costs nothing until someone goes looking.
      logger.debug('unknown command ignored', { command: name, userId: user.id, login: user.login });
      return;
    }
    if (def.mod && !user.isMod && !user.isBroadcaster) {
      logger.debug('mod-only command ignored', { command: name, userId: user.id, login: user.login });
      return;
    }

    // Per-user command cooldown. Commands whose sub-verbs ANSWER a prompt the bot
    // posted (`!offer accept`, `!trade counter`) opt into keying it per sub-verb:
    // otherwise glancing at the offer — or fat-fingering it — burns the window and
    // the accept that follows is dropped, which reads in chat as a broken bot.
    // Per sub-verb still stops the thing the cooldown is for (the SAME command
    // repeated), and each verb keeps its own window.
    const sub = def.cooldownPerSubcommand ? `:${String(args[0] || '').toLowerCase()}` : '';
    const key = `${user.id}:${name}${sub}`;
    const now = Date.now();
    if (def.cooldownMs && now - (cmdCooldown.get(key) || 0) < def.cooldownMs) {
      // Never drop a command without a trace: "it did nothing and there was
      // nothing in the logs" is how this cost a stream's worth of debugging.
      logger.debug('command dropped by cooldown', { command: name, sub: args[0] || null, userId: user.id });
      return;
    }
    cmdCooldown.set(key, now);

    // Outbound mute (`!mute`): swallow every reply while muted EXCEPT for
    // commands flagged `bypassMute` — that's the !mute control itself, so mods
    // still get confirmation even while the bot is otherwise silent.
    const silent = isChatMuted() && !def.bypassMute;
    const ctx = {
      user,
      args,
      channel,
      reply: (t) => (silent ? undefined : rawSay(t)),
      action: (t) => (silent ? undefined : rawAction(t)),
      logger,
    };

    // Sub-only participation (broadcaster can't sub to herself → always allowed).
    if (def.subOnly && !user.isSubscriber && !user.isBroadcaster) {
      ctx.reply(`@${user.displayName} the raid game is subscriber-only — sub to ${channel} to play! 🌱`);
      return;
    }

    try {
      await def.run(ctx);
    } catch (err) {
      logger.error('command failed', { command: name, err: String(err?.stack || err) });
    }
  }

  // Say "you got this" to someone who ALREADY HAS IT. Raid rewards land in the
  // bag at payout with nobody required to be watching, so the line telling them
  // is held until they next speak — the one moment we know they're here. Said
  // PUBLICLY on purpose: other viewers seeing someone come back from a raid with
  // loot is the cheapest advertising the raid has. Nothing is claimed and nothing
  // is withheld; dropping a line loses the sentence, never the gear.
  //
  // Spaced globally so a post-raid rush can't burst a dozen lines into chat and
  // trip Twitch's rate limit; anyone skipped simply gets theirs on their next
  // message, which costs nothing because the notice stays parked until claimed.
  let lastNoticeAt = 0;
  async function deliverNotice(user) {
    if (!hasNotice(user.id) || isChatMuted()) return; // Map lookup — no I/O
    const now = Date.now();
    if (now - lastNoticeAt < config.notices.minGapMs) return;
    lastNoticeAt = now;

    let notice;
    try {
      notice = await takeNotice(user.id); // atomic — delivered exactly once
    } catch (err) {
      logger.error('notice claim failed', { userId: user.id, err: String(err) });
      return;
    }
    if (!notice) return; // another message beat us to saying it

    if (notice.kind === 'raidReward') {
      const rarity = notice.rarity ? `${notice.rarity} ` : '';
      const badge = notice.mvp ? ' 🏅 MVP of the fight!' : '';
      sender.say(
        `🎁 @${user.displayName} — your hero brought back a ${rarity}${notice.itemName} from ${notice.bossName}!${badge} ` +
        `It's in your !bag, ready to !equip.`,
      );
      logger.info('raid reward notice delivered', { userId: user.id, item: notice.itemId });
      return;
    }

    if (notice.kind === 'seasonInvite') {
      // Skip if they enlisted between the invite being queued and them speaking —
      // being told to join something you already joined reads as a broken bot.
      const p = getRaidPointer();
      if (p?.seasonId && p.seasonId === notice.seasonId) {
        const already = await getSignup(p.seasonId, p.weekId, user.id).catch(() => null);
        if (already) return;
      }
      sender.say(
        `🌱 @${user.displayName} — ${notice.seasonName} has begun and your hero isn't on the roster. ` +
        `One !muster enlists you for the WHOLE season; you don't need to be around when the battles run.`,
      );
      logger.info('season invite delivered', { userId: user.id, season: notice.seasonId });
    }
  }

  async function passiveTick(user) {
    const cfg = getConfig();
    if (!shouldGrantExp(cfg)) return; // live gate / expMode override (spec §5.1)

    const now = Date.now();
    if (now - (expCooldown.get(user.id) || 0) < config.exp.cooldownMs) return;
    expCooldown.set(user.id, now); // set BEFORE awaiting to block reentrant double-grant

    let tick;
    try {
      // Pass live sub status so the engagement boost reflects it (any active sub
      // ≥ tier 1; exact 2/3 still come from sub events).
      tick = await applyChatTick(user.id, { isSubscriber: user.isSubscriber });
    } catch (err) {
      logger.error('exp tick failed', { userId: user.id, err: String(err) });
      return;
    }
    if (!tick) return; // not a player → nothing accrues (non-subs never created one)
    if (tick.leveledUp && !isChatMuted()) {
      sender.say(`@${user.displayName} reached level ${tick.toLevel}! ⚔️`);
    }
  }

  return async function onMessage(_channel, username, text, msg) {
    try {
      const info = msg?.userInfo;
      const userId = info?.userId;
      if (!userId || userId === botUserId) return; // ignore self + unknown
      onActivity?.();

      const user = {
        id: String(userId),
        login: String(info.userName || username || '').toLowerCase(),
        displayName: info.displayName || info.userName || username,
        isMod: Boolean(info.isMod),
        isBroadcaster: Boolean(info.isBroadcaster),
        isSubscriber: Boolean(info.isSubscriber),
      };

      const trimmed = (text || '').trim();
      if (trimmed.startsWith('!')) {
        const parts = trimmed.slice(1).split(/\s+/);
        const name = parts[0].toLowerCase();
        await dispatchCommand(user, parts.slice(1), name);
      }

      await passiveTick(user);
      await deliverNotice(user);
    } catch (err) {
      logger.error('message handler error', { err: String(err?.stack || err) });
    }
  };
}
