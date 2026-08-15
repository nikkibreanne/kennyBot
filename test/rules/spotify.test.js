// NOW PLAYING — reading Spotify's payload and turning it into the line chat sees.
//
// Spotify's currently-playing response has more shapes than "a song is playing",
// and every one of them ends up on stream, so each gets a test. The one that
// actually breaks things is an EPISODE: it has no `artists`, so the obvious
// `item.artists[0].name` throws mid-command and the viewer gets nothing at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  readNowPlaying, chatLine, overlayLine, formatDuration, clip, joinArtists, MAX_TITLE_LEN,
} from '../../src/rules/spotify.js';

const track = (over = {}) => ({
  is_playing: true,
  progress_ms: 83_000,
  currently_playing_type: 'track',
  item: {
    name: 'Bohemian Rhapsody',
    duration_ms: 354_000,
    artists: [{ name: 'Queen' }],
    album: { name: 'A Night at the Opera' },
    external_urls: { spotify: 'https://open.spotify.com/track/abc' },
  },
  ...over,
});

// ── helpers ───────────────────────────────────────────────────────────────────

test('durations read as mm:ss, and hh:mm:ss only when needed', () => {
  assert.equal(formatDuration(0), '0:00');
  assert.equal(formatDuration(83_000), '1:23');
  assert.equal(formatDuration(354_000), '5:54');
  assert.equal(formatDuration(3_723_000), '1:02:03', 'a long podcast');
  assert.equal(formatDuration(-5), '0:00');
  assert.equal(formatDuration(undefined), '0:00');
});

test('clip cuts on a word boundary when there is one worth using', () => {
  assert.equal(clip('short'), 'short');
  const long = 'word '.repeat(40);
  const out = clip(long);
  assert.ok(out.length <= MAX_TITLE_LEN);
  assert.ok(out.endsWith('…'));
  assert.ok(!out.includes('  '), 'whitespace collapsed');
});

test('artists join the way a person would say them', () => {
  assert.equal(joinArtists([{ name: 'Queen' }]), 'Queen');
  assert.equal(joinArtists([{ name: 'A' }, { name: 'B' }]), 'A & B');
  assert.equal(joinArtists([{ name: 'A' }, { name: 'B' }, { name: 'C' }]), 'A, B & C');
  assert.equal(joinArtists([]), '');
  assert.equal(joinArtists(undefined), '');
});

// ── payload shapes ────────────────────────────────────────────────────────────

test('a playing track reads out fully', () => {
  const np = readNowPlaying(track());
  assert.equal(np.kind, 'track');
  assert.equal(np.playing, true);
  assert.equal(np.title, 'Bohemian Rhapsody');
  assert.equal(np.subtitle, 'Queen');
  assert.equal(np.url, 'https://open.spotify.com/track/abc');
  assert.match(chatLine(np), /Queen — Bohemian Rhapsody \(1:23\/5:54\)/);
});

test('nothing playing is a 204 — null payload, not an error', () => {
  const np = readNowPlaying(null);
  assert.equal(np.kind, 'nothing');
  assert.match(chatLine(np), /nothing is playing/);
});

test('paused is not the same as nothing playing', () => {
  // The item is still populated; only is_playing changes. Reporting "nothing is
  // playing" here would be wrong, and viewers can see the stream is paused.
  const np = readNowPlaying(track({ is_playing: false }));
  assert.equal(np.kind, 'track');
  assert.equal(np.playing, false);
  assert.match(chatLine(np), /paused/);
});

test('an episode has no artists — reading it must not throw', () => {
  const np = readNowPlaying({
    is_playing: true,
    progress_ms: 60_000,
    currently_playing_type: 'episode',
    item: { name: 'Episode 12', duration_ms: 3_600_000, show: { name: 'Some Podcast' } },
  });
  assert.equal(np.kind, 'episode');
  assert.equal(np.subtitle, 'Some Podcast');
  assert.match(chatLine(np), /🎙️ Some Podcast: Episode 12/);
});

test('an ad says so rather than claiming nothing is on', () => {
  const np = readNowPlaying({ is_playing: true, currently_playing_type: 'ad', item: null });
  assert.equal(np.kind, 'ad');
  assert.match(chatLine(np), /ad/);
});

test('a local file has no url and still reads fine', () => {
  const t = track();
  delete t.item.external_urls;
  const np = readNowPlaying(t);
  assert.equal(np.url, null);
  assert.doesNotMatch(chatLine(np), /https?:/);
  assert.match(chatLine(np), /Bohemian Rhapsody/);
});

test('garbage in is "nothing playing", never a thrown command', () => {
  for (const bad of [undefined, '', 0, [], 'nope']) {
    assert.equal(readNowPlaying(bad).kind, 'nothing');
  }
  assert.equal(readNowPlaying({ currently_playing_type: 'track' }).kind, 'nothing', 'no item');
});

// ── the overlay line ──────────────────────────────────────────────────────────

test('the overlay is bare text — no link, no timestamp, no emoji', () => {
  const line = overlayLine(readNowPlaying(track()));
  assert.equal(line, 'Queen — Bohemian Rhapsody');
  // A timestamp would be wrong between polls, and a link is unclickable on video.
  assert.doesNotMatch(line, /https?:|\d:\d\d|🎧/);
});

test('the overlay CLEARS rather than freezing on the last song', () => {
  // A stale track name is worse than none, because viewers believe it.
  assert.equal(overlayLine(readNowPlaying(null)), '');
  assert.equal(overlayLine(readNowPlaying(track({ is_playing: false }))), '', 'paused');
  assert.equal(overlayLine(readNowPlaying({ currently_playing_type: 'ad', item: null })), '', 'ad');
});

test('a prefix is applied to a real line and NOT to an empty one', () => {
  // "Now Playing:" alone over a black box, with nothing after it, is worse than
  // showing nothing at all.
  const opts = { prefix: 'Now Playing: ' };
  assert.equal(overlayLine(readNowPlaying(track()), opts), 'Now Playing: Queen — Bohemian Rhapsody');
  assert.equal(overlayLine(readNowPlaying(null), opts), '');
  assert.equal(overlayLine(readNowPlaying(track({ is_playing: false })), opts), '');
});

test('the overlay clips hard — it renders on a video frame, not in chat', () => {
  const np = readNowPlaying(track({
    item: { ...track().item, name: 'T'.repeat(200), artists: [{ name: 'A'.repeat(200) }] },
  }));
  const line = overlayLine(np);
  assert.ok(line.length <= 125, `overlay line was ${line.length} chars`);
});
