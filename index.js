// kennyBot — Twitch chat + raid-game backend (entry point / wiring only).
// Connects chat (twurple) + the live gate + Firebase, routes events to the
// command registry and the game engine, and enforces the single-instance lease.
// Outbound-only: listens on nothing (IMPLEMENTATION §B).
import 'dotenv/config';
import { writeFile } from 'node:fs/promises';
import { ApiClient } from '@twurple/api';
import { ChatClient } from '@twurple/chat';

import { logger } from './src/logger.js';
import { config } from './src/config.js';
import { initFirebase, closeFirebase } from './src/db/firebase.js';
import { startConfigMirror, setLive } from './src/db/configStore.js';
import { acquireLock, startHeartbeat, releaseLock, defaultInstanceId } from './src/db/lock.js';
import { TokenStore } from './src/db/tokenStore.js';
import { buildAuth } from './src/twitch/auth.js';
import { startLivePoll } from './src/twitch/liveGate.js';
import { startEventSub } from './src/twitch/eventsub.js';
import { advanceRaidPhases } from './src/db/raid.js';
import { createMessageHandler } from './src/events/chat.js';
import { attachTwitchEvents } from './src/events/twitchEvents.js';
import { startDropScheduler } from './src/events/dropScheduler.js';
import { processDrops } from './src/db/drops.js';

const HEARTBEAT_FILE = process.env.HEARTBEAT_FILE || '/tmp/kennybot.heartbeat';

// Health snapshot written to HEARTBEAT_FILE for the container HEALTHCHECK. More
// than a liveness ping: it records whether the Twitch chat socket is actually
// connected, so a "process alive but chat wedged" zombie reads unhealthy and the
// orchestrator restarts it, rather than the check passing on a dead connection.
const health = { chatConnected: false, live: false };

// Shutdown is wired up inside main(); module scope holds the reference so signal
// handlers and the lease-lost callback can trigger it cleanly.
let doShutdown = null;
let shuttingDown = false;

function requireEnv() {
  const missing = [];
  for (const key of ['TWITCH_CLIENT_ID', 'TWITCH_CLIENT_SECRET', 'TWITCH_CHANNEL']) {
    if (!process.env[key]) missing.push(key);
  }
  if (!process.env.FIREBASE_DATABASE_EMULATOR_HOST) {
    if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) missing.push('GOOGLE_APPLICATION_CREDENTIALS');
    if (!process.env.FIREBASE_DATABASE_URL) missing.push('FIREBASE_DATABASE_URL');
  }
  if (missing.length) {
    logger.error('missing required environment', { missing });
    process.exit(1);
  }
}

async function touchHeartbeat() {
  try {
    await writeFile(HEARTBEAT_FILE, JSON.stringify({ ts: Date.now(), ...health }));
  } catch {
    /* best effort */
  }
}

