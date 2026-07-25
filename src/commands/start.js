// !start — the "clapperboard". Drops a per-stream sync anchor in RTDB (clipSync)
// so the separate okra-clip-archiver tool can align this stream's Twitch clips to
// the local 4K recording. When live, best-effort also creates a MARKER Twitch clip
// whose vod_offset pins the VOD timeline precisely. Broadcaster/mod only.
import { getConfig } from '../db/configStore.js';
import { startSession } from '../db/clipSync.js';
import { createChannelClip, clipsReady } from '../twitch/clips.js';

export default {
  names: ['start', 'slate'],
  mod: true,
  cooldownMs: 10_000,
  help: '!start — set a stream sync point for the clip archiver (mods)',
  async run({ user, reply, channel, logger }) {
    // Marker clip is a precision bonus, never a hard requirement — only attempt it
    // while live, and never let its failure block the anchor write.
    let markerClipId = null;
    if (getConfig().live && clipsReady()) {
      try {
        markerClipId = (await createChannelClip()).id;
      } catch (err) {
        logger?.warn?.('start: marker clip failed', { err: String(err) });
      }
    }
    try {
      const { sessionId } = await startSession({ channel, startedBy: user.login, markerClipId });
      reply(
        `🎬 Sync point set${markerClipId ? ' (+ marker clip)' : ''} — the clip archiver can align this stream. [${sessionId.slice(0, 6)}]`,
      );
    } catch (err) {
      logger?.warn?.('start: anchor write failed', { err: String(err) });
      reply(`@${user.displayName} couldn't set the sync point — try again.`);
    }
  },
};
