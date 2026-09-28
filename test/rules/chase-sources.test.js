// CHASE SOURCES — the parse layer and the failure behaviour of the fetchers.
//
// `npm test` is offline, so every request here goes through the fetch seam and
// the fixtures are inline. That is not a compromise: the things that actually
// break this module are shape changes in the feeds and a source going down, and
// both are reproducible without a network.
//
// THE ROSTER IS PRIVATE (CLAUDE.md): every org, channel id, feed url and title
// below is invented. Only the SHAPE of the documents and the stream classes are
// real, and the shape is all this module parses.
//
// The load-bearing guarantees under test:
//   * nothing in this module throws — a 403, a timeout or a garbage body all
//     degrade to a partial result, because a monitor failure must never surface
//     in chat;
//   * no YOUTUBE_API_KEY means an RSS-only monitor, not a crashed one;
//   * the API key never reaches a log line;
//   * `concurrentViewers` absent means null, never 0 (a 0 would poison the
//     trailing median that the whole audience channel is built on).
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  chaseSourcesReady,
  youtubeKeyPresent,
  fetchLiveSamples,
  discoverVideoIds,
  fetchArticles,
  parseRssVideoIds,
  parseVideosListResponse,
  parseArticleFeed,
  initChaseSourcesWith,
} from '../../src/integrations/chaseSources.js';

const NOW = Date.parse('2026-09-28T22:00:00Z');
const MIN = 60_000;

const ORGS = [
  { id: 'org1', name: 'Org One', channelId: 'UC-org1', streamClass: 'chopper' },
  { id: 'org6', name: 'Org Six', channelId: 'UC-org6', streamClass: 'episodic' },
  { id: 'org3', name: 'Org Three', channelId: 'UC-org3', streamClass: 'newscast',
    articleFeed: 'https://example.test/org3/chases' },
];

/** Collects what was logged so a test can assert on leakage, not just on calls. */
function recorder() {
  const lines = [];
  const push = (level) => (msg, meta) => lines.push(`${level} ${msg} ${JSON.stringify(meta ?? {})}`);
  return { lines, info: push('info'), warn: push('warn'), error: push('error'), debug: push('debug') };
}

const res200 = (body, headers = {}) => ({
  ok: true,
  status: 200,
  headers: { get: (k) => headers[String(k).toLowerCase()] ?? null },
  json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});
const resStatus = (status) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => null },
  json: async () => ({}),
  text: async () => '',
});

let savedKey;
beforeEach(() => {
  savedKey = process.env.YOUTUBE_API_KEY;
  process.env.YOUTUBE_API_KEY = 'test-key-SECRET';
});
afterEach(() => {
  initChaseSourcesWith(null); // never leak the seam or the 304 cache between tests
  if (savedKey === undefined) delete process.env.YOUTUBE_API_KEY;
  else process.env.YOUTUBE_API_KEY = savedKey;
});

// ── fixtures, shaped like the real feeds (design §1) ─────────────────────────

/** A YouTube channel feed: header tags outside <entry>, one live + one upload. */
const CHANNEL_FEED_XML = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015"
      xmlns:media="http://search.yahoo.com/mrss/" xmlns="http://www.w3.org/2005/Atom">
  <id>yt:channel:-org1</id>
  <yt:channelId>UC-org1</yt:channelId>
  <title>Org One</title>
  <published>2006-08-08T20:36:05+00:00</published>
  <entry>
    <id>yt:video:org1Live001</id>
    <yt:videoId>org1Live001</yt:videoId>
    <yt:channelId>UC-org1</yt:channelId>
    <title>&#128308;LIVE: Chopper Camera</title>
    <published>2026-09-28T15:00:00+00:00</published>
    <updated>2026-09-28T21:55:00+00:00</updated>
    <media:group>
      <media:title>&#128308;LIVE: Chopper Camera</media:title>
    </media:group>
  </entry>
  <entry>
    <id>yt:video:org1Upload02</id>
    <yt:videoId>org1Upload02</yt:videoId>
    <title>Fire crews &amp; police respond downtown</title>
    <published>2026-09-28T12:30:00+00:00</published>
    <media:group>
      <media:title>Fire crews &amp; police respond downtown</media:title>
    </media:group>
  </entry>
