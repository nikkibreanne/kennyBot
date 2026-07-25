// Clip-sync "clapperboard" anchors. On `!start` kennyBot stamps a per-stream sync
// point in RTDB; the SEPARATE okra-clip-archiver tool reads it (public-read) to
// align a stream's Twitch clips to the local 4K recording. kennyBot only writes
// the anchor — it does no clip processing itself.
import { database, PATHS, SERVER_TIMESTAMP } from './firebase.js';

/**
 * Record a stream sync anchor. Returns the generated session id.
 * @param {{ channel: string, startedBy: string, markerClipId?: string|null }} args
 * @returns {Promise<{ sessionId: string }>}
 */
export async function startSession({ channel, startedBy, markerClipId = null }) {
  const ref = database().ref(PATHS.clipSync()).push();
  await ref.set({
    startedAt: SERVER_TIMESTAMP, // the clapperboard instant (server wall-clock)
    channel,
    startedBy,
    ...(markerClipId ? { markerClipId } : {}),
  });
  return { sessionId: ref.key };
}

/** Best-effort: stamp an end time on a session (optional `!end`). */
export async function endSession(sessionId) {
  await database().ref(`${PATHS.clipSession(sessionId)}/endedAt`).set(SERVER_TIMESTAMP);
  return sessionId;
}
