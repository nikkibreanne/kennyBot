// Live config mirror. The chat handler reads game config on EVERY message, so
// reading RTDB each time would be slow and rate-limit-heavy. Instead we keep an
// in-memory mirror kept fresh by RTDB listeners (one persistent connection),
// and the hot path reads from memory. Setters write through to RTDB.

import { database, PATHS, SERVER_TIMESTAMP } from './firebase.js';
import { config as gameConfig } from '../config.js';

/** @type {{ live: boolean, liveSince: number|null, expMode: string, chatMuted: boolean, season: any, raid: any, dropScheduler: any, timer: any, reminders: any }} */
const mirror = {
  live: false,
  // When the current live session began (null when offline). Stamped by setLive
  // on the OFF→ON edge only, so a restart mid-stream keeps the original start.
  liveSince: null,
  expMode: gameConfig.liveGate.defaultExpMode,
  // Mod kill-switch for OUTBOUND chat (`!mute`). When true the bot stays fully
  // connected — listening, granting EXP, processing drops, holding the lease —
  // but sends nothing to chat. Persisted so a restart keeps the mods' choice.
  chatMuted: false,
  // What !clip does: 'local' | 'twitch' | 'both'. Seeded once from
  // config.clip.defaultMode; RTDB is then the only source, so a mod can flip it
  // from chat — the streamer's OBS can die mid-stream, and re-deploying the
  // container to get Twitch clips back is not an acceptable recovery path.
  clipMode: null, // null until the mirror is warm; readers fall back to the config default
  season: null,
  raid: null, // config/raid: { seasonId, weekId, phase, locksAt, startsAt }
  dropScheduler: { enabled: gameConfig.loot.scheduler.enabled, intervalSec: gameConfig.loot.scheduler.intervalSec },
  // config/timer: the one mod-set countdown, or null. Read once a second by the
  // timer scheduler, so it belongs in the mirror rather than an RTDB read loop.
  timer: null,
  // config/reminders: id → scheduled-nudge record. Evaluated on every reminder
  // tick, so it's mirrored rather than re-read.
  reminders: {},
  // config/subathon: the clock + its append-only ledger. Mirrored because every
  // sub and every cheer has to be priced against the CURRENT band, and going to
  // RTDB for the schedule on each event would put a network round-trip in front
  // of something that arrives in bursts (a large gift bundle is one event per
  // recipient).
  subathon: null,
};

let started = false;

/**
 * Subscribe to the config subtree and seed defaults if missing. Returns once the
 * first snapshot has been applied so callers start with real state.
 */
