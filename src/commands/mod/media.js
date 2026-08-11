// !media (mod) — fire a mapped OBS media source from chat.
//
//   !media 3                     play slot 3
//   !media                       list what's mapped
//   !media inputs                ask OBS which media sources exist
//   !media set 3 GIF | Sound     map slot 3 — one alert, however many OBS sources
//   !media add 3 Extra Sound     append a source to an existing slot
//   !media scene 3 Alerts        reveal them in the "Alerts" scene before playing
//   !media scene 3 none          stop revealing it (it's always on screen)
//   !media action 3 stop         change what "trigger" means for this slot
//   !media clear 3               unmap
//
// This is the manual half of a StreamElements-style alert: the *play* mechanism,
// driven by a mod typing a number. Wiring it to Twitch events (cheers, subs,
// redemptions) is a separate piece of work and needs broadcaster scopes this bot
// does not currently hold — the mechanism has to exist and be trusted first.
//
// Mod-only, deliberately. This makes noise over the stream, and a public version
// is a way for chat to talk over the streamer. Opening it up is a decision to be
// made once the slot map exists, not a default.
//
// Names are OBS's names, character for character. `!media inputs` exists because
// typing them from memory is how you get a slot that looks mapped and plays
// nothing — which is indistinguishable, live, from the bot being broken.
//
// CONTRACT: a successful play says NOTHING in chat — the sound is the feedback,
// and an alert that also posts a line is just clutter. EVERY failure replies. So
// silence means OBS accepted the request; if you then hear nothing, the problem
// is on the OBS side (source muted, hidden, or its media file missing), not here.
import { listSlots, getSlot, mapSlot, addInput, clearMediaSlot } from '../../db/media.js';
import { describeSlot, parseSlot, slotInputs, MEDIA_ACTIONS, DEFAULT_ACTION, MAX_SLOT, MAX_PARTS, PART_SEPARATOR } from '../../rules/media.js';
import { playMedia, listInputs, mediaReady } from '../../integrations/obsMedia.js';

const ACTIONS = MEDIA_ACTIONS;
const USAGE = `Usage: !media <1-${MAX_SLOT}> · set <n> <source> ${PART_SEPARATOR} <source> · add <n> <source> · scene <n> <scene|none> · action <n> ${ACTIONS.join('/')} · clear <n> · inputs`;

/** Why a write was refused, in words a mod can act on. */
function refusal(reason) {
  switch (reason) {
    case 'bad-input': return `each source name must be non-empty and under 100 chars — separate them with ${PART_SEPARATOR}`;
    case 'too-many-parts': return `a slot fires at most ${MAX_PARTS} sources`;
    case 'bad-scene': return 'that scene name is empty or too long';
    case 'bad-action': return `action must be one of: ${ACTIONS.join(', ')}`;
    case 'bad-label': return 'that label is empty or too long';
    case 'unmapped': return 'that slot is not mapped yet — set it first';
    default: return reason;
  }
}

