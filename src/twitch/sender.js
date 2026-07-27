// Outbound chat sender — the single seam every bot-authored message flows
// through, so the transport is swappable without touching call sites.
//
//   'helix' → Send Chat Message API on an APP access token
//             (apiClient.chat.sendChatMessageAsApp). The ONLY way a bot earns the
//             Twitch "Chat Bot" badge on its own messages (dev.twitch.tv/docs/chat):
//             an IRC / user-token send never gets it.
//   'irc'   → twurple ChatClient (chat:edit). The historical path.
//   'auto'  → DEFAULT. Try helix; if Twitch rejects it as unauthorized, fall back
//             to IRC for the rest of the run and say exactly why.
//
// Why 'auto' is the default rather than plain 'helix': helix sending is not just
// "IRC plus a badge" — Twitch REFUSES the call unless the bot user granted
// `user:bot` + `user:write:chat` AND the broadcaster granted `channel:bot` (or the
// bot is a moderator there). Defaulting to bare 'helix' would make a bot with an
// older token or without mod status go completely SILENT. With 'auto' the bot
// always talks, and upgrades itself to the badge the moment the grants are in
// place. Set TWITCH_SEND_MODE=helix to force it (and surface failures loudly), or
// =irc to pin the old path.
//
// NOTE: the ChatClient is NOT removable — it is how the bot RECEIVES chat. Only
// the send direction is switchable, so keeping the IRC fallback costs nothing.
//
// Mute is applied by callers (the handler's per-command `bypassMute` lives there),
// so the sender is transport-only and never swallows a message on its own.

/** Twitch says "you may not send this" — a grant problem, not a transient blip. */
export function isAuthzFailure(err) {
  const status = err?.statusCode ?? err?.status ?? err?.response?.status;
  if (status === 401 || status === 403) return true;
  const text = String(err?.body ?? err?.message ?? err);
  return /\b40[13]\b/.test(text) || /unauthoriz|forbidden|missing scope|not permitted/i.test(text);
}

/**
 * @param {{
 *   mode?: 'auto' | 'irc' | 'helix',
 *   chat: { say: Function, action: Function },
 *   apiClient: import('@twurple/api').ApiClient,
 *   channel: string,
 *   broadcasterId: string,
 *   botUserId: string,
 *   logger?: any,
 * }} deps
 * @returns {{ say: Function, action: Function, mode: string, effectiveMode: () => string }}
 */
export function createSender({ mode = 'auto', chat, apiClient, channel, broadcasterId, botUserId, logger = console }) {
  // What we're actually using right now — 'helix' until Twitch refuses it.
  let current = mode === 'irc' ? 'irc' : 'helix';
  const allowFallback = mode === 'auto';

  async function sendIrc(text) {
    try {
      await chat.say(channel, text);
    } catch (err) {
      logger.warn?.('chat send failed', { mode: 'irc', err: String(err) });
    }
  }

  async function say(text) {
    if (current === 'irc') return sendIrc(text);
    try {
      await apiClient.chat.sendChatMessageAsApp(botUserId, broadcasterId, text);
    } catch (err) {
      if (allowFallback && isAuthzFailure(err)) {
        current = 'irc';
        logger.warn?.(
          'helix chat send refused — falling back to IRC for this run (so no Chat Bot badge). ' +
            'Fix: re-issue the bot token with user:bot + user:write:chat, and make the bot a ' +
            'moderator in the channel (or have the broadcaster grant channel:bot).',
          { err: String(err) },
        );
        return sendIrc(text); // the message still goes out
      }
      // Transient (rate limit, 5xx) or forced helix: report, don't downgrade.
      logger.warn?.('chat send failed', { mode: current, err: String(err) });
    }
    return undefined;
  }

  // The Send Chat Message API has no `/me` action, so in helix mode an action
  // degrades to a normal message — the content still lands (and carries the
  // badge); only the italic styling is lost. IRC keeps true actions.
  async function action(text) {
    if (current !== 'irc') return say(text);
    try {
      await chat.action(channel, text);
    } catch {
      /* actions are cosmetic — never surface a failure */
    }
    return undefined;
  }

  return { say, action, mode, effectiveMode: () => current };
}
