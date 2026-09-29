// CHASE SOURCES — the parse layer and the failure behaviour of the fetchers.
//
// `npm test` is offline, so every request here goes through the fetch seam and
// the fixtures are inline. That is not a compromise: the things that actually
// break this module are shape changes in the feeds and a source going down, and
// both are reproducible without a network.
//
// THE ROSTER IS PRIVATE (CLAUDE.md): every org, channel id, twitch login, feed url
// and title below is invented. Only the SHAPE of the documents and the stream
// classes are real, and the shape is all this module parses.
//
// The load-bearing guarantees under test:
//   * nothing in this module throws — a 403, a timeout or a garbage body all
//     degrade to a partial result, because a monitor failure must never surface
//     in chat;
//   * no YOUTUBE_API_KEY means an RSS-only monitor, not a crashed one;
//   * neither the YouTube API key nor the Twitch client secret / app token ever
//     reaches a log line;
//   * `concurrentViewers` absent means null, never 0 (a 0 would poison the
//     trailing median that the whole audience channel is built on).
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  chaseSourcesReady,
  youtubeKeyPresent,
  twitchReady,
  fetchLiveSamples,
  discoverVideoIds,
  fetchArticles,
  fetchTwitchSamples,
  partitionSources,
  parseRssVideoIds,
  parseVideosListResponse,
  parseArticleFeed,
  parseTwitchStreams,
  foldTwitchTags,
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

