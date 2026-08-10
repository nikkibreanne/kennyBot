// !timer — the stream countdown ("brb 10", "raid starts in 5m"). ONE timer at a
// time: setting a new one replaces whatever was running, so there is never a
// list to address in chat. kennyBot announces the heads-up marks and calls
// "time's up" itself (src/events/timerScheduler.js).
//
// Mixed public/mod (like !fact and !market): it stays `mod:false` so ANYONE can
// ask how long is left, and every control is gated on isMod inline — a non-mod
// trying one is ignored, exactly as the dispatcher would.
//   Public:  !timer                       — how long is left
//   Mod:     !timer <duration> [label]    — set/replace  (10 · 90s · 45m · 1h30m · 5:30)
//            !timer +5 | !timer -90s      — add/remove time (bare number = minutes)
//            !timer pause | resume        — freeze / un-freeze the countdown
//            !timer stop                  — dismiss it
import {
  getTimer, startTimer, addTime, pauseTimer, resumeTimer, clearTimer,
  takeDuration, parseAdjustment, formatDuration, remainingMs, cleanLabel,
} from '../../db/timer.js';
import { config } from '../../config.js';

const SET = ['set', 'start', 'go', 'new'];
const STOP = ['stop', 'dismiss', 'cancel', 'clear', 'off', 'end', 'done'];
const PAUSE = ['pause', 'hold', 'freeze'];
const RESUME = ['resume', 'unpause', 'unfreeze', 'continue'];
const ADD = ['add', 'plus', 'extend'];
const SUB = ['sub', 'subtract', 'minus', 'less'];

const USAGE = 'Usage: !timer <10 | 90s | 1h30m> [label] · !timer +5 · !timer -2m · !timer pause | resume | stop';

/** `Break: 4m 12s` / `4m 12s` — the countdown with its label, when it has one. */
function withLabel(timer, remaining) {
  const left = formatDuration(remaining);
  return timer?.label ? `${timer.label}: ${left}` : left;
}

export default {
  names: ['timer', 'countdown'],
  mod: false, // mixed: public status, mod controls (gated inline)
  cooldownMs: 2_000,
  help: '!timer — time left on the stream timer · mods: !timer <10m> [label] | +5 | pause | stop',
  async run({ user, args, reply }) {
    const isMod = user.isMod || user.isBroadcaster;
    const sub = (args[0] || '').toLowerCase();
    const cur = getTimer();
    const now = Date.now();

    // ── status (public, and the bare-command default) ──
    if (!sub || sub === 'status' || sub === 'left' || sub === 'time') {
      if (!cur) {
        reply(isMod ? 'No timer running. Set one: !timer 10m [label]' : 'No timer running right now.');
        return;
      }
      const left = remainingMs(cur, now);
      reply(cur.paused
        ? `⏸️ ${withLabel(cur, left)} left — paused.${isMod ? ' (!timer resume)' : ''}`
        : `⏳ ${withLabel(cur, left)} left.`);
      return;
    }

    if (!isMod) return; // every control below is a mod control — ignore quietly

    // ── +5 / -90s (and the `add` / `subtract` spellings) ──
    let delta = parseAdjustment(args);
    if (delta == null && (ADD.includes(sub) || SUB.includes(sub))) {
      const taken = takeDuration(args.slice(1));
      if (!taken?.ms) { reply(`Usage: !timer ${SUB.includes(sub) ? '-' : '+'}<minutes>  (e.g. !timer ${SUB.includes(sub) ? '-2' : '+5'})`); return; }
      delta = SUB.includes(sub) ? -taken.ms : taken.ms;
    }
    if (delta != null) {
      const res = await addTime(delta, now);
      if (!res.ok) {
        reply(res.reason === 'none'
          ? 'No timer running — set one first: !timer 10m [label]'
          : `That would push it past the ${formatDuration(config.timer.maxMs)} limit.`);
        return;
      }
      const sign = delta > 0 ? '+' : '−';
      if (res.ended) {
        // Ran the clock out. A running timer is now due, so the countdown tick
        // calls "time's up" a moment from now — don't say it twice here.
        reply(res.timer ? `⏱️ ${sign}${formatDuration(Math.abs(delta))} — that runs it out.` : '⏹️ Timer wound down to zero — cleared.');
        return;
      }
      reply(`⏱️ ${sign}${formatDuration(Math.abs(delta))} — ${withLabel(res.timer, res.remaining)}${res.timer.paused ? ' (paused)' : ' left'}.`);
      return;
    }

    // ── stop / pause / resume ──
    if (STOP.includes(sub)) {
      const res = await clearTimer(now);
      reply(res.ok
        ? `⏹️ Timer dismissed${res.timer.label ? ` — “${res.timer.label}”` : ''} (${formatDuration(res.remaining)} was left).`
        : 'No timer running.');
      return;
    }
    if (PAUSE.includes(sub)) {
      const res = await pauseTimer(now);
      if (!res.ok) { reply(res.reason === 'none' ? 'No timer running.' : `⏸️ Already paused — ${formatDuration(res.remaining)} left. (!timer resume)`); return; }
      reply(`⏸️ Paused — ${withLabel(res.timer, res.remaining)} on the clock. !timer resume to start it again.`);
      return;
    }
    // A bare `!timer start` / `!timer go` on a paused clock means resume — it's
    // the natural thing to type, and there's no duration for it to mean instead.
    if (RESUME.includes(sub) || (SET.includes(sub) && args.length === 1 && cur?.paused)) {
      const res = await resumeTimer(now);
      if (!res.ok) { reply(res.reason === 'none' ? 'No timer running — set one: !timer 10m [label]' : `⏳ Already running — ${formatDuration(res.remaining)} left.`); return; }
      reply(`▶️ Resumed — ${withLabel(res.timer, res.remaining)} left.`);
      return;
    }

    // ── set: `!timer 10m Break` or the explicit `!timer set 10m Break` ──
    const words = SET.includes(sub) ? args.slice(1) : args;
    const taken = takeDuration(words);
    if (!taken?.ms) { reply(USAGE); return; }

    const label = cleanLabel(taken.rest.join(' '));
    const res = await startTimer({ durationMs: taken.ms, label, by: user.displayName, now });
    if (!res.ok) {
      reply(res.reason === 'too-short'
        ? `That's too short — ${formatDuration(config.timer.minMs)} is the minimum.`
        : `That's too long — ${formatDuration(config.timer.maxMs)} is the maximum.`);
      return;
    }
    const replaced = res.replaced ? ` (replaced the ${formatDuration(remainingMs(res.replaced, now))} one)` : '';
    reply(`⏳ Timer set — ${withLabel(res.timer, taken.ms)}${replaced}. I'll call it when it's up.`);
  },
};
