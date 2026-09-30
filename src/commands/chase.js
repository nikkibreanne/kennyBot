// !chase — is there a police chase on in LA right now?
//
// The public half of the chase monitor (docs/chase-monitor-design.md §2.7). It
// answers one question and says nothing else: no score, no evidence, no source
// names, no org ids, no hint that an API is involved. Everything an operator
// needs lives behind `!chasemon`, which is mod-only for exactly that reason.
//
// It exists because the monitor announces ONCE per incident, deliberately — a
// two-hour pursuit announced at minute 3 is invisible to someone arriving at
// minute 40, and re-announcing on a timer would spam the far commoner case of a
// chase that ends in six minutes. `!chase` is the pull half of that trade.
import { loadMonitorState, getChaseSettings } from '../db/chaseMonitor.js';

/** How long a finished chase is still worth mentioning unprompted. */
const RECENT_MS = 3 * 60 * 60_000;

/** "4m" / "1h 12m" — chat wants a duration, not a timestamp. */
function since(ms) {
  const mins = Math.max(0, Math.round(ms / 60_000));
  if (mins < 1) return 'under a minute';
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

/**
 * The source's ON-AIR name. The incident stores the internal org id (`org1`),
 * which is a config detail and never belongs in chat — this is the only place
 * that translation happens.
 */
function orgName(settings, id) {
  return settings?.orgs?.find((o) => o.id === id)?.name || 'a local station';
}

export default {
  names: ['chase'],
  mod: false,
  cooldownMs: 15_000,
  help: '!chase — is there a police chase on in LA right now?',
  async run({ reply, logger }) {
    let state = null;
    let settings = null;
    try {
      // Settings carry the private roster, which is the only place an org id can be
      // turned into an on-air name — the public config no longer holds it.
      [state, settings] = await Promise.all([loadMonitorState(), getChaseSettings()]);
    } catch (err) {
      // A monitor problem must never become a chat problem, and the reason for
      // it is never chat's business — it goes to the log and nowhere else.
      logger.error('!chase could not read monitor state', { err: err?.message });
      reply("couldn't check that right now — try again in a moment.");
      return;
    }

    const open = state?.incident || null;
    if (open?.url) {
      const ran = since(Date.now() - (Number(open.openedAt) || Date.now()));
      reply(`🚨 yes — ${orgName(settings, open.org)} has been on a chase for ${ran}: ${open.url}`);
      return;
    }

    // Nothing open. The most recent incident is worth reporting, but WITHOUT its
    // link: these are 24/7 streams, so that URL still resolves to a chopper cam
    // quietly orbiting nothing, and handing it over reads as "it's still on".
    const closedAt = Number(state?.lastClosedAt) || 0;
    const ago = Date.now() - closedAt;
    if (closedAt > 0 && ago >= 0 && ago < RECENT_MS) {
      const last = state?.lastIncident || null;
      const who = last?.org ? `${orgName(settings, last.org)}'s ` : '';
      reply(`no chase right now 🚔 — ${who}last one wrapped up about ${since(ago)} ago.`);
      return;
    }
    reply('no chase detected right now 🚔');
  },
};