export async function startConfigMirror(logger = console) {
  if (started) return;
  started = true;
  const db = database();

  // Seed defaults transactionally if absent (never clobber existing values).
  await db.ref(PATHS.configExpMode()).transaction((v) => (v == null ? gameConfig.liveGate.defaultExpMode : v));
  await db.ref(PATHS.configLive()).transaction((v) => (v == null ? false : v));
  await db.ref(PATHS.configChatMuted()).transaction((v) => (v == null ? false : v));
  // Seeded once from config.js, exactly like expMode above — never clobbered, so a
  // mod's `!clipmode` survives every restart. There is deliberately no env var:
  // one source of truth beats two that can disagree.
  await db.ref(PATHS.configClipMode()).transaction((v) => (v == null ? parseClipMode(gameConfig.clip.defaultMode) : v));

  const liveRef = db.ref(PATHS.configLive());
  const expRef = db.ref(PATHS.configExpMode());
  const mutedRef = db.ref(PATHS.configChatMuted());
  const clipRef = db.ref(PATHS.configClipMode());
  const seasonRef = db.ref(PATHS.seasonCurrent());
  const raidRef = db.ref(PATHS.configRaid());
  const dropRef = db.ref(PATHS.configDropScheduler());
  const timerRef = db.ref(PATHS.configTimer());
  const liveSinceRef = db.ref(PATHS.configLiveSince());
  const remindersRef = db.ref(PATHS.reminders());
  const subathonRef = db.ref(PATHS.subathon());

  // Seed drop-scheduler defaults once (never clobber a mod's settings).
  await dropRef.transaction((v) => (v == null ? { enabled: gameConfig.loot.scheduler.enabled, intervalSec: gameConfig.loot.scheduler.intervalSec } : v));

  liveRef.on('value', (s) => { mirror.live = Boolean(s.val()); });
  expRef.on('value', (s) => { mirror.expMode = s.val() || gameConfig.liveGate.defaultExpMode; });
  mutedRef.on('value', (s) => { mirror.chatMuted = Boolean(s.val()); });
  clipRef.on('value', (s) => { mirror.clipMode = parseClipMode(s.val()); });
  seasonRef.on('value', (s) => { mirror.season = s.val(); });
  raidRef.on('value', (s) => { mirror.raid = s.val(); });
  dropRef.on('value', (s) => { if (s.val()) mirror.dropScheduler = s.val(); });
  timerRef.on('value', (s) => { mirror.timer = s.val() || null; });
  liveSinceRef.on('value', (s) => { mirror.liveSince = s.val() || null; });
  remindersRef.on('value', (s) => { mirror.reminders = s.val() || {}; });
  // Log the on/off edge. The subathon is switched on by a CLI writing a record,
  // with no restart and no env var — so without this there is nothing in the log
  // to confirm the bot actually saw it, which is the one thing an operator wants
  // to check before the event starts. Deliberately no rates or totals.
  subathonRef.on('value', (s) => {
    const next = s.val() || null;
    const was = Boolean(mirror.subathon?.active);
    const now = Boolean(next?.active);
    mirror.subathon = next;
    if (now !== was) logger.info?.(now ? 'subathon ACTIVE' : 'subathon inactive', { startedAt: next?.startedAt ?? null });
  });

  // Wait for the initial reads so the mirror is warm before chat starts.
  const [liveSnap, expSnap, mutedSnap, clipSnap, seasonSnap, raidSnap, dropSnap, timerSnap, liveSinceSnap, remindersSnap, subathonSnap] = await Promise.all([
    liveRef.get(), expRef.get(), mutedRef.get(), clipRef.get(), seasonRef.get(), raidRef.get(), dropRef.get(),
    timerRef.get(), liveSinceRef.get(), remindersRef.get(), subathonRef.get(),
  ]);
  mirror.live = Boolean(liveSnap.val());
  mirror.expMode = expSnap.val() || gameConfig.liveGate.defaultExpMode;
  mirror.chatMuted = Boolean(mutedSnap.val());
  mirror.clipMode = parseClipMode(clipSnap.val());
  mirror.season = seasonSnap.val();
  mirror.raid = raidSnap.val();
  if (dropSnap.val()) mirror.dropScheduler = dropSnap.val();
  mirror.timer = timerSnap.val() || null;
  mirror.liveSince = liveSinceSnap.val() || null;
  mirror.reminders = remindersSnap.val() || {};
  mirror.subathon = subathonSnap.val() || null;
  logger.info?.('config mirror warm', {
    live: mirror.live, expMode: mirror.expMode, chatMuted: mirror.chatMuted, clipMode: mirror.clipMode,
  });
}

/** Current in-memory config view (hot path). */
export function getConfig() {
  return {
    live: mirror.live,
    expMode: mirror.expMode,
    chatMuted: mirror.chatMuted,
    clipMode: mirror.clipMode,
    season: mirror.season,
  };
}

/**
 * When the current live session started (ms epoch), or null when offline.
 * Stamped on the OFF→ON edge only — a bot restart mid-stream sees no edge, so
 * the original start survives and "30 minutes after going live" stays honest.
 */
export function getLiveSince() {
  return mirror.liveSince;
}

/** True when a mod has muted the bot's outbound chat (`!mute`). Hot-path read. */
export function isChatMuted() {
  return mirror.chatMuted;
}

/** Active season pointer { id, name, weekId, ... } or null. */
export function getSeason() {
  return mirror.season;
}

/** Active raid pointer { seasonId, weekId, phase, locksAt, startsAt } or null. */
export function getRaidPointer() {
  return mirror.raid;
}

/** Auto chat-drop scheduler settings { enabled, intervalSec }. */
export function getDropScheduler() {
  return mirror.dropScheduler;
}

/** Mod-controlled update of the drop-scheduler settings (persisted + mirrored). */
export async function setDropScheduler(patch) {
  await database().ref(PATHS.configDropScheduler()).update(patch);
  return { ...mirror.dropScheduler, ...patch };
}

