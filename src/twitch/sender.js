// Outbound chat sender — the single seam every bot-authored message flows
// through, so the transport is swappable without touching call sites.
//
//   mode 'irc'   → twurple ChatClient (chat:edit). The historical path.
//   mode 'helix' → Send Chat Message API via an APP access token
//                  (apiClient.chat.sendChatMessageAsApp). This is the ONLY way a
//                  bot earns the Twitch "Chat Bot" badge on its own messages
//                  (dev.twitch.tv/docs/chat) — a user-token / IRC send never gets
//                  it, which is why the badge needs this seam and not a setting.
//
// Requirements for helix mode (enforced by Twitch, NOT the library — twurple's
// own JSDoc on sendChatMessageAsApp says the scopes "can not be checked by the
// library"): the bot user must have granted `user:bot` + `user:write:chat`, and
// the broadcaster must have granted `channel:bot` OR the bot must be a moderator
// in the channel. The app token itself is minted from the client id/secret by the
// existing RefreshingAuthProvider — no new auth wiring, and no inbound surface, so
// the outbound-only invariant (§B) still holds.
//
// Reading always stays on the ChatClient; only sending switches here. Mute is
// applied by callers (the handler's per-command `bypassMute` lives there), so the
// sender is transport-only and never swallows a message on its own.

/**
 * @param {{
 *   mode?: 'irc' | 'helix',
 *   chat: { say: Function, action: Function },
 *   apiClient: import('@twurple/api').ApiClient,
 *   channel: string,
 *   broadcasterId: string,
 *   botUserId: string,
 *   logger?: any,
 * }} deps
 * @returns {{ say: (text: string) => Promise<void>, action: (text: string) => Promise<void>, mode: string }}
 */
export function createSender({ mode = 'irc', chat, apiClient, channel, broadcasterId, botUserId, logger = console }) {
  const helix = mode === 'helix';

  async function say(text) {
    try {
      if (helix) {
        await apiClient.chat.sendChatMessageAsApp(botUserId, broadcasterId, text);
      } else {
        await chat.say(channel, text);
      }
    } catch (err) {
      // Never throw at a send site — a failed line must not abort a command or a
      // draw tick. Warn so a misconfigured helix grant (401/403) is visible.
      logger.warn?.('chat send failed', { mode, err: String(err) });
    }
  }

  // The Send Chat Message API has no `/me` action, so in helix mode an action
  // degrades to a normal message — the content still lands (and carries the
  // badge); only the italic styling is lost. IRC keeps true actions.
  async function action(text) {
    if (helix) return say(text);
    try {
      await chat.action(channel, text);
    } catch {
      /* actions are cosmetic — never surface a failure */
    }
  }

  return { say, action, mode };
}
