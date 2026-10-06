// !chasemon (mod) — the kill switch for the chase monitor, and the only window
// anyone has into it while it runs.
//
//   !chasemon                  status (same as `!chasemon status`)
//   !chasemon on | off         run the loops at all — seeds OFF (design §4)
//   !chasemon shadow | live    score-and-log quietly, or actually speak in chat
//   !chasemon threshold <n>    the total score an incident opens at
//   !chasemon dwell <n>        consecutive polls at/over threshold before it opens
//
// `on` and `live` are two separate acts on purpose: nothing this thing detects
// reaches chat until someone has deliberately said so twice, and the first two
// weeks are meant to be spent in shadow comparing the log against what actually
// happened (design §5).
//
// `status` is deliberately detailed — in shadow mode it is the ONLY evidence an
// operator has that the monitor is alive — but it stops hard at "a YouTube key
// is present". The key, the quota, and any fetch error never appear in chat.
//
// Bad input never half-applies. `!clipmode` set that precedent because a typo'd
// token that quietly produces a mode doing LESS than asked is discovered at the
// worst possible moment; a monitor whose threshold silently didn't move is the
// same failure with a longer fuse.
import {
  loadMonitorState, getChaseSettings, setChaseSettings,
} from '../../db/chaseMonitor.js';
import { youtubeKeyPresent } from '../../integrations/chaseSources.js';
import { config } from '../../config.js';

const USAGE = 'Usage: !chasemon on | off | shadow | live | status | threshold <n> | dwell <n> | aircraft on|off';

/** A dwell longer than this is a typo, not a policy — 20 polls is 20 minutes. */
const MAX_DWELL = 20;

/**
 * The highest total score the current org set can physically produce. A
 * threshold above it is not "strict", it is "off" — and that is a very quiet way
 * to break the feature, so it is rejected rather than accepted.
 */
export function ceilingScore(settings) {
  // `settings.orgs`, NOT `config.chase.orgs`. The roster is private and ships
  // EMPTY in the repo (it is loaded into RTDB out-of-band), so reducing over the
  // config list returned 0 on every real deployment — and since the floor is
  // `clearScore` (6), `n > 0` rejected every threshold a mod could type. The
  // command was unconditionally broken in production and silent about it.
  const orgs = Array.isArray(settings?.orgs) ? settings.orgs : [];
  const fromOrgs = orgs.reduce((n, o) => n + (o.groupCap ?? settings.groupCap ?? 0), 0);
  // The aircraft channel scores in its OWN group (§2.10), outside any org, so it
  // raises the attainable ceiling too — but only while it is switched on.
  const ac = settings?.aircraft;
  const fromAircraft = ac && ac.enabled !== false ? Number(ac.weight) || 0 : 0;
  return fromOrgs + fromAircraft;
}