</feed>`;

/** The newscast org's chase feed is RSS 2.0 with CDATA titles and RFC-822 pubDates. */
const articleFeedXml = (items) => `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>Police Chase Feed</title>
  <link>https://example.test/org3/chases</link>
${items.map(([title, at]) => `  <item>
    <title><![CDATA[${title}]]></title>
    <link>https://example.test/a</link>
    <pubDate>${new Date(at).toUTCString()}</pubDate>
  </item>`).join('\n')}
</channel></rss>`;

// ── parseRssVideoIds ─────────────────────────────────────────────────────────

test('parseRssVideoIds pulls id, title and published from each entry', () => {
  const got = parseRssVideoIds(CHANNEL_FEED_XML);
  assert.equal(got.length, 2, 'the feed-level <title>/<published> are not an entry');
  assert.equal(got[0].videoId, 'org1Live001');
  assert.equal(got[0].title, '🔴LIVE: Chopper Camera',
    'numeric entities are decoded — vocab matching runs on the decoded title');
  assert.equal(got[0].publishedAt, Date.parse('2026-09-28T15:00:00Z'));
  assert.equal(got[1].title, 'Fire crews & police respond downtown');
});

test('parseRssVideoIds skips an entry with no videoId and survives garbage', () => {
  const xml = '<feed><entry><title>no id here</title></entry></feed>';
  assert.deepEqual(parseRssVideoIds(xml), []);
  assert.deepEqual(parseRssVideoIds(''), []);
  assert.deepEqual(parseRssVideoIds('<html>404 Not Found</html>'), []);
  assert.deepEqual(parseRssVideoIds(undefined), []);
});

// ── parseVideosListResponse ──────────────────────────────────────────────────

const videosList = (items) => ({ kind: 'youtube#videoListResponse', items });
const videoItem = (id, channelId, title, liveBroadcastContent, concurrentViewers) => ({
  kind: 'youtube#video',
  id,
  snippet: { channelId, title, liveBroadcastContent },
  ...(concurrentViewers === undefined ? {} : { liveStreamingDetails: { concurrentViewers } }),
});

test('parseVideosListResponse maps a live stream onto its org and class', () => {
  const byChannel = new Map(ORGS.map((o) => [o.channelId, o]));
  const got = parseVideosListResponse(
    videosList([videoItem('org1Live001', 'UC-org1', 'LIVE: Pursuit in progress', 'live', '24310')]),
    byChannel,
    NOW,
  );
  assert.deepEqual(got, [{
    org: 'org1',
    videoId: 'org1Live001',
    streamClass: 'chopper',
    live: true,
    title: 'LIVE: Pursuit in progress',
    viewers: 24310,
    at: NOW,
  }]);
});

test('an absent concurrentViewers is null, never 0', () => {
  // 0 would enter the trailing median as a real reading and make the next sample
  // look like an infinite spike. "Unknown" has to stay unknown.
  const got = parseVideosListResponse(
    videosList([videoItem('org6Live001', 'UC-org6', 'Org Six News at 10', 'none')]),
    { 'UC-org6': ORGS[1] },
    NOW,
  );
  assert.equal(got[0].viewers, null);
  assert.equal(got[0].live, false, "liveBroadcastContent 'none' is not live");
  assert.equal(got[0].streamClass, 'episodic');
});

test('parseVideosListResponse accepts a plain object lookup as well as a Map', () => {
  const item = videoItem('org1Live001', 'UC-org1', 'Chopper Camera', 'live', '243');
  const viaMap = parseVideosListResponse(videosList([item]), new Map([['UC-org1', ORGS[0]]]), NOW);
  const viaObj = parseVideosListResponse(videosList([item]), { 'UC-org1': ORGS[0] }, NOW);
  assert.deepEqual(viaObj, viaMap);
});

test('a video from an untracked channel is dropped, not guessed at', () => {
  const got = parseVideosListResponse(
    videosList([videoItem('someoneElse', 'UC-stranger', 'LIVE: Police pursuit!', 'live', '90000')]),
    new Map(ORGS.map((o) => [o.channelId, o])),
    NOW,
  );
  assert.deepEqual(got, [], 'an unattributable stream cannot score for any org');
});

test('parseVideosListResponse never throws on a malformed body', () => {
  const by = new Map(ORGS.map((o) => [o.channelId, o]));
  assert.deepEqual(parseVideosListResponse(null, by, NOW), []);
  assert.deepEqual(parseVideosListResponse({ error: { code: 403 } }, by, NOW), []);
  assert.deepEqual(parseVideosListResponse(videosList([null, {}, { id: 'x' }]), by, NOW), []);
});

// ── parseArticleFeed ─────────────────────────────────────────────────────────

test('parseArticleFeed reads RSS 2.0 items with CDATA titles', () => {
  const xml = articleFeedXml([
    ['Deputies chase a speeding motorcyclist on the freeway', NOW - 5 * MIN],
    ['Driver in custody after chase on surface streets', NOW - 3 * 60 * MIN],
  ]);
  const got = parseArticleFeed(xml, 'org3');
  assert.equal(got.length, 2, 'the channel-level <title> is not an item');
  assert.equal(got[0].org, 'org3');
  assert.equal(got[0].title, 'Deputies chase a speeding motorcyclist on the freeway');
  assert.equal(got[0].publishedAt, NOW - 5 * MIN);
});

test('parseArticleFeed also reads an Atom feed, and dates it from <published>', () => {
  const xml = `<feed><entry><title>Police pursuit underway downtown</title>
    <published>2026-09-28T21:50:00Z</published></entry></feed>`;
  assert.deepEqual(parseArticleFeed(xml, 'org2'), [{
    org: 'org2',
    title: 'Police pursuit underway downtown',
    publishedAt: Date.parse('2026-09-28T21:50:00Z'),
  }]);
});

test('an undateable item gets 0, which the age window then rejects', () => {
  const xml = '<rss><channel><item><title>Pursuit on the freeway</title></item></channel></rss>';
  assert.equal(parseArticleFeed(xml, 'org3')[0].publishedAt, 0);
  assert.deepEqual(parseArticleFeed('<html>500</html>', 'org3'), []);
});

// ── fetchLiveSamples ─────────────────────────────────────────────────────────

test('chaseSourcesReady is true on a runtime with fetch', () => {
  assert.equal(chaseSourcesReady(), true);
});

test('youtubeKeyPresent follows the env var, blank string included', () => {
  assert.equal(youtubeKeyPresent(), true);
  process.env.YOUTUBE_API_KEY = '   ';
  assert.equal(youtubeKeyPresent(), false, 'a whitespace key is not a key');
  delete process.env.YOUTUBE_API_KEY;
  assert.equal(youtubeKeyPresent(), false);
});

test('with no API key the monitor degrades to RSS-only and says so ONCE', async () => {
  delete process.env.YOUTUBE_API_KEY;
  let calls = 0;
  initChaseSourcesWith(async () => { calls += 1; return res200(videosList([])); });
  const log = recorder();

  assert.deepEqual(await fetchLiveSamples(ORGS, { org1: ['org1Live001'] }, log, NOW), []);
  assert.deepEqual(await fetchLiveSamples(ORGS, { org1: ['org1Live001'] }, log, NOW), []);
  assert.equal(calls, 0, 'no key means no request at all');
  const notices = log.lines.filter((l) => l.startsWith('info') && l.includes('YOUTUBE_API_KEY'));
  assert.equal(notices.length, 1, 'once at info — not a warning every single minute');
});

test('every known id goes out in ONE videos.list call', async () => {
  const seen = [];
  initChaseSourcesWith(async (url) => {
    seen.push(url);
    return res200(videosList([
      videoItem('org1Live001', 'UC-org1', 'LIVE: Pursuit in progress', 'live', '31000'),
      videoItem('org3Live001', 'UC-org3', 'Org Three News', 'live', '810'),
    ]));
  });

  const got = await fetchLiveSamples(
    ORGS,
    { org1: ['org1Live001'], org3: ['org3Live001'], org6: [] },
    recorder(),
    NOW,
  );

  assert.equal(seen.length, 1, 'one call = one quota unit; a loop would be 6x the cost');
  const q = new URL(seen[0]).searchParams;
  assert.equal(q.get('part'), 'snippet,liveStreamingDetails');
  assert.deepEqual(q.get('id').split(','), ['org1Live001', 'org3Live001']);
  assert.equal(got.length, 2);
  assert.deepEqual(got.map((s) => s.org), ['org1', 'org3']);
});

test('a flat array of ids works as well as the per-org map', async () => {
  initChaseSourcesWith(async () => res200(videosList([
    videoItem('org1Live001', 'UC-org1', 'Chopper Camera', 'live', '243'),
  ])));
  const got = await fetchLiveSamples(ORGS, ['org1Live001'], recorder(), NOW);
  assert.equal(got[0].org, 'org1', 'the org comes from snippet.channelId, not the input shape');
});

test('no known ids spends no quota', async () => {
  let calls = 0;
  initChaseSourcesWith(async () => { calls += 1; return res200(videosList([])); });
  assert.deepEqual(await fetchLiveSamples(ORGS, {}, recorder(), NOW), []);
  assert.deepEqual(await fetchLiveSamples(ORGS, undefined, recorder(), NOW), []);
  assert.equal(calls, 0);
});

test('a quota-exhausted 403 resolves as empty, never as a throw', async () => {
  initChaseSourcesWith(async () => resStatus(403));
  const log = recorder();
  assert.deepEqual(await fetchLiveSamples(ORGS, ['org1Live001'], log, NOW), []);
  assert.ok(log.lines.some((l) => l.startsWith('warn') && l.includes('403')));
});

test('an unreachable API resolves as empty and never logs the key', async () => {
  initChaseSourcesWith(async () => {
    // Undici puts the whole request URL in the message — key and all.
    throw new Error('request to https://www.googleapis.com/youtube/v3/videos?id=x&key=test-key-SECRET failed');
  });
  const log = recorder();
  assert.deepEqual(await fetchLiveSamples(ORGS, ['org1Live001'], log, NOW), []);
  assert.equal(log.lines.length, 1);
  assert.ok(!log.lines.join(' ').includes('test-key-SECRET'), 'the API key must never reach a log line');
  assert.ok(log.lines[0].includes('key=***'));
});

test('a body that is not JSON resolves as empty', async () => {
  initChaseSourcesWith(async () => ({
    ok: true, status: 200, headers: { get: () => null },
    json: async () => { throw new SyntaxError('Unexpected token < in JSON'); },
    text: async () => '<html>',
  }));
  assert.deepEqual(await fetchLiveSamples(ORGS, ['org1Live001'], recorder(), NOW), []);
});

// ── discoverVideoIds ─────────────────────────────────────────────────────────

test('discoverVideoIds returns the newest ids per org, keyed by org id', async () => {
  const seen = [];
  initChaseSourcesWith(async (url) => { seen.push(url); return res200(CHANNEL_FEED_XML); });

  const got = await discoverVideoIds([ORGS[0]], recorder());
  assert.deepEqual(got, { org1: ['org1Live001', 'org1Upload02'] });
  assert.ok(seen[0].startsWith('https://www.youtube.com/feeds/videos.xml?channel_id=UC-org1'));
});

test('one dead channel feed never stops the others', async () => {
  initChaseSourcesWith(async (url) => {
    if (url.includes('UC-org1')) throw new Error('ETIMEDOUT');
    if (url.includes('UC-org6')) return resStatus(503);
    return res200(CHANNEL_FEED_XML);
  });
  const log = recorder();

  const got = await discoverVideoIds(ORGS, log);
  // A FAILED org is absent rather than empty: a caller merging this into its known
  // set must keep the last good ids instead of forgetting the stream.
  assert.deepEqual(Object.keys(got), ['org3']);
  assert.equal(got.org3.length, 2);
  assert.equal(log.lines.filter((l) => l.startsWith('warn')).length, 2);
});

test('discoverVideoIds tolerates junk input without throwing', async () => {
  initChaseSourcesWith(async () => res200(CHANNEL_FEED_XML));
  assert.deepEqual(await discoverVideoIds(undefined, recorder()), {});
  assert.deepEqual(await discoverVideoIds([null, {}, { id: 'x' }], recorder()), {});
});

// ── fetchArticles ────────────────────────────────────────────────────────────

test('fetchArticles keeps recent chase items and drops everything else', async () => {
  initChaseSourcesWith(async () => res200(articleFeedXml([
    ['Police pursuit underway on the freeway', NOW - 4 * MIN],     // keep
    ['Chase ends in custody on surface streets', NOW - 90 * MIN],  // too old
    ['Raw video: chase ends in fiery crash', NOW - 2 * MIN],       // retrospective clip
    ['Traffic hazard closes two lanes downtown', NOW - MIN],       // not a chase
  ])));

  const got = await fetchArticles(ORGS, recorder(), NOW);
  assert.deepEqual(got, [{
    org: 'org3',
    title: 'Police pursuit underway on the freeway',
    publishedAt: NOW - 4 * MIN,
  }]);
});

test('an org with no articleFeed is simply not fetched', async () => {
  let calls = 0;
  initChaseSourcesWith(async () => { calls += 1; return res200(articleFeedXml([])); });
  assert.deepEqual(await fetchArticles([ORGS[0], ORGS[1]], recorder(), NOW), []);
  assert.equal(calls, 0);
});

test('a 304 costs nothing and replays what was already published', async () => {
  const xml = articleFeedXml([['Police pursuit heads east', NOW - MIN]]);
  const sent = [];
  initChaseSourcesWith(async (url, init) => {
    sent.push(init?.headers ?? {});
    return sent.length === 1
      ? res200(xml, { etag: 'W/"abc123"', 'last-modified': 'Mon, 28 Sep 2026 21:59:00 GMT' })
      : resStatus(304);
  });

  const first = await fetchArticles(ORGS, recorder(), NOW);
  const second = await fetchArticles(ORGS, recorder(), NOW + MIN);
  assert.equal(first.length, 1);
  assert.deepEqual(second, first, 'a 304 means "unchanged", not "nothing is happening"');
  assert.equal(sent[1]['if-none-match'], 'W/"abc123"');
  assert.equal(sent[1]['if-modified-since'], 'Mon, 28 Sep 2026 21:59:00 GMT');
});

test('the replay still expires — a cached item ages out of the window', async () => {
  const xml = articleFeedXml([['Police pursuit heads east', NOW - MIN]]);
  let n = 0;
  initChaseSourcesWith(async () => (n++ === 0 ? res200(xml, { etag: 'W/"abc"' }) : resStatus(304)));

  assert.equal((await fetchArticles(ORGS, recorder(), NOW)).length, 1);
  assert.deepEqual(await fetchArticles(ORGS, recorder(), NOW + 45 * MIN), [],
    'the age window retires an item, not the fetch outcome');
});

test('a failed article feed replays the cache instead of flapping the signal off', async () => {
  const xml = articleFeedXml([['Police pursuit underway on the freeway', NOW - MIN]]);
  let n = 0;
  initChaseSourcesWith(async () => {
    n += 1;
    if (n === 1) return res200(xml, { etag: 'W/"abc"' });
    if (n === 2) throw new Error('ECONNRESET');
    return resStatus(500);
  });
  const log = recorder();

  assert.equal((await fetchArticles(ORGS, log, NOW)).length, 1);
  assert.equal((await fetchArticles(ORGS, log, NOW + MIN)).length, 1, 'a reset connection is not news');
  assert.equal((await fetchArticles(ORGS, log, NOW + 2 * MIN)).length, 1);
  assert.equal(log.lines.filter((l) => l.startsWith('warn')).length, 2);
});

test('fetchArticles never throws, whatever comes back', async () => {
  initChaseSourcesWith(async () => { throw new Error('getaddrinfo ENOTFOUND'); });
  assert.deepEqual(await fetchArticles(ORGS, recorder(), NOW), []);
  initChaseSourcesWith(async () => res200('<html><body>maintenance</body></html>'));
  assert.deepEqual(await fetchArticles(ORGS, recorder(), NOW), []);
  initChaseSourcesWith(async () => undefined); // a seam/transport that returns nothing
  assert.deepEqual(await fetchArticles(ORGS, recorder(), NOW), []);
  assert.deepEqual(await fetchArticles(undefined, recorder(), NOW), []);
});