export default {
  names: ['media'],
  mod: true,
  // No cooldown, like !clipmode and !timer. A soundboard's whole value is landing
  // on the beat, sometimes twice — and a window here would also swallow the
  // map-then-immediately-test workflow. It's mod-only, and unlike !clip's local
  // capture (hundreds of MB per trigger, hence its own rate limit) a media action
  // costs OBS nothing. Spam is a conversation to have with a mod, not a lockout.
  cooldownMs: 0,
  help: `!media <n> plays the OBS sources mapped to that number · set/add/scene/action/clear/inputs to map them — mod-only`,
  async run({ args, reply, logger }) {
    const [first, ...rest] = args;
    const verb = String(first || '').toLowerCase();

    // ── list ────────────────────────────────────────────────────────────────
    if (!verb) {
      const slots = listSlots();
      if (!slots.length) {
        reply(`no media slots mapped yet · ${USAGE}`);
        return;
      }
      reply(`🎬 media: ${slots.map(describeSlot).join(' · ')}`);
      return;
    }

    // ── inputs (discovery) ──────────────────────────────────────────────────
    if (verb === 'inputs') {
      if (!mediaReady()) {
        reply('no OBS is configured for this bot, so there is nothing to list');
        return;
      }
      // ffmpeg_source IS the OBS "Media Source" kind — the only one that answers
      // media actions. Listing everything would offer sources that can never play.
      const res = await listInputs('ffmpeg_source', logger);
      if (!res.ok) {
        reply(`could not reach OBS: ${res.reason}`);
        return;
      }
      if (!res.inputs.length) {
        reply('OBS answered, but it has no Media Sources — add one in OBS first');
        return;
      }
      reply(`🎬 OBS media sources: ${res.inputs.map((i) => `"${i.name}"`).join(' · ')}`);
      return;
    }

    // ── set <n> <name…> ─────────────────────────────────────────────────────
    // The source names are the REST OF THE LINE, not one token: real OBS sources
    // are called things like "Airhorn SFX". `|` separates them, because a GIF and
    // its sound are two sources in OBS and one alert to everyone watching.
    if (verb === 'set') {
      const n = parseSlot(rest[0]);
      if (!n) {
        reply(`slot must be a number 1-${MAX_SLOT} · ${USAGE}`);
        return;
      }
      const res = await mapSlot(n, { inputs: rest.slice(1).join(' ') });
      if (!res.ok) {
        reply(refusal(res.reason));
        return;
      }
      reply(`🎬 slot ${describeSlot(res.slot)} — try it with !media ${n}`);
      return;
    }

    // ── add <n> <name…> ─────────────────────────────────────────────────────
    if (verb === 'add') {
      const n = parseSlot(rest[0]);
      if (!n) {
        reply(`slot must be a number 1-${MAX_SLOT} · ${USAGE}`);
        return;
      }
      const res = await addInput(n, rest.slice(1).join(' '));
      if (!res.ok) {
        reply(refusal(res.reason));
        return;
      }
      reply(`🎬 slot ${describeSlot(res.slot)}`);
      return;
    }

    // ── scene <n> <name…|none> ──────────────────────────────────────────────
    if (verb === 'scene') {
      const n = parseSlot(rest[0]);
      if (!n) {
        reply(`slot must be a number 1-${MAX_SLOT} · ${USAGE}`);
        return;
      }
      const raw = rest.slice(1).join(' ');
      const res = await mapSlot(n, { scene: /^none$/i.test(raw.trim()) ? null : raw });
      if (!res.ok) {
        reply(refusal(res.reason));
        return;
      }
      reply(`🎬 slot ${describeSlot(res.slot)}`);
      return;
    }

    // ── action <n> <action> ─────────────────────────────────────────────────
    if (verb === 'action') {
      const n = parseSlot(rest[0]);
      if (!n) {
        reply(`slot must be a number 1-${MAX_SLOT} · ${USAGE}`);
        return;
      }
      const res = await mapSlot(n, { action: String(rest[1] || '').toLowerCase() });
      if (!res.ok) {
        reply(refusal(res.reason));
        return;
      }
      reply(`🎬 slot ${describeSlot(res.slot)}`);
      return;
    }

    // ── clear <n> ───────────────────────────────────────────────────────────
    if (verb === 'clear') {
      const n = parseSlot(rest[0]);
      if (!n) {
        reply(`slot must be a number 1-${MAX_SLOT} · ${USAGE}`);
        return;
      }
      if (!getSlot(n)) {
        reply(`slot ${n} was not mapped`);
        return;
      }
      await clearMediaSlot(n);
      reply(`🎬 slot ${n} cleared`);
      return;
    }

    // ── play <n> ────────────────────────────────────────────────────────────
    const n = parseSlot(verb);
    if (!n) {
      reply(USAGE);
      return;
    }
    const slot = getSlot(n);
    if (!slot) {
      reply(`slot ${n} is not mapped — !media set ${n} <OBS source name>`);
      return;
    }
    if (!mediaReady()) {
      reply('no OBS is configured for this bot, so nothing can play');
      return;
    }

    const res = await playMedia(slot, logger);
    if (!res.ok) {
      // Name the slot AND the reason: "it didn't work" costs a stream's worth of
      // guessing, and the usual cause (a source renamed in OBS) is in the reason.
      reply(`🎬 slot ${n} (${slotInputs(slot).map((i) => `"${i}"`).join(' + ')}) failed: ${res.reason}`);
      return;
    }
    logger.info?.('media slot fired', { slot: n, inputs: slotInputs(slot), action: slot.action || DEFAULT_ACTION });
  },
};
