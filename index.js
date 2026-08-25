// kennyBot — Twitch chat + raid-game backend (entry point / wiring only).
// Connects chat (twurple) + the live gate + Firebase, routes events to the
// command registry and the game engine, and enforces the single-instance lease.
// Outbound-only: listens on nothing (IMPLEMENTATION §B).
import 'dotenv/config';
import { writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { ApiClient } from '@twurple/api';
import { ChatClient } from '@twurple/chat';

import { logger } from './src/logger.js';
import { config } from './src/config.js';
import { initFirebase, closeFirebase } from './src/db/firebase.js';
import { startConfigMirror, setLive, isChatMuted, getConfig, getRaidPointer } from './src/db/configStore.js';
import { acquireLock, startHeartbeat, releaseLock, defaultInstanceId } from './src/db/lock.js';
import { TokenStore } from './src/db/tokenStore.js';
import { buildAuth } from './src/twitch/auth.js';
import { createSender } from './src/twitch/sender.js';
import { initClips } from './src/twitch/clips.js';
import { initCapture, captureReady } from './src/integrations/capture.js';
// Read once at boot purely to log what's in force; the live value is RTDB-backed.
import { activeClipMode } from './src/commands/clip.js';
import { startLivePoll } from './src/twitch/liveGate.js';
import { startEventSub } from './src/twitch/eventsub.js';
import { advanceRaidPhases, refreshMusteredRoster, raidScheduleStatus } from './src/db/raid.js';
import { seedCuratedFacts } from './src/db/facts.js';
import { seedCatalog } from './src/db/catalog.js';
import { createMessageHandler } from './src/events/chat.js';
import { attachTwitchEvents } from './src/events/twitchEvents.js';
import { attachSubathonEvents } from './src/events/subathonEvents.js';
import { startDropScheduler } from './src/events/dropScheduler.js';
import { startTimerScheduler } from './src/events/timerScheduler.js';
import { startReminderScheduler } from './src/events/reminderScheduler.js';
import { seedReminders } from './src/db/reminders.js';
import { processDrops } from './src/db/drops.js';
import { startNoticeMirror } from './src/db/notices.js';
import { findLapsedHero, markInvited } from './src/db/enlistReminder.js';

// Running version, read from the bundled package.json (in the image at /app).
// Surfaced in the startup log + heartbeat so "which release is this box on?"
// is answerable from `docker logs` / the health snapshot — no label inspection.
const APP_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;
  } catch {
    return 'unknown';
  }
})();

const HEARTBEAT_FILE = process.env.HEARTBEAT_FILE || '/tmp/kennybot.heartbeat';

// Health snapshot written to HEARTBEAT_FILE for the container HEALTHCHECK. More
// than a liveness ping: it records whether the Twitch chat socket is actually
// connected, so a "process alive but chat wedged" zombie reads unhealthy and the
// orchestrator restarts it, rather than the check passing on a dead connection.
const health = { version: APP_VERSION, chatConnected: false, live: false, sendMode: null, clipMode: null };

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
    // clipMode is RUNTIME config — a mod can change it with `!clipmode` at any
    // moment, so read it at write time. Capturing it once at boot would make the
    // snapshot quietly lie about what the bot is doing, which is the one thing a
    // health snapshot must never do.
    health.clipMode = activeClipMode();
    await writeFile(HEARTBEAT_FILE, JSON.stringify({ ts: Date.now(), ...health }));
  } catch {
    /* best effort */
  }
}

/**
 * Say what just happened to the raid. Nothing announced these transitions, so a
 * cleared boss paid gear silently into bags — the single biggest reason the raid
 * rewards read as an opaque mechanism. Chat now hears the lock, the result, and
 * who got what.
 * @param {{transition: string, seasonId: string, weekId: string, result?: object}} t
 */
