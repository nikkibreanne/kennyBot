// !song / !nowplaying / !np — what the streamer's Spotify is playing.
//
// Public: it is read-only, it names music rather than anything about the rig, and
// "what's this song?" is the single most common question a music stream gets.
//
// The per-user cooldown is the usual gate, but the real protection is the cache in
// the integration — twenty viewers asking at once is ONE Spotify request, and the
// answer cannot meaningfully change in the couple of seconds between them.
//
// Every not-playing case is a real sentence rather than silence, because the
// states are genuinely different and viewers can tell: paused is not stopped, and
// an ad is not a song. Those distinctions live in src/rules/spotify.js.
import { currentlyPlaying, spotifyReady } from '../integrations/spotify.js';
import { readNowPlaying, chatLine } from '../rules/spotify.js';

export default {
  names: ['song', 'nowplaying', 'np'],
  mod: false,
  cooldownMs: 10_000,
  help: '!song — what is playing on Spotify right now',
  async run({ reply, logger }) {
    if (!spotifyReady()) {
      reply('🎧 Spotify isn\'t connected for this bot');
      return;
    }
    const res = await currentlyPlaying(logger);
    if (!res.ok) {
      // Spotify's own words, not ours — "rate limited, retry in 3s" tells a viewer
      // something useful, where "something went wrong" tells them nothing.
      reply(`🎧 couldn't reach Spotify: ${res.reason}`);
      return;
    }
    reply(chatLine(readNowPlaying(res.payload)));
  },
};