/** Two INVENTED twitch sources. A twitch entry carries `login`, never `channelId`. */
const TWITCH_ORGS = [
  { id: 'org7', name: 'Org Seven', platform: 'twitch', login: 'OrgSevenCam', streamClass: 'episodic' },
  { id: 'org8', name: 'Org Eight', platform: 'twitch', login: 'orgeight', streamClass: 'newscast' },
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
let savedTwitchId;
let savedTwitchSecret;
beforeEach(() => {
  savedKey = process.env.YOUTUBE_API_KEY;
  savedTwitchId = process.env.TWITCH_CLIENT_ID;
  savedTwitchSecret = process.env.TWITCH_CLIENT_SECRET;
  process.env.YOUTUBE_API_KEY = 'test-key-SECRET';
  process.env.TWITCH_CLIENT_ID = 'test-client-id';
  process.env.TWITCH_CLIENT_SECRET = 'test-client-SECRET';
});
afterEach(() => {
  // Never leak the seam, the 304 cache or the cached app token between tests.
  initChaseSourcesWith(null);
  const restore = (name, saved) => {
    if (saved === undefined) delete process.env[name];
    else process.env[name] = saved;
  };
  restore('YOUTUBE_API_KEY', savedKey);
  restore('TWITCH_CLIENT_ID', savedTwitchId);
  restore('TWITCH_CLIENT_SECRET', savedTwitchSecret);
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
    startedAt: null, // absent actualStartTime in this fixture
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

// ── Twitch: the platform split ───────────────────────────────────────────────

test('partitionSources defaults an entry with no platform to youtube', () => {
  const got = partitionSources([...ORGS, ...TWITCH_ORGS]);
  assert.deepEqual(got.youtube.map((o) => o.id), ['org1', 'org6', 'org3'],
    'an entry written before Twitch existed keeps working untouched');
  assert.deepEqual(got.twitch.map((o) => o.id), ['org7', 'org8']);
});

test('partitionSources drops an entry with no usable identifier', () => {
  const got = partitionSources([
    { id: 'a' }, // youtube by default, but no channelId
    { id: 'b', platform: 'twitch' }, // twitch, but no login
    { channelId: 'UC-nope' }, // no id at all
    null,
  ]);
  assert.deepEqual(got, { youtube: [], twitch: [] });
  assert.deepEqual(partitionSources(undefined), { youtube: [], twitch: [] });
});

test('twitchReady needs BOTH halves — an id with no secret cannot mint a token', () => {
  assert.equal(twitchReady(), true);
  delete process.env.TWITCH_CLIENT_SECRET;
  assert.equal(twitchReady(), false);
  process.env.TWITCH_CLIENT_SECRET = 'test-client-SECRET';
  process.env.TWITCH_CLIENT_ID = '  ';
  assert.equal(twitchReady(), false, 'a whitespace client id is not a client id');
});

// ── foldTwitchTags ───────────────────────────────────────────────────────────

test('foldTwitchTags splits a CamelCase tag so the vocabulary can see the word', () => {
  // This is the whole reason the helper exists: 'PoliceChase' has no word boundary
  // inside it, so \bchase\b cannot match it until it is split.
  assert.equal(foldTwitchTags('out and about', ['PoliceChase']), 'out and about · Police Chase');
  assert.equal(foldTwitchTags('out and about', ['police_chase']), 'out and about · police chase');
  assert.equal(foldTwitchTags('out and about', ['HighSpeed']), 'out and about · High Speed');
});

test('foldTwitchTags keeps only vocabulary tags — location and language are noise', () => {
  const got = foldTwitchTags('driving around', ['LosAngeles', 'Pursuit', 'English', 'DropsEnabled']);
  assert.equal(got, 'driving around · Pursuit');
});

test('foldTwitchTags folds a NEGATIVE tag too — it is the veto, not noise', () => {
  // A 24/7 replay loop is the retrospective false positive this monitor has to
  // reject, and the tag is the only structured marker that identifies it.
  assert.equal(foldTwitchTags('chases all day', ['Replay']), 'chases all day · Replay');
});

test('foldTwitchTags does not repeat a word the title already carries', () => {
  assert.equal(foldTwitchTags('Live pursuit right now', ['Pursuit', 'PoliceChase']),
    'Live pursuit right now · Police Chase');
});

test('foldTwitchTags survives a missing or junk tag list', () => {
  assert.equal(foldTwitchTags('just a title', undefined), 'just a title');
  assert.equal(foldTwitchTags('just a title', []), 'just a title');
  assert.equal(foldTwitchTags(undefined, ['Pursuit']), 'Pursuit');
  assert.equal(foldTwitchTags('just a title', [null, 42, {}]), 'just a title');
});

// ── parseTwitchStreams ───────────────────────────────────────────────────────

const helixStreams = (data) => ({ data, pagination: {} });
const helixRow = (over = {}) => ({
  id: '40952679880',
  user_id: '1',
  user_login: 'orgsevencam',
  user_name: 'OrgSevenCam',
  game_id: '514859',
  game_name: 'Special Events',
  type: 'live',
  title: 'following the pursuit',
  viewer_count: 1843,
  started_at: '2026-09-28T21:30:00Z',
  language: 'en',
  thumbnail_url: 'https://example.test/{width}x{height}.jpg',
  tags: ['LosAngeles', 'PoliceChase'],
  ...over,
});
const byLogin = new Map(TWITCH_ORGS.map((o) => [o.login.toLowerCase(), o]));

test('parseTwitchStreams maps a live stream onto its org, class, url and start time', () => {
  const got = parseTwitchStreams(helixStreams([helixRow()]), byLogin, NOW);
  assert.deepEqual(got[0], {
    org: 'org7',
    videoId: '40952679880', // the Twitch STREAM id, which is per-broadcast
    streamClass: 'episodic',
    live: true,
    title: 'following the pursuit · Police Chase', // the tag is folded in
    viewers: 1843,
    startedAt: Date.parse('2026-09-28T21:30:00Z'),
    at: NOW,
    url: 'https://www.twitch.tv/orgsevencam',
  });
});

test('a roster login ABSENT from the response is live:false, never omitted', () => {
  // Omitting it would mean the evaluator never sees a stream STOP — and a stream it
  // never sees stop is one it never drops.
  const got = parseTwitchStreams(helixStreams([helixRow()]), byLogin, NOW);
  assert.equal(got.length, 2);
  const dark = got.find((sample) => sample.org === 'org8');
  assert.deepEqual(dark, {
    org: 'org8',
    videoId: 'tw:orgeight', // there IS no stream id for an offline channel
    streamClass: 'newscast',
    live: false,
    title: '',
    viewers: null,
    startedAt: null,
    at: NOW,
    url: 'https://www.twitch.tv/orgeight',
  });
});

test('an empty response makes every roster login not-live', () => {
  const got = parseTwitchStreams(helixStreams([]), byLogin, NOW);
  assert.deepEqual(got.map((sample) => sample.live), [false, false]);
  assert.deepEqual(got.map((sample) => sample.org), ['org7', 'org8']);
});

test('a row for a login we do not track is dropped, not guessed at', () => {
  // The category query returns whoever is live in it, including 24/7 replay loops.
  // An unattributable stream cannot score for any org.
  const got = parseTwitchStreams(
    helixStreams([helixRow({ user_login: 'somebodyelse', title: 'PURSUIT REPLAY 24/7' })]),
    byLogin,
    NOW,
  );
  assert.equal(got.length, 2);
  assert.deepEqual(got.map((sample) => sample.live), [false, false]);
});

test('parseTwitchStreams takes a plain object lookup as well as a Map', () => {
  const viaMap = parseTwitchStreams(helixStreams([helixRow()]), byLogin, NOW);
  const viaObj = parseTwitchStreams(
    helixStreams([helixRow()]),
    { OrgSevenCam: TWITCH_ORGS[0], orgeight: TWITCH_ORGS[1] },
    NOW,
  );
  assert.deepEqual(viaObj, viaMap, 'the login key is matched case-insensitively');
});

test('a missing viewer_count is null, never 0', () => {
  const got = parseTwitchStreams(
    helixStreams([helixRow({ viewer_count: undefined })]),
    byLogin,
    NOW,
  );
  assert.equal(got[0].viewers, null, '0 would poison the trailing median');
  const zero = parseTwitchStreams(helixStreams([helixRow({ viewer_count: 0 })]), byLogin, NOW);
  assert.equal(zero[0].viewers, 0, 'a real reading of 0 is still a reading');
});

test('an unparseable started_at leaves startedAt null rather than guessing', () => {
  const got = parseTwitchStreams(helixStreams([helixRow({ started_at: 'soon' })]), byLogin, NOW);
  assert.equal(got[0].startedAt, null, 'the evaluator declines to score liveness rather than guess');
});

test('parseTwitchStreams never throws on a malformed body', () => {
  assert.equal(parseTwitchStreams(null, byLogin, NOW).length, 2); // everything dark
  assert.equal(parseTwitchStreams({ error: 'Unauthorized' }, byLogin, NOW).length, 2);
  assert.equal(parseTwitchStreams(helixStreams([null, {}, { id: 'x' }]), byLogin, NOW).length, 2);
  assert.deepEqual(parseTwitchStreams(helixStreams([helixRow()]), undefined, NOW), []);
});

// ── fetchTwitchSamples ───────────────────────────────────────────────────────

/** Answers the token POST and the streams GET, and records both. */
function twitchSeam({ token = 'app-token-SECRET', streams = [], status = 200, ttl = 5_184_000 } = {}) {
  const calls = [];
  const statuses = Array.isArray(status) ? [...status] : [status];
  initChaseSourcesWith(async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).startsWith('https://id.twitch.tv/')) {
      return res200({ access_token: token, expires_in: ttl, token_type: 'bearer' });
    }
    const next = statuses.length > 1 ? statuses.shift() : statuses[0];
    return next === 200 ? res200({ data: streams, pagination: {} }) : resStatus(next);
  });
  return calls;
}

