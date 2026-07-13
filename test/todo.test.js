// Behavioral tests for the TODO BOARD (/todo/): add (default + explicit date),
// list ordering (by date, then creation order), remove, and validation. Mirrors
// the market/fact emulator tests; skipped without the emulator host.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { initFirebase, database, closeFirebase } from '../src/db/firebase.js';
import { addTodo, removeTodo, listTodos, channelDate, resolveDateToken } from '../src/db/todo.js';

const host = process.env.FIREBASE_DATABASE_EMULATOR_HOST;
const runOrSkip = host ? test : test.skip;

async function wipe() {
  await Promise.all(['todos', 'counters'].map((p) => database().ref(p).remove().catch(() => {})));
}

before(async () => { if (host) initFirebase(); });
after(async () => { if (host) { await wipe(); await closeFirebase(); } });
beforeEach(async () => { if (host) await wipe(); });

runOrSkip('todo: add assigns short ids, cleans text, defaults to today', async () => {
  const a = await addTodo({ text: '  stream   setup  ', by: 'Mod' });
  const b = await addTodo({ text: 'call the vet for Ghost', by: 'Mod' });
  assert.deepEqual([a.ok, a.id, b.id], [true, 1, 2], 'short ids 1,2');
  assert.equal(a.todo.text, 'stream setup', 'whitespace collapsed');
  assert.equal(a.todo.date, channelDate(), 'defaults to the channel today');
});

runOrSkip('todo: explicit date honored; list sorts by date then id', async () => {
  await addTodo({ text: 'later thing', date: '2099-12-31' });
  await addTodo({ text: 'today A' });
  await addTodo({ text: 'today B' });
  const list = await listTodos();
  assert.deepEqual(list.map((t) => t.text), ['today A', 'today B', 'later thing'], 'soonest day first, then id order');
});

runOrSkip('todo: date tokens resolve; a bad token stays part of the text', async () => {
  assert.equal(resolveDateToken('2026-07-20'), '2026-07-20');
  assert.equal(resolveDateToken('today'), channelDate());
  assert.equal(resolveDateToken('groceries'), null, 'non-date token → null (kept as text)');
  // An invalid date passed straight to addTodo falls back to today, never stored raw.
  assert.equal((await addTodo({ text: 'x', date: 'nope' })).todo.date, channelDate());
});

runOrSkip('todo: validation rejects empty and over-long', async () => {
  assert.equal((await addTodo({ text: '   ' })).reason, 'empty');
  assert.equal((await addTodo({ text: 'x'.repeat(201) })).reason, 'too-long');
});

runOrSkip('todo: remove clears an item; a missing id reports not-found', async () => {
  const a = await addTodo({ text: 'to be removed' });
  assert.equal((await removeTodo(a.id)).ok, true, 'removed');
  assert.equal((await listTodos()).length, 0, 'board empty');
  assert.equal((await removeTodo(a.id)).reason, 'not-found', 'already gone');
  assert.equal((await removeTodo(999)).reason, 'not-found');
});
