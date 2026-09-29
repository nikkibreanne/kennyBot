// Chase-monitor sources — the only place this feature touches the network.
//
// TWO PLATFORMS. YouTube is the newsroom side (below); Twitch is a second, cheaper
// and categorically STRONGER one, and it lives at the bottom of this file. The
// difference is what the liveness of each actually means: a newsroom is live for
// many reasons — a newscast, a weather hit, a 24/7 loop — so its going live is weak
// evidence, while a dedicated chase channel goes live BECAUSE there is a chase.
//
// Four sources, deliberately unequal (docs/chase-monitor-design.md §1, the YouTube
// three probed against the live internet on 2026-09-28, Twitch on 2026-09-29):
//
//   1. YouTube `videos.list` — the FAST path. `part=snippet,liveStreamingDetails`
//      costs ONE quota unit for up to 50 video ids in a SINGLE call, and it is the
//      only source that reports `concurrentViewers`. `search.list` costs 100 units
//      and is therefore never used in a loop here — 100 calls would exhaust the
//      whole free daily quota.
//   2. The channel RSS feed — DISCOVERY only. Free, keyless, ~20 KB, and it does
//      list an in-progress live stream. It sends `cache-control: max-age=900` and
//      NO ETag / NO Last-Modified, so it is up to 15 minutes stale and conditional
//      GET buys nothing: it can notice that a new broadcast object exists, and
//      nothing faster than that.
//   3. The org's article feed — EDITORIAL corroboration. This one DOES send ETag
//      and Last-Modified, so it is polled conditionally and a 304 costs nothing.
//
// Scraping `youtube.com/channel/<id>/live` is NOT an option and must not be added:
// it is 1.2 MB, it ignores `Range:`, and it violates YouTube's ToS. The Data API is
// both cheaper and the supported path.
//
// NOTHING here throws. A dead feed is a normal Tuesday — every network call is
// wrapped on its own so one failure degrades the score by one channel instead of
// stopping the monitor, and the caller always gets a (possibly partial) array.
// With no YOUTUBE_API_KEY at all the monitor still runs: it loses the `audience`
// channel and scores from titles and liveness alone.
//
// XML is parsed with regex on purpose. These are two small, well-formed machine
// feeds with a fixed shape, and a parser dependency is not worth carrying for
// three tag names (CLAUDE.md: no new dependencies).

import { config } from '../config.js';

/**
 * One observation of one stream at one instant.
 * @typedef {object} StreamSample
 * @property {string} org          - config.chase.orgs[].id, e.g. 'org1' (roster is private)
 * @property {string} videoId      - the platform's id for THIS broadcast: a YouTube
 *                                   video id, or a Twitch stream id. For a Twitch
 *                                   channel that is OFFLINE there is no stream id at
 *                                   all, so a stable `tw:<login>` stands in — see
 *                                   parseTwitchStreams.
 * @property {string} streamClass  - 'chopper' | 'newscast' | 'episodic'
 * @property {boolean} live
 * @property {string} title
 * @property {number|null} viewers - concurrent viewers; NULL when unknown
 *                                   (no API key -> audience channel disabled)
 * @property {number|null} startedAt - ms epoch the BROADCAST began, per the platform
 * @property {number} at           - ms epoch
 * @property {string} [url]        - only on platforms where the evaluator cannot
 *                                   build the link from `videoId` alone (Twitch).
 */

/**
 * A present-tense chase item from an org's article feed.
 * @typedef {object} OrgArticle
 * @property {string} org
 * @property {string} title
 * @property {number} publishedAt  - ms epoch
 */

const VIDEOS_URL = 'https://www.googleapis.com/youtube/v3/videos';
const CHANNEL_FEED = 'https://www.youtube.com/feeds/videos.xml';
const TWITCH_TOKEN_URL = 'https://id.twitch.tv/oauth2/token';
const TWITCH_STREAMS_URL = 'https://api.twitch.tv/helix/streams';
const TWITCH_CHANNEL_URL = 'https://www.twitch.tv/';

const HTTP_TIMEOUT_MS = 10_000;
/** `videos.list` bills 1 unit per CALL, not per id — but only up to 50 ids. */
const MAX_IDS = 50;
/** `/helix/streams` takes 100 `user_login` values per call, for ONE point. */
const MAX_LOGINS = 100;
/**
 * Re-mint an app token this long before it actually expires. It lasts ~60 days, so
 * this is only about never handing a poll a token that dies mid-flight; a token
 * revoked early is caught by the 401 retry instead, which is the real backstop.
 */
