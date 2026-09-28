// Chase-monitor sources — the only place this feature touches the network.
//
// Three sources, deliberately unequal (docs/chase-monitor-design.md §1, all of it
// probed against the live internet on 2026-09-28):
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
 * @property {string} videoId      - YouTube video id
 * @property {string} streamClass  - 'chopper' | 'newscast' | 'episodic'
 * @property {boolean} live
 * @property {string} title
 * @property {number|null} viewers - concurrent viewers; NULL when unknown
 *                                   (no API key -> audience channel disabled)
 * @property {number} at           - ms epoch
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

const HTTP_TIMEOUT_MS = 10_000;
/** `videos.list` bills 1 unit per CALL, not per id — but only up to 50 ids. */
const MAX_IDS = 50;
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
}

/**
 * True when the cheap half of the pipeline can run at all. RSS needs nothing but
 * `fetch`, so this is really "is this runtime usable" — the YouTube key is a
 * separate, optional question (`youtubeKeyPresent`).
 */
export function chaseSourcesReady() {
  return Boolean(fakeFetch) || typeof fetch === 'function';
}

/** Whether the audience channel can work at all. The only env var this feature has. */
export function youtubeKeyPresent() {
  return Boolean((process.env.YOUTUBE_API_KEY || '').trim());
}

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

/** Keys never reach a log line; the URL is the only thing that carries one. */
const redact = (s) => String(s).replace(/key=[^&\s]+/gi, 'key=***');

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
