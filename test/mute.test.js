// Behavioral test for the mod mute switch (!mute). Verifies the actual chat
// handler wiring against the emulator: while muted, ordinary command replies are
// SUPPRESSED, but the !mute control itself (bypassMute) still answers so mods
// keep getting confirmation. Run via:
//
//   npm run test:emulator
//
// (skipped when the emulator host isn't set, same as firebase-rules.test.js).
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { initFirebase, database, closeFirebase } from '../src/db/firebase.js';
import { startConfigMirror, setChatMuted, isChatMuted } from '../src/db/configStore.js';
import { createMessageHandler } from '../src/events/chat.js';

const host = process.env.FIREBASE_DATABASE_EMULATOR_HOST;
const runOrSkip = host ? test : test.skip;

const noopLogger = { info() {}, warn() {}, error() {}, debug() {} };

// Records outbound chat so we can assert on what the bot said (or didn't).
const sent = [];
const fakeChat = {
  say: (_ch, text) => { sent.push(text); return Promise.resolve(); },
  action: (_ch, text) => { sent.push(text); return Promise.resolve(); },
};

let handler;

// Distinct ids per call avoid the per-user/per-command cooldown masking a send.
let seq = 0;
function fire(text, { mod = false, broadcaster = false } = {}) {
  seq += 1;
  const userId = `u_mute_${seq}`;
  const msg = {
    userInfo: {
      userId,
      userName: `tester${seq}`,
      displayName: `Tester${seq}`,
      isMod: mod,
      isBroadcaster: broadcaster,
      isSubscriber: false,
    },
  };
  return handler('#test', `tester${seq}`, text, msg);
}

before(async () => {
  if (!host) return;
  initFirebase();
  await startConfigMirror(noopLogger);
  handler = createMessageHandler({ chat: fakeChat, channel: '#test', botUserId: 'bot', logger: noopLogger, onActivity() {} });
});

after(async () => {
  if (!host) return;
  await setChatMuted(false).catch(() => {});
  await closeFirebase();
});

beforeEach(async () => {
  if (!host) return;
  sent.length = 0;
  await setChatMuted(false);
});

runOrSkip('unmuted: an ordinary command replies in chat', async () => {
  await fire('!muster'); // no active raid → "No raid is scheduled yet"
  assert.equal(sent.length, 1, 'an unmuted command should reply');
});

runOrSkip('muted: an ordinary command is silenced', async () => {
  await setChatMuted(true);
  assert.equal(isChatMuted(), true, 'setter updates the mirror synchronously');
  await fire('!muster');
  assert.equal(sent.length, 0, 'muted commands must not reach chat');
});

runOrSkip('muted: !mute (bypassMute) still answers so mods get confirmation', async () => {
  await setChatMuted(true);
  await fire('!mute status', { mod: true });
  assert.equal(sent.length, 1, '!mute must bypass the mute gate');
});

runOrSkip('!mute off re-enables output and confirms', async () => {
  await setChatMuted(true);
  await fire('!mute off', { mod: true });
  assert.equal(isChatMuted(), false, '!mute off clears the flag');
  assert.equal(sent.length, 1, 'the unmute confirmation reaches chat');
  // …and ordinary commands talk again afterward.
  await fire('!muster');
  assert.equal(sent.length, 2, 'output resumes after unmute');
});

runOrSkip('a non-mod cannot toggle mute', async () => {
  await fire('!mute on'); // ordinary viewer
  assert.equal(isChatMuted(), false, 'non-mods must not flip the switch');
  assert.equal(sent.length, 0, 'and get no response');
});
