// LA chase monitor persistence (docs/chase-monitor-design.md). Three nodes, kept
// deliberately separate because they have three different owners:
//
//   config/chaseMonitor — the live-tunable knobs (`!chasemon`). Seeded ONCE from
//     config.chase and never clobbered afterwards, exactly like clipMode: an
//     operator who drops the threshold at 2am must not have it quietly restored
//     by the next deploy.
//   chaseMonitor/state  — the evaluator's carry-over. Persisted because every
//     guard that stops this thing announcing twice is a COUNT (dwell, clear,
//     cooldown, per-hour), and a restart that forgot the counts would re-announce
//     a chase already in progress.
//   chaseMonitor/shadow — every would-be announcement while mode is 'shadow'.
//     That log is the calibration dataset (design §5), so it is written even
//     though nothing is said. Trimmed, because it outlives every incident.
//
// No scoring here. The model is pure and lives in src/rules/chase.js.

import { database, PATHS, SERVER_TIMESTAMP } from './firebase.js';
import { config } from '../config.js';

/**
 * Persisted monitor state. The evaluator is PURE over this: it takes one and
 * returns the next. Must survive a JSON round-trip through RTDB.
 * @typedef {object} MonitorState
 * @property {Record<string, {title: string, live: boolean, wentLiveAt: number|null, seenAt: number, org?: string}>} streams
 *           keyed by videoId. `title` is the stream's RESTING title — what a
 *           change is measured against, not necessarily what is showing now —
 *           and `seenAt` is how the evaluator decides which stream to evict when
 *           the map is full, so BOTH have to survive the round trip.
 * @property {Record<string, Array<[number, number]>>} baselines
 *           videoId -> array of [at, viewers], trimmed to config.baselineWindowMs
 * @property {number} overCount    - consecutive polls with score >= threshold
 * @property {number} underCount   - consecutive polls with score < clearScore
 * @property {ChaseIncident|null} incident
 * @property {number} lastClosedAt - ms epoch of the last incident close (0 if none)
 * @property {number[]} announcedAt- ms epochs of recent announcements (for maxPerHour)
 */

/**
 * @typedef {object} ChaseIncident
 * @property {string} id           - `${org}-${openedAt}`
 * @property {number} openedAt
 * @property {string} org
 * @property {string} videoId
 * @property {string} url          - https://www.youtube.com/watch?v=<id>
 * @property {string} title
 * @property {number} peakScore
 * @property {number|null} announcedAt - null while in shadow mode
 */

/**
 * The knobs an operator owns at runtime. Everything else in `config.chase` —
 * weights, vocabulary, the org list, the baseline window — stays code, because
 * changing those is a model change that belongs in a reviewed commit, not in a
 * chat message at 2am.
 */
const TUNABLE = [
  'enabled', 'mode', 'threshold', 'groupCap', 'dwell',
  'clearScore', 'clearPolls', 'reopenCooldownMs', 'maxPerHour',
];

/**
 * One source. The roster is PRIVATE (CLAUDE.md) so it is deliberately NOT part of
 * `TUNABLE` and not settable from chat — it is loaded out-of-band by
 * `npm run chase:sources` from a gitignored file, and `config.chase.orgs` ships empty.
 * @param {unknown} raw @returns {object|null} the org, or null if unusable
 */
function normalizeOrg(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id ?? '').trim();
  const channelId = String(raw.channelId ?? '').trim();
  const login = String(raw.login ?? '').trim();
  // Two platforms, two identifiers. YouTube is the default so every existing roster
  // entry keeps working untouched; a twitch entry is keyed by login instead and has no
  // channelId at all — requiring one silently dropped every twitch source on load.
  const platform = raw.platform === 'twitch' ? 'twitch' : 'youtube';
  if (!id || (platform === 'twitch' ? !login : !channelId)) return null;
  const streamClass = ['chopper', 'newscast', 'episodic'].includes(raw.streamClass)
    ? raw.streamClass
    : 'newscast'; // a missing class must LOSE a signal (L1), never invent one
  const org = platform === 'twitch'
    ? { id, name: String(raw.name ?? id), platform, login, streamClass }
    : { id, name: String(raw.name ?? id), channelId, streamClass };
  if (typeof raw.articleFeed === 'string' && raw.articleFeed) org.articleFeed = raw.articleFeed;
  if (Number.isFinite(Number(raw.groupCap))) org.groupCap = Number(raw.groupCap);
  return org;
}

