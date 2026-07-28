// !clip — grab the last ~30–60s of the stream.
//
// TWO independent halves, selected by CLIP_MODE:
//   local  (default) — tell the streamer's OBS/Aitum to save its replay buffer at
//                      full recording quality. Nothing is posted to Twitch.
//   twitch           — Helix Create Clip only (the original behaviour).
//   both             — do each; the reply carries the Twitch link plus a note.
//
// Local is the default because a Twitch clip is capped at the STREAM resolution
// (≤1080p here) while the local recording is whatever the camera actually shot —
// the high-quality copy is the point of the command.
import { getConfig } from '../db/configStore.js';
import { createChannelClip, clipsReady } from '../twitch/clips.js';
import { triggerCapture, captureReady } from '../integrations/capture.js';

export const CLIP_MODES = ['local', 'twitch', 'both'];

/**
 * Resolve CLIP_MODE, defaulting to 'local'. An unrecognised value falls back to
 * the default rather than failing boot — index.js warns about it once at startup.
 */
export function resolveClipMode(raw = process.env.CLIP_MODE) {
  const v = String(raw ?? '').trim().toLowerCase();
  return CLIP_MODES.includes(v) ? v : 'local';
}

/**
 * Chat wording for a local-only capture. Deliberately never names the saved file
 * — that's the streamer's disk layout, not something to post in public chat.
 */
function localOnlyReply(res) {
  if (res?.ok) {
    return res.started
      ? "🎬 the recording buffer wasn't running — I've started it, so the next !clip will catch it."
      : '🎬 clipped it! Saved a full-quality local capture.';
  }
  if (res?.reason === 'rate-limited') {
    return `🎬 just captured one — try again in ${Math.ceil((res.retryInMs || 0) / 1000)}s.`;
  }
  return "couldn't reach the recording PC just now — try again in a moment.";
}

export default {
  names: ['clip'],
  mod: false,
  cooldownMs: 60_000, // per-user: a viewer can clip at most once a minute
  help: '!clip — clip the last ~30s of the stream',
  async run({ user, reply, logger }) {
    const mode = resolveClipMode();
    let twitch = mode !== 'local' && clipsReady();
    const local = mode !== 'twitch' && captureReady();

    if (!twitch && !local) {
      reply(
        mode === 'local'
          ? `@${user.displayName} local clip capture isn't set up right now.`
          : `@${user.displayName} clipping isn't set up right now.`,
      );
      return;
    }
    // Twitch's Create Clip only works while live. The local replay buffer doesn't
    // care — OBS can be recording with nothing streamed — so an offline !clip is
    // still worth doing locally; we just drop the Twitch half.
    if (twitch && !getConfig().live) {
      if (!local) {
        reply(`@${user.displayName} I can only clip while the stream is live!`);
        return;
      }
      twitch = false;
    }

    // Fire the local capture FIRST and in parallel: the replay buffer holds the
    // last N seconds, so the sooner it's told to save, the less the moment has
    // aged out of it. Its failure never affects the Twitch clip.
    const capture = local ? triggerCapture(logger) : null;

    if (!twitch) {
      reply(`@${user.displayName} ${localOnlyReply(await capture)}`);
      return;
    }

    try {
      const { url } = await createChannelClip();
      const res = await capture;
      // `started` means the replay buffer wasn't running and we just turned it on
      // — nothing was captured this time, but the next !clip will have content.
      const note = res?.ok
        ? res.started
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
