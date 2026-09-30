// Spotify "now playing" — reads what the STREAMER'S ACCOUNT is playing.
//
// The Web API is account-scoped, not device-scoped: this returns whatever that
// Spotify account is playing on any device — desktop, phone, web. So the bot does
// NOT need to run on the machine Spotify is on, and nothing is installed there.
// That is the whole reason this is an API integration rather than a local scrape.
//
// You can only ever read your OWN account. There is no endpoint for "what is user
// X playing"; anyone else's playback would require them to authorise this app.
//
// Auth is the same shape as the Twitch bot token: a refresh token obtained once,
// interactively, by scripts/get-spotify-token.mjs, then persisted through the same
// TokenStore. The bot stays outbound-only — the only thing that ever listened on a
// port is that one-off script.
//
// Failure is never fatal. Spotify being down, the token being revoked, or the
// account being in a private session all resolve to `{ ok:false, reason }`, and
// chat gets a sentence instead of silence.

import { TokenStore } from '../db/tokenStore.js';
import { config } from '../config.js';

const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const NOW_PLAYING_URL =
  'https://api.spotify.com/v1/me/player/currently-playing?additional_types=track,episode';

/** The TokenStore key. Not a Twitch user id — just a stable filename. */
const STORE_KEY = 'spotify';

let cfg = null;         // { clientId, clientSecret, store }
let access = null;      // { token, expiresAt }
let refreshToken = null;
let cache = null;       // { at, payload } — see currentlyPlaying
/** Test seam: stands in for the whole HTTP round trip. */
let fakeFetch = null;

/**
 * @param {{clientId?: string, clientSecret?: string, refreshToken?: string, storeDir?: string}} [opts]
 */
export async function initSpotify(opts = {}, logger = console) {
  fakeFetch = null;
  access = null;
  cache = null;
  const clientId = opts.clientId ?? process.env.SPOTIFY_CLIENT_ID ?? '';
  const clientSecret = opts.clientSecret ?? process.env.SPOTIFY_CLIENT_SECRET ?? '';
  if (!clientId || !clientSecret) {
    cfg = null;
    logger.info?.('spotify disabled (no SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET)');
    return;
  }

  const store = new TokenStore(opts.storeDir ?? process.env.TOKEN_STORE_DIR ?? './.tokens');
  // A stored token wins over the env one: Spotify MAY hand back a new refresh
  // token on any refresh, and the stored copy is the one that has been rotated.
  const saved = await store.load(STORE_KEY).catch(() => null);
  refreshToken = saved?.refreshToken || opts.refreshToken || process.env.SPOTIFY_REFRESH_TOKEN || '';
  if (!refreshToken) {
    cfg = null;
    logger.warn?.('spotify disabled — no refresh token. Run: node scripts/get-spotify-token.mjs');
    return;
  }

  cfg = { clientId, clientSecret, store };
  logger.info?.('spotify ready', { source: saved?.refreshToken ? 'token store' : 'env' });
}

/** Test seam: `fn(url, init)` replaces fetch. Pass null to disable Spotify. */
export function initSpotifyWith(fn) {
  fakeFetch = fn || null;
  cfg = fn ? { clientId: 'test', clientSecret: 'test', store: null } : null;
  refreshToken = fn ? 'test-refresh' : null;
  access = null;
  cache = null;
}

/** True when Spotify is configured and has a refresh token. */
export function spotifyReady() {
  return cfg !== null;
}

const http = (url, init) => (fakeFetch ? fakeFetch(url, init) : fetch(url, init));

/**
 * Exchange the refresh token for an access token, reusing the live one until it
 * is nearly expired. Spotify's access tokens last an hour.
 */
async function accessToken() {
  if (access && access.expiresAt > Date.now() + 30_000) return access.token;

  const res = await http(TOKEN_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      // Client credentials go in the Basic header, not the body — Spotify accepts
      // both, but the header form keeps the secret out of any body logging.
      authorization: `Basic ${Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64')}`,
    },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`token refresh failed (${res.status})${body ? `: ${body.slice(0, 120)}` : ''}`);
  }
  const json = await res.json();
  access = { token: json.access_token, expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000 };

  // Spotify MAY rotate the refresh token. Persisting it is the difference between
  // this surviving a restart and silently needing the interactive login again.
  if (json.refresh_token && json.refresh_token !== refreshToken) {
    refreshToken = json.refresh_token;
    await cfg.store?.save(STORE_KEY, { refreshToken, obtainmentTimestamp: Date.now() }).catch(() => {});
  }
  return access.token;
}

/**
 * What the account is playing right now. Never throws.
 *
 * Cached briefly: `!song` is the kind of command chat piles onto, and the answer
 * cannot meaningfully change in a couple of seconds. The overlay poller shares
 * this cache, so a viewer asking mid-poll costs nothing.
 *
 * @returns {Promise<{ok: true, payload: object|null} | {ok: false, reason: string}>}
 */
export async function currentlyPlaying(logger = console, now = Date.now()) {
  if (!cfg) return { ok: false, reason: 'not configured' };
  if (cache && now - cache.at < config.spotify.cacheMs) return { ok: true, payload: cache.payload };

  try {
    const token = await accessToken();
    const res = await http(NOW_PLAYING_URL, { headers: { authorization: `Bearer ${token}` } });

    // 204 is Spotify's "nothing is playing" — not an error, and the body is empty
    // so parsing it would throw. A private session looks identical from here.
    if (res.status === 204) {
      cache = { at: now, payload: null };
      return { ok: true, payload: null };
    }
    if (res.status === 429) {
      const retry = res.headers?.get?.('retry-after');
      return { ok: false, reason: `rate limited${retry ? `, retry in ${retry}s` : ''}` };
    }
    if (!res.ok) return { ok: false, reason: `spotify said ${res.status}` };

    // 200 with an empty body happens too — belt and braces, since a throw here
    // would surface as a broken command rather than "nothing playing".
    const text = await res.text();
    const payload = text ? JSON.parse(text) : null;
    cache = { at: now, payload };
    return { ok: true, payload };
  } catch (err) {
    logger.warn?.('spotify lookup failed', { err: String(err?.message || err) });
    return { ok: false, reason: String(err?.message || err) };
  }
}