/** The active mod timer record (`!timer`), or null. See src/db/timer.js. */
export function getTimer() {
  return mirror.timer;
}

/**
 * Replace (or clear, with null) the mod timer. Updates the mirror synchronously
 * so a follow-up `!timer +5` — or the countdown tick a moment later — sees the
 * new state without waiting for the RTDB listener to echo it back.
 */
export async function setTimerState(timer) {
  mirror.timer = timer || null;
  const ref = database().ref(PATHS.configTimer());
  await (timer ? ref.set(timer) : ref.remove());
  return mirror.timer;
}

/** All reminder records as `{ id: record }` (see src/db/reminders.js). */
export function getReminders() {
  return mirror.reminders || {};
}

/**
 * Merge a patch into one reminder (persisted + mirrored synchronously, so a mod
 * running `!reminder off ghosty` then `!reminder` reads their own write). Passing
 * a null VALUE for a key removes it, per RTDB update semantics.
 */
export async function patchReminder(id, patch) {
  const merged = { ...(mirror.reminders?.[id] || {}), ...patch, id };
  for (const [k, v] of Object.entries(patch)) if (v === null) delete merged[k];
  mirror.reminders = { ...(mirror.reminders || {}), [id]: merged };
  await database().ref(PATHS.reminder(id)).update({ ...patch, id });
  return merged;
}

/** Replace a reminder's bot-managed firing state (what has already gone out). */
export async function setReminderState(id, state) {
  const cur = mirror.reminders?.[id];
  if (cur) mirror.reminders = { ...mirror.reminders, [id]: { ...cur, state } };
  await database().ref(PATHS.reminderState(id)).set(state || null);
  return state;
}

/**
 * The subathon record (clock + rate card + ledger), or null when none is running.
 * Read on every sub and every cheer, so it comes from the mirror.
 */
export function getSubathonState() {
  return mirror.subathon;
}

/**
 * Patch the config/raid pointer (active-raid + phase + schedule). The website's
 * muster/live pages key off this (UI contract).
 * @param {{ seasonId?: string, weekId?: string, phase?: string, locksAt?: number, startsAt?: number }} patch
 */
export async function setRaidPointer(patch) {
  await database().ref(PATHS.configRaid()).update(patch);
  return patch;
}

/**
 * Set live status. Idempotent (only writes on change). `source` is for logging
 * the dual-writer (EventSub vs Helix poll) precedence.
 */
export async function setLive(value, source = 'unknown', logger = console) {
  const next = Boolean(value);
  if (mirror.live === next) return false;
  // Stamp the session start on the same write as the flag, so "N minutes after
  // going live" can never read a live channel with no start time. Written only
  // on an EDGE: a restart while already live leaves the original stamp alone.
  const startedAt = next ? Date.now() : null;
  mirror.live = next;
  mirror.liveSince = startedAt;
  await database().ref().update({
    [PATHS.configLive()]: next,
    [PATHS.configLiveSince()]: startedAt, // null removes it (offline)
  });
  logger.info?.('live status changed', { live: next, source, startedAt });
  return true;
}

/**
 * Test seam: prime the in-memory mirror without RTDB. Unit tests run with no
 * database, so the mirror is otherwise stuck at its cold defaults and any
 * "live config wins" behaviour is untestable offline.
 * @param {Partial<typeof mirror>} patch
 */
export function primeConfigForTest(patch) {
  Object.assign(mirror, patch);
}

/**
 * The three things `!clip` can independently produce. The mode is a SET of these,
 * not a fixed preset, so every combination is expressible with one config value:
 *   horizontal — OBS's main replay buffer  → 16:9 file on the streamer's PC
 *   vertical   — Aitum's Backtrack output  → 9:16 file, natively framed
 *   twitch     — Helix Create Clip         → a public clip link in chat
 */
export const CLIP_TARGETS = ['horizontal', 'vertical', 'twitch'];

/**
 * Shorthands, kept so existing values and muscle memory keep working. `local`
 * predates the vertical canvas and has always meant "the local capture", which is
 * now explicitly both local files.
 */
export const CLIP_MODE_ALIASES = {
  local: ['horizontal', 'vertical'],
  both: ['horizontal', 'vertical', 'twitch'],
  all: ['horizontal', 'vertical', 'twitch'],
  off: [],
  none: [],
};

