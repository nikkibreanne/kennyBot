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
 * Chat wording for a local-only capture: a bare confirmation and nothing else.
 * Viewers get no signal about HOW the clip is made — no file path, no OBS, no
 * second machine, not even that a local recording exists. Every diagnostic
 * detail belongs in the log (see integrations/capture.js), never in public chat.
 */
function localOnlyReply(res) {
  if (res?.ok && !res.started) return '🎬 clipped it!';
  if (res?.reason === 'rate-limited') {
    return `🎬 just clipped that — try again in ${Math.ceil((res.retryInMs || 0) / 1000)}s.`;
  }
  // `started` means the buffer wasn't running, so nothing was actually saved.
  // To a viewer that's indistinguishable from any other miss — say the same thing.
  return "couldn't clip that one — try again in a moment.";
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

    // One wording for every unconfigured mode — which half is missing is an
    // operator concern (the boot log spells it out), not a thing to tell chat.
    if (!twitch && !local) {
      reply(`@${user.displayName} clipping isn't set up right now.`);
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
      await capture; // settle the local save so its outcome still reaches the log
      reply(`@${user.displayName} 🎬 clipped it! ${url}`);
    } catch (err) {
      logger?.warn?.('clip failed', { userId: user.id, err: String(err) });
      await capture; // let the local save settle so its result is still logged
      reply(`@${user.displayName} couldn't make a clip just now — try again in a moment.`);
    }
  },
};
