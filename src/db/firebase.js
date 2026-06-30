// Firebase Admin SDK init (IMPLEMENTATION §G). The Admin SDK bypasses RTDB
// rules, so this process can write authoritative game state while every client
// stays read-only (spec §7). Emulator-aware: when FIREBASE_DATABASE_EMULATOR_HOST
// is set we target the local emulator and need no real credentials, so tests and
// local dev never touch prod state.

import { initializeApp, applicationDefault, deleteApp } from 'firebase-admin/app';
import { getDatabase, ServerValue } from 'firebase-admin/database';

let app = null;
let db = null;

/** Bare Firebase project id. */
export function projectId() {
  return process.env.FIREBASE_PROJECT_ID || 'okrafans';
}

/**
 * RTDB namespace = the project's DEFAULT database instance ("<projectId>-default-rtdb").
 * This is the namespace the emulator governs with database.rules.json (a bare
 * "<projectId>" namespace is ungoverned/open), and it matches the real prod
 * instance name — so the rejection test and the bot use the same value.
 */
export function emulatorNamespace() {
  return `${projectId()}-default-rtdb`;
}

/**
 * Initialize the Admin app exactly once. Idempotent.
 * @returns {import('firebase-admin').database.Database}
 */
export function initFirebase() {
  if (db) return db;

  const emulatorHost = process.env.FIREBASE_DATABASE_EMULATOR_HOST;

  if (emulatorHost) {
    // The Admin SDK detects the emulator from the env var; a real credential is
    // not required. ns is the governed default-instance namespace.
    const databaseURL = `http://${emulatorHost}?ns=${emulatorNamespace()}`;
    app = initializeApp({ projectId: projectId(), databaseURL }, 'kennybot');
  } else {
    const databaseURL = process.env.FIREBASE_DATABASE_URL;
    if (!databaseURL) throw new Error('FIREBASE_DATABASE_URL is required in production');
    // GOOGLE_APPLICATION_CREDENTIALS points at the mounted service-account JSON.
    app = initializeApp({ credential: applicationDefault(), databaseURL }, 'kennybot');
  }

  db = getDatabase(app);
  return db;
}

/** The initialized RTDB handle (throws if initFirebase() hasn't run). */
export function database() {
  if (!db) throw new Error('Firebase not initialized — call initFirebase() first');
  return db;
}

/** Atomic server-side increment for idempotent counters (EXP, damage, etc.). */
export function increment(delta) {
  return ServerValue.increment(delta);
}

/** Server timestamp sentinel. */
export const SERVER_TIMESTAMP = ServerValue.TIMESTAMP;

/** Tear down (used by graceful shutdown / tests). */
export async function closeFirebase() {
  if (app) {
    await deleteApp(app);
    app = null;
    db = null;
  }
}

/**
 * Centralized path builder for the §9 data model — the shared contract with the
 * website. Changing a shape here means coordinating with the UI track (the
 * shared interface contract).
 */
export const PATHS = {
  configLive: () => 'config/live',
  configExpMode: () => 'config/expMode',
  seasonCurrent: () => 'config/season/current',
  configRaid: () => 'config/raid',
  configDropScheduler: () => 'config/dropScheduler',
  configLock: () => 'config/lock',
  botToken: () => 'config/secrets/botToken',
  items: () => 'items',
  dropActive: () => 'drops/active',
  player: (userId) => `players/${userId}`,
  username: (login) => `usernames/${login}`,
  boss: (seasonId, weekId) => `bosses/${seasonId}/${weekId}`,
  bossesForSeason: (seasonId) => `bosses/${seasonId}`,
  raid: (seasonId, weekId) => `raids/${seasonId}/${weekId}`,
  signup: (seasonId, weekId, userId) => `raids/${seasonId}/${weekId}/signups/${userId}`,
  signups: (seasonId, weekId) => `raids/${seasonId}/${weekId}/signups`,
  team: (seasonId, weekId) => `raids/${seasonId}/${weekId}/team`,
  combat: (seasonId, weekId) => `raids/${seasonId}/${weekId}/combat`,
  leaderboardEntry: (seasonId, userId) => `leaderboard/${seasonId}/${userId}`,
};
