// Live config mirror. The chat handler reads game config on EVERY message, so
// reading RTDB each time would be slow and rate-limit-heavy. Instead we keep an
// in-memory mirror kept fresh by RTDB listeners (one persistent connection),
// and the hot path reads from memory. Setters write through to RTDB.

import { database, PATHS, SERVER_TIMESTAMP } from './firebase.js';
import { config as gameConfig } from '../config.js';

/** @type {{ live: boolean, expMode: string, season: any, raid: any }} */
const mirror = {
  live: false,
  expMode: gameConfig.liveGate.defaultExpMode,
  season: null,
  raid: null, // config/raid: { seasonId, weekId, phase, locksAt, startsAt }
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

  const liveRef = db.ref(PATHS.configLive());
  const expRef = db.ref(PATHS.configExpMode());
  const seasonRef = db.ref(PATHS.seasonCurrent());
  const raidRef = db.ref(PATHS.configRaid());

  liveRef.on('value', (s) => { mirror.live = Boolean(s.val()); });
  expRef.on('value', (s) => { mirror.expMode = s.val() || gameConfig.liveGate.defaultExpMode; });
  seasonRef.on('value', (s) => { mirror.season = s.val(); });
  raidRef.on('value', (s) => { mirror.raid = s.val(); });

  // Wait for the initial reads so the mirror is warm before chat starts.
  const [liveSnap, expSnap, seasonSnap, raidSnap] = await Promise.all([
    liveRef.get(), expRef.get(), seasonRef.get(), raidRef.get(),
  ]);
  mirror.live = Boolean(liveSnap.val());
  mirror.expMode = expSnap.val() || gameConfig.liveGate.defaultExpMode;
  mirror.season = seasonSnap.val();
  mirror.raid = raidSnap.val();
  logger.info?.('config mirror warm', { live: mirror.live, expMode: mirror.expMode });
}

/** Current in-memory config view (hot path). */
export function getConfig() {
  return { live: mirror.live, expMode: mirror.expMode, season: mirror.season };
}

/** Active season pointer { id, name, weekId, ... } or null. */
export function getSeason() {
  return mirror.season;
}

/** Active raid pointer { seasonId, weekId, phase, locksAt, startsAt } or null. */
export function getRaidPointer() {
  return mirror.raid;
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
  await database().ref(PATHS.configLive()).set(next);
  logger.info?.('live status changed', { live: next, source });
  return true;
}

/** Set the EXP gate override mode (on|off|auto). */
export async function setExpMode(mode) {
  if (!['on', 'off', 'auto'].includes(mode)) throw new Error(`invalid expMode: ${mode}`);
  await database().ref(PATHS.configExpMode()).set(mode);
  return mode;
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
