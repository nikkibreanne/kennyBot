// !obs (mod) — drive OBS from chat: scenes, source visibility, filters, audio.
//
//   !obs                          what's live right now
//   !obs scenes                   list scenes
//   !obs scene Starting Soon      cut to one
//   !obs sources [scene]          what's in a scene, and what's visible
//   !obs show|hide|toggle <src>   flip a source's visibility (current scene)
//   !obs filters <source>         list a source's filters
//   !obs filter on|off <src> | <filter>
//   !obs audio                    audio inputs, mute state and level
//   !obs mute|unmute <input>      OBS audio mute — NOT the bot's !mute
//   !obs stats                    dropped frames, CPU, disk
//
// One command with sub-verbs rather than eight top-level names: these are for
// LEARNING what OBS exposes, and `!obs` on its own is the discoverable index of
// that. It also keeps eight words out of a chat namespace shared with other bots.
//
// `!obs mute` is under this command precisely BECAUSE `!mute` already exists and
// means something entirely different — silencing the bot's own chat output. Two
// mutes at top level is a mistake waiting for a stressful moment.
//
// Deliberately thin: each verb is one or two obs-websocket requests with no policy
// on top, and `scene` accepts any scene name rather than an allowlist. That is the
// owner's call for an experiment — if a verb proves worth keeping, it can earn its
// own command and its own guard rails then.
import {
  listScenes, setScene, listSources, setSourceVisible,
  listFilters, setFilters, listAudio, setMute, getStats, obsControlReady,
} from '../../integrations/obsControl.js';

/** How many filters one `!obs filter` may flip. A mod typo should not fan out. */
const MAX_FILTERS = 5;

const USAGE =
  'Usage: !obs scenes · scene <name> · sources [scene] · show|hide|toggle <source> · ' +
  'filters <source> · filter on|off <source> | <filter> [| <filter>…] · audio · mute|unmute <input> · stats';

/** Chat-sized list: OBS can hold far more scenes than a message can carry. */
function joinCapped(items, max = 12) {
  const shown = items.slice(0, max);
  const extra = items.length - shown.length;
  return shown.join(' · ') + (extra > 0 ? ` …+${extra} more` : '');
}