const TOKEN_SKEW_MS = 5 * 60_000;
/**
 * Newest N entries per channel feed.
 *
 * MEASURED 2026-09-28, and it is the reason `findLiveVideos` below exists: channel
 * RSS lists recent UPLOADS, so a stream that has been live for hours gets pushed out
 * by newer clips. Probing the real roster, FOUR of six sources were live and their
 * live video was NOT IN THE FEED AT ALL — not merely below this cap. RSS alone is
 * therefore useless for finding a persistent live stream, whatever this number is.
 * It stays small because its only remaining job is catching a BRAND-NEW broadcast
 * (which is genuinely the newest upload) cheaply between search sweeps.
 */
const MAX_IDS_PER_ORG = 5;

/**
 * `search.list` costs 100 units against a 10,000/day budget, so it can never go in a
 * per-minute loop — but it is the ONLY call that reliably answers "is this channel
 * live right now, and which video is it". Used sparingly, and only for orgs we do not
 * already have a live video for (see the sticky set in the scheduler): a 24/7 stream
 * is found once and then tracked for free by the 1-unit videos.list poll.
 */
export const SEARCH_UNITS = 100;
/**
 * Coarse pre-filter for article items. The evaluator applies the real 15-minute
 * A1 window (design §2.4); this only keeps the list short and bounded.
 */
const ARTICLE_MAX_AGE_MS = 30 * 60_000;

/** Test seam: `fn(url, init)` replaces fetch. */
let fakeFetch = null;
/** The "running without a key" notice is worth saying once, not every minute. */
let loggedNoKey = false;
/** The same, for the Twitch half. */
let loggedNoTwitch = false;
/** Cached app access token: `{ token, expiresAt }`. ~60 days, so this is not a loop. */
let twitchToken = null;
/** feed url -> { etag, lastModified, articles } — powers conditional GET + 304. */
const feedCache = new Map();

const http = (url, init) => (fakeFetch ? fakeFetch(url, init) : fetch(url, init));

/**
 * Test seam. Pass a `fetch`-shaped function to intercept every request, or `null`
 * to go back to the real one. Also clears the conditional-GET cache and the
 * once-only log flags, so tests never inherit another test's state.
 */
export function initChaseSourcesWith(fn) {
  fakeFetch = fn || null;
  feedCache.clear();
  loggedNoKey = false;
  loggedNoTwitch = false;
  twitchToken = null;
}

/**
 * True when the cheap half of the pipeline can run at all. RSS needs nothing but
 * `fetch`, so this is really "is this runtime usable" — the YouTube key is a
 * separate, optional question (`youtubeKeyPresent`).
 */
export function chaseSourcesReady() {
  return Boolean(fakeFetch) || typeof fetch === 'function';
}

/** Whether the audience channel can work at all. YouTube's only env var. */
export function youtubeKeyPresent() {
  return Boolean((process.env.YOUTUBE_API_KEY || '').trim());
}
// (`twitchReady()` is the equivalent for the Twitch platform — see the bottom of
// this file. It needs no NEW credential: the bot already holds both.)

// ── pure parsers (exported so the whole parse layer is covered offline) ───────

const stripCdata = (s) => String(s).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');

const XML_NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** Feed titles routinely carry `&amp;` and `&#39;`; a raw title would mis-match vocab. */
function decodeXml(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, ent) => {
    const e = ent.toLowerCase();
    if (e[0] === '#') {
      const code = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return XML_NAMED[e] ?? whole;
  });
}

/** Every `<name>…</name>` body in `xml`, for any of `names`, in document order. */
function* blocks(xml, ...names) {
  const src = String(xml ?? '');
  for (const name of names) {
    const re = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'gi');
    let m;
    while ((m = re.exec(src))) yield m[1];
  }
}

/** The first of `names` that appears in `block`, decoded; `null` when none do. */
function tagText(block, ...names) {
  for (const name of names) {
    const m = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'i').exec(String(block ?? ''));
    if (m) return decodeXml(stripCdata(m[1])).trim();
  }
  return null;
}

