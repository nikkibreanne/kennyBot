// Fact ordering. `!fact <n>` promises the number a viewer can SEE on the /info/
// page — and the page numbers its <ol> positionally, storing no number anywhere.
// So the bot has to reproduce the site's sort exactly. These tests pin that sort
// against the website's own implementation (_includes/info.html sortFacts):
//
//   curated first, by `order` · then submissions, newest-first by `at`
//
// If these fail, `!fact 3` is quoting a different fact than the page displays.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sortFacts } from '../../src/db/facts.js';

const curated = (order, text = `c${order}`) => ({ text, source: 'curated', order });
const submitted = (at, text = `s${at}`, by = 'viewer') => ({ text, by, at });

const texts = (facts) => sortFacts(facts).map((f) => f.text);

test('curated facts come first, in their seeded order', () => {
  assert.deepEqual(texts([curated(3), curated(1), curated(2)]), ['c1', 'c2', 'c3']);
});

test('submissions follow the curated block, newest first', () => {
  const facts = [submitted(100), curated(2), submitted(300), curated(1), submitted(200)];
  assert.deepEqual(texts(facts), ['c1', 'c2', 's300', 's200', 's100']);
});

test('a curated fact outranks a submission regardless of timestamps', () => {
  // Curated facts carry no `at`, so a submission approved just now must not
  // jump ahead of them.
  const t = 1_900_000_000_000;
  assert.deepEqual(texts([submitted(t), curated(1)]), ['c1', `s${t}`]);
});

test('the input array is never mutated — callers may hold the original', () => {
  const input = [curated(2), curated(1)];
  const copy = [...input];
  sortFacts(input);
  assert.deepEqual(input, copy);
});

test('missing order/at fields sort predictably instead of throwing', () => {
  // Real data has gaps: approveFact writes no `order`, and older curated rows
  // predate the field. Treat them as 0 rather than producing NaN comparisons.
  const facts = [{ text: 'no-order', source: 'curated' }, curated(1), { text: 'no-at', by: 'x' }, submitted(50)];
  const out = texts(facts);
  assert.equal(out[0], 'no-order', 'order-less curated sorts as 0 → first');
  assert.equal(out[1], 'c1');
  assert.deepEqual(out.slice(2), ['s50', 'no-at'], 'at-less submission sorts as 0 → last');
});

test('numbering is 1-based and positional, matching the page <ol>', () => {
  const ordered = sortFacts([submitted(200), curated(1), submitted(100), curated(2)]);
  assert.equal(ordered.length, 4);
  // What `!fact 2` must resolve to:
  assert.equal(ordered[2 - 1].text, 'c2');
  assert.equal(ordered[4 - 1].text, 's100');
});
