// CHASE DETECTION — the pure evaluator. Everything hard about the monitor lives
// here: evidence channels, the within-org discount, dwell, hysteresis and the
// viewer baselines. The clock, the fetches and the RTDB round-trip belong to
// src/events/chaseMonitor.js, which is what puts the whole model under the
// OFFLINE suite (`npm test`) — you cannot schedule a police chase to test
// against, so every case below is hand-built samples and a fixed `now`.
//
// The one idea the rest follows from (design §2.1): evidence is sorted into
// independent EVIDENCE CHANNELS, and at most one signal scores per channel per
// organization — the highest that fired. Without that guard, "a chopper stream's
// spiked" scores again as "the title says chopper" and again as "the stream is
// live": one measurement wearing three hats, and no threshold survives that.
//
//   title      a producer RETITLED the stream into chase vocabulary
//   audience   concurrent viewers moved against their own 30-minute median
//   liveness   an `episodic` channel went not-live -> live
//   editorial  the org's article feed carries a present-tense chase item
//   aircraft   aircraft are ORBITING one patch of ground (ADS-B, no newsroom)
//
// `aircraft` is the odd one out and deliberately so. It is not a property of any
// newsroom, so it cannot live inside an org's group — it scores in its OWN
// pseudo-org group (`aircraft`), which is both conceptually right (it is an
// independent evidence CLASS) and leaves every real org's one-signal-per-channel
// budget untouched. Its weight sits BELOW the threshold, so it can never fire
// alone; it also can never nominate an announcement, because an announcement needs
// a stream to link to and this source has none. Corroboration only, structurally.
//
// An org's channels are summed with `withinOrgDiscount` on everything but its
// strongest — one newsroom deciding to cover a chase drives all of its systems
// at once — and then capped. Orgs are summed with NO discount, because two
// newsrooms are two independent decisions. A single org can therefore cross the
// threshold, but only from two genuinely different observations.
//
// WHAT "TITLE CHANGED" HAS TO MEAN. A `chopper`-class cam carries a permanent,
// generic title, so matching static title words would score
// that stream forever: a title only scores when it CHANGED. But the score must
// also hold for `dwell` consecutive polls, and a poll-to-poll diff is true for
// exactly ONE poll — which would make every "fires" row of the design's worked
// table unfireable. So `state.streams[videoId].title` holds the stream's
// RESTING title, and is only advanced while the live title is NOT chase
// vocabulary. A title that never changed always equals its resting title and
// scores 0 forever; a title retitled to "pursuit" differs from it and keeps
// scoring until the newsroom puts the old one back. See docs/chase-monitor-design.md §2.4.
import { config } from '../config.js';

const MIN_MS = 60_000;
const HOUR_MS = 60 * MIN_MS;
// Fallback only. A sample that knows its own url (any non-YouTube platform) wins.
const WATCH_URL = 'https://www.youtube.com/watch?v=';

// Windows the design fixes (§2.4) but config.js carries no knob for.
const LIVENESS_WINDOW_MS = 10 * MIN_MS; // L1: went live within 10 minutes
const ARTICLE_MAX_AGE_MS = 15 * MIN_MS; // A1: a present-tense item < 15 min old

// State lives in RTDB forever, so every collection in it is bounded here.
const MAX_BASELINE_ENTRIES = 200;
const MAX_TRACKED_STREAMS = 200;
const MAX_ANNOUNCE_STAMPS = 24;

/**
 * The pseudo-org the `aircraft` channel scores under. Not a news organization — a
 * group of one independent channel, so the arithmetic below needs no special case.
 * A roster org that somehow used this id would keep the group and the aircraft
 * reading would be dropped; opaque ids (`org1`, `source2`) are the convention, so
 * that collision is a misconfiguration rather than something to design around.
 */
const AIRCRAFT_GROUP = 'aircraft';

