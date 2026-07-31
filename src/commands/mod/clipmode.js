// !clipmode local|twitch|both|status (mod) — change what !clip does, live.
//
// Exists because the failure is operational, not a game setting: the streamer's
// OBS can go down mid-stream, and until it's back `!clip` in `local` mode can do
// nothing. Recovering by SSHing into the host, editing an env file and restarting
// the container is not a recovery path anyone will take at 2am, so this is
// reachable from chat like the EXP gate and the chat mute.
//
// RTDB is authoritative once set, so this is NOT undone by the container's
// CLIP_MODE on the next restart.
import { setClipMode, getConfig, CLIP_MODES } from '../../db/configStore.js';
import { captureReady } from '../../integrations/capture.js';
import { clipsReady } from '../../twitch/clips.js';

/** What each half of !clip could actually do right now. */
function readiness(mode) {
  const local = mode !== 'twitch' && captureReady();
  const twitch = mode !== 'local' && clipsReady();
  return { local, twitch, dead: !local && !twitch };
}

export default {
  names: ['clipmode'],
  mod: true,
  cooldownMs: 0,
  help: '!clipmode local|twitch|both|status — mod-only control of what !clip does',
  async run({ args, reply }) {
    const sub = (args[0] || 'status').toLowerCase();
    const current = getConfig().clipMode ?? 'local';

    if (sub === 'status') {
      const r = readiness(current);
      const parts = [
        `capture ${captureReady() ? 'ready' : 'not configured'}`,
        `twitch ${clipsReady() ? 'ready' : 'not configured'}`,
      ];
      reply(`!clip mode: ${current} · ${parts.join(' · ')}${r.dead ? ' — ⚠ !clip can do nothing' : ''}`);
      return;
    }

    if (!CLIP_MODES.includes(sub)) {
      reply(`Usage: !clipmode ${CLIP_MODES.join(' | ')} | status`);
      return;
    }

    await setClipMode(sub);

    // Warn immediately if the mode just set can't actually produce anything —
    // better a mod finds out here than a viewer finds out by being told clipping
    // isn't set up.
    const r = readiness(sub);
    const warn = r.dead
      ? ' — ⚠ nothing is configured for that mode, !clip will tell viewers clipping is unavailable'
      : '';
    reply(`!clip mode set to ${sub}${warn}`);
  },
};
