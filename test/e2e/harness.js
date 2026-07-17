// E2E harness: drive real chat commands end-to-end through the ACTUAL dispatcher
// (src/events/chat.js `createMessageHandler`) against the Firebase emulator, and
// capture what the bot would say. This exercises the whole path a live message
// takes — parsing, the mod/sub/mute gates, `def.run`, and the DB writes — not just
// a command's inner function. See commands.e2e.test.js for the scenarios.

import { createMessageHandler } from '../../src/events/chat.js';

/** A logger that swallows everything (the dispatcher logs warns/errors). */
export const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

export const CHANNEL = '#nikkibreanne';
export const BOT_USER_ID = 'bot-self';

/** Poll `pred` until it's truthy or `ms` elapses (the config mirror is async). */
export async function until(pred, ms = 2000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 15));
  }
  return pred();
}

/**
 * Build a chat user for a synthetic message. `id`/`login`/`name` identify them;
 * the boolean flags drive the mod / broadcaster / subscriber gates.
 */
export function user(id, opts = {}) {
  return {
    id: String(id),
    login: opts.login || String(id),
    name: opts.name || opts.login || String(id),
    mod: !!opts.mod,
    broadcaster: !!opts.broadcaster,
    sub: opts.sub !== false, // default: a subscriber (most game commands are sub-only)
  };
}

/**
 * A fake bot: `send(user, text)` runs one chat line through the real handler and
 * returns the combined reply text; `replies` holds the structured captures from
 * the LAST send. A FRESH handler is built per send so the per-user/per-command
 * cooldown map never carries between steps (multi-step scenarios — e.g. a trade's
 * open→counter→accept from the same user — would otherwise trip the 3s cooldown).
 */
export function makeBot({ channel = CHANNEL, botUserId = BOT_USER_ID } = {}) {
  const replies = [];
  const chat = {
    say: async (_ch, text) => { replies.push({ kind: 'say', text }); },
    action: async (_ch, text) => { replies.push({ kind: 'action', text }); },
  };

  async function send(u, text) {
    replies.length = 0;
    const handler = createMessageHandler({ chat, channel, botUserId, logger: silentLogger, onActivity() {} });
    const msg = {
      userInfo: {
        userId: u.id,
        userName: u.login,
        displayName: u.name,
        isMod: !!u.mod,
        isBroadcaster: !!u.broadcaster,
        isSubscriber: u.sub !== false,
      },
    };
    await handler(channel, u.login, text, msg);
    return replies.map((r) => r.text).join(' ⏎ ');
  }

  return { send, replies, chat };
}
