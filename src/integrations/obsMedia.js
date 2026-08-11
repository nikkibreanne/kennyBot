// OBS media actions — "play a sound / roll a clip on stream", on the SAME
// obs-websocket connection the capture path already uses.
//
// This is the StreamElements alert mechanism reduced to what it actually is: a
// media source sitting in a scene, and a request that restarts it. OBS already
// owns the compositing, the audio routing, and the hide-when-finished behaviour.
// The bot's entire job is the trigger.
//
// Deliberately NOT built: an overlay web page driven by a message channel. That
// is how a hosted alert service has to do it — it has no access to your OBS — but
// kennyBot does, and adding a page plus a transport to reach it would be strictly
// more moving parts than the one request below.
//
// A SLOT is the mapping (config/media/<n>): a number a mod types → an OBS input
// name, an optional scene to reveal it in, and which media action to fire. Numbers
// because a slot has to be typeable in one second while something is happening.
//
// Same contract as capture.js, for the same reason: connect per trigger,
// deadline-bounded, and every failure RESOLVES with `{ ok:false, reason }` rather
// than throwing. The streamer's PC may be off — that must never break chat.

import { withObs, obsConnectionFromEnv, websocketAvailable } from './obsWebsocket.js';
import { DEFAULT_ACTION } from '../rules/media.js';

/**
 * Protocol encoding only — a mod's word for an action → obs-websocket's enum.
 * The VOCABULARY (which words exist, which is the default) belongs to
 * src/rules/media.js, so the validation that rejects a typo can be tested
 * without a socket. This table is just the wire format.
 */
export const OBS_MEDIA_ACTION = {
  restart: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART',
  play: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PLAY',
  pause: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PAUSE',
  stop: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_STOP',
  next: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_NEXT',
  previous: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PREVIOUS',
};

/** Connection config, or `null` when this deployment has no OBS. */
let conn = null;
/** Test seam: when set, stands in for the whole obs-websocket round trip. */
let fakeTrigger = null;

/**
 * @param {{ url?: string, password?: string, timeoutMs?: number }} [opts]
 * @param {any} [logger]
 */
export function initMedia(opts = {}, logger = console) {
  fakeTrigger = null;
  const env = obsConnectionFromEnv();
  const url = opts.url ?? env?.url ?? '';
  if (!url) {
    conn = null;
    logger.info?.('media actions disabled (no OBS_WEBSOCKET_URL)');
    return;
  }
  if (!websocketAvailable()) {
    conn = null;
    logger.warn?.('media actions disabled — this Node build lacks WebSocket (needs Node 22+)');
    return;
  }
  conn = {
    url,
    password: opts.password ?? env?.password ?? '',
    timeoutMs: opts.timeoutMs ?? env?.timeoutMs ?? 8000,
  };
  logger.info?.('media actions ready', { url });
}

/**
 * Test seam: `fn({ slot })` replaces the OBS round trip entirely. Pass `null` to
 * turn media actions off (the "no OBS configured" deployment).
 */
export function initMediaWith(fn) {
  fakeTrigger = fn || null;
  conn = fn ? { url: 'test://obs', password: '', timeoutMs: 0 } : null;
}

/** True when an OBS connection is configured. */
export function mediaReady() {
  return conn !== null;
}

/**
 * The request sequence, split from the socket so it can be unit-tested with a
 * fake `request` — the same shape as replayBufferSequence, and for the same
 * reason: every bug worth catching here is an ordering bug.
 *
 * Order is load-bearing. The scene item is enabled BEFORE the media action, so
 * the restart plays into a source that is already on screen. Reversed, the first
 * frames play to nobody.
 *
 * @param {(type: string, data?: object) => Promise<any>} request
 * @param {{ input: string, scene?: string|null, action?: string }} slot
 * @returns {Promise<{ played: boolean, shown: boolean }>}
 */
export async function mediaSequence(request, slot) {
  const name = slot?.action || DEFAULT_ACTION;
  const mediaAction = OBS_MEDIA_ACTION[name];
  if (!mediaAction) throw new Error(`unknown media action "${name}"`);
  if (!slot?.input) throw new Error('slot has no OBS input name');

  let shown = false;
  if (slot.scene) {
    // SetSceneItemEnabled takes a NUMERIC sceneItemId, not a source name, so the
    // id has to be looked up first — there is no name-based form of this request.
    const { sceneItemId } = await request('GetSceneItemId', {
      sceneName: slot.scene,
      sourceName: slot.input,
    });
    await request('SetSceneItemEnabled', {
      sceneName: slot.scene,
      sceneItemId,
      sceneItemEnabled: true,
    });
    shown = true;
  }

  await request('TriggerMediaInputAction', { inputName: slot.input, mediaAction });
  return { played: true, shown };
}

/**
 * Fire one slot. Never throws.
 *
 * NOTE: there is no "and then hide it" step, deliberately. OBS's own Media Source
 * property — *Hide source when playback ends* — already does that, frame-accurately
 * and without the bot holding a timer that a restart would lose. Set it there.
 *
 * @param {{ input: string, scene?: string|null, action?: string }} slot
 * @returns {Promise<{ ok: boolean, played?: boolean, shown?: boolean, reason?: string }>}
 */
export async function playMedia(slot, logger = console) {
  if (!conn) return { ok: false, reason: 'not configured' };
  if (!slot?.input) return { ok: false, reason: 'unmapped' };
  try {
    const res = fakeTrigger
      ? await fakeTrigger({ slot })
      : await withObs(conn, (request) => mediaSequence(request, slot));
    logger.info?.('media triggered', {
      input: slot.input,
      action: slot.action || DEFAULT_ACTION,
      scene: slot.scene || null,
    });
    return { ok: true, played: true, shown: Boolean(res?.shown) };
  } catch (err) {
    // Expected whenever the streamer's PC is off, OBS is closed, or the source
    // was renamed in OBS but not in the slot map. Log it and tell the mod.
    logger.warn?.('media trigger failed', { input: slot.input, err: String(err?.message || err) });
    return { ok: false, reason: String(err?.message || err) };
  }
}

/**
 * Ask OBS what inputs exist. This is what makes the slot map usable: source names
 * must match OBS EXACTLY, and guessing at them from memory is how you get a slot
 * that silently does nothing.
 *
 * @param {string|null} [kind] restrict to one input kind, e.g. `ffmpeg_source`
 *   (Media Source). Pass null for everything.
 * @returns {Promise<{ ok: boolean, inputs?: Array<{name: string, kind: string}>, reason?: string }>}
 */
export async function listInputs(kind = null, logger = console) {
  if (!conn) return { ok: false, reason: 'not configured' };
  try {
    const data = await withObs(conn, (request) =>
      request('GetInputList', kind ? { inputKind: kind } : {}),
    );
    const inputs = (data?.inputs || []).map((i) => ({
      name: i.inputName,
      kind: i.inputKind,
    }));
    return { ok: true, inputs };
  } catch (err) {
    logger.warn?.('input list failed', { err: String(err?.message || err) });
    return { ok: false, reason: String(err?.message || err) };
  }
}