function announceRaidPhase(t, send, logger) {
  try {
    if (t.transition === 'locked') {
      send.say('🔒 The roster is LOCKED — no more !muster. The battle begins shortly; watch it at ' + `${config.siteUrl}/arena/`);
      return;
    }
    if (t.transition === 'live') {
      send.say(`⚔️ RAID NIGHT! The battle is playing out now — watch it at ${config.siteUrl}/arena/`);
      return;
    }
    if (t.transition !== 'done' || !t.result) return;

    const r = t.result;
    if (!r.downed) {
      send.say(`💀 ${r.bossName} survived — the patch was wiped (${r.roster} heroes). No loot this week. Replay: ${config.siteUrl}/arena/`);
      promptNextWeek(send, logger);
      return;
    }
    const mvp = r.mvpName ? ` MVP: @${r.mvpName}.` : '';
    send.say(
      `🏆 ${r.bossName} is DOWN! ${r.survivors}/${r.roster} heroes walked away.${mvp} ` +
      `Everyone who raided got a piece of gear — check !bag, then !equip it.`,
    );
    // The week just closed and nothing schedules the next one — say so here,
    // while it's the obvious next step, rather than letting the game stall.
    promptNextWeek(send, logger);
    // Name the standout drops rather than all of them: one line, not a wall.
    const best = (r.awards || [])
      .filter((a) => a.item && ['epic', 'legendary'].includes(a.item.rarity))
      .slice(0, 3)
      .map((a) => `@${a.name || 'a hero'} → ${a.item.rarity} ${a.item.name}`);
    if (best.length) send.say(`✨ ${best.join(' · ')}`);
  } catch (err) {
    logger.error('raid announce failed', { err: String(err) });
  }
}

/**
 * Say what needs scheduling next, if anything. Weeks are opened by hand
 * (`!boss next`) so the muster window lands while the stream is live — the
 * trade-off is that forgetting is invisible, and a whole week quietly passes
 * with no raid. Called after a battle resolves and, as a backstop, on a slow
 * live-only timer.
 */
