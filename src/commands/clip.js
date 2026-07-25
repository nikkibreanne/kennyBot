// !clip — create a Twitch clip of the last ~30s of the live stream (Helix Create
// Clip). Open to everyone with a per-user cooldown; only works while live. The
// Twitch clip is capped at the stream resolution — a local high-res / 4K copy is a
// separate capture (obs-websocket replay buffer / post-hoc archive).
import { getConfig } from '../db/configStore.js';
import { createChannelClip, clipsReady } from '../twitch/clips.js';

export default {
  names: ['clip'],
  mod: false,
  cooldownMs: 60_000, // per-user: a viewer can clip at most once a minute
  help: '!clip — clip the last ~30s of the stream (posts a Twitch clip link)',
  async run({ user, reply, logger }) {
    if (!clipsReady()) {
      reply(`@${user.displayName} clipping isn't set up right now.`);
      return;
    }
    if (!getConfig().live) {
      reply(`@${user.displayName} I can only clip while the stream is live!`);
      return;
    }
    try {
      const { url } = await createChannelClip();
      reply(`@${user.displayName} 🎬 clipped it! ${url}`);
    } catch (err) {
      logger?.warn?.('clip failed', { userId: user.id, err: String(err) });
      reply(`@${user.displayName} couldn't make a clip just now — try again in a moment.`);
    }
  },
};
