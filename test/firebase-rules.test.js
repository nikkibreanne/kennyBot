// Verifies the anti-cheat invariant (spec §7, IMPLEMENTATION §I): game state is
// CLIENT-READ-ONLY. The Admin SDK (the bot) writes freely; an unauthenticated
// client (here: the emulator REST endpoint, standing in for the website) is
// REJECTED on writes and on reading secrets. Run via:
//
//   npm run test:emulator
//
// which is `firebase emulators:exec --only database "node --test …"` and sets
// FIREBASE_DATABASE_EMULATOR_HOST. Without the emulator the suite is skipped.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { initFirebase, database, emulatorNamespace, closeFirebase } from '../src/db/firebase.js';

const host = process.env.FIREBASE_DATABASE_EMULATOR_HOST;
const ns = emulatorNamespace();
const runOrSkip = host ? test : test.skip;

function restUrl(path) {
  return `http://${host}/${path}.json?ns=${ns}`;
}

before(() => {
  if (host) initFirebase();
});

after(async () => {
  if (host) {
    await database().ref('players/_ruletest_admin').remove().catch(() => {});
    await closeFirebase();
  }
});

runOrSkip('Admin SDK can write authoritative game state (bypasses rules)', async () => {
  await database().ref('players/_ruletest_admin').set({ displayName: 'admin-write', level: 1 });
  const snap = await database().ref('players/_ruletest_admin').get();
  assert.equal(snap.exists(), true);
  assert.equal(snap.val().displayName, 'admin-write');
});

runOrSkip('client WRITE to players is rejected and leaves no data', async () => {
  const res = await fetch(restUrl('players/_client_attempt'), {
    method: 'PUT',
    body: JSON.stringify({ hacked: true, level: 9999 }),
  });
  assert.equal(res.status, 401, 'client write must be denied');

  // Prove the rule actually blocked it (not just returned a code).
  const snap = await database().ref('players/_client_attempt').get();
  assert.equal(snap.exists(), false, 'no data should have been written');
});

runOrSkip('client WRITE to leaderboard/bosses/raids/config is rejected', async () => {
  for (const path of ['leaderboard/t1/u1', 'bosses/t1/w1', 'raids/t1/w1/x', 'config/live', 'config/expMode']) {
    const res = await fetch(restUrl(path), { method: 'PUT', body: JSON.stringify({ x: 1 }) });
    assert.equal(res.status, 401, `client write to ${path} must be denied`);
  }
});

runOrSkip('client can READ public game state', async () => {
  await database().ref('config/live').set(true);
  const res = await fetch(restUrl('config/live'));
  assert.equal(res.status, 200, 'public read must succeed');
  assert.equal(await res.json(), true);
});

runOrSkip('client CANNOT read config/secrets (bot token path)', async () => {
  await database().ref('config/secrets/botToken').set({ secret: 'do-not-leak' });
  const res = await fetch(restUrl('config/secrets/botToken'));
  assert.equal(res.status, 401, 'secrets must be unreadable by clients');

  // …but the Admin SDK can.
  const snap = await database().ref('config/secrets/botToken').get();
  assert.equal(snap.val().secret, 'do-not-leak');
});
