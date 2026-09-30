// NOW PLAYING — the pure half of `!song`: turning Spotify's payload into the one
// line chat sees, and the shorter one the on-stream overlay shows.
//
// Pure like every other src/rules module: no HTTP, no config, no OBS. Spotify's
// response has more shapes than "a song is playing" suggests, and each of them is
// a line someone reads on stream — so they get tested rather than assumed:
//
//   nothing playing   · 204 or an empty body, when Spotify is closed
//   paused            · is_playing:false, but `item` is still populated
//   a podcast         · currently_playing_type "episode" — `artists` does not exist
//   an advert         · type "ad", with item null on free accounts
//   a local file      · a real track with no external_urls
//
// The one that bites is `artists` being absent on episodes: reading
// `item.artists[0]` throws mid-command and the reply never arrives.

/** Longest track/artist text before it gets clipped, so one line stays one line. */
export const MAX_TITLE_LEN = 120;

/** `1:23` / `1:02:03` — mm:ss unless it's over an hour. */
export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '0:00';
  const total = Math.floor(ms / 1000);
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const mm = h ? String(m).padStart(2, '0') : String(m);
  return `${h ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`;
}

/** Clip to a sane length without cutting mid-word where avoidable. */
export function clip(text, max = MAX_TITLE_LEN) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${space > max * 0.6 ? cut.slice(0, space) : cut}…`;
}

/** "A, B & C" — Spotify hands back every credited artist, which can be a lot. */
export function joinArtists(artists = []) {
  const names = artists.map((a) => a?.name).filter(Boolean);
  if (!names.length) return '';
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(', ')} & ${names.at(-1)}`;
}

/**
 * Normalise a currently-playing payload into everything the callers need.
 *
 * @param {object|null} payload the parsed body, or null for 204 / empty
 * @returns {{
 *   kind: 'track'|'episode'|'ad'|'nothing',
 *   playing: boolean, title: string, subtitle: string,
 *   url: string|null, progressMs: number|null, durationMs: number|null,
 * }}
 */
export function readNowPlaying(payload) {
  const none = {
    kind: 'nothing', playing: false, title: '', subtitle: '',
    url: null, progressMs: null, durationMs: null,
  };
  if (!payload || typeof payload !== 'object') return none;

  const type = payload.currently_playing_type;
  const item = payload.item;

  // An advert has no item on a free account. It is still "something is happening",
  // and saying so is better than claiming nothing is playing.
  if (type === 'ad') return { ...none, kind: 'ad' };
  if (!item) return none;

  const playing = Boolean(payload.is_playing);
  const progressMs = Number.isFinite(payload.progress_ms) ? payload.progress_ms : null;
  const durationMs = Number.isFinite(item.duration_ms) ? item.duration_ms : null;
  // A local file has no Spotify URL — the field is absent, not empty.
  const url = item.external_urls?.spotify || null;

  if (type === 'episode' || item.show) {
    return {
      kind: 'episode', playing, url, progressMs, durationMs,
      title: clip(item.name || ''),
      subtitle: clip(item.show?.name || ''),
    };
  }

  return {
    kind: 'track', playing, url, progressMs, durationMs,
    title: clip(item.name || ''),
    subtitle: clip(joinArtists(item.artists)),
  };
}

/**
 * The chat reply for `!song`. Says what is true rather than guessing: paused is
 * not the same as nothing playing, and a listener asking during an ad deserves
 * to know that's what they're hearing.
 */
export function chatLine(np) {
  switch (np.kind) {
    case 'nothing':
      return '🎧 nothing is playing right now';
    case 'ad':
      return '🎧 Spotify is playing an ad right now';
    case 'episode': {
      const where = np.progressMs != null && np.durationMs
        ? ` (${formatDuration(np.progressMs)}/${formatDuration(np.durationMs)})`
        : '';
      const state = np.playing ? '' : ' — paused';
      return `🎙️ ${np.subtitle ? `${np.subtitle}: ` : ''}${np.title}${where}${state}`;
    }
    default: {
      const where = np.progressMs != null && np.durationMs
        ? ` (${formatDuration(np.progressMs)}/${formatDuration(np.durationMs)})`
        : '';
      const state = np.playing ? '' : ' — paused';
      const link = np.url ? ` ${np.url}` : '';
      return `🎧 ${np.subtitle ? `${np.subtitle} — ` : ''}${np.title}${where}${state}${link}`;
    }
  }
}

/**
 * The on-stream overlay line. No link (unclickable on a video), no timestamp (it
 * would rewrite the source every poll and still be wrong between polls), and no
 * emoji — the OBS text source has its own styling.
 *
 * Returns '' for anything not worth showing, which the scheduler treats as
 * "clear the overlay" rather than "leave the last song up forever".
 *
 * `prefix` is passed in rather than read from config, because this module is pure
 * — the caller owns the setting. It is applied ONLY to a non-empty line: a bare
 * "Now Playing:" over a black box, with nothing after it, is worse than nothing.
 */
export function overlayLine(np, { prefix = '' } = {}) {
  if (np.kind === 'nothing' || np.kind === 'ad') return '';
  if (!np.playing) return '';
  const title = clip(np.title, 60);
  const sub = clip(np.subtitle, 60);
  return `${prefix}${sub ? `${sub} — ${title}` : title}`;
}