/** Unparseable/absent dates become 0, which every age check then rejects. */
function parseDate(s) {
  const t = Date.parse(String(s ?? '').trim());
  return Number.isFinite(t) ? t : 0;
}

/**
 * Video ids out of a YouTube channel feed (`feeds/videos.xml?channel_id=…`).
 * Atom: one `<entry>` per video, `<yt:videoId>`, `<media:title>` (the plain
 * `<title>` is the same string) and `<published>`.
 *
 * @param {string} xml
 * @returns {Array<{videoId: string, title: string, publishedAt: number}>}
 */
export function parseRssVideoIds(xml) {
  const out = [];
  for (const entry of blocks(xml, 'entry')) {
    const videoId = tagText(entry, 'yt:videoId');
    if (!videoId) continue; // the feed header and anything malformed
    out.push({
      videoId,
      title: tagText(entry, 'media:title', 'title') ?? '',
      publishedAt: parseDate(tagText(entry, 'published', 'updated')),
    });
  }
  return out;
}

/**
 * A `videos.list` response → StreamSample[]. The org is resolved from
 * `snippet.channelId`, so the caller can ask for a flat list of ids and still get
 * them attributed; a video from a channel we do not track is dropped.
 *
 * `concurrentViewers` arrives as a STRING and is simply absent when the broadcast
 * is not live or the owner hides its count. Absent means `null` — NOT 0, which
 * would read as "nobody is watching" and poison the trailing median.
 *
 * @param {any} json
 * @param {Map<string, any>|Record<string, any>} orgByChannelId - channelId -> org
 * @param {number} [now] - stamped onto every sample; injectable for tests
 * @returns {StreamSample[]}
 */
export function parseVideosListResponse(json, orgByChannelId, now = Date.now()) {
  const items = Array.isArray(json?.items) ? json.items : [];
  const lookup = (id) => (orgByChannelId instanceof Map
    ? orgByChannelId.get(id)
    : orgByChannelId?.[id]);

  const out = [];
  for (const item of items) {
    const snippet = item?.snippet;
    const videoId = typeof item?.id === 'string' ? item.id : '';
    if (!snippet || !videoId) continue;
    const found = lookup(snippet.channelId);
    if (!found) continue;
    const org = typeof found === 'string' ? { id: found } : found;

    // YouTube reports when the broadcast ACTUALLY began. That is the only
    // trustworthy way to tell "this just went live" from "this has been live for
    // weeks and we only just started looking at it" — our own observation history
    // cannot, because discovering a stream for the first time looks identical to a
    // stream starting. Absent (or unparseable) leaves it null, and the evaluator
    // then declines to score liveness rather than guessing.
    const startedRaw = item?.liveStreamingDetails?.actualStartTime;
    const startedAt = startedRaw ? Date.parse(startedRaw) : NaN;
    const raw = item?.liveStreamingDetails?.concurrentViewers;
    const viewers = raw == null || raw === '' ? null : Number.parseInt(raw, 10);

    out.push({
      org: org.id,
      videoId,
      // Only `episodic` unlocks L1, so an org missing its class loses a signal
      // rather than gaining one it did not earn.
      streamClass: org.streamClass || 'newscast',
      live: snippet.liveBroadcastContent === 'live',
      title: typeof snippet.title === 'string' ? snippet.title : '',
      viewers: Number.isFinite(viewers) ? viewers : null,
      startedAt: Number.isFinite(startedAt) ? startedAt : null,
      at: now,
    });
  }
  return out;
}

/**
 * An org's article feed → OrgArticle[]. Handles RSS 2.0 (`<item>`/`<pubDate>`) and
 * Atom (`<entry>`/`<published>`) because the orgs do not agree on one.
 * Unfiltered — `fetchArticles` applies the vocabulary and the age window.
 *
 * @param {string} xml
 * @param {string} orgId
 * @returns {OrgArticle[]}
 */
export function parseArticleFeed(xml, orgId) {
  const out = [];
  for (const item of blocks(xml, 'item', 'entry')) {
    const title = tagText(item, 'title');
    if (!title) continue;
    out.push({
      org: orgId,
      title,
      publishedAt: parseDate(tagText(item, 'pubDate', 'published', 'dc:date', 'updated')),
    });
  }
  return out;
}

// ── fetchers ─────────────────────────────────────────────────────────────────

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const vocabRe = (terms) => new RegExp(`\\b(?:${(terms || []).map(escapeRe).join('|')})\\b`, 'i');