test('every twitch login goes out in ONE helix/streams call', async () => {
  const calls = twitchSeam({ streams: [helixRow()] });
  const got = await fetchTwitchSamples(TWITCH_ORGS, recorder(), NOW);

  const streamCalls = calls.filter((c) => c.url.includes('/helix/streams'));
  assert.equal(streamCalls.length, 1, 'one call = one point; a loop would be one per source');
  const q = new URL(streamCalls[0].url).searchParams;
  assert.deepEqual(q.getAll('user_login'), ['orgsevencam', 'orgeight']);
  assert.equal(streamCalls[0].init.headers['Client-Id'], 'test-client-id');
  assert.equal(streamCalls[0].init.headers.Authorization, 'Bearer app-token-SECRET');
  assert.deepEqual(got.map((s) => [s.org, s.live]), [['org7', true], ['org8', false]]);
});

test('the app token is minted once and then reused across polls', async () => {
  const calls = twitchSeam({ streams: [helixRow()] });
  await fetchTwitchSamples(TWITCH_ORGS, recorder(), NOW);
  await fetchTwitchSamples(TWITCH_ORGS, recorder(), NOW + MIN);
  await fetchTwitchSamples(TWITCH_ORGS, recorder(), NOW + 2 * MIN);

  const tokenCalls = calls.filter((c) => c.url.startsWith('https://id.twitch.tv/'));
  assert.equal(tokenCalls.length, 1, 'an app token lasts ~60 days — re-minting it every minute is waste');
  assert.equal(tokenCalls[0].init.method, 'POST');
  assert.ok(!tokenCalls[0].url.includes('client_secret'), 'the secret goes in the BODY, never the URL');
  assert.ok(tokenCalls[0].init.body.includes('grant_type=client_credentials'));
});

