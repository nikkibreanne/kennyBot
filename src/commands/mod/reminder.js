// !reminder (mod) — the scheduled chat nudges: the Wallpaper Engine check,
// Ghosty's meals, the hourly hydration ping. Every schedule is a record in RTDB
// (config/reminders/<id>), so all of this edits data — nothing here is baked
// into a release, and a change takes effect on the next tick.
//   !reminder                          — list them all, with what fires when
//   !reminder on|off <id>              — enable / disable one
//   !reminder test <id>                — say it right now (ignores every gate)
//   !reminder at <id> <HH:MM…>         — daily times     (e.g. !reminder at ghosty 08:00 17:00)
//   !reminder lead <id> <min>          — daily heads-up lead (0 = none)
//   !reminder every <id> <min>         — interval period
//   !reminder jitter <id> <min>        — interval wobble (±)
//   !reminder after <id> <min>         — afterLive delay
//   !reminder zone <id> <IANA>         — daily time zone
//   !reminder text|leadtext <id> <msg> — what it says
//   !reminder channel <id> <name|any>  — which channel it belongs to
import {
  listReminders, getReminder, editReminder, cleanText, isValidTimeZone,
} from '../../db/reminders.js';
import { describeSchedule } from '../../rules/reminders.js';

const USAGE = 'Usage: !reminder · on|off|test <id> · at <id> <HH:MM…> · every|jitter|after|lead <id> <min> · text|leadtext <id> <msg> · zone <id> <IANA> · channel <id> <name|any>';

/** Minutes → ms from a chat argument, or null when it isn't a sane number. */
function minutesArg(raw) {
  const min = Number(raw);
  if (!Number.isFinite(min) || min < 0 || min > 24 * 60) return null;
  return Math.round(min * 60_000);
}

/** `✅ ghosty — daily 08:00, 17:00 Los Angeles +20m heads-up · while live · #nikkibreanne` */
function summarize(reminder) {
  const scope = reminder.channel ? ` · #${reminder.channel}` : '';
  const live = reminder.liveOnly === false ? ' · always' : ' · while live';
  return `${reminder.enabled === false ? '⏸️' : '✅'} ${reminder.id} — ${describeSchedule(reminder)}${live}${scope}`;
}

// Twitch drops anything past ~500 characters, so a long list is trimmed here
// rather than silently losing its tail mid-word.
const LIST_BUDGET = 440;

/** Join as many summaries as fit, noting how many were left out. */
function listLine(reminders) {
  const kept = [];
  let used = 0;
  for (const line of reminders.map(summarize)) {
    if (used + line.length > LIST_BUDGET && kept.length) break;
    kept.push(line);
    used += line.length + 5;
  }
  const extra = reminders.length - kept.length;
  return `⏰ ${kept.join('  ·  ')}${extra > 0 ? `  ·  (+${extra} more)` : ''}`;
}

export default {
  names: ['reminder', 'reminders'],
  mod: true,
  cooldownMs: 2_000,
  help: '!reminder — list/edit the scheduled reminders (times, text, on/off)',
  async run({ user, args, reply }) {
    const sub = (args[0] || 'list').toLowerCase();

    // ── list ──
    if (sub === 'list' || sub === 'status') {
      const all = listReminders();
      if (!all.length) { reply('No reminders configured.'); return; }
      reply(listLine(all));
      return;
    }

    const id = String(args[1] || '').toLowerCase();
    if (!id) { reply(USAGE); return; }
    const reminder = getReminder(id);
    if (!reminder) {
      reply(`No reminder called “${id}”. Known: ${listReminders().map((r) => r.id).join(', ') || '(none)'}`);
      return;
    }
    const rest = args.slice(2).join(' ').trim();

    // ── test: say it now, whatever the schedule and gates would decide ──
    if (sub === 'test' || sub === 'fire') {
      reply(reminder.text || `(reminder “${id}” has no text)`);
      return;
    }

    // ── on / off ──
    if (sub === 'on' || sub === 'off' || sub === 'enable' || sub === 'disable') {
      const enabled = sub === 'on' || sub === 'enable';
      const res = await editReminder(id, { enabled });
      if (!res.ok) { reply(`Couldn't update ${id} (${res.reason}).`); return; }
      reply(`${enabled ? '✅' : '⏸️'} ${id} ${enabled ? 'on' : 'off'} — ${describeSchedule(res.reminder)}.`);
      return;
    }

    // ── daily times ──
    if (sub === 'at' || sub === 'times') {
      const times = args.slice(2).map((t) => t.replace(/,$/, ''));
      if (!times.length) { reply(`Usage: !reminder at ${id} 08:00 17:00`); return; }
      const res = await editReminder(id, { times });
      if (!res.ok) {
        reply(res.reason.startsWith('bad-time')
          ? `“${res.reason.split(':').slice(1).join(':')}” isn't a time — use 24-hour HH:MM (e.g. 08:00 17:00).`
          : `Couldn't update ${id} (${res.reason}).`);
        return;
      }
      reply(`⏰ ${id} — ${describeSchedule(res.reminder)}.`);
      return;
    }

    // ── numeric knobs, all in minutes ──
    const MINUTE_KEYS = { lead: 'leadMs', every: 'everyMs', jitter: 'jitterMs', after: 'afterMs' };
    if (MINUTE_KEYS[sub]) {
      const ms = minutesArg(args[2]);
      if (ms == null) { reply(`Usage: !reminder ${sub} ${id} <minutes>`); return; }
      const res = await editReminder(id, { [MINUTE_KEYS[sub]]: ms });
      if (!res.ok) {
        reply(res.reason === 'too-often'
          ? 'That would fire more than once a minute — pick 1 minute or more.'
          : `Couldn't update ${id} (${res.reason}).`);
        return;
      }
      reply(`⏰ ${id} — ${describeSchedule(res.reminder)}.`);
      return;
    }

    // ── message text ──
    if (sub === 'text' || sub === 'say' || sub === 'leadtext') {
      const text = cleanText(rest);
      if (!text) { reply(`Usage: !reminder ${sub} ${id} <what it should say>`); return; }
      const res = await editReminder(id, sub === 'leadtext' ? { leadText: text } : { text });
      if (!res.ok) { reply(`Couldn't update ${id} (${res.reason}).`); return; }
      reply(`📝 ${id} ${sub === 'leadtext' ? 'heads-up' : 'message'} updated → ${text}`);
      return;
    }

    // ── time zone ──
    if (sub === 'zone' || sub === 'tz') {
      if (!rest) { reply(`Usage: !reminder zone ${id} America/Los_Angeles`); return; }
      if (!isValidTimeZone(rest)) { reply(`“${rest}” isn't a time zone I know — use an IANA name like America/Los_Angeles.`); return; }
      const res = await editReminder(id, { timeZone: rest });
      if (!res.ok) { reply(`Couldn't update ${id} (${res.reason}).`); return; }
      reply(`🌍 ${id} — ${describeSchedule(res.reminder)}.`);
      return;
    }

    // ── which channel it belongs to ──
    if (sub === 'channel') {
      if (!rest) { reply(`Usage: !reminder channel ${id} <channel|any>`); return; }
      const any = ['any', 'all', 'none', '*'].includes(rest.toLowerCase());
      const res = await editReminder(id, { channel: any ? null : rest });
      if (!res.ok) { reply(`Couldn't update ${id} (${res.reason}).`); return; }
      reply(`📺 ${id} → ${res.reminder.channel ? `#${res.reminder.channel} only` : 'any channel'}.`);
      return;
    }

    reply(`@${user.displayName} ${USAGE}`);
  },
};