export default {
  names: ['obs'],
  mod: true,
  cooldownMs: 0,
  help: '!obs scene|sources|show|hide|filters|filter|audio|mute|stats — drive OBS from chat, mod-only',
  async run({ args, reply }) {
    if (!obsControlReady()) {
      reply('no OBS is configured for this bot');
      return;
    }
    const [first, ...rest] = args;
    const verb = String(first || '').toLowerCase();
    const arg = rest.join(' ').trim();

    // ── status ──────────────────────────────────────────────────────────────
    if (!verb) {
      const [sc, st] = await Promise.all([listScenes(), getStats()]);
      if (!sc.ok) {
        reply(`could not reach OBS: ${sc.reason}`);
        return;
      }
      const health = st.ok
        ? ` · ${st.data.fps.toFixed(0)}fps, ${st.data.outputSkipped}/${st.data.outputTotal} frames skipped`
        : '';
      reply(`🎛️ scene "${sc.data.current}" (${sc.data.names.length} scenes)${health} · ${USAGE}`);
      return;
    }

    // ── scenes ──────────────────────────────────────────────────────────────
    if (verb === 'scenes') {
      const res = await listScenes();
      if (!res.ok) {
        reply(`could not reach OBS: ${res.reason}`);
        return;
      }
      const named = res.data.names.map((n) => (n === res.data.current ? `▶ ${n}` : n));
      reply(`🎛️ scenes: ${joinCapped(named)}`);
      return;
    }

    if (verb === 'scene') {
      if (!arg) {
        reply(`name a scene · ${USAGE}`);
        return;
      }
      const res = await setScene(arg);
      // OBS's own error names the scene it couldn't find, which is exactly the
      // information a mod needs — pass it through rather than rewriting it.
      reply(res.ok ? `🎛️ switched to "${arg}"` : `couldn't switch: ${res.reason}`);
      return;
    }

    // ── sources ─────────────────────────────────────────────────────────────
    if (verb === 'sources') {
      const res = await listSources(arg || null);
      if (!res.ok) {
        reply(`could not list sources: ${res.reason}`);
        return;
      }
      const named = res.data.items.map((i) => `${i.visible ? '👁' : '🚫'} ${i.name}`);
      reply(`🎛️ "${res.data.scene}": ${joinCapped(named)}`);
      return;
    }

    if (verb === 'show' || verb === 'hide' || verb === 'toggle') {
      if (!arg) {
        reply(`name a source · ${USAGE}`);
        return;
      }
      const res = await setSourceVisible(arg, verb);
      reply(res.ok
        ? `🎛️ "${arg}" is now ${res.data.visible ? 'visible' : 'hidden'} in "${res.data.scene}"`
        : `couldn't ${verb} it: ${res.reason}`);
      return;
    }

    // ── filters ─────────────────────────────────────────────────────────────
    if (verb === 'filters') {
      if (!arg) {
        reply(`name a source · ${USAGE}`);
        return;
      }
      const res = await listFilters(arg);
      if (!res.ok) {
        reply(`could not list filters: ${res.reason}`);
        return;
      }
      if (!res.data.filters.length) {
        reply(`🎛️ "${arg}" has no filters`);
        return;
      }
      reply(`🎛️ "${arg}": ${joinCapped(res.data.filters.map((f) => `${f.enabled ? '✅' : '⬜'} ${f.name}`))}`);
      return;
    }

    if (verb === 'filter') {
      // `source | filter [| filter…]` — every name here is an OBS name and may
      // contain spaces, so a separator is the only unambiguous split. Same `|` as
      // `!media set`. The FIRST part is the source; everything after it is a
      // filter, which is what makes "flip these two together" expressible.
      const state = String(rest[0] || '').toLowerCase();
      const parts = rest.slice(1).join(' ').split('|').map((s) => s.trim()).filter(Boolean);
      const [sourceName, ...filterNames] = parts;
      if ((state !== 'on' && state !== 'off') || !sourceName || !filterNames.length) {
        reply(`Usage: !obs filter on|off <source> | <filter> [| <filter>…]`);
        return;
      }
      if (filterNames.length > MAX_FILTERS) {
        reply(`that's ${filterNames.length} filters — ${MAX_FILTERS} at a time is the limit`);
        return;
      }
      const res = await setFilters(sourceName, filterNames, state === 'on');
      if (!res.ok) {
        reply(`couldn't set it: ${res.reason}`);
        return;
      }
      // Partial success is the case worth being loud about: silently reporting
      // success for the ones that worked is how a mod walks away believing a
      // filter is on when it never was.
      const done = res.data.results.filter((r) => r.ok).map((r) => `"${r.filterName}"`);
      const failed = res.data.results.filter((r) => !r.ok);
      const okPart = done.length ? `🎛️ ${done.join(' + ')} on "${sourceName}" now ${state}` : '';
      const badPart = failed.length
        ? `${done.length ? ' · ' : ''}couldn't set ${failed.map((r) => `"${r.filterName}"`).join(' + ')}: ${failed[0].reason}`
        : '';
      reply(`${okPart}${badPart}`);
      return;
    }

    // ── audio ───────────────────────────────────────────────────────────────
    if (verb === 'audio') {
      const res = await listAudio();
      if (!res.ok) {
        reply(`could not list audio: ${res.reason}`);
        return;
      }
      const named = res.data.inputs.map((i) => `${i.muted ? '🔇' : '🔊'} ${i.name} ${i.db.toFixed(0)}dB`);
      reply(named.length ? `🎛️ audio: ${joinCapped(named)}` : '🎛️ OBS reports no audio inputs');
      return;
    }

    if (verb === 'mute' || verb === 'unmute') {
      if (!arg) {
        reply(`name an OBS audio input · ${USAGE}`);
        return;
      }
      const res = await setMute(arg, verb);
      reply(res.ok
        ? `🎛️ "${arg}" is now ${res.data.muted ? 'muted 🔇' : 'unmuted 🔊'}`
        : `couldn't ${verb} it: ${res.reason}`);
      return;
    }

    // ── stats ───────────────────────────────────────────────────────────────
    if (verb === 'stats') {
      const res = await getStats();
      if (!res.ok) {
        reply(`could not reach OBS: ${res.reason}`);
        return;
      }
      const d = res.data;
      // Dropped frames matter as a RATE, not a count — "312 dropped" means
      // nothing without knowing it's 312 out of two million.
      const pct = (a, b) => (b > 0 ? `${((a / b) * 100).toFixed(2)}%` : 'n/a');
      const stream = d.streaming
        ? ` · dropped ${d.streamSkipped}/${d.streamTotal} (${pct(d.streamSkipped, d.streamTotal)})`
        : ' · not streaming';
      reply(
        `🎛️ ${d.fps.toFixed(0)}fps · CPU ${d.cpu.toFixed(1)}% · ` +
        `render skip ${pct(d.renderSkipped, d.renderTotal)} · ` +
        `encode skip ${pct(d.outputSkipped, d.outputTotal)}${stream} · ${d.diskGb.toFixed(1)}GB free`,
      );
      return;
    }

    reply(USAGE);
  },
};
