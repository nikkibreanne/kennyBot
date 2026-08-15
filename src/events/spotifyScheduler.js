// NOW-PLAYING OVERLAY — keeps an OBS text source showing the current track.
//
// Polls Spotify and writes the line into a text source over the same
// obs-websocket connection everything else uses. The source is named by
// SPOTIFY_OVERLAY_SOURCE; unset means no overlay and no polling at all.
//
// WRITES ONLY ON CHANGE. A text source rewritten every ten seconds with identical
// content is pure churn — and in OBS a settings write is not free, it re-renders
// the source. So the last written value is held in memory and compared first.
//
// Memory, not the database, on purpose: this is a cache of what OBS was last told,
// not state worth surviving a restart. After a restart the first poll writes
// whatever is playing, which is correct by construction.
//
// An empty line (nothing playing, paused, an ad) CLEARS the overlay rather than
// leaving the last song frozen on screen — a stale track name is worse than none,
// because viewers believe it.

import { withObs, obsConnectionFromEnv } from '../integrations/obsWebsocket.js';
import { currentlyPlaying, spotifyReady } from '../integrations/spotify.js';
import { readNowPlaying, overlayLine } from '../rules/spotify.js';
import { config } from '../config.js';

/**
 * @param {{ sourceName?: string, logger?: any, intervalMs?: number }} deps
 * @returns {() => void} stop
 */
export function startSpotifyOverlay({ sourceName, logger = console, intervalMs } = {}) {
  const source = sourceName ?? process.env.SPOTIFY_OVERLAY_SOURCE ?? '';
  const every = intervalMs ?? config.spotify.overlayPollMs;

  if (!source) {
    logger.info?.('spotify overlay disabled (no SPOTIFY_OVERLAY_SOURCE)');
    return () => {};
  }
  if (!spotifyReady()) {
    logger.info?.('spotify overlay disabled (spotify not connected)');
    return () => {};
  }
  if (!obsConnectionFromEnv()) {
    logger.info?.('spotify overlay disabled (no OBS_WEBSOCKET_URL)');
    return () => {};
  }

  let lastWritten = null;
  let stopped = false;
  let running = false;

  async function tick() {
    // A slow poll must never overlap the next one — Spotify and OBS are both
    // network hops, and two writes racing would fight over the same source.
    if (stopped || running) return;
    running = true;
    try {
      const res = await currentlyPlaying(logger);
      if (!res.ok) return; // already logged; keep whatever is on screen
      const line = overlayLine(readNowPlaying(res.payload), { prefix: config.spotify.overlayPrefix });
      if (line === lastWritten) return;

      await withObs(obsConnectionFromEnv(), (request) =>
        request('SetInputSettings', { inputName: source, inputSettings: { text: line }, overlay: true }),
      );
      lastWritten = line;
      logger.info?.('spotify overlay updated', { source, text: line || '(cleared)' });
    } catch (err) {
      // OBS closed, PC asleep, source renamed — all expected, none fatal. Reset
      // so the next successful poll rewrites rather than believing OBS still
      // shows what we last sent it.
      lastWritten = null;
      logger.warn?.('spotify overlay update failed', { source, err: String(err?.message || err) });
    } finally {
      running = false;
    }
  }

  logger.info?.('spotify overlay started', { source, everyMs: every });
  const timer = setInterval(tick, every);
  timer.unref?.();
  tick();

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