const num = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
const numOrNull = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));
const round2 = (n) => Math.round(n * 100) / 100;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const WORD_CHAR = /[\p{L}\p{N}_]/u;

/**
 * Does `text` carry any of `terms`? Boundaries matter both ways: "chase" must
 * not fire on "purchase", but the feeds write these words in the present tense
 * ("CHP chases speeding motorcyclist", design §1.4), so a short inflection is
 * allowed on the end. Terms that start or end on punctuation ("watch:") get no
 * boundary on that side — `\b` there would demand a word character that is not
 * coming.
 */
export function matchesAny(text, terms) {
  const hay = String(text ?? '');
  if (!hay) return false;
  for (const raw of Array.isArray(terms) ? terms : []) {
    const term = String(raw ?? '').trim();
    if (!term) continue;
    const head = WORD_CHAR.test(term[0]) ? '\\b' : '';
    const tail = WORD_CHAR.test(term[term.length - 1]) ? '(?:s|es|d|ed|ing)?\\b' : '';
    if (new RegExp(`${head}${escapeRe(term)}${tail}`, 'iu').test(hay)) return true;
  }
  return false;
}

/** Median of a numeric list; 0 when there is nothing to take a median of. */
export function median(values) {
  const sorted = (Array.isArray(values) ? values : []).filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * One observation of one stream at one instant.
 * @typedef {object} StreamSample
 * @property {string} org          - config.chase.orgs[].id, e.g. 'org1' (roster is private)
 * @property {string} videoId      - YouTube video id
 * @property {string} streamClass  - 'chopper' | 'newscast' | 'episodic'
 * @property {boolean} live
 * @property {string} title
 * @property {number|null} viewers - concurrent viewers; NULL when unknown
 *                                   (no API key → audience channel disabled)
 * @property {number} at           - ms epoch
 */

/**
 * A present-tense chase item from an org's article feed.
 * @typedef {object} OrgArticle
 * @property {string} org
 * @property {string} title
 * @property {number} publishedAt  - ms epoch
 */

/**
 * One AIRCRAFT READING, as `sampleAircraft()` returns it. The evaluator treats this
 * as an INPUT like any sample — it never fetches, so a reading that was never taken
 * (null) and one that has gone stale both score 0 rather than being guessed at.
 * @typedef {object} AircraftReading
 * @property {Array<{size: number, lat: number, lon: number, spreadKm: number}>} clusters
 *           groups of aircraft orbiting the same place; `size` is how many
 * @property {Array<object>} orbiting - the individual orbiters, for the log
 * @property {number} samples - how many passes actually came back (< 2 means no measurement)
 * @property {number|null} rateRemaining
 * @property {number} at - ms epoch the reading FINISHED; what staleness is measured from
 */

/**
 * Persisted monitor state. The evaluator is PURE over this: it takes one and
 * returns the next. Must survive a JSON round-trip through RTDB.
 * @typedef {object} MonitorState
 * @property {Record<string, {title: string, live: boolean, wentLiveAt: number|null, seenAt: number}>} streams
 *           keyed by videoId. `title` is the stream's RESTING title (see the
 *           header) — the thing a change is measured against, not necessarily
 *           the title showing right now.
 * @property {Record<string, Array<[number, number]>>} baselines
 *           videoId -> array of [at, viewers], trimmed to config.baselineWindowMs
 * @property {number} overCount    - consecutive polls with score >= threshold
 * @property {number} underCount   - consecutive polls with score < clearScore
 * @property {ChaseIncident|null} incident
 * @property {ChaseIncident|null} lastIncident - the last one that closed, for !chase
 * @property {number} lastClosedAt - ms epoch of the last incident close (0 if none)
 * @property {number[]} announcedAt- ms epochs of recent announcements (for maxPerHour)
 * @property {number} lastScore   - the score at the last tick, so !chasemon can show it
 *                                  without re-running a poll
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
 * @property {number|null} announcedAt - null until the sender confirms it went out
 */

/** Anything RTDB (or a fresh install) can hand back, coerced into a usable state. */
function normalizeState(state) {
  const s = state && typeof state === 'object' ? state : {};
  const streams = {};
  for (const [videoId, rec] of Object.entries(plain(s.streams))) {
    if (!rec || typeof rec !== 'object') continue;
    streams[videoId] = {
      title: String(rec.title ?? ''),
      live: Boolean(rec.live),
      wentLiveAt: numOrNull(rec.wentLiveAt),
      seenAt: Math.max(0, num(rec.seenAt, 0)),
      org: rec.org ? String(rec.org) : undefined,
    };
  }
  const baselines = {};
  for (const [videoId, ring] of Object.entries(plain(s.baselines))) {
    const rows = (Array.isArray(ring) ? ring : Object.values(plain(ring)))
      .filter((e) => Array.isArray(e) && Number.isFinite(Number(e[0])) && Number.isFinite(Number(e[1])))
      .map((e) => [Number(e[0]), Number(e[1])]);
    if (rows.length) baselines[videoId] = rows;
  }
  const stamps = Array.isArray(s.announcedAt) ? s.announcedAt : Object.values(plain(s.announcedAt));
  return {
    streams,
    baselines,
    overCount: Math.max(0, Math.trunc(num(s.overCount, 0))),
    underCount: Math.max(0, Math.trunc(num(s.underCount, 0))),
    incident: s.incident && typeof s.incident === 'object' ? s.incident : null,
    lastIncident: s.lastIncident && typeof s.lastIncident === 'object' ? s.lastIncident : null,
    lastClosedAt: Math.max(0, num(s.lastClosedAt, 0)),
    announcedAt: stamps.map(Number).filter(Number.isFinite),
    lastScore: Math.max(0, num(s.lastScore, 0)),
  };
}

/** RTDB hands back objects (or nothing) where the code wants a plain record. */
function plain(v) {
  return v && typeof v === 'object' ? v : {};
}

/**
 * Score this tick and decide whether an incident opens, holds or closes.
 *
 * Pure: it never mutates its arguments, never reads a clock and never touches
 * I/O — `now` is passed in and the returned `state` is the NEXT state, which
 * the caller persists BEFORE it says anything (a crash between the two should
 * cost one announcement, not repeat one forever).
 *
 * @param {{ samples?: StreamSample[], articles?: OrgArticle[],
 *           aircraft?: AircraftReading|null, state?: MonitorState,
 *           now: number, cfg?: object }} input
 * @returns {{ score: number,
 *             groups: Record<string, {score: number, channels: object, vetoed: boolean}>,
 *             best: {org: string, videoId: string, url: string, title: string}|null,
 *             state: MonitorState,
 *             announce: {text: string, incident: ChaseIncident}|null,
 *             opened: boolean, closed: boolean }}
 */
export function evaluateChase({ samples = [], articles = [], aircraft = null, state = null, now = 0, cfg = config.chase } = {}) {
  const at = num(now, 0);
  const s = normalizeState(state);
  const weights = plain(cfg?.weights);
  const w = (id, fallback) => num(weights[id], fallback);
  const discount = num(cfg?.withinOrgDiscount, 0.6);
  const baselineWindowMs = Math.max(MIN_MS, num(cfg?.baselineWindowMs, 30 * MIN_MS));
  const minSamples = Math.max(1, Math.round(num(cfg?.minSamples, 20)));
  const minViewers = Math.max(0, num(cfg?.minViewers, 500));
  const spikeStrong = num(cfg?.spikeStrong, 8);
  const spikeWeak = num(cfg?.spikeWeak, 3);

  // Trim first, so the medians below see only the trailing window and a videoId
  // nobody has reported in half an hour drops out of state entirely.
  const cutoff = at - baselineWindowMs;
  const nextBaselines = {};
  for (const [videoId, ring] of Object.entries(s.baselines)) {
    const kept = ring.filter(([t]) => t >= cutoff).slice(-MAX_BASELINE_ENTRIES);
    if (kept.length) nextBaselines[videoId] = kept;
  }

  // ── per-stream evidence ────────────────────────────────────────────────────
  const nextStreams = { ...s.streams };
  // Did anything this tick actually name a CHASE, rather than just "an event"? The
  // aircraft channel is gated on it, because aircraft converging on a patch of ground
  // happens for a fire, a manhunt or a motorcade too.
  let chaseNamed = false;
  const evidence = [];
  const readings = [];
  for (const raw of Array.isArray(samples) ? samples : []) {
    const videoId = String(raw?.videoId ?? '');
    if (!videoId) continue;
    const orgId = String(raw?.org ?? '');
    const title = String(raw?.title ?? '');
    const live = Boolean(raw?.live);
    const viewers = numOrNull(raw?.viewers);
    const prev = s.streams[videoId] || null;
    const orgCfg = (cfg?.orgs || []).find((o) => String(o?.id) === orgId) || null;
    const streamClass = String(raw?.streamClass || orgCfg?.streamClass || '');

    // A stream we have never seen counts as "changed" only if it is also newly
    // live — i.e. a broadcast that just appeared. Anything else is seeded in
    // silence, which is what stops a restart from reading every standing title
    // as a fresh editorial decision.
    // WHEN DID THIS BROADCAST START? YouTube answers directly (actualStartTime), and
    // that is the only trustworthy source. Inferring it from our own observation
    // history cannot work: "a stream just started" and "a stream has been live for
    // weeks and we only just started polling it" look identical from here. Inferring
    // it produced a real false positive — three long-running streams discovered in one
    // search sweep each scored L1, totalling 15, and announced a chase that never
    // happened. Measured on the same data: one source had been live 15,714 hours.
    const startedAt = numOrNull(raw?.startedAt);
    const newlyLive = live && (prev != null && prev.live === false);
    // Null until a transition is actually witnessed, so `sinceLive` stays Infinity for
    // a stream we simply found already running.
    const wentLiveAt = live ? (newlyLive ? at : numOrNull(prev?.wentLiveAt)) : null;
    const restingTitle = prev ? prev.title : (live ? '' : title);

    const strong = matchesAny(title, cfg?.strongVocab);
    const weak = matchesAny(title, cfg?.weakVocab);
    const negative = matchesAny(title, cfg?.negativeVocab);
    // Did ANYTHING this tick actually say "chase", as opposed to merely "an event is
    // happening"? A live title carrying chase vocabulary does; so does a dedicated
    // chase source going live, whose show name IS the claim. The aircraft channel
    // depends on this — see where it is scored.
    //
    // Note this is NOT the same test as the `title` channel's. That one needs the
    // title to have CHANGED (scoring a standing show name forever is the §2.1
    // error); this one only asks whether the words are present. A chopper cam
    // sitting under a permanent "pursuit" title scores 0 for `title` and still
    // names a chase, which is correct for both.
    if (live && !negative && (strong || weak || orgCfg?.titleIsShowName)) chaseNamed = true;
    const changed = title !== restingTitle;
    // A source that streams under a fixed SHOW NAME is not describing this broadcast,
    // so its title is a constant and carries no evidence about the event. Scoring it
    // next to liveness counted one observation (they went live) twice.
    const titleIsShowName = Boolean(orgCfg?.titleIsShowName);
    let titleScore = 0;
    if (titleIsShowName) titleScore = 0;
    else if (live && changed && strong) titleScore = w('T1', 5);
    else if (live && changed && weak) titleScore = w('T2', 2);

    // One signal per channel: V1 wins outright, V2 is the same measurement at a
    // lower bar. Under `minSamples` the channel is DISABLED rather than
    // defaulted-on — a restart must never fire on a baseline it does not have.
    const prior = nextBaselines[videoId] || [];
    let audienceScore = 0;
    if (live && viewers != null && viewers >= minViewers && prior.length >= minSamples) {
      const ratio = viewers / Math.max(median(prior.map(([, v]) => v)), 1);
      if (ratio >= spikeStrong) audienceScore = w('V1', 5);
      else if (ratio >= spikeWeak) audienceScore = w('V2', 2);
    }

    // GATED BY CLASS, but on the right set. See config.chase.livenessClasses: a
    // newscast going live is a scheduled bulletin, not an event, and scoring it let two
    // unrelated newsrooms announce a chase between them.
    const livenessClasses = Array.isArray(cfg?.livenessClasses) ? cfg.livenessClasses : ['chopper', 'episodic'];
    // ...or when the source SAYS why it went live. A newscast's going-live is routine
    // and must not score on its own — but a newscast that cuts in AND titles it a
    // pursuit has done two separate things, and losing that case costs a real chase.
    // Two routine bulletins still score nothing, because neither says anything.
    const livenessCounts = livenessClasses.includes(streamClass) || strong || weak;
    // The ORIGINAL gate required `streamClass === 'episodic'`, on the theory
    // that an always-live stream is not a signal — but that is already true by
    // construction: a stream that never goes off never transitions, so `wentLiveAt`
    // stays null and this scores 0 anyway. The gate added nothing and cost the single
    // most valuable signal available: a chopper cam is NOT a 24/7 stream (measured —
    // it was dark while the org's separate news loop ran), and it goes up BECAUSE
    // something is happening. An org's class describes its usual stream; it must not
    // decide whether a real off->on transition counts.
    // Prefer what YouTube says; fall back to a WITNESSED off->on transition of this
    // same stream only when the broadcast time is unknown. The old inference — a new
    // video id for an org we had seen before — is deliberately gone.
    const sinceLive = startedAt != null
      ? at - startedAt
      : (wentLiveAt == null ? Infinity : at - wentLiveAt);
    // Per-org override: for a source whose premise IS the event, going live is the
    // evidence and is allowed to fire alone — explicitly, not as a side effect of its
    // title matching a regex. The negative-marker veto still guards it.
    const l1 = Number.isFinite(Number(orgCfg?.livenessWeight)) ? Number(orgCfg.livenessWeight) : w('L1', 5);
    const livenessScore = livenessCounts && sinceLive >= 0 && sinceLive <= LIVENESS_WINDOW_MS ? l1 : 0;

    if (viewers != null) readings.push([videoId, viewers]);
    nextStreams[videoId] = {
      title: live && (strong || weak) ? restingTitle : title,
      live,
      wentLiveAt,
      seenAt: at,
      org: orgId, // so a NEW stream can be told apart from a cold start (see newBroadcast)
    };
    // A source carries its own watch url when its platform is not YouTube. Building
    // one from the videoId only works for YouTube; for anything else it produces a
    // DEAD LINK, and the link is the entire payload of the announcement.
    const url = typeof raw?.url === 'string' && raw.url ? raw.url : '';
    evidence.push({ orgId, videoId, url, title, live, negative, titleScore, audienceScore, livenessScore, viewers });
  }

  for (const [videoId, viewers] of readings) {
    nextBaselines[videoId] = [...(nextBaselines[videoId] || []), [at, viewers]].slice(-MAX_BASELINE_ENTRIES);
  }
  pruneStreams(nextStreams);

  // ── the editorial channel ──────────────────────────────────────────────────
  // A1 is meant to be PRESENT tense. The article feeds are mostly retrospective
  // (design §1.4), so an item carrying a negative marker is dropped rather than
  // counted — it is a recap, and recaps are the common false positive here.
  const editorial = {};
  const articleMaxAgeMs = Math.max(MIN_MS, num(cfg?.articleMaxAgeMs, ARTICLE_MAX_AGE_MS));
  for (const raw of Array.isArray(articles) ? articles : []) {
    const orgId = String(raw?.org ?? '');
    const publishedAt = numOrNull(raw?.publishedAt);
    if (!orgId || publishedAt == null) continue;
    if (Math.abs(at - publishedAt) >= articleMaxAgeMs) continue; // stale, or a feed dated into the future
    const headline = String(raw?.title ?? '');
    if (matchesAny(headline, cfg?.negativeVocab)) continue;
    editorial[orgId] = w('A1', 2);
    // A live newsroom article saying "pursuit" is the most EXPLICIT naming of a chase
    // available anywhere in this design, so it satisfies the aircraft gate as well.
    // The vocabulary is re-checked here rather than assumed: the fetcher already
    // admits only strong-vocabulary items, but this evaluator is pure over its
    // inputs and must not depend on an upstream filter for a gate this one matters.
    if (matchesAny(headline, cfg?.strongVocab) || matchesAny(headline, cfg?.weakVocab)) chaseNamed = true;
  }

  // ── grouping ───────────────────────────────────────────────────────────────
  const orgIds = (cfg?.orgs || []).map((o) => String(o?.id)).filter(Boolean);
  for (const id of [...evidence.map((e) => e.orgId), ...Object.keys(editorial)]) {
    if (id && !orgIds.includes(id)) orgIds.push(id);
  }
  const groups = {};
  for (const orgId of orgIds) {
    const rows = evidence.filter((e) => e.orgId === orgId);
    const channels = {};
    const best = (key) => rows.reduce((hi, r) => Math.max(hi, r[key]), 0);
    const title = best('titleScore');
    const audience = best('audienceScore');
    const liveness = best('livenessScore');
    if (title) channels.title = title;
    if (audience) channels.audience = audience;
    if (liveness) channels.liveness = liveness;
    if (editorial[orgId]) channels.editorial = editorial[orgId];

    // A negative marker in a LIVE title zeroes the whole org for this tick. The
    // channels stay in the breakdown on purpose: "we saw a pursuit title and
    // threw it out as a recap" is the answer an operator actually needs.
    const vetoed = rows.some((r) => r.live && r.negative);
    const ranked = Object.values(channels).sort((a, b) => b - a);
    const cap = num(cfg?.orgs?.find((o) => String(o?.id) === orgId)?.groupCap ?? cfg?.groupCap, 10);
    const raw = ranked.length ? ranked[0] + discount * ranked.slice(1).reduce((a, b) => a + b, 0) : 0;
    groups[orgId] = { score: vetoed ? 0 : Math.min(round2(raw), cap), channels, vetoed };
  }
  // ── the aircraft channel ───────────────────────────────────────────────────
  // Its own pseudo-org group, because aircraft overhead belong to no newsroom.
  // Across groups there is no discount (two independent observations are two
  // independent observations), which is exactly the arithmetic this source wants:
  // it adds its weight to whatever the newsrooms contributed, and that weight is
  // below the threshold, so it can only ever TOP UP a case someone else opened.
  // GATED ON SOMETHING HAVING NAMED A CHASE. Aircraft orbiting one patch of ground
  // says "an event is happening there" — it does NOT say which kind. A brush fire
  // converges news helicopters exactly as a pursuit does, and it spikes an audience
  // exactly as a pursuit does. Summing those two as if they discriminated produced a
  // real false positive: a 60x audience spike on a fire-titled stream plus an aircraft
  // cluster reached 8 and announced a police chase. Measured, not hypothetical — a
  // brush fire in the live logs produced that audience shape on 2026-10-03.
  //
  // So this channel can only TOP UP a case something else already called a chase. It
  // costs no recall: every genuine-chase path names one (a retitle, or a dedicated
  // source going live), and those are exactly the cases it still reinforces.
  const aircraftScore = chaseNamed ? scoreAircraft(aircraft, at, cfg) : 0;
  if (aircraftScore > 0 && !groups[AIRCRAFT_GROUP]) {
    groups[AIRCRAFT_GROUP] = { score: aircraftScore, channels: { aircraft: aircraftScore }, vetoed: false };
  }

  const score = round2(Object.values(groups).reduce((a, g) => a + g.score, 0));

  // The link. Rank by the org's score first — the announcement should point at
  // the newsroom carrying the evidence — then by what this particular stream
  // contributed, then by audience, with videoId as a deterministic tiebreak.
  const candidates = evidence.filter((e) => e.live && !groups[e.orgId]?.vetoed);
  candidates.sort((a, b) => (groups[b.orgId].score - groups[a.orgId].score)
    || (b.titleScore + b.audienceScore + b.livenessScore) - (a.titleScore + a.audienceScore + a.livenessScore)
    || ((b.viewers ?? -1) - (a.viewers ?? -1))
    || a.videoId.localeCompare(b.videoId));
  const top = candidates[0] || null;
  const bestStream = top
    ? { org: top.orgId, videoId: top.videoId, url: top.url || `${WATCH_URL}${top.videoId}`, title: top.title }
    : null;

  // ── incident lifecycle ─────────────────────────────────────────────────────
  const threshold = num(cfg?.threshold, 8);
  const clearScore = num(cfg?.clearScore, 4);
  const dwell = Math.max(1, Math.round(num(cfg?.dwell, 3)));
  const clearPolls = Math.max(1, Math.round(num(cfg?.clearPolls, 5)));
  const maxIncidentMs = num(cfg?.maxIncidentMs, 3 * 60 * 60_000);
  const reopenCooldownMs = Math.max(0, num(cfg?.reopenCooldownMs, 20 * MIN_MS));
  const maxPerHour = Math.max(0, Math.round(num(cfg?.maxPerHour, 3)));

  let overCount = score >= threshold ? s.overCount + 1 : 0;
  let underCount = 0;
  let lastClosedAt = s.lastClosedAt;
  let lastIncident = s.lastIncident;
  let incident = s.incident ? { ...s.incident, peakScore: round2(Math.max(num(s.incident.peakScore, 0), score)) } : null;
  let announce = null;
  let opened = false;
  let closed = false;
  const announcedAt = s.announcedAt.filter((t) => at - t < HOUR_MS).slice(-MAX_ANNOUNCE_STAMPS);

  if (incident) {
    // Hysteresis: hard to start, easy to continue — which is how chases behave.
    underCount = score < clearScore ? s.underCount + 1 : 0;
    // ...but never forever. An incident that will not close BLOCKS every new one, so
    // the monitor would go silently dead rather than loudly wrong. `clearScore` already
    // sits above a lone standing title; this is the backstop for whatever we did not
    // think of. Age is measured from openedAt, so no amount of score can defeat it.
    const tooOld = maxIncidentMs > 0 && at - num(incident.openedAt, at) >= maxIncidentMs;
    if (underCount >= clearPolls || tooOld) {
      closed = true;
      lastIncident = incident;
      lastClosedAt = at;
      incident = null;
      underCount = 0;
      overCount = 0; // the next one earns its own dwell
    }
  } else if (
    overCount >= dwell // §2.6 — the dwell is what actually removes false positives
    && at - lastClosedAt >= reopenCooldownMs // the ragged tail of one chase is not a second one
    && announcedAt.length < maxPerHour // channel-wide, never per-user
    && bestStream
  ) {
    opened = true;
    incident = {
      id: `${bestStream.org}-${at}`,
      openedAt: at,
      org: bestStream.org,
      videoId: bestStream.videoId,
      url: bestStream.url,
      title: bestStream.title,
      peakScore: score,
      announcedAt: null, // the sender stamps this; shadow mode leaves it null
    };
    announcedAt.push(at);
    announce = { text: announcementText(bestStream.org, bestStream.url, cfg), incident: { ...incident } };
    overCount = 0;
  }

  return {
    score,
    groups,
    best: bestStream,
    state: {
      streams: nextStreams,
      baselines: nextBaselines,
      overCount,
      underCount,
      incident,
      lastIncident,
      lastClosedAt,
      lastScore: score,
      announcedAt,
    },
    announce,
    opened,
    closed,
  };
}

/**
 * What an aircraft reading is worth this tick. PURE — it reads `now` from its
 * caller and never a clock.
 *
 * ALL of these score 0, deliberately:
 *   * no reading at all (the monitor has not sampled yet, or sampling failed);
 *   * a reading with fewer than 2 surviving passes — an orbit cannot be seen in one
 *     snapshot, so that is "we could not measure", not "the sky is empty";
 *   * a reading older than `maxAgeMs`, or one dated into the future;
 *   * a reading with no CLUSTER of at least `minCluster` aircraft. Lone orbiters are
 *     the measured background — 4-7 of them over the basin at any moment — and a
 *     count of them is not evidence of anything. Pairs within the cluster radius had
 *     a measured background rate of ZERO.
 *
 * It is one score or nothing: a single channel in a single group, so two clusters
 * cannot pay twice any more than two spiking streams can (§2.1).
 *
 * @param {AircraftReading|null|undefined} reading
 * @param {number} at - the tick's `now`
 * @param {object} [cfg] - the chase settings
 * @returns {number}
 */
function scoreAircraft(reading, at, cfg) {
  const ac = plain(cfg?.aircraft);
  if (ac.enabled === false) return 0;
  if (!reading || typeof reading !== 'object') return 0;
  if (Math.round(num(reading.samples, 0)) < 2) return 0;
  const sampledAt = numOrNull(reading.at);
  if (sampledAt == null) return 0;
  const age = at - sampledAt;
  const maxAgeMs = Math.max(MIN_MS, num(ac.maxAgeMs, 10 * MIN_MS));
  if (age < 0 || age > maxAgeMs) return 0;
  // TWO shapes, ONE score. An orbit cluster is aircraft holding over one spot —
  // a chase that has stopped, a standoff, a fire. A pursuit cluster is aircraft
  // travelling together at road speed — a chase still running. Either answers
  // "there is aerial activity consistent with an incident", and the second exists
  // because the first structurally cannot see a moving pursuit (§2.10).
  //
  // They do not add. This is a single channel in a single group, so a sky with
  // both cannot pay twice any more than two spiking streams can (§2.1) — which
  // is the whole reason the previous version of this bug was dangerous.
  const asList = (v) => (Array.isArray(v) ? v : Object.values(plain(v)));
  const big = (list, min) => asList(list).some((c) => Math.round(num(c?.size, 0)) >= min);
  const orbitMin = Math.max(2, Math.round(num(ac.minCluster, 2)));
  const pursuitMin = Math.max(2, Math.round(num(ac.pursuitMinCluster, num(ac.minCluster, 2))));
  const qualifies = big(reading.clusters, orbitMin) || big(reading.pursuitClusters, pursuitMin);
  return qualifies ? Math.max(0, num(ac.weight, 3)) : 0;
}

/**
 * One line, and nothing in it about scores, orgs' internal ids, sources or APIs
 * — chat sees a chase and a link, never the rig behind them.
 */
function announcementText(orgId, url, cfg) {
  const name = (cfg?.orgs || []).find((o) => String(o?.id) === orgId)?.name || orgId;
  return `🚨 Police chase live in LA right now — ${name} is on it: ${url}`;
}

/** Every broadcast gets a fresh videoId, so the stream map needs a ceiling. */
function pruneStreams(streams) {
  const ids = Object.keys(streams);
  if (ids.length <= MAX_TRACKED_STREAMS) return;
  ids.sort((a, b) => streams[b].seenAt - streams[a].seenAt);
  for (const id of ids.slice(MAX_TRACKED_STREAMS)) delete streams[id];
}
