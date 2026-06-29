// Chat message handler (IMPLEMENTATION §G events/chat.js). Every message:
//   1. ignore the bot's own echoes / unknown users (idempotency, spec §6);
//   2. if it's a command, dispatch via the registry (per-user/per-command cd,
//      mod gate, sub-only gate);
//   3. run the passive tick — gated EXP + pity level-up — bounded by a per-user
//      in-memory cooldown (single instance, so memory is authoritative for
//      rate-limiting; lastExpAt is persisted for audit).
//
// NOTE (spec §5.8): chat during the week is MUSTER growth (EXP/levels/gear), not
// direct boss damage — the boss is fought in the scheduled raid-night battle.
// A lapsed sub keeps earning EXP on an existing character; only !create and loot
// claims require an active sub (handled by the per-command `subOnly` gate).
import { getCommand } from '../commands/registry.js';
import { getConfig } from '../db/configStore.js';
import { config, shouldGrantExp } from '../config.js';
import { applyChatTick } from '../db/players.js';

/**
 * @param {{
 *   chat: { say: Function, action: Function },
 *   channel: string,
 *   botUserId: string,
 *   logger: any,
 *   onActivity?: () => void,
 * }} deps
 * @returns {(channel: string, user: string, text: string, msg: any) => Promise<void>}
 */
export function createMessageHandler({ chat, channel, botUserId, logger, onActivity }) {
  const expCooldown = new Map(); // userId -> last grant ms
  const cmdCooldown = new Map(); // `${userId}:${cmd}` -> last run ms

  async function dispatchCommand(ctx, name) {
    const def = getCommand(name);
    if (!def) return;
    if (def.mod && !ctx.user.isMod && !ctx.user.isBroadcaster) return; // silently ignore non-mods

    const key = `${ctx.user.id}:${name}`;
    const now = Date.now();
    if (def.cooldownMs && now - (cmdCooldown.get(key) || 0) < def.cooldownMs) return;
    cmdCooldown.set(key, now);

    // Sub-only participation (broadcaster can't sub to herself → always allowed).
    if (def.subOnly && !ctx.user.isSubscriber && !ctx.user.isBroadcaster) {
      ctx.reply(`@${ctx.user.displayName} the raid game is subscriber-only — sub to ${channel} to play! 🌱`);
      return;
    }

    try {
      await def.run(ctx);
    } catch (err) {
      logger.error('command failed', { command: name, err: String(err?.stack || err) });
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
      tick = await applyChatTick(user.id);
    } catch (err) {
      logger.error('exp tick failed', { userId: user.id, err: String(err) });
      return;
    }
    if (!tick) return; // not a player → nothing accrues (non-subs never created one)
    if (tick.leveledUp) {
      chat.say(channel, `@${user.displayName} reached level ${tick.toLevel}! ⚔️`).catch(() => {});
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
        const ctx = {
          user,
          args: parts.slice(1),
          channel,
          reply: (t) => chat.say(channel, t).catch((e) => logger.warn('say failed', { err: String(e) })),
          action: (t) => chat.action(channel, t).catch(() => {}),
          logger,
        };
        await dispatchCommand(ctx, name);
      }

      await passiveTick(user);
    } catch (err) {
      logger.error('message handler error', { err: String(err?.stack || err) });
    }
  };
}
