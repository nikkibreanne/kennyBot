// Local high-quality capture trigger — the "grab the last N seconds on the
// streamer's PC" half of a clip.
//
// A Twitch clip is capped at the STREAM resolution, so `!clip` alone can never
// give you a 4K keepsake. This fires a second, local capture at full recording
// quality on the streamer's machine (reached over the tailnet), which the
// okra-clip-archiver then picks up.
//
// Backend-agnostic on purpose: obs-websocket today (free, password-authed, built
// into OBS 28+), Aitum's :7777 rule API later. Commands call `triggerCapture()`
// and never learn which one is configured.
//
// EVERY failure here is non-fatal. The streamer's PC may be off, OBS may be
// closed, the tailnet may be down — none of that may break `!clip`, which still
// produces a perfectly good Twitch clip on its own.
//
// RATE LIMITING is global, and deliberately separate from !clip's cooldown. That
// cooldown is per-user, so N viewers can each clip within the same minute — fine
// for Twitch clips (free, server-side) but not for local saves, where every
// trigger writes hundreds of MB and then has to be shipped over the streamer's
// upload. This gate is channel-wide: a burst of !clips yields one local capture.

import { saveReplayBuffer, websocketAvailable } from './obsWebsocket.js';

/** Resolved once at boot from env; `null` when no capture backend is set up. */
let cfg = null;
/** When the last capture actually fired — the global rate gate. */
let lastAt = 0;

/**
 * @param {{ backend?: string, url?: string, password?: string, timeoutMs?: number }} [opts]
 * @param {any} [logger]
 */
export function initCapture(opts = {}, logger = console) {
  const url = opts.url ?? process.env.OBS_WEBSOCKET_URL ?? '';
  const backend = (opts.backend ?? process.env.CAPTURE_BACKEND ?? (url ? 'obs-websocket' : 'none')).toLowerCase();

  if (backend === 'none' || !url) {
    cfg = null;
    logger.info?.('local capture disabled (no OBS_WEBSOCKET_URL) — !clip will make Twitch clips only');
    return;
  }
  if (backend !== 'obs-websocket') {
    cfg = null;
    logger.warn?.('unknown CAPTURE_BACKEND — local capture disabled', { backend });
    return;
  }
  if (!websocketAvailable()) {
    cfg = null;
    logger.warn?.('local capture disabled — this Node build lacks WebSocket (needs Node 22+)');
    return;
  }

  cfg = {
    backend,
    url,
    password: opts.password ?? process.env.OBS_WEBSOCKET_PASSWORD ?? '',
    timeoutMs: opts.timeoutMs ?? Number(process.env.OBS_TIMEOUT_MS || 8000),
    minIntervalMs: opts.minIntervalMs ?? Number(process.env.CAPTURE_MIN_INTERVAL_MS || 60_000),
  };
  lastAt = 0;
  logger.info?.('local capture ready', { backend, url, minIntervalMs: cfg.minIntervalMs });
}

/** Test seam: inject a fake trigger. Pass `null` to disable capture. */
export function initCaptureWith(fn, { minIntervalMs = 0 } = {}) {
  cfg = fn ? { backend: 'test', trigger: fn, minIntervalMs } : null;
  lastAt = 0;
}

/** True when a capture backend is configured. */
export function captureReady() {
  return cfg !== null;
}

/**
 * Fire the local capture. Never throws.
 * @returns {Promise<{ ok: boolean, path?: string|null, started?: boolean, reason?: string }>}
 */
export async function triggerCapture(logger = console, now = Date.now()) {
  if (!cfg) return { ok: false, reason: 'not configured' };

  const since = now - lastAt;
  if (cfg.minIntervalMs && lastAt && since < cfg.minIntervalMs) {
    const retryInMs = cfg.minIntervalMs - since;
    logger.info?.('local capture skipped — rate limited', { retryInMs });
    return { ok: false, reason: 'rate-limited', retryInMs };
  }
  // Claim the slot BEFORE awaiting, so concurrent !clips can't both slip through.
  lastAt = now;

  try {
    const res = cfg.backend === 'test' ? await cfg.trigger() : await saveReplayBuffer(cfg);
    logger.info?.('local capture saved', { path: res?.path ?? null, startedBuffer: Boolean(res?.started) });
    return { ok: true, path: res?.path ?? null, started: Boolean(res?.started) };
  } catch (err) {
    // A failed attempt shouldn't burn the rate-limit window — let the next !clip
    // retry immediately (the PC may have just come back).
    lastAt = 0;
    // Expected whenever the streamer's PC is off or OBS is closed — log, move on.
    logger.warn?.('local capture failed (Twitch clip is unaffected)', { err: String(err?.message || err) });
    return { ok: false, reason: String(err?.message || err) };
  }
}
