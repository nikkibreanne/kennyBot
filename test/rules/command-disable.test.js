// Per-channel command switch (`!kcommand`). Runs offline: the dispatcher returns
// before any database work for a disabled command, and a command that IS allowed
// (`!song` with Spotify unconfigured) answers without touching one either.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMessageHandler } from '../../src/events/chat.js';
import { primeConfigForTest, isCommandDisabled } from '../../src/db/configStore.js';
import { getCommand, listCommands } from '../../src/commands/registry.js';

const logger = { info() {}, warn() {}, error() {}, debug() {} };
const sent = [];
const sender = { say: async (t) => { sent.push(t); }, action: async (t) => { sent.push(t); } };
const handler = createMessageHandler({ sender, channel: '#test', botUserId: 'bot', logger, onActivity() {} });

let seq = 0;
const say = (text, { mod = false } = {}) => {
  seq += 1;
  return handler('#test', `u${seq}`, text, {
    userInfo: { userId: `u${seq}`, userName: `u${seq}`, displayName: `U${seq}`, isMod: mod, isBroadcaster: false, isSubscriber: true },
  });
};

afterEach(() => { sent.length = 0; primeConfigForTest({ disabledCommands: {} }); });

test('a command is on by default', async () => {
  await say('!song');
  assert.equal(sent.length, 1);
});

test('a disabled command is ignored silently, under every alias', async () => {
  primeConfigForTest({ disabledCommands: { song: true } });
  assert.equal(isCommandDisabled('song'), true);
  await say('!song');
  await say('!np');
  await say('!nowplaying');
  assert.deepEqual(sent, [], 'no reply at all — another bot owns this command');
});

test('disabling one command leaves the others alone', async () => {
  primeConfigForTest({ disabledCommands: { song: true } });
  await say('!kennycommands');
  assert.equal(sent.length, 1);
});

test('the controls themselves can never be switched off', async () => {
  primeConfigForTest({ disabledCommands: { command: true, mute: true } });
  await say('!kcommand list', { mod: true });
  assert.equal(sent.length, 1, '!kcommand keeps answering even if its own flag is set');
  const alwaysOn = listCommands().filter((d) => d.alwaysOn).map((d) => d.names[0]);
  assert.ok(alwaysOn.includes('kcommand') && alwaysOn.includes('mute'));
  assert.equal(getCommand('kcmd'), getCommand('kcommand'));
});