/**
 * Replace the private source roster. Written by the loader script, never by chat.
 * @param {unknown[]} orgs @returns {Promise<number>} how many were stored
 */
export async function setChaseSources(orgs) {
  const clean = (Array.isArray(orgs) ? orgs : []).map(normalizeOrg).filter(Boolean);
  if (!clean.length) throw new Error('no usable sources — each needs an id plus a channelId (youtube) or login (twitch)');
  const seen = new Set();
  for (const o of clean) {
    if (seen.has(o.id)) throw new Error(`duplicate source id: ${o.id}`);
    seen.add(o.id);
  }
  await ensureSeeded();
  await database().ref(`${PATHS.configChaseMonitor()}/orgs`).set(clean);
  return clean.length;
}

/** How many shadow entries to keep. Bounded storage beats a complete history. */
const SHADOW_KEEP = 200;

/** @returns {MonitorState} a cold state — no streams, no baselines, no incident. */
export function emptyState() {
  return {
    streams: {},
    baselines: {},
    overCount: 0,
    underCount: 0,
    incident: null,
    lastIncident: null,
    lastClosedAt: 0,
    announcedAt: [],
    lastScore: 0,
  };
}

let seeding = null;

/**
 * Create config/chaseMonitor if it is absent, once per process. Returning
 * undefined ABORTS the transaction, so an existing record is not even rewritten
 * — the same never-clobber contract seedReminders() follows, and the reason a
 * mod's `!chasemon threshold 6` survives every restart.
 */
async function ensureSeeded() {
  if (!seeding) {
    const seed = Object.fromEntries(TUNABLE.map((k) => [k, config.chase[k]]));
    seeding = database().ref(PATHS.configChaseMonitor())
      .transaction((cur) => (cur == null ? seed : undefined))
      // A failed seed must be retryable: keeping the rejected promise cached
      // would wedge the monitor off for the life of the process.
      .catch((err) => { seeding = null; throw err; });
  }
  return seeding;
}

/**
 * The effective settings: RTDB's tunables over everything in `config.chase`, so
 * one object can be handed straight to the evaluator as its `cfg`.
 *
 * Stored values are treated as untrusted — this node is hand-editable in the
 * Firebase console — and every coercion fails SAFE: only a real boolean `true`
 * enables the monitor, and any mode that is not exactly 'live' reads as
 * 'shadow'. A typo can therefore silence this feature but can never make it
 * speak.
 * @returns {Promise<typeof config.chase>}
 */
export async function getChaseSettings() {
  await ensureSeeded();
  const snap = await database().ref(PATHS.configChaseMonitor()).get();
  return mergeSettings(snap.val());
}

/** @param {unknown} stored @returns {typeof config.chase} */
function mergeSettings(stored) {
  const merged = { ...config.chase };
  const raw = stored && typeof stored === 'object' ? stored : {};
  for (const key of TUNABLE) {
    const value = raw[key];
    if (value == null) continue;
    if (key === 'enabled') merged.enabled = value === true;
    else if (key === 'mode') merged.mode = value === 'live' ? 'live' : 'shadow';
    else if (Number.isFinite(Number(value))) merged[key] = Number(value);
  }
  // The roster lives only in RTDB — `config.chase.orgs` is [] in the public repo, so
  // a fresh clone with nothing loaded yields no sources and an inert monitor.
  const stored_orgs = Array.isArray(raw.orgs) ? raw.orgs : [];
  const orgs = stored_orgs.map(normalizeOrg).filter(Boolean);
  merged.orgs = orgs.length ? orgs : config.chase.orgs;
  return merged;
}

