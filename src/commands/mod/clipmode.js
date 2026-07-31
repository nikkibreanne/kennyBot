// !clipmode (mod) — choose which of !clip's three outputs are produced, live.
//
//   !clipmode horizontal vertical      both local files, nothing on Twitch
//   !clipmode horizontal               16:9 only
//   !clipmode twitch                   Twitch clip only
//   !clipmode horizontal vertical twitch
//   !clipmode local | all | off        shorthands
//
// A SET rather than fixed presets, so every combination is reachable without
// multiplying config values — and so "just horizontal" and "horizontal + twitch",
// which the old local|twitch|both presets could not express, are just typing.
//
// Exists as a chat command because the failure is operational: the streamer's OBS
// can go down mid-stream, and until it's back a local-only mode leaves !clip with
// nothing to do. SSHing in to edit an env file is not a 2am recovery path.
//
// RTDB is the only source (seeded once from config.clip.defaultMode), so nothing
// reverts this on the next restart.
import { setClipMode, getConfig, clipTargets, readClipTargets, CLIP_TARGETS } from '../../db/configStore.js';
import { captureReady, verticalReady } from '../../integrations/capture.js';
import { clipsReady } from '../../twitch/clips.js';

const USAGE = `Usage: !clipmode ${CLIP_TARGETS.join(' | ')} (combine freely) · local | all | off · status`;

/**
 * Per-target: asked for, and able to run? The second half is what makes `status`
 * worth typing — "horizontal,vertical" looks fine right up until you learn the
 * vertical output was never named.
 */
function report(mode) {
  const want = clipTargets(mode);
  if (want.none) return { line: 'off — !clip is disabled', dead: false };
  const bits = [];
  if (want.horizontal) bits.push(`horizontal ${captureReady() ? '✓' : '✗ no OBS configured'}`);
  if (want.vertical) {
    bits.push(`vertical ${captureReady() && verticalReady() ? '✓' : '✗ no vertical output configured'}`);
  }
  if (want.twitch) bits.push(`twitch ${clipsReady() ? '✓' : '✗ not configured'}`);
  const dead =
    !(want.horizontal && captureReady()) &&
    !(want.vertical && captureReady() && verticalReady()) &&
    !(want.twitch && clipsReady());
  return { line: bits.join(' · '), dead };
}

export default {
  names: ['clipmode'],
  mod: true,
  cooldownMs: 0,
  help: '!clipmode horizontal|vertical|twitch (combine) | local | all | off | status — mod-only',
  async run({ args, reply }) {
    const input = args.join(' ').trim();
    const current = getConfig().clipMode ?? 'local';

    if (!input || input.toLowerCase() === 'status') {
      const { line, dead } = report(current);
      reply(`!clip mode: ${current} · ${line}${dead ? ' — ⚠ !clip can do nothing' : ''}`);
      return;
    }

    // All-or-nothing: a typo'd token must not quietly produce a mode that does
    // less than asked, because the symptom is a clip that silently isn't made.
    if (readClipTargets(input) === null) {
      reply(USAGE);
      return;
    }

    const saved = await setClipMode(input);
    const { line, dead } = report(saved);
    const warn = dead ? ' — ⚠ nothing is configured for that, !clip will tell viewers it is unavailable' : '';
    reply(`!clip mode set to ${saved} · ${line}${warn}`);
  },
};
