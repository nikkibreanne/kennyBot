// tmi/twurple native events → game effects (spec §5.4, Phase 5 seed). Kept
// intentionally small for milestone 1: subs update the engagement tier so the
// rating engine reflects reality, and a raid-in / big cheer triggers a COMMUNAL
// drop (shared benefit — never a private pay-to-win advantage, spec §6). Deeper
// levers (per-sub EXP boosts, channel points via EventSub) are later phases.
import { setSubStatus } from '../db/players.js';
import { setDrop } from '../db/drops.js';
import { pickDrop } from '../rules/loot.js';
import { getItem, DEFAULT_LOOT_TABLE } from '../content/items.js';
import { getSeason, isChatMuted } from '../db/configStore.js';
import { config } from '../config.js';

/** Twitch sub plan → engagement tier (Prime counts as tier 1). */
function planToTier(plan) {
  switch (String(plan)) {
    case '3000': return 3;
    case '2000': return 2;
    case '1000':
    case 'Prime': return 1;
    default: return 1;
  }
}

function lootTable() {
  const s = getSeason();
  return s?.lootTable?.length ? s.lootTable : DEFAULT_LOOT_TABLE;
}

/**
 * Attach native chat-event listeners. Returns a cleanup function that removes
 * them (twurple listeners expose .unbind()).
 * @param {{ chat: import('@twurple/chat').ChatClient, channel: string, logger: any }} deps
 */
export function attachTwitchEvents({ chat, channel, logger }) {
  const listeners = [];
  // Outbound mute (`!mute`): these communal-drop announcements are suppressed
  // while muted, but the drop itself is still created so !grab keeps working.
  const say = (text) => { if (!isChatMuted()) chat.say(channel, text).catch(() => {}); };

  const onSubLike = (label) => async (_ch, _user, info, msg) => {
    const userId = msg?.userInfo?.userId;
    if (!userId) return;
    try {
      await setSubStatus(userId, { subTier: planToTier(info?.plan), subMonths: info?.months ?? undefined });
      logger.info(`${label} processed`, { userId, tier: planToTier(info?.plan) });
    } catch (err) {
      logger.error(`${label} handler failed`, { err: String(err) });
    }
  };

  // Attach a handler only if this twurple version exposes it — a missing method
  // should warn, never crash startup (API drift defense).
  const attach = (name, handler) => {
    if (typeof chat[name] === 'function') listeners.push(chat[name](handler));
    else logger.warn?.('chat event not available in this twurple version', { event: name });
  };

  attach('onSub', onSubLike('sub'));
  attach('onResub', onSubLike('resub'));

  // Raid-in: welcome the incoming community with a communal drop (spec §5.4 —
  // existing viewers benefit from new arrivals).
  attach('onRaid', async (_ch, _user, raidInfo) => {
    try {
      const itemId = pickDrop(lootTable(), getItem, Math.random, config);
      if (!itemId) return;
      const drop = await setDrop(itemId);
      if (drop.status === 'full') return;
      const lead = `Raid incoming (${raidInfo?.viewerCount ?? '?'})!`;
      const line =
        drop.status === 'open'
          ? `${lead} A ${drop.rarity} ${drop.name} dropped — !grab to enter the draw!`
          : `${lead} A ${drop.rarity} ${drop.name} is queued up — !grab when it opens!`;
      say(line);
    } catch (err) {
      logger.error('raid handler failed', { err: String(err) });
    }
  });

  // Cheers/bits are NOT a dedicated event in twurple — they ride on a chat
  // message (msg.bits). A big cheer pops a communal drop (shared benefit, never a
  // private advantage). This is a second onMessage listener alongside the main
  // game handler, which twurple supports.
  attach('onMessage', async (_ch, _user, _text, msg) => {
    try {
      const bits = msg?.bits || 0;
      if (bits < 100) return;
      const itemId = pickDrop(lootTable(), getItem, Math.random, config);
      if (!itemId) return;
      const drop = await setDrop(itemId);
      if (drop.status === 'full') return;
      const line =
        drop.status === 'open'
          ? `${bits} bits! A ${drop.rarity} ${drop.name} dropped — !grab to enter the draw!`
          : `${bits} bits! A ${drop.rarity} ${drop.name} is queued — !grab when it opens!`;
      say(line);
    } catch (err) {
      logger.error('cheer handler failed', { err: String(err) });
    }
  });

  return () => {
    for (const l of listeners) l?.unbind?.();
  };
}
