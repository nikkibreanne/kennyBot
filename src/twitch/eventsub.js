// EventSub over WebSocket (IMPLEMENTATION §B — the load-bearing transport
// decision). The bot DIALS OUT to eventsub.wss.twitch.tv; Twitch streams events
// back down the socket we opened. Outbound-only: no inbound endpoint, no public
// surface. @twurple/eventsub-ws handles welcome/keepalive/reconnect/session
// resets for us (IMPLEMENTATION §J).
//
// stream.online/offline drive the live gate (spec §5.1). Subscribing requires
// the BROADCASTER's user auth in the provider — so this is OPTIONAL: if no
// broadcaster token is configured, the bot runs on the Helix poll alone.

import { EventSubWsListener } from '@twurple/eventsub-ws';

/**
 * @param {{
 *   apiClient: import('@twurple/api').ApiClient,
 *   broadcasterUserId: string,
 *   setLive: (live: boolean, source: string) => Promise<any>,
 *   logger?: any,
 * }} args
 * @returns {{ stop: () => void }}
 */
export function startEventSub({ apiClient, broadcasterUserId, setLive, logger = console }) {
  const listener = new EventSubWsListener({ apiClient });
  listener.start();

  const online = listener.onStreamOnline(broadcasterUserId, async (e) => {
    // Only a real "live" broadcast — exclude reruns/premieres/watch-parties.
    if (e.streamType && e.streamType !== 'live') {
      logger.info?.('stream.online ignored (non-live type)', { type: e.streamType });
      return;
    }
    logger.info?.('eventsub stream.online');
    await setLive(true, 'eventsub');
  });

  const offline = listener.onStreamOffline(broadcasterUserId, async () => {
    logger.info?.('eventsub stream.offline');
    await setLive(false, 'eventsub');
  });

  // Surface subscription failures (e.g. missing broadcaster auth) instead of
  // failing silently — the Helix poll still covers the gate.
  for (const sub of [online, offline]) {
    sub.onAuthRevoke?.(() => logger.warn?.('eventsub auth revoked'));
  }
  listener.onSubscriptionCreateFailure?.((_sub, err) =>
    logger.error?.('eventsub subscription failed', { err: String(err) }),
  );
  listener.onUserSocketDisconnect?.((_userId, err) =>
    logger.warn?.('eventsub socket disconnected', { err: err ? String(err) : null }),
  );

  return { stop: () => listener.stop() };
}