test('a 401 re-mints the token and retries exactly once', async () => {
  const calls = twitchSeam({ streams: [helixRow()], status: [401, 200] });
  const got = await fetchTwitchSamples(TWITCH_ORGS, recorder(), NOW);

  assert.equal(calls.filter((c) => c.url.startsWith('https://id.twitch.tv/')).length, 2,
    'a revoked token is the only reason a cached one stops working');
  assert.equal(calls.filter((c) => c.url.includes('/helix/streams')).length, 2);
  assert.equal(got.find((s) => s.org === 'org7').live, true);
});

test('a second 401 gives up empty rather than looping', async () => {
  const calls = twitchSeam({ status: 401 });
  const log = recorder();
  assert.deepEqual(await fetchTwitchSamples(TWITCH_ORGS, log, NOW), []);
  assert.equal(calls.filter((c) => c.url.includes('/helix/streams')).length, 2, 'exactly one retry');
  assert.ok(log.lines.some((l) => l.startsWith('warn') && l.includes('401')));
});

test('a rate-limited 429 resolves as empty, never as "nobody is live"', async () => {
  // [] is "we could not ask". Manufacturing live:false samples here would retire a
  // stream that is still running.
  const log = recorder();
  twitchSeam({ status: 429 });
  assert.deepEqual(await fetchTwitchSamples(TWITCH_ORGS, log, NOW), []);
  assert.ok(log.lines.some((l) => l.startsWith('warn') && l.includes('429')));
});

test('a rejected token exchange resolves as empty and asks for no streams', async () => {
  const calls = [];
  initChaseSourcesWith(async (url) => { calls.push(String(url)); return resStatus(403); });
  const log = recorder();
  assert.deepEqual(await fetchTwitchSamples(TWITCH_ORGS, log, NOW), []);
  assert.equal(calls.filter((u) => u.includes('/helix/streams')).length, 0);
  assert.ok(log.lines.some((l) => l.includes('token rejected')));
});

test('an unreachable Twitch never logs the client secret or the app token', async () => {
  initChaseSourcesWith(async (url) => {
    if (String(url).startsWith('https://id.twitch.tv/')) {
      return res200({ access_token: 'app-token-SECRET', expires_in: 5_184_000 });
    }
    // Undici echoes the request back in the message, headers and all.
    throw new Error('request to https://api.twitch.tv/helix/streams failed'
      + ' (Authorization: Bearer app-token-SECRET, client_secret=test-client-SECRET)');
  });
  const log = recorder();

  assert.deepEqual(await fetchTwitchSamples(TWITCH_ORGS, log, NOW), []);
  const all = log.lines.join(' ');
  assert.ok(!all.includes('app-token-SECRET'), 'the app token must never reach a log line');
  assert.ok(!all.includes('test-client-SECRET'), 'the client secret must never reach a log line');
  assert.ok(all.includes('Bearer ***') && all.includes('client_secret=***'));
});

test('no twitch credentials means no request at all, and it says so ONCE', async () => {
  delete process.env.TWITCH_CLIENT_SECRET;
  const calls = twitchSeam({ streams: [helixRow()] });
  const log = recorder();

  assert.deepEqual(await fetchTwitchSamples(TWITCH_ORGS, log, NOW), []);
  assert.deepEqual(await fetchTwitchSamples(TWITCH_ORGS, log, NOW + MIN), []);
  assert.equal(calls.length, 0, 'no credentials means no token exchange either');
  const notices = log.lines.filter((l) => l.startsWith('info') && l.includes('TWITCH_CLIENT'));
  assert.equal(notices.length, 1, 'once at info — not a warning every single minute');
});

test('a roster with no twitch sources costs nothing — no token, no call', async () => {
  const calls = twitchSeam({ streams: [helixRow()] });
  assert.deepEqual(await fetchTwitchSamples(ORGS, recorder(), NOW), []);
  assert.deepEqual(await fetchTwitchSamples(undefined, recorder(), NOW), []);
  assert.equal(calls.length, 0);
});

test('fetchTwitchSamples filters the roster itself, so a caller can pass all of it', async () => {
  twitchSeam({ streams: [helixRow()] });
  const got = await fetchTwitchSamples([...ORGS, ...TWITCH_ORGS], recorder(), NOW);
  assert.deepEqual(got.map((s) => s.org), ['org7', 'org8'],
    'a youtube entry is not a twitch login and is never asked about here');
});