async function main() {
  requireEnv();
  const channel = process.env.TWITCH_CHANNEL;
  const instanceId = defaultInstanceId();
  const shutdownHooks = [];

  doShutdown = async function shutdown(reason) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutting down', { reason });
    // A hung dependency (a wedged socket close, a stuck RTDB op) must not trap
    // the process — force exit if graceful cleanup overruns. Also keeps us inside
    // Docker's stop grace period (it SIGKILLs after ~10s).
    const watchdog = setTimeout(() => {
      logger.error('shutdown timed out — forcing exit');
      process.exit(1);
    }, 5000);
    watchdog.unref?.();
    for (const hook of shutdownHooks.reverse()) {
      try {
        await hook();
      } catch (err) {
        logger.warn('shutdown hook failed', { err: String(err) });
      }
    }
    await closeFirebase().catch(() => {});
    clearTimeout(watchdog);
    process.exit(0);
  };

  logger.info('kennyBot starting', {
    channel,
    instanceId,
    emulator: Boolean(process.env.FIREBASE_DATABASE_EMULATOR_HOST),
  });

  // ── Firebase + config mirror ──
  initFirebase();
  await startConfigMirror(logger);

  // ── Single-instance lease (correctness invariant) ──
  const { acquired, holder } = await acquireLock({ instanceId });
  if (!acquired) {
    logger.error('another instance holds the lease — refusing to start', { holder });
    await closeFirebase();
    process.exit(1);
  }
  shutdownHooks.push(
    startHeartbeat({
      instanceId,
      onLost: (h) => {
        logger.error('lost single-instance lease — shutting down', { holder: h });
        doShutdown('lease-lost');
      },
    }),
  );
  shutdownHooks.push(() => releaseLock({ instanceId }));

  // ── Twitch auth (persisted refresh token) ──
  const tokenStore = new TokenStore(process.env.TOKEN_STORE_DIR || './.tokens');
  const { authProvider, addRole } = await buildAuth({
    clientId: process.env.TWITCH_CLIENT_ID,
    clientSecret: process.env.TWITCH_CLIENT_SECRET,
    tokenStore,
    logger,
  });

  const botUserId = await addRole('bot', process.env.TWITCH_BOT_REFRESH_TOKEN, ['chat']);
  if (!botUserId) {
    logger.error('no bot token available (set TWITCH_BOT_REFRESH_TOKEN for first run)');
    await doShutdown('no-bot-token');
    return;
  }
  const broadcasterUserId = process.env.TWITCH_BROADCASTER_REFRESH_TOKEN
    ? await addRole('broadcaster', process.env.TWITCH_BROADCASTER_REFRESH_TOKEN, [])
    : null;

  const apiClient = new ApiClient({ authProvider });

  // Resolve the channel's user id (for live polling + EventSub).
  const channelUser = await apiClient.users.getUserByName(channel);
  if (!channelUser) {
    logger.error('could not resolve channel user', { channel });
    await doShutdown('bad-channel');
    return;
  }
  const channelUserId = channelUser.id;

  // ── Resolve-on-boot: advance raid phases by stored timestamps, never a timer
  //    a restart could lose (§H.5 / §L.1). Loop to catch up after downtime
  //    (e.g. signup→locked→live→done all overdue).
  for (let i = 0; i < 5; i++) {
    const t = await advanceRaidPhases();
    if (!t) break;
    logger.info('raid phase advanced on boot', t);
  }

  // ── Chat ──
  const chat = new ChatClient({ authProvider, channels: [channel] });
  chat.onMessage(createMessageHandler({ chat, channel, botUserId, logger, onActivity: touchHeartbeat }));
  chat.onConnect(() => {
    health.chatConnected = true;
    touchHeartbeat();
    logger.info('chat connected', { channel });
  });
  chat.onDisconnect((manual, reason) => {
    health.chatConnected = false;
    touchHeartbeat();
    logger.warn('chat disconnected', { manual, reason: String(reason || '') });
  });
  shutdownHooks.push(attachTwitchEvents({ chat, channel, logger }));
  await chat.connect();
  shutdownHooks.push(() => chat.quit());

  // Auto chat-drop scheduler (mod-toggled via !drops; fires only while live).
  shutdownHooks.push(startDropScheduler({ chat, channel, logger }));

  // ── Live gate: Helix poll (always) + EventSub (when broadcaster auth fits) ──
  const setLiveBound = (live, source) => {
    health.live = live;
    return setLive(live, source, logger);
  };
  shutdownHooks.push(
    startLivePoll({
      apiClient,
      broadcasterUserId: channelUserId,
      setLive: setLiveBound,
      pollIntervalMs: config.liveGate.pollIntervalMs,
      logger,
    }),
  );

  const eventSubActive = Boolean(broadcasterUserId && broadcasterUserId === channelUserId);
  if (eventSubActive) {
    const { stop } = startEventSub({ apiClient, broadcasterUserId: channelUserId, setLive: setLiveBound, logger });
    shutdownHooks.push(stop);
    logger.info('eventsub started (push live detection)');
  } else {
    logger.info('eventsub disabled — running on Helix poll only', {
      reason: broadcasterUserId ? 'broadcaster token is not the channel owner' : 'no broadcaster token',
    });
  }

  // ── Periodic phase tick (live cadence; authoritative trigger is stored
  //    locksAt/startsAt/doneAt compared at boot + here) ──
  const phaseTimer = setInterval(async () => {
    try {
      const t = await advanceRaidPhases();
      if (t) logger.info('raid phase advanced', t);
    } catch (err) {
      logger.error('phase tick failed', { err: String(err) });
    }
  }, 30_000);
  phaseTimer.unref?.();
  shutdownHooks.push(() => clearInterval(phaseTimer));

  // ── Loot lottery: close expired drops and draw a single winner (spec §5.2) ──
  const drawTimer = setInterval(async () => {
    try {
      const { drawResult, activated } = await processDrops();
      if (drawResult) {
        if (drawResult.winner) {
          chat
            .say(
              channel,
              `🎉 @${drawResult.winner.name || 'a lucky grabber'} won the ${drawResult.item?.rarity ?? ''} ${drawResult.item?.name ?? 'drop'}! (${drawResult.count} entered) — it's in their !bag.`,
            )
            .catch(() => {});
          logger.info('drop drawn', { item: drawResult.itemId, winner: drawResult.winner.userId, entrants: drawResult.count });
        } else {
          logger.info('drop expired with no entrants', { item: drawResult.itemId });
        }
      }
      if (activated) {
        const secs = Math.round(config.loot.windowMs / 1000);
        chat
          .say(channel, `⏭️ Next up — a ${activated.rarity} ${activated.name} is open! !grab within ${secs}s to enter the draw.`)
          .catch(() => {});
      }
    } catch (err) {
      logger.error('drop draw tick failed', { err: String(err) });
    }
  }, 10_000);
  drawTimer.unref?.();
  shutdownHooks.push(() => clearInterval(drawTimer));

  // ── Healthcheck heartbeat (file-based; no listener, §E) ──
  await touchHeartbeat();
  const hbTimer = setInterval(touchHeartbeat, 30_000);
  hbTimer.unref?.();
  shutdownHooks.push(() => clearInterval(hbTimer));

  logger.info('kennyBot ready', { channel, botUserId, channelUserId, eventsub: eventSubActive });
}

// First signal → graceful shutdown (itself watchdog-bounded above). A second
// signal (impatient Ctrl-C, or Docker escalating) → hard exit immediately.
let signalCount = 0;
function onSignal() {
  signalCount += 1;
  if (signalCount >= 2) {
    process.stderr.write('forced exit\n');
    process.exit(1);
  }
  if (doShutdown) doShutdown('signal');
  else process.exit(0);
}
process.on('SIGINT', onSignal);
process.on('SIGTERM', onSignal);
process.on('unhandledRejection', (err) => logger.error('unhandledRejection', { err: String(err?.stack || err) }));
process.on('uncaughtException', (err) => {
  logger.error('uncaughtException', { err: String(err?.stack || err) });
  if (doShutdown) doShutdown('uncaught');
  else process.exit(1);
});

main().catch(async (err) => {
  logger.error('fatal startup error', { err: String(err?.stack || err) });
  await closeFirebase().catch(() => {});
  process.exit(1);
});
