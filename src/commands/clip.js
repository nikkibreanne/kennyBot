// !clip — create a Twitch clip of the last ~30s of the live stream (Helix Create
// Clip). Open to everyone with a per-user cooldown; only works while live. The
// Twitch clip is capped at the stream resolution — a local high-res / 4K copy is a
// separate capture (obs-websocket replay buffer / post-hoc archive).
import { getConfig } from '../db/configStore.js';
import { createChannelClip, clipsReady } from '../twitch/clips.js';
import { triggerCapture, captureReady } from '../integrations/capture.js';

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
    // Fire the local high-quality capture FIRST and in parallel: the replay
    // buffer holds the last N seconds, so the sooner it's told to save, the less
    // the moment has aged out of the buffer. Its failure never affects the clip.
    const capture = captureReady() ? triggerCapture(logger) : null;

    try {
      const { url } = await createChannelClip();
      const local = await capture;
      // `started` means the replay buffer wasn't running and we just turned it on
      // — nothing was captured this time, but the next !clip will have content.
      const note = local?.ok
        ? local.started
          ? ' (local recording buffer just started — the next !clip will capture it too)'
          : ' (+ full-quality local capture saved)'
        : '';
      reply(`@${user.displayName} 🎬 clipped it! ${url}${note}`);
    } catch (err) {
      logger?.warn?.('clip failed', { userId: user.id, err: String(err) });
      await capture; // let the local save settle so its result is still logged
      reply(`@${user.displayName} couldn't make a clip just now — try again in a moment.`);
    }
  },
};