// Only the STRONG vocabulary ('pursuit', 'chase') qualifies an article. The feed
// that actually exists is already a chase feed (design §1.4), so the weak terms
// would match nearly every item in it and hand out A1 for free.
const ARTICLE_RE = vocabRe(config.chase.strongVocab);
const NEGATIVE_RE = vocabRe(config.chase.negativeVocab);

/**
 * No credential ever reaches a log line. Undici puts the whole request URL into the
 * error message it throws, and the Twitch token exchange puts the client secret in a
 * request BODY that a transport error can echo back — so all four shapes are scrubbed
 * here rather than trusted not to appear.
 */
const redact = (s) => String(s)
  .replace(/key=[^&\s]+/gi, 'key=***')
  .replace(/client_secret=[^&\s]+/gi, 'client_secret=***')
  .replace(/access_token=[^&\s"]+/gi, 'access_token=***')
  .replace(/\bBearer\s+[\w.+/=-]+/gi, 'Bearer ***');

/** Collapse whatever shape the caller keeps its known ids in into a unique list. */
function collectIds(known) {
  const ids = new Set();
  const add = (v) => { if (typeof v === 'string' && v) ids.add(v); };
  if (Array.isArray(known)) known.forEach(add);
  else if (known && typeof known === 'object') {
    for (const v of Object.values(known)) (Array.isArray(v) ? v : [v]).forEach(add);
  }
  return [...ids];
}

/**
 * One `videos.list` call over every known id — title, live state and concurrent
 * viewers for all of them, for ONE quota unit (design §3, loop 1).
 *
 * With no `YOUTUBE_API_KEY` this returns `[]` and says so once: the monitor then
 * detects NOTHING: YouTube's channel RSS carries no live flag, and the design's
 * whole premise is that we only announce something we KNOW is live. So the key is
 * required for the feature to work at all — this is a clean stand-down rather than a
 * crashed one.
 *
 * @param {Array<{id: string, channelId: string, streamClass?: string}>} orgs
 * @param {Record<string, string[]>|string[]} knownVideoIds
 * @param {any} [logger]
 * @param {number} [now]
 */
export async function fetchLiveSamples(orgs, knownVideoIds, logger = console, now = Date.now()) {
  try {
    const key = (process.env.YOUTUBE_API_KEY || '').trim();
    if (!key) {
      if (!loggedNoKey) {
        loggedNoKey = true;
        logger?.info?.('chase: no YOUTUBE_API_KEY — monitor is INERT (RSS cannot report live status); set the key to enable detection');
      }
      return [];
    }

    let ids = collectIds(knownVideoIds);
    if (!ids.length) return []; // nothing discovered yet — spend no quota
    if (ids.length > MAX_IDS) {
      // Truncating keeps the tick at exactly one billed call. Discovery caps its
      // own output, so this is a "something is wrong upstream" guard.
      logger?.warn?.('chase: more live ids than one videos.list call holds', { ids: ids.length });
      ids = ids.slice(0, MAX_IDS);
    }

    const byChannel = new Map(
      (Array.isArray(orgs) ? orgs : []).filter((o) => o?.channelId).map((o) => [o.channelId, o]),
    );
    const qs = new URLSearchParams({
      part: 'snippet,liveStreamingDetails',
      id: ids.join(','),
      key,
    });

    const res = await http(`${VIDEOS_URL}?${qs}`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!res?.ok) {
      // 403 here is usually quota exhaustion or a revoked key — both are operator
      // problems, and both must leave chat untouched.
      logger?.warn?.('chase: videos.list rejected', { status: res?.status ?? 0, ids: ids.length });
      return [];
    }
    return parseVideosListResponse(await res.json(), byChannel, now);
  } catch (err) {
    logger?.warn?.('chase: videos.list unreachable', { err: redact(err?.message || err) });
    return [];
  }
}

/**
 * Ask YouTube which video each given org is live on RIGHT NOW. 100 units PER ORG, so
 * the caller decides who is worth asking — never call this for an org whose live
 * video is already known.
 * @param {Array<object>} orgs @param {any} logger
 * @returns {Promise<Record<string, string>>} orgId -> live videoId (absent = not live)
 */
export async function findLiveVideos(orgs, logger = console) {
  const key = (process.env.YOUTUBE_API_KEY || '').trim();
  if (!key || !orgs?.length) return {};
  const found = {};
  await Promise.all(orgs.map(async (org) => {
    if (!org?.channelId) return;
    const url = 'https://www.googleapis.com/youtube/v3/search'
      + `?part=id&channelId=${encodeURIComponent(org.channelId)}`
      + `&eventType=live&type=video&maxResults=1&key=${encodeURIComponent(key)}`;
    try {
      const res = await http(url, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
      if (!res?.ok) {
        logger?.warn?.('chase: live search rejected', { org: org.id, status: res?.status ?? 0 });
        return;
      }
      const json = await res.json();
      const id = json?.items?.[0]?.id?.videoId;
      if (id) found[org.id] = id;
    } catch (err) {
      logger?.warn?.('chase: live search unreachable', { org: org.id, err: redact(err?.message || err) });
    }
  }));
  return found;
}

/**
 * The free discovery sweep (design §3, loop 2): each org's channel feed → the
 * newest video ids, which the fast loop then prices in bulk.
 *
 * An org whose feed FAILED is absent from the result, deliberately: a caller
 * merging this into its known-id set keeps the last good ids for that org instead
 * of forgetting a stream because one request timed out. An org that is present
 * with `[]` really did return nothing.
 *
 * @param {Array<{id: string, channelId: string}>} orgs
 * @param {any} [logger]
 * @returns {Promise<Record<string, string[]>>}
 */
export async function discoverVideoIds(orgs, logger = console) {
  /** @type {Record<string, string[]>} */
  const out = {};
  try {
    await Promise.all((Array.isArray(orgs) ? orgs : []).map(async (org) => {
      if (!org?.id || !org?.channelId) return;
      try {
        // No conditional GET: these feeds send neither ETag nor Last-Modified.
        const res = await http(
          `${CHANNEL_FEED}?channel_id=${encodeURIComponent(org.channelId)}`,
          { headers: { accept: 'application/atom+xml, application/xml;q=0.9' },
            signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) },
        );
        if (!res?.ok) {
          logger?.warn?.('chase: channel feed rejected', { org: org.id, status: res?.status ?? 0 });
          return;
        }
        out[org.id] = parseRssVideoIds(await res.text())
          .slice(0, MAX_IDS_PER_ORG)
          .map((e) => e.videoId);
      } catch (err) {
        logger?.warn?.('chase: channel feed unreachable', { org: org.id, err: String(err?.message || err) });
      }
    }));
  } catch (err) {
    logger?.warn?.('chase: discovery sweep failed', { err: String(err?.message || err) });
  }
  return out;
}

/** Present-tense-ish, recent, and not a retrospective clip write-up. */
function selectChaseItems(articles, now) {
  return (articles || []).filter((a) => a
    && now - a.publishedAt < ARTICLE_MAX_AGE_MS
    && ARTICLE_RE.test(a.title)
    && !NEGATIVE_RE.test(a.title));
}

/**
 * The editorial channel: each org's article feed, conditionally fetched.
 *
 * These feeds DO send ETag/Last-Modified, so a quiet newsroom costs a 304 and no
 * body. A 304 — or a failed request — replays the cached items, because an item
 * published four minutes ago is still true when the next poll happens to fail;
 * the age window is what eventually retires it, not the fetch outcome.
 *
 * @param {Array<{id: string, articleFeed?: string}>} orgs
 * @param {any} [logger]
 * @param {number} [now]
 * @returns {Promise<OrgArticle[]>}
 */
export async function fetchArticles(orgs, logger = console, now = Date.now()) {
  const out = [];
  try {
    await Promise.all((Array.isArray(orgs) ? orgs : []).map(async (org) => {
      if (!org?.id || !org?.articleFeed) return;
      const cached = feedCache.get(org.articleFeed);
      const headers = { accept: 'application/rss+xml, application/xml;q=0.9, */*;q=0.8' };
      if (cached?.etag) headers['if-none-match'] = cached.etag;
      if (cached?.lastModified) headers['if-modified-since'] = cached.lastModified;

      try {
        const res = await http(org.articleFeed, {
          headers,
          signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
        });
        if (res?.status === 304) {
          out.push(...selectChaseItems(cached?.articles, now));
          return;
        }
        if (!res?.ok) {
          logger?.warn?.('chase: article feed rejected', { org: org.id, status: res?.status ?? 0 });
          out.push(...selectChaseItems(cached?.articles, now));
          return;
        }
        const articles = parseArticleFeed(await res.text(), org.id);
        feedCache.set(org.articleFeed, {
          etag: res.headers?.get?.('etag') || null,
          lastModified: res.headers?.get?.('last-modified') || null,
          articles, // cached RAW — the age window is re-applied on every poll
        });
        out.push(...selectChaseItems(articles, now));
      } catch (err) {
        logger?.warn?.('chase: article feed unreachable', { org: org.id, err: String(err?.message || err) });
        out.push(...selectChaseItems(cached?.articles, now));
      }
    }));
  } catch (err) {
    logger?.warn?.('chase: article sweep failed', { err: String(err?.message || err) });
  }
  return out;
}

// ── Twitch ───────────────────────────────────────────────────────────────────
//
// The second source PLATFORM, and the strongest signal available to this monitor.
// A newsroom is live for a dozen reasons; a dedicated chase channel goes live
// BECAUSE of a chase, so its liveness is evidence in a way a newsroom's never is.
//
// It is also nearly free, which is why none of YouTube's rationing appears here.
// `GET /helix/streams` takes up to 100 `user_login` values in ONE call and costs
// ONE point against 800 points PER MINUTE — so every Twitch source is asked about
// on every tick, with no discovery loop, no cooldown and no daily cap to schedule.
// (Compare `search.list`: 100 units against 10,000 per DAY, which is the entire
// reason the YouTube half above is built the way it is.)
//
// The credentials are the ones the bot already has. The token is an APP access
// token (`grant_type=client_credentials`): it acts for no user, grants nothing but
// public reads, lasts ~60 days, and is therefore cached in memory and re-minted
// only when a request comes back 401.
//
// NOT USED, deliberately: the category query (`?game_id=…`). It returns whoever is
// live in a category, and right now that includes a 24/7 REPLAY loop — an UNVETTED
// channel is exactly the retrospective false positive the evaluator's negative
// vocabulary exists to veto, so this module only ever asks about the vetted roster.

/**
 * Whether the Twitch platform can be polled at all. Both halves are required: a
 * client id with no secret cannot mint an app token.
 */
export function twitchReady() {
  return Boolean((process.env.TWITCH_CLIENT_ID || '').trim())
    && Boolean((process.env.TWITCH_CLIENT_SECRET || '').trim());
}

/**
 * Split a roster by PLATFORM.
 *
 * `platform` is OPTIONAL and absent means 'youtube', so every entry written before
 * Twitch existed keeps working untouched. A youtube entry carries `channelId`; a
 * twitch entry carries `login`. An entry missing its platform's identifier is
 * dropped here rather than half-fetched downstream.
 *
 * @param {Array<object>} orgs
 * @returns {{youtube: object[], twitch: object[]}}
 */
export function partitionSources(orgs) {
  const youtube = [];
  const twitch = [];
  for (const org of Array.isArray(orgs) ? orgs : []) {
    if (!org?.id) continue;
    if (org.platform === 'twitch') {
      if (typeof org.login === 'string' && org.login.trim()) twitch.push(org);
    } else if (org.channelId) youtube.push(org);
  }
  return { youtube, twitch };
}

/**
 * Chase vocabulary for TAGS — strong, weak AND negative together. The negative half
 * is in here on purpose: see foldTwitchTags.
 */
const TAG_RE = vocabRe([
  ...(config.chase.strongVocab || []),
  ...(config.chase.weakVocab || []),
  ...(config.chase.negativeVocab || []),
]);

/**
 * `PoliceChase` → `Police Chase`, `LAPDPursuit` → `LAPD Pursuit`, `police_chase` →
 * `police chase`. A Twitch tag is ONE token with no separators, so `\bchase\b` cannot
 * see the word inside it — the vocabulary only matches once the token is split.
 */
function splitTagWords(tag) {
  return String(tag ?? '')
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Fold a stream's matching TAGS into its title.
 *
 * Twitch tags are STRUCTURED where a title is prose — a channel carries `Pursuit` or
 * `PoliceChase` as first-class metadata rather than hoping the operator typed the
 * word. The evaluator reads `title` and nothing else, so the useful tags are folded
 * into the title string HERE and the scoring model needs no change at all.
 *
 * Only tags that match the chase vocabulary are folded — including the NEGATIVE
 * vocabulary, deliberately. A `Replay` / `Rerun` tag is precisely the veto the
 * evaluator needs against the 24/7 replay loops that live in this category, and
 * dropping it would discard the one structured marker that identifies them. Anything
 * else (`LosAngeles`, `English`) is noise and is left out, so a recorded sample stays
 * readable; a tag whose words the title already says is skipped rather than doubled.
 *
 * @param {string} title @param {unknown} tags @returns {string}
 */
export function foldTwitchTags(title, tags) {
  const base = String(title ?? '').trim();
  if (!Array.isArray(tags)) return base;
  const seen = new Set();
  const extra = [];
  for (const tag of tags) {
    const words = splitTagWords(tag);
    if (!words || !TAG_RE.test(words)) continue;
    const key = words.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (base.toLowerCase().includes(key)) continue; // the title already says it
    extra.push(words);
  }
  // ' · ' and not ' ': a non-word separator cannot accidentally weld two words into
  // one that the vocabulary would then fail (or falsely) match.
  return [base, ...extra].filter(Boolean).join(' · ');
}

/**
 * A `/helix/streams` response → StreamSample[].
 *
 * OFFLINE IS AN ABSENCE. Twitch answers with only the channels that are live, so a
 * roster login missing from `data` is not live. It still yields a sample, with
 * `live: false` — omitting it would mean the evaluator never sees a stream STOP, and
 * a stream it never sees stop is one it never drops from its state. There is no
 * stream id for an offline channel, so a stable `tw:<login>` stands in: a live
 * broadcast is keyed by its real (and per-broadcast) Twitch stream id, and the two
 * deliberately do not collide.
 *
 * That split costs nothing, because liveness here is keyed on `started_at` — what
 * Twitch says about the BROADCAST — and not on a witnessed off→on transition of one
 * id, exactly as the YouTube path keys on `actualStartTime`.
 *
 * A row for a login we do not track is dropped: an unattributable stream cannot
 * score for any org.
 *
 * @param {any} json
 * @param {Map<string, any>|Record<string, any>} orgByLogin - lowercased login -> org
 * @param {number} [now] - stamped onto every sample; injectable for tests
 * @returns {StreamSample[]}
 */
export function parseTwitchStreams(json, orgByLogin, now = Date.now()) {
  const pairs = orgByLogin instanceof Map
    ? [...orgByLogin.entries()]
    : Object.entries(orgByLogin || {});
  const byLogin = new Map(
    pairs.filter(([, org]) => org).map(([login, org]) => [String(login).trim().toLowerCase(), org]),
  );
  const idOf = (org) => (typeof org === 'string' ? org : String(org?.id ?? ''));
  const classOf = (org) => (typeof org === 'string' ? 'newscast' : org?.streamClass || 'newscast');

  const rows = Array.isArray(json?.data) ? json.data : [];
  const out = [];
  const live = new Set();
  for (const row of rows) {
    const login = String(row?.user_login ?? '').trim().toLowerCase();
    const org = byLogin.get(login);
    const streamId = String(row?.id ?? '').trim();
    if (!org || !streamId || live.has(login)) continue;
    live.add(login);

    const startedAt = Date.parse(String(row?.started_at ?? ''));
    const viewers = Number.parseInt(row?.viewer_count, 10);
    out.push({
      org: idOf(org),
      videoId: streamId,
      streamClass: classOf(org),
      live: true,
      title: foldTwitchTags(row?.title, row?.tags),
      // Twitch always reports a count, so `null` here means the field was missing or
      // garbled — never 0, which would enter the trailing median as a real reading.
      viewers: Number.isFinite(viewers) ? viewers : null,
      startedAt: Number.isFinite(startedAt) ? startedAt : null,
      at: now,
      url: `${TWITCH_CHANNEL_URL}${login}`,
    });
  }

  for (const [login, org] of byLogin) {
    if (live.has(login)) continue;
    out.push({
      org: idOf(org),
      videoId: `tw:${login}`,
      streamClass: classOf(org),
      live: false,
      title: '',
      viewers: null,
      startedAt: null,
      at: now,
      url: `${TWITCH_CHANNEL_URL}${login}`,
    });
  }
  return out;
}

/**
 * The cached app access token, minted on demand. Returns `null` rather than throwing
 * when the exchange fails — the caller then records nothing for this tick, which is
 * the only honest thing to do: "we could not ask" is not "nobody is live".
 */
async function twitchAppToken(logger) {
  const now = Date.now();
  if (twitchToken && twitchToken.expiresAt - TOKEN_SKEW_MS > now) return twitchToken.token;

  // The secret goes in the BODY, never the query string: a URL is what ends up in
  // an undici error message, in a proxy log and in a redirect header.
  const body = new URLSearchParams({
    client_id: (process.env.TWITCH_CLIENT_ID || '').trim(),
    client_secret: (process.env.TWITCH_CLIENT_SECRET || '').trim(),
    grant_type: 'client_credentials',
  }).toString();

  const res = await http(TWITCH_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body,
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (!res?.ok) {
    // A 400/403 here is bad credentials — an operator problem, and never chat's.
    logger?.warn?.('chase: twitch app token rejected', { status: res?.status ?? 0 });
    return null;
  }
  const json = await res.json();
  const token = typeof json?.access_token === 'string' ? json.access_token.trim() : '';
  if (!token) {
    logger?.warn?.('chase: twitch app token response carried no token');
    return null;
  }
  const ttl = Number(json?.expires_in);
  twitchToken = {
    token,
    // A missing `expires_in` is treated as an HOUR, not as forever: the cost of
    // re-minting too often is one extra request, and the cost of caching a dead
    // token is a blind platform.
    expiresAt: now + (Number.isFinite(ttl) && ttl > 0 ? ttl * 1000 : 60 * 60_000),
  };
  return token;
}

/**
 * Every Twitch source's live state, in ONE call and for ONE point.
 *
 * Like everything else in this module it NEVER throws and never partially reports a
 * failure as fact: a rejected call, a dead network or missing credentials all return
 * `[]`, which the evaluator reads as "no observation", NOT as "not live". Only a
 * response that actually came back produces the `live: false` samples that retire a
 * stream (see parseTwitchStreams).
 *
 * @param {Array<{id: string, login: string, platform?: string, streamClass?: string}>} orgs
 * @param {any} [logger]
 * @param {number} [now]
 * @returns {Promise<StreamSample[]>}
 */
export async function fetchTwitchSamples(orgs, logger = console, now = Date.now()) {
  try {
    let { twitch } = partitionSources(orgs);
    if (!twitch.length) return []; // no Twitch sources -> no request, no token, no cost
    if (!twitchReady()) {
      if (!loggedNoTwitch) {
        loggedNoTwitch = true;
        logger?.info?.('chase: no TWITCH_CLIENT_ID/TWITCH_CLIENT_SECRET — the twitch sources are not polled');
      }
      return [];
    }
    if (twitch.length > MAX_LOGINS) {
      // One call is the whole point. A roster this big is an upstream problem.
      logger?.warn?.('chase: more twitch sources than one helix/streams call holds', { logins: twitch.length });
      twitch = twitch.slice(0, MAX_LOGINS);
    }

    const byLogin = new Map(twitch.map((o) => [String(o.login).trim().toLowerCase(), o]));
    const qs = new URLSearchParams();
    for (const login of byLogin.keys()) qs.append('user_login', login);
    const url = `${TWITCH_STREAMS_URL}?${qs}`;

    // Exactly one retry, and only on 401. An app token lasts ~60 days, so the only
    // way a cached one stops working is that it was revoked or rotated out from
    // under us — which a fresh mint fixes, and which retrying on any other status
    // would not.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const token = await twitchAppToken(logger);
      if (!token) return [];
      const res = await http(url, {
        headers: {
          'Client-Id': (process.env.TWITCH_CLIENT_ID || '').trim(),
          Authorization: `Bearer ${token}`,
          accept: 'application/json',
        },
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
      if (res?.status === 401 && attempt === 0) {
        twitchToken = null;
        continue;
      }
      if (!res?.ok) {
        logger?.warn?.('chase: helix/streams rejected', { status: res?.status ?? 0, logins: byLogin.size });
        return [];
      }
      return parseTwitchStreams(await res.json(), byLogin, now);
    }
    return [];
  } catch (err) {
    logger?.warn?.('chase: helix/streams unreachable', { err: redact(err?.message || err) });
    return [];
  }
}