async function promptNextWeek(send, logger) {
  try {
    const st = await raidScheduleStatus();
    if (st.open) return false;
    if (st.seasonComplete) {
      send.say(
        st.nextTier
          ? `🏁 ${st.seasonName || st.seasonId} is complete. Mods: !season rollover t${st.nextTier} <name> to start the next tier.`
          : `🏁 ${st.seasonName || st.seasonId} is complete — every boss has been faced. Mods: !season start <id> <name> for a new tier.`,
      );
      return true;
    }
    if (!st.nextWeek) return false;
    send.say(`⏭️ Nothing is scheduled yet — next up is week ${st.nextWeek}, ${st.nextBoss}. Mods: !boss next to open the muster.`);
    return true;
  } catch (err) {
    logger.error('schedule prompt failed', { err: String(err) });
    return false;
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
    version: APP_VERSION,
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

  // ── Seed the curated fun facts (idempotent upsert) so `!fact` and the /info/
  //    page read ONE source. Lease-gated (only the active instance seeds) and
  //    non-fatal — a seed hiccup must never block the bot from coming up. ──
  try {
    const seeded = await seedCuratedFacts();
    logger.info('curated facts seeded', seeded);
  } catch (err) {
    logger.warn('curated fact seed failed (non-fatal)', { err: String(err) });
  }

  // ── Seed the item catalog (idempotent upsert of src/content/items.js into
  //    items/) so the /items/ Compendium renders the same gear the raid engine
  //    uses — ONE source, no drift. Lease-gated + non-fatal, like the fact seed. ──
  try {
    const cat = await seedCatalog();
    logger.info('item catalog seeded', cat);
  } catch (err) {
    logger.warn('item catalog seed failed (non-fatal)', { err: String(err) });
  }

  // ── Seed the default reminders (config/reminders). Creates only what's
  //    MISSING — an id that already exists keeps whatever the mods set, so
  //    edited times and text survive every deploy. Non-fatal like the seeds above. ──
  try {
    const rem = await seedReminders();
    logger.info('reminders seeded', rem);
  } catch (err) {
    logger.warn('reminder seed failed (non-fatal)', { err: String(err) });
  }

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

  // Clip service (Helix Create Clip). Clips in the BOT's user context, so the bot
  // token needs clips:edit and the channel must be live; wired here so the !clip
  // command reaches it without threading the ApiClient through the chat handler.
  initClips({ apiClient, broadcasterId: channelUserId, botUserId });

  // Local full-quality capture on the streamer's PC (obs-websocket over the
  // tailnet), reached whenever !clip's mode includes the local half.
  initCapture({}, logger);

  // What !clip actually does. Default 'local': trigger the streamer's OBS/Aitum
  // capture and post NO Twitch clip — a Twitch clip is capped at the stream
  // resolution, so the local recording is the copy worth keeping. 'twitch'
  // restores the Helix-clip-only behaviour; 'both' does each.
  // Lives in RTDB (`config/clipMode`), seeded once from config.clip.defaultMode and
  // changed live by mods with `!clipmode` — there is no env var to disagree with.
  const clipMode = activeClipMode(); // logged once; the snapshot re-reads it live
  logger.info('clip mode', { mode: clipMode, localCapture: captureReady() });
  if (clipMode === 'local' && !captureReady()) {
    logger.warn(
      '!clip has nothing to do: clip mode is local but no capture backend is configured — set OBS_WEBSOCKET_URL, or switch with `!clipmode twitch` in chat',
    );
  }

  // ── Resolve-on-boot: advance raid phases by stored timestamps, never a timer
  //    a restart could lose (§H.5 / §L.1). Loop to catch up after downtime
  //    (e.g. signup→locked→live→done all overdue).
  // Undelivered raid-reward lines, said when their owner next speaks. The gear
  // itself was handed over at payout — this only restores what's left to SAY.
  try {
    const n = await startNoticeMirror(logger);
    if (n) logger.info('undelivered raid-reward announcements restored', { count: n });
  } catch (err) {
    logger.error('notice mirror failed to start', { err: String(err) });
  }

  // Deliberately SILENT: a battle that resolved during downtime is old news, and
  // announcing it on boot would replay stale results into chat.
  for (let i = 0; i < 5; i++) {
    const t = await advanceRaidPhases();
    if (!t) break;
    logger.info('raid phase advanced on boot', t);
  }

  // ── Chat ──
  const chat = new ChatClient({ authProvider, channels: [channel] });

  // Outbound sender (src/twitch/sender.js). Default 'auto': prefer the Helix
  // Send Chat Message API (the only path that earns the Chat Bot badge) and fall
  // back to IRC if Twitch refuses the grant, so the bot can never go silent
  // because a token or mod status is missing. Reading always stays on the
  // ChatClient. 'helix' forces it (failures surface); 'irc' pins the old path.
  const rawSendMode = (process.env.TWITCH_SEND_MODE || 'auto').toLowerCase();
  const sendMode = ['auto', 'helix', 'irc'].includes(rawSendMode) ? rawSendMode : 'auto';
  if (rawSendMode !== sendMode) {
    logger.warn('unknown TWITCH_SEND_MODE — using auto', { value: process.env.TWITCH_SEND_MODE });
  }
  const sender = createSender({
    mode: sendMode,
    chat,
    apiClient,
    channel,
    broadcasterId: channelUserId,
    botUserId,
    logger,
  });
  logger.info('chat sender ready', { mode: sender.mode, sending: sender.effectiveMode() });

  // Mute-aware wrapper for spontaneous (non-command) announcements — loot draws +
  // the auto-drop scheduler. When a mod mutes the bot (`!mute`) these are
  // suppressed while the bot keeps listening, granting EXP, processing drops, and
  // holding the lease. Command replies + level-ups do their own mute gating inside
  // the handler (which also lets the !mute control itself bypass for confirmation).
  const send = {
    say: (text) => (isChatMuted() ? Promise.resolve() : sender.say(text)),
    action: (text) => (isChatMuted() ? Promise.resolve() : sender.action(text)),
  };
  health.sendMode = sender.effectiveMode();
  chat.onMessage(createMessageHandler({ sender, channel, botUserId, logger, onActivity: touchHeartbeat }));
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
  shutdownHooks.push(attachTwitchEvents({ chat, sender, logger }));
  // Subathon ledger: prices subs/gifts/bits against the current band and appends
  // them. A no-op (not even a read) unless a subathon is actually running.
  shutdownHooks.push(attachSubathonEvents({ chat, logger }));
  await chat.connect();
  shutdownHooks.push(() => chat.quit());

  // Auto chat-drop scheduler (mod-toggled via !drops; fires only while live).
  shutdownHooks.push(startDropScheduler({ send, logger }));

  // Mod timer countdown (`!timer`): heads-up marks + "time's up". Resumes any
  // timer that was running before a restart from its stored deadline.
  shutdownHooks.push(startTimerScheduler({ send, logger }));

  // Scheduled reminders (`!reminder`). Schedules are data in config/reminders,
  // so this only supplies the clock and the channel — which is also what makes a
  // reminder channel-specific without any per-channel branch in the code.
  shutdownHooks.push(startReminderScheduler({ send, channel, logger }));

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
      if (!t) return;
      logger.info('raid phase advanced', t);
      announceRaidPhase(t, send, logger);
    } catch (err) {
      logger.error('phase tick failed', { err: String(err) });
    }
  }, 30_000);
  phaseTimer.unref?.();
  shutdownHooks.push(() => clearInterval(phaseTimer));

  // ── Enlistment reminder ───────────────────────────────────────────────────
  //    One hero at a time, at most one per `minGapMs`, and only someone who has
  //    a week-old character, never joined this season, and has been chatting in
  //    the last few minutes. Not fired on their message — a bot that answers
  //    your first line of the night with a nag reads as lying in wait.
  let lastReminderAt = Date.now(); // don't fire the moment the bot boots
  const reminderTimer = setInterval(async () => {
    try {
      const cfg = config.enlistReminder;
      if (!cfg.enabled || isChatMuted() || !getConfig().live) return;
      if (Date.now() - lastReminderAt < cfg.minGapMs) return;
      const pointer = getRaidPointer();
      if (pointer?.phase !== 'signup') return; // nothing to enlist into
      const target = await findLapsedHero(pointer);
      if (!target) return;
      // Mark BEFORE saying it: a send failure should cost the invite, not risk
      // asking the same person again on every later pass.
      await markInvited(target.uid, pointer.seasonId);
      lastReminderAt = Date.now();
      send.say(
        `🌱 @${target.player.displayName} — your ${target.player.class} isn't on this season's roster. ` +
        `One !muster enlists you for every week of it, and a thin raid really can wipe.`,
      );
      logger.info('enlistment reminder sent', { userId: target.uid, season: pointer.seasonId });
    } catch (err) {
      logger.error('enlistment reminder failed', { err: String(err) });
    }
  }, config.enlistReminder.checkMs);
  reminderTimer.unref?.();
  shutdownHooks.push(() => clearInterval(reminderTimer));

  // ── Backstop: a week that never got scheduled ─────────────────────────────
  //    The prompt above rides the battle result, which covers the normal case.
  //    This catches the rest — a restart across the transition, a muted bot, or
  //    simply nobody acting on it — so the game can't silently sit idle.
  let lastPromptAt = Date.now();
  const promptTimer = setInterval(async () => {
    try {
      const cfg = config.schedulePrompt;
      if (!cfg.enabled || isChatMuted() || !getConfig().live) return;
      if (Date.now() - lastPromptAt < cfg.minGapMs) return;
      if (await promptNextWeek(send, logger)) lastPromptAt = Date.now();
    } catch (err) {
      logger.error('schedule prompt tick failed', { err: String(err) });
    }
  }, config.schedulePrompt.checkMs);
  promptTimer.unref?.();
  shutdownHooks.push(() => clearInterval(promptTimer));

  // ── Muster roster refresh: during signup, keep each hero's card current with
  //    their live level/gear (frozen again at lock). No-op outside signup. ──
  const rosterTimer = setInterval(async () => {
    try {
      const n = await refreshMusteredRoster();
      if (n) logger.info('muster roster refreshed', { updated: n });
    } catch (err) {
      logger.error('roster refresh failed', { err: String(err) });
    }
  }, config.raid.rosterRefreshMs);
  rosterTimer.unref?.();
  shutdownHooks.push(() => clearInterval(rosterTimer));

  // ── Loot lottery: close expired drops and draw a single winner (spec §5.2) ──
  const drawTimer = setInterval(async () => {
    try {
      const { drawResult, activated } = await processDrops();
      if (drawResult) {
        if (drawResult.winner) {
          send.say(
            `🎉 @${drawResult.winner.name || 'a lucky grabber'} won the ${drawResult.item?.rarity ?? ''} ${drawResult.item?.name ?? 'drop'}! (${drawResult.count} entered) — it's in their !bag.`,
          );
          logger.info('drop drawn', { item: drawResult.itemId, winner: drawResult.winner.userId, entrants: drawResult.count });
        } else {
          logger.info('drop expired with no entrants', { item: drawResult.itemId });
        }
      }
      if (activated) {
        const secs = Math.round(config.loot.windowMs / 1000);
        send.say(`⏭️ Next up — a ${activated.rarity} ${activated.name} is open! !grab within ${secs}s to enter the draw.`);
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

  logger.info('kennyBot ready', { version: APP_VERSION, channel, botUserId, channelUserId, eventsub: eventSubActive });
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
