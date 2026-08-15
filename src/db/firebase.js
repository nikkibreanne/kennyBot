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
  // When the CURRENT live session started (null when offline). Reminders that
  // count from "going live" need this, and persisting it is what stops a bot
  // restart mid-stream from re-running them.
  configLiveSince: () => 'config/liveSince',
  configExpMode: () => 'config/expMode',
  configChatMuted: () => 'config/chatMuted',
  configClipMode: () => 'config/clipMode',
  seasonCurrent: () => 'config/season/current',
  configRaid: () => 'config/raid',
  configDropScheduler: () => 'config/dropScheduler',
  // MOD TIMER (`!timer`): the single shared countdown. Stored (not just held in
  // memory) so a restart resumes it from `endsAt` instead of losing it — the
  // same "never a timer a restart could lose" rule the raid phases follow.
  configTimer: () => 'config/timer',
  // REMINDERS (`!reminder`): scheduled chat nudges. Schedules are DATA here, not
  // code — seeded from src/content/reminders.js and editable from chat. Each
  // record's `state` (what has already fired) lives under it so firing stays
  // idempotent across restarts.
  reminders: () => 'config/reminders',
  reminder: (id) => `config/reminders/${id}`,
  reminderState: (id) => `config/reminders/${id}/state`,
  // MEDIA SLOTS (`!media`): slot number → { input, scene?, action?, label? },
  // the map from a number a mod types to a media source in OBS. Config, not a
  // message channel — nothing is ever *sent* through here. It lives in RTDB for
  // the same reason clipMode does: the names change whenever the streamer
  // renames a source in OBS, and re-deploying a container to rename a sound is
  // not a thing anyone does mid-stream.
  mediaSlots: () => 'config/media',
  mediaSlot: (n) => `config/media/${n}`,
  // SUBATHON: the clock (an absolute deadline, so a restart mid-event resumes
  // instead of losing hours) plus an APPEND-ONLY ledger of every credit. The
  // ledger is not bookkeeping decoration — it is how a long event gets
  // reconciled afterwards, and how a mistyped adjustment at 4am gets reversed
  // without guessing what the clock "should" say.
  subathon: () => 'config/subathon',
  subathonLedger: () => 'config/subathon/ledger',
  subathonLedgerEntry: (id) => `config/subathon/ledger/${id}`,
  configLock: () => 'config/lock',
  // OKRA FACTS (/info/): approved facts are client-read-only; the submission
  // queue + counter are admin-only.
  facts: () => 'facts',
  factSubmissions: () => 'factSubmissions',
  factSubmission: (id) => `factSubmissions/${id}`,
  factCounter: () => 'counters/factSub',
  // TODO BOARD (/todo/): Nikki's public, date-organized to-do list. Items are
  // client-READ-ONLY; mods add/remove them from chat (`!todo`). Keyed by a short
  // atomic counter so a mod can target one to remove (`!todo remove 3`).
  todos: () => 'todos',
  todo: (id) => `todos/${id}`,
  todoCounter: () => 'counters/todo',
  // OKRAMARKET economy: wallets (points ledger) + the active/archived markets.
  wallet: (userId) => `wallets/${userId}`,
  wallets: () => 'wallets',
  // Concurrent binary YES/NO markets: each lives at markets/open/<id> while
  // running (bets nested under it); resolved/cancelled ones move to history.
  marketsOpen: () => 'markets/open',
  marketOpen: (id) => `markets/open/${id}`,
  marketBet: (id, userId) => `markets/open/${id}/bets/${userId}`,
  marketHistory: (id) => `markets/history/${id}`,
  marketCounter: () => 'counters/market',
  // Viewer-proposed markets: an admin-only moderation queue (default-deny, like
  // factSubmissions) — a mod promotes one to the live market via `!market approve`.
  marketSuggestions: () => 'marketSuggestions',
  marketSuggestion: (id) => `marketSuggestions/${id}`,
  marketSuggestionCounter: () => 'counters/marketSug',
  // DUELS: transient PvP credit wagers. A pending challenge is keyed by the
  // TARGET's login (so the target accepts/denies with just `!duel accept`), and
  // is Admin-only (default-deny — the site never reads it). Cleared on
  // resolve/deny/expiry; no history kept.
  duelsPending: () => 'duels/pending',
  duelPending: (toLogin) => `duels/pending/${toLogin}`,
  // TRADES — item/credit swaps negotiated between two players. Transient +
  // Admin-only (default-deny; the site never reads them). A trade lives at
  // trades/active/<id>; trades/index/<login> maps each participant → that id so
  // accept/counter/decline need no target argument. Cleared on settle/decline/expiry.
  tradesActive: () => 'trades/active',
  trade: (id) => `trades/active/${id}`,
  tradeIndex: (login) => `trades/index/${login}`,
  botToken: () => 'config/secrets/botToken',
  items: () => 'items',
  dropActive: () => 'drops/active',
  dropsRoot: () => 'drops',
  dropQueue: () => 'drops/queue',
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
  // CLIP SYNC (clapperboard): per-stream anchors for the okra-clip-archiver tool.
  clipSync: () => 'clipSync',
  clipSession: (id) => `clipSync/${id}`,
};
