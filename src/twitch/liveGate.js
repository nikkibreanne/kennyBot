// Live detection — the riskiest unknown (IMPLEMENTATION §H.1). tmi/chat can't
// report live status, and EXP integrity depends on it (spec §5.1). This is the
// Helix POLL FALLBACK: a cheap safety net that works with only the bot token.
// EventSub (eventsub.js) is the push-based primary when a broadcaster token is
// available; both feed the same idempotent setLive(), so they never fight.

/**
 * @param {{
 *   apiClient: import('@twurple/api').ApiClient,
 *   broadcasterUserId: string,
 *   setLive: (live: boolean, source: string) => Promise<any>,
 *   pollIntervalMs: number,
 *   logger?: any,
 * }} args
 * @returns {() => void} stop function
 */
export function startLivePoll({ apiClient, broadcasterUserId, setLive, pollIntervalMs, logger = console }) {
  let stopped = false;

  async function pollOnce() {
    if (stopped) return;
    try {
      const stream = await apiClient.streams.getStreamByUserId(broadcasterUserId);
      // Exclude reruns/premieres/watch-parties — only a real live broadcast counts.
      const live = Boolean(stream && stream.type === 'live');
      await setLive(live, 'helix-poll');
    } catch (err) {
      logger.warn?.('helix live poll failed', { err: String(err) });
    }
  }

  pollOnce(); // prime immediately so we don't wait a full interval at boot
  const timer = setInterval(pollOnce, pollIntervalMs);
  timer.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