/** Legal single words for `!clipmode`, for usage messages. */
export const CLIP_MODES = [...CLIP_TARGETS, ...Object.keys(CLIP_MODE_ALIASES)];

/**
 * Parse a clip mode from any source (RTDB, chat, config). Anything unrecognised —
 * including null/undefined — falls back to the configured default, because the
 * failure that matters is a typo quietly turning Twitch clipping back on.
 *
 * Lives here rather than in commands/clip.js so configStore can validate and seed
 * without importing the command that imports it.
 */
export function parseClipMode(raw) {
  const targets = readClipTargets(raw);
  if (targets === null) return parseClipMode(gameConfig.clip.defaultMode);
  // 'off' is a real, storable choice — an empty string would round-trip back to
  // the default on the next read, silently re-enabling clipping a mod turned off.
  return targets.length ? targets.join(',') : 'off';
}

/**
 * Parse a mode into its target list, or `null` if ANY token is unrecognised.
 *
 * All-or-nothing on purpose: silently dropping a bad token would leave a mode that
 * looks accepted but does less than asked, and the failure that matters here is a
 * clip quietly not being made. Callers decide what to do with `null` — RTDB reads
 * fall back to the default, `!clipmode` shows usage.
 *
 * Accepts commas or spaces, any order, aliases mixed in: `local twitch`,
 * `horizontal,vertical`, `all`.
 *
 * @returns {string[]|null} canonical targets in CLIP_TARGETS order, deduped
 */
export function readClipTargets(raw) {
  const words = String(raw ?? '').toLowerCase().split(/[\s,]+/).filter(Boolean);
  if (!words.length) return null;
  const set = new Set();
  for (const w of words) {
    if (CLIP_TARGETS.includes(w)) set.add(w);
    else if (w in CLIP_MODE_ALIASES) CLIP_MODE_ALIASES[w].forEach((t) => set.add(t));
    else return null;
  }
  return CLIP_TARGETS.filter((t) => set.has(t)); // canonical order, so 'a,b' === 'b,a'
}

/**
 * The stored mode as booleans, for callers that just want to know what to do.
 * @returns {{ horizontal: boolean, vertical: boolean, twitch: boolean, none: boolean }}
 */
export function clipTargets(mode) {
  const list = readClipTargets(mode) ?? readClipTargets(gameConfig.clip.defaultMode) ?? [];
  return {
    horizontal: list.includes('horizontal'),
    vertical: list.includes('vertical'),
    twitch: list.includes('twitch'),
    none: list.length === 0,
  };
}

/**
 * Change what `!clip` does, live (`!clipmode`). Updates the mirror synchronously
 * so the very next `!clip` obeys it without waiting for the RTDB round-trip, then
 * persists so the choice survives every restart.
 */
export async function setClipMode(mode) {
  if (readClipTargets(mode) === null) throw new Error(`invalid clipMode: ${mode}`);
  // Store the CANONICAL form, so 'local', 'vertical horizontal' and
  // 'horizontal,vertical' all persist identically and comparisons are trivial.
  const canonical = parseClipMode(mode);
  mirror.clipMode = canonical;
  await database().ref(PATHS.configClipMode()).set(canonical);
  return canonical;
}

/** Set the EXP gate override mode (on|off|auto). */
export async function setExpMode(mode) {
  if (!['on', 'off', 'auto'].includes(mode)) throw new Error(`invalid expMode: ${mode}`);
  await database().ref(PATHS.configExpMode()).set(mode);
  return mode;
}

/**
 * Mute / unmute the bot's outbound chat (`!mute`). Updates the mirror
 * synchronously so the very next send respects it without waiting for the RTDB
 * round-trip, then persists so the choice survives a restart.
 */
export async function setChatMuted(value) {
  const next = Boolean(value);
  mirror.chatMuted = next;
  await database().ref(PATHS.configChatMuted()).set(next);
  return next;
}

/**
 * Set the active season pointer. Includes `weekId` (UI contract refinement #1)
 * so the website can find the live boss without scanning.
 * @param {{ id: string, name?: string, weekId?: string, startsAt?: number, endsAt?: number, lootTable?: string[] }} season
 */
export async function setSeason(season) {
  await database().ref(PATHS.seasonCurrent()).set({
    ...season,
    updatedAt: SERVER_TIMESTAMP,
  });
  return season;
}