/**
 * Apply an operator's change. ALL-OR-NOTHING, following the `!clipmode`
 * precedent: an invalid value throws and nothing is written, because a
 * half-applied patch leaves a monitor that looks configured and behaves
 * otherwise. Callers surface the throw as a usage line.
 * @param {Partial<{enabled: boolean, mode: string, threshold: number, groupCap: number,
 *   dwell: number, clearScore: number, clearPolls: number, reopenCooldownMs: number,
 *   maxPerHour: number}>} patch
 * @returns {Promise<typeof config.chase>} the settings as they now read
 */
export async function setChaseSettings(patch) {
  await ensureSeeded();
  const update = {};
  for (const [key, value] of Object.entries(patch || {})) {
    if (!TUNABLE.includes(key)) throw new Error(`unknown chase setting: ${key}`);
    update[key] = validateSetting(key, value);
  }
  if (Object.keys(update).length) {
    await database().ref(PATHS.configChaseMonitor()).update(update);
  }
  // Re-read rather than merge locally, so there is exactly one place where
  // "what the monitor will actually use" is decided.
  return getChaseSettings();
}

function validateSetting(key, value) {
  if (key === 'enabled') {
    if (typeof value !== 'boolean') throw new Error('enabled must be true or false');
    return value;
  }
  if (key === 'mode') {
    if (value !== 'shadow' && value !== 'live') throw new Error('mode must be shadow or live');
    return value;
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${key} must be a number >= 0`);
  // Poll counts are counts. Accepting 2.5 polls would make the dwell guard —
  // the single most important false-positive filter — behave unpredictably.
  if (['dwell', 'clearPolls', 'maxPerHour'].includes(key)) {
    if (!Number.isInteger(n)) throw new Error(`${key} must be a whole number`);
    if (key !== 'maxPerHour' && n < 1) throw new Error(`${key} must be at least 1`);
  }
  return n;
}

/** @returns {Promise<MonitorState>} the stored state, or a cold one if absent. */
export async function loadMonitorState() {
  const snap = await database().ref(PATHS.chaseState()).get();
  return normalizeState(snap.val());
}

/**
 * Replace the stored state. Normalized on the way out as well as in, because
 * RTDB REJECTS a write containing `undefined` — and the one write that must
 * never fail is this one: it is what stands between a crash and a repeated
 * announcement.
 * @param {MonitorState} state
 */
export async function saveMonitorState(state) {
  await database().ref(PATHS.chaseState()).set(normalizeState(state));
}

/**
 * Rebuild the state from whatever RTDB handed back. Nothing is trusted: RTDB
 * drops empty objects and empty arrays entirely (they read back as null) and
 * returns a sparse array as an object keyed by index, so every container is
 * reconstructed rather than assumed.
 * @param {unknown} raw @returns {MonitorState}
 */
function normalizeState(raw) {
  if (!raw || typeof raw !== 'object') return emptyState();

  const streams = {};
  for (const [videoId, s] of Object.entries(raw.streams || {})) {
    if (!s || typeof s !== 'object') continue;
    streams[videoId] = {
      title: String(s.title ?? ''),
      live: s.live === true,
      wentLiveAt: toTimeOrNull(s.wentLiveAt),
      // Load-bearing, not bookkeeping: every broadcast gets a fresh videoId, and
      // this is the only thing telling the evaluator's pruner which stream is
      // stale. Dropped, it reads back as 0 for all of them and the pruner would
      // evict the stream currently being watched.
      seenAt: toCount(s.seenAt),
      // Carries which org the stream belongs to — the evaluator needs it to tell a NEW
      // broadcast from a cold start. Dropping it here would silently disable that.
      ...(s.org ? { org: String(s.org) } : {}),
    };
  }

  const baselines = {};
  for (const [videoId, ring] of Object.entries(raw.baselines || {})) {
    const points = toList(ring)
      .map(toList)
      .filter((p) => p.length === 2 && p.every((n) => Number.isFinite(Number(n))))
      .map((p) => [Number(p[0]), Number(p[1])]);
    if (points.length) baselines[videoId] = points; // an empty ring is just absent
  }

  return {
    streams,
    baselines,
    overCount: toCount(raw.overCount),
    underCount: toCount(raw.underCount),
    incident: normalizeIncident(raw.incident),
    // The evaluator sets this when an incident closes and `!chase` reads it to answer
    // "or the most recent one". Dropping it here silently emptied that on every save.
    lastIncident: normalizeIncident(raw.lastIncident),
    lastClosedAt: toCount(raw.lastClosedAt),
    announcedAt: toList(raw.announcedAt).map(Number).filter(Number.isFinite),
    lastScore: toCount(raw.lastScore),
  };
}

/** @param {unknown} raw @returns {ChaseIncident|null} */
function normalizeIncident(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const openedAt = toTimeOrNull(raw.openedAt);
  // Without an id and a real open time there is no incident to sustain or close;
  // treating a damaged record as "none" reopens cleanly instead of wedging.
  if (!raw.id || !openedAt) return null;
  return {
    id: String(raw.id),
    openedAt,
    org: String(raw.org ?? ''),
    videoId: String(raw.videoId ?? ''),
    url: String(raw.url ?? ''),
    title: String(raw.title ?? ''),
    peakScore: Number.isFinite(Number(raw.peakScore)) ? Number(raw.peakScore) : 0,
    announcedAt: toTimeOrNull(raw.announcedAt),
  };
}

/**
 * A timestamp, or null — and null has to STAY null. `Number(null)` is 0, which is
 * finite, so the obvious coercion silently turns "never announced" into
 * "announced at epoch 0"; on an incident that is the difference between a shadow
 * run and one that believes it already spoke.
 */
function toTimeOrNull(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** A non-negative finite number, or 0. Counters are never allowed to go weird. */
function toCount(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Array, or a numerically-keyed object as RTDB returns a sparse array, or []. */
function toList(v) {
  if (Array.isArray(v)) return v.filter((x) => x != null);
  if (v && typeof v === 'object') {
    return Object.keys(v).sort((a, b) => Number(a) - Number(b)).map((k) => v[k]);
  }
  return [];
}

/**
 * Record a would-be announcement without saying it (`mode: 'shadow'`). This is
 * the whole point of shadow mode: two weeks of these, scored against a published
 * retrospective chase feed, is what turns the invented weights in design §2 into
 * measured ones.
 * @param {ChaseIncident} incident
 * @param {number} score  the total score at the moment it would have fired
 * @param {Record<string, object>} groups  the per-org breakdown — a bare total
 *        cannot answer "which org contributed what", which is the only question
 *        anyone asks of this log
 * @returns {Promise<string|null>} the entry's push key
 */
export async function logShadowAnnouncement(incident, score, groups) {
  const ref = database().ref(PATHS.chaseShadow()).push();
  await ref.set({
    at: SERVER_TIMESTAMP,
    incidentId: incident?.id ?? null,
    org: incident?.org ?? null,
    videoId: incident?.videoId ?? null,
    url: incident?.url ?? null,
    title: incident?.title ?? null,
    score: Number.isFinite(Number(score)) ? Number(score) : null,
    // Round-tripped through JSON to drop any undefined the evaluator left in an
    // absent channel — RTDB rejects the whole write over one of those.
    groups: groups && typeof groups === 'object' ? JSON.parse(JSON.stringify(groups)) : null,
  });
  await trimShadowLog();
  return ref.key;
}

/**
 * Keep only the most recent SHADOW_KEEP entries. Push keys sort chronologically,
 * so "recent" is just the tail of a key-ordered query. Trimming on every write
 * means the second query normally matches a single entry; only a log that grew
 * before this ran costs more, and only once.
 */
async function trimShadowLog() {
  const ref = database().ref(PATHS.chaseShadow());
  const kept = await ref.orderByKey().limitToLast(SHADOW_KEEP).get();
  const keys = [];
  kept.forEach((child) => { keys.push(child.key); }); // forEach preserves query order
  if (keys.length < SHADOW_KEEP) return; // nothing older than the oldest kept can exist

  const stale = await ref.orderByKey().endBefore(keys[0]).get();
  const removals = {};
  stale.forEach((child) => { removals[child.key] = null; });
  if (Object.keys(removals).length) await ref.update(removals);
}