/** "14m" / "1h 02m" — an incident's age, for the status line. */
function since(ms) {
  const mins = Math.max(0, Math.round(ms / 60_000));
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m`;
}

/**
 * The operator's whole view in one line. Ordered by what gets asked first:
 * is it running, will it speak, what is it tuned to, can it see, what does it
 * see right now.
 */
export function statusLine(settings, state) {
  const bits = [
    `🚔 chase monitor: ${settings.enabled ? 'ON' : 'OFF'}`,
    `mode ${settings.mode}`,
    `threshold ${settings.threshold}`,
    `dwell ${settings.dwell}`,
    // Presence only. Whether a key exists changes what the monitor can detect
    // (no key = no audience channel at all), so an operator has to be able to
    // ask — but the value itself has no business anywhere near chat.
    `YouTube key ${youtubeKeyPresent() ? 'present' : '⚠ ABSENT — nothing can be detected without it'}`,
    // The roster is loaded out-of-band (npm run chase:sources) and ships empty, so
    // "on, with no sources" is the misconfiguration an operator will actually hit.
    // Count only — which outlets they are is private and never goes to chat.
    settings.orgs?.length
      ? `${settings.orgs.length} sources`
      : '⚠ NO SOURCES LOADED — monitor is inert',
    // Corroboration only, and worth saying out loud because it is the one
    // channel an operator can switch off without a deploy — so "is it on?"
    // has to be answerable the same way.
    `aircraft ${settings.aircraft?.enabled === false ? 'off' : 'on'}`,
  ];

  const incident = state?.incident || null;
  if (incident) {
    const age = since(Date.now() - (Number(incident.openedAt) || Date.now()));
    const peak = Number(incident.peakScore);
    bits.push(`INCIDENT OPEN ${age} (${incident.org})${Number.isFinite(peak) ? `, peak score ${peak.toFixed(2)}` : ''}`);
    bits.push(`under ${Number(state?.underCount) || 0}/${settings.clearPolls} polls`);
    return bits.join(' · ');
  }

  // Nothing open. The state deliberately does not keep a per-tick score, so the
  // honest answer to "what is it seeing right now" is the dwell counter: the
  // difference between "nothing is happening" and "something is building and
  // has stalled one poll short of the threshold" is exactly the question an
  // argument about the threshold turns on, and a bare 0.00 hides it.
  bits.push(`no incident · over ${Number(state?.overCount) || 0}/${settings.dwell} polls`);
  const last = state?.lastIncident || null;
  const lastClosed = Number(state?.lastClosedAt) || 0;
  if (last && lastClosed > 0) {
    const peak = Number(last.peakScore);
    bits.push(`last ${since(Date.now() - lastClosed)} ago (${last.org}${Number.isFinite(peak) ? `, peak ${peak.toFixed(2)}` : ''})`);
  }
  return bits.join(' · ');
}

export default {
  names: ['chasemon'],
  mod: true,
  cooldownMs: 0,
  help: '!chasemon on|off|shadow|live|status|threshold <n>|dwell <n>|aircraft on|off — chase monitor control, mod-only',
  async run({ args, reply, logger }) {
    const [first, ...rest] = args;
    const verb = String(first || 'status').toLowerCase();

    try {
      if (verb === 'status') {
        const settings = await getChaseSettings();
        // The settings are the half that always answers; a state read failing
        // must not cost the operator the rest of the line.
        let state = null;
        try {
          state = await loadMonitorState();
        } catch (err) {
          logger.warn('!chasemon could not read monitor state', { err: err?.message });
        }
        reply(statusLine(settings, state));
        return;
      }

      if (verb === 'on' || verb === 'off') {
        const settings = await setChaseSettings({ enabled: verb === 'on' });
        if (verb === 'off') {
          reply('🚔 chase monitor OFF — no polling, no announcements.');
          return;
        }
        const note = settings.mode === 'live'
          ? ' and in LIVE mode — it will announce in chat.'
          : ' in SHADOW mode — it will score and log, but say nothing. `!chasemon live` when the log looks right.';
        reply(`🚔 chase monitor ON${note}`);
        return;
      }

      if (verb === 'shadow' || verb === 'live') {
        const settings = await setChaseSettings({ mode: verb });
        const off = settings.enabled ? '' : ' — the monitor itself is still OFF (`!chasemon on`)';
        const what = verb === 'live'
          ? 'LIVE — detections now go to chat'
          : 'SHADOW — detections are logged, never spoken';
        reply(`🚔 chase monitor mode: ${what}${off}`);
        return;
      }

      if (verb === 'aircraft') {
        const which = String(rest[0] ?? '').trim().toLowerCase();
        if (rest.length !== 1 || (which !== 'on' && which !== 'off')) {
          reply(`aircraft takes on or off — nothing changed · ${USAGE}`);
          return;
        }
        const saved = await setChaseSettings({ aircraftEnabled: which === 'on' });
        if (saved.aircraft?.enabled === false) {
          reply('🚔 aircraft corroboration OFF — no ADS-B calls, and scoring falls back to the news channels alone.');
          return;
        }
        // Deliberately restates the ceiling rather than just confirming: this
        // channel cannot detect anything by itself, and an operator switching it
        // on should not come away thinking they added a detector.
        reply(`🚔 aircraft corroboration ON — adds up to ${Number(saved.aircraft?.weight) || 0} to an incident something else already named, never enough to announce on its own.`);
        return;
      }

      if (verb === 'threshold' || verb === 'dwell') {
        // One argument, and it must parse. Two numbers, a stray word or a blank
        // all mean the mod did not type what they meant — say so and change
        // nothing, rather than applying the half that happened to parse.
        const raw = String(rest[0] ?? '').trim();
        const n = Number(raw);
        if (rest.length !== 1 || raw === '' || !Number.isFinite(n)) {
          reply(USAGE);
          return;
        }

        const settings = await getChaseSettings();
        if (verb === 'dwell') {
          if (!Number.isInteger(n) || n < 1 || n > MAX_DWELL) {
            reply(`dwell is a whole number of polls, 1–${MAX_DWELL} — nothing changed · ${USAGE}`);
            return;
          }
          const saved = await setChaseSettings({ dwell: n });
          const secs = Math.round((n * (saved.pollMs ?? config.chase.pollMs)) / 1000);
          reply(`🚔 dwell set to ${saved.dwell} polls (~${secs}s at/over threshold before an announcement).`);
          return;
        }

        const ceiling = ceilingScore(settings);
        const floor = Number(settings.clearScore) || 0;
        // Below clearScore an incident would open and could never close; above
        // the ceiling it could never open. Both are silent no-ops in production.
        if (n < floor || n > ceiling) {
          reply(`threshold must be between the clear score (${floor}) and ${ceiling}, the most the current sources can score — nothing changed · ${USAGE}`);
          return;
        }
        const saved = await setChaseSettings({ threshold: n });
        reply(`🚔 threshold set to ${saved.threshold} (closes back under ${saved.clearScore}).`);
        return;
      }

      reply(USAGE);
    } catch (err) {
      // Whatever broke — RTDB, a malformed record — the mod gets a plain
      // failure and the detail goes to the log.
      logger.error('!chasemon failed', { verb, err: err?.message });
      reply("couldn't reach the chase monitor right now — nothing changed.");
    }
  },
};
