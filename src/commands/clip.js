// !clip — grab the last ~30–60s of the stream.
//
// THREE independent outputs, each switched on or off by the live clip mode
// (`!clipmode`, stored in RTDB):
//   horizontal — OBS's main replay buffer → 16:9 file at full recording quality
//   vertical   — Aitum's Backtrack output → 9:16 file, framed for portrait
//   twitch     — Helix Create Clip        → a public clip link in chat
//
// The default is horizontal+vertical and no Twitch, because a Twitch clip is capped
// at the STREAM resolution (≤1080p here) while the local recording is whatever the
// camera actually shot — the high-quality copy is the point of the command.
import { getConfig, parseClipMode, clipTargets, CLIP_MODES } from '../db/configStore.js';
import { config as gameConfig } from '../config.js';
import { createChannelClip, clipsReady } from '../twitch/clips.js';
import { triggerCapture, captureReady, verticalReady } from '../integrations/capture.js';

export { CLIP_MODES };

/**
 * The mode in force right now — RTDB `config/clipMode`, changed live by mods with
 * `!clipmode`. There is no environment variable: one source of truth, seeded once
 * from `config.clip.defaultMode`, exactly like the EXP gate.
 *
 * The fallback only covers the window before the config mirror is warm (early
 * boot, and unit tests that run without a database).
 */
export function activeClipMode() {
  return getConfig().clipMode ?? parseClipMode(gameConfig.clip.defaultMode);
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
  help: '!clip — capture the last ~60s of the stream',
  async run({ user, reply, logger }) {
    const want = clipTargets(activeClipMode());
    let twitch = want.twitch && clipsReady();
    // Vertical needs a configured output NAME (env) as well as being asked for.
    const vertical = want.vertical && verticalReady();
    const local = (want.horizontal || vertical) && captureReady();

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
    const capture = local
      ? triggerCapture(logger, Date.now(), { horizontal: want.horizontal, vertical })
      : null;

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
