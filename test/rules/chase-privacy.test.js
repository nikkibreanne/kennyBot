// The source roster must never enter this public repo (CLAUDE.md).
//
// A guard for this has an obvious problem: a list of forbidden outlet names would
// itself BE the roster, sitting in the repo, defeating the point. So this test
// derives its forbidden list from the private file — which is gitignored and absent
// from a fresh clone — and falls back to structural checks when that file is not
// there. It scans only git-TRACKED files, which is exactly the set that would be
// published.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { config } from '../../src/config.js';

const SOURCES_FILE = '.workspace/chase-sources.json';
const SKIP = /^(package-lock\.json|CHANGELOG\.md|.*\.(png|jpg|jpeg|gif|ico|woff2?))$/;

/**
 * Everything `git add -A` would stage: tracked files PLUS untracked ones that are not
 * gitignored. Scanning only TRACKED files would let a leak sit in a new, unstaged file
 * — the guard would pass, the author would commit, and it would only fail on the next
 * run, after the secret was already in history. `.workspace/` is ignored, so the
 * private roster itself is correctly invisible here.
 */
function trackedFiles() {
  try {
    return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' })
      .split('\n').filter((f) => f && !SKIP.test(f));
  } catch {
    return []; // not a git checkout (a tarball, a container) — nothing to police
  }
}

function readTracked() {
  const out = [];
  for (const f of trackedFiles()) {
    try { out.push([f, readFileSync(f, 'utf8')]); } catch { /* binary or gone */ }
  }
  return out;
}

test('the public config ships no sources', () => {
  assert.deepEqual(config.chase.orgs, [], 'the roster belongs in RTDB, loaded from a gitignored file');
});

test('no YouTube channel id appears in any tracked file', () => {
  // Structural, so it works with or without the private file present.
  const pattern = /\bUC[A-Za-z0-9_-]{22}\b/;
  const hits = [];
  for (const [file, body] of readTracked()) {
    for (const [i, line] of body.split('\n').entries()) {
      // No exemptions, deliberately. Placeholders elsewhere in this repo are kept SHORT
      // (`UC-org1`) precisely so this stays a single unambiguous rule that a plain
      // `grep -E 'UC[A-Za-z0-9_-]{22}'` reproduces exactly — an exemption list here
      // would silently diverge from the grep CLAUDE.md tells a human to run.
      if (pattern.test(line)) hits.push(`${file}:${i + 1}`);
    }
  }
  assert.deepEqual(hits, [], 'a real channel id is in the repo');
});

test('nothing from the private roster leaks into a tracked file', (t) => {
  if (!existsSync(SOURCES_FILE)) {
    t.skip(`${SOURCES_FILE} not present — structural checks above still ran`);
    return;
  }
  /** @type {Array<Record<string, unknown>>} */
  const roster = JSON.parse(readFileSync(SOURCES_FILE, 'utf8'));

  // Every distinctive string the roster knows about: display names (and their
  // word-pieces, so "Foo 11" is caught as "Foo"), channel ids, TWITCH LOGINS, and
  // feed hostnames. A login is a real channel name by another route — CLAUDE.md
  // forbids it in a comment or a fixture exactly as it forbids a channel id — and it
  // is not covered by the display name, because a login is usually the name squashed
  // into one token.
  const secrets = new Set();
  for (const org of roster) {
    for (const piece of String(org.name ?? '').split(/[\s/]+/)) {
      if (piece.length >= 4 && !/^\d+$/.test(piece)) secrets.add(piece.toLowerCase());
    }
    if (org.channelId) secrets.add(String(org.channelId).toLowerCase());
    // Guarded on length for the same reason the name pieces are: a three-letter login
    // would match half the repo and make this test useless rather than strict.
    if (String(org.login ?? '').length >= 4) secrets.add(String(org.login).toLowerCase());
    if (org.articleFeed) {
      try { secrets.add(new URL(org.articleFeed).hostname.toLowerCase()); } catch { /* not a url */ }
    }
  }

  const hits = [];
  for (const [file, body] of readTracked()) {
    const lower = body.toLowerCase();
    for (const secret of secrets) {
      if (lower.includes(secret)) hits.push(`${file} contains a roster string`);
    }
  }
  assert.deepEqual([...new Set(hits)], [], 'the private roster leaked into tracked files');
});
