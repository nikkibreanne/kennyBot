// Sender transport tests. The important guarantee: defaulting to the Helix send
// (for the Chat Bot badge) must never be able to silence the bot — if Twitch
// refuses the grant, the message still reaches chat over IRC.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSender, isAuthzFailure } from '../../src/twitch/sender.js';

const noopLogger = { info() {}, warn() {}, error() {}, debug() {} };

/** Fakes for the two transports, recording what each was asked to send. */
function harness({ helixError } = {}) {
  const irc = [];
  const helix = [];
  const chat = {
    say: async (_ch, text) => { irc.push(text); },
    action: async (_ch, text) => { irc.push(`/me ${text}`); },
  };
  const apiClient = {
    chat: {
      sendChatMessageAsApp: async (_bot, _bc, text) => {
        if (helixError) throw helixError;
        helix.push(text);
      },
    },
  };
  return { irc, helix, chat, apiClient };
}

const build = (h, mode) =>
  createSender({
    mode,
    chat: h.chat,
    apiClient: h.apiClient,
    channel: '#test',
    broadcasterId: 'b1',
    botUserId: 'u1',
    logger: noopLogger,
  });

test('auto (default) sends over helix while Twitch allows it', async () => {
  const h = harness();
  const s = build(h);
  await s.say('hello');
  assert.deepEqual(h.helix, ['hello']);
  assert.deepEqual(h.irc, []);
  assert.equal(s.effectiveMode(), 'helix');
});

test('auto falls back to IRC when helix is refused — the message still lands', async () => {
  const err = Object.assign(new Error('Forbidden'), { statusCode: 403 });
  const h = harness({ helixError: err });
  const s = build(h);
  await s.say('hello');
  assert.deepEqual(h.irc, ['hello'], 'the line must not be lost');
  assert.equal(s.effectiveMode(), 'irc', 'downgraded for the rest of the run');
});

test('after falling back, later sends go straight to IRC', async () => {
  const h = harness({ helixError: Object.assign(new Error('Unauthorized'), { statusCode: 401 }) });
  const s = build(h);
  await s.say('first');
  await s.say('second');
  assert.deepEqual(h.irc, ['first', 'second']);
});

test('a transient helix error does NOT downgrade the transport', async () => {
  const h = harness({ helixError: Object.assign(new Error('server error'), { statusCode: 500 }) });
  const s = build(h);
  await s.say('hello');
  assert.equal(s.effectiveMode(), 'helix', '5xx is a blip, not a grant problem');
  assert.deepEqual(h.irc, [], 'no double-send on a transient failure');
});

test('mode=helix never falls back (failures stay visible)', async () => {
  const h = harness({ helixError: Object.assign(new Error('Forbidden'), { statusCode: 403 }) });
  const s = build(h, 'helix');
  await s.say('hello');
  assert.equal(s.effectiveMode(), 'helix');
  assert.deepEqual(h.irc, [], 'forced helix must not silently reroute');
});

test('mode=irc pins the old path and keeps true /me actions', async () => {
  const h = harness();
  const s = build(h, 'irc');
  await s.say('hello');
  await s.action('waves');
  assert.deepEqual(h.helix, []);
  assert.deepEqual(h.irc, ['hello', '/me waves']);
});

test('helix actions degrade to plain messages (the API has no /me)', async () => {
  const h = harness();
  const s = build(h);
  await s.action('waves');
  assert.deepEqual(h.helix, ['waves'], 'content lands, styling is lost');
});

test('a send never throws, whatever the transport does', async () => {
  const h = harness({ helixError: Object.assign(new Error('403'), { statusCode: 403 }) });
  h.chat.say = async () => { throw new Error('irc down too'); };
  const s = build(h);
  await assert.doesNotReject(() => s.say('hello'));
});

test('isAuthzFailure distinguishes grant problems from blips', () => {
  assert.equal(isAuthzFailure({ statusCode: 401 }), true);
  assert.equal(isAuthzFailure({ statusCode: 403 }), true);
  assert.equal(isAuthzFailure(new Error('HTTP 403 Forbidden')), true);
  assert.equal(isAuthzFailure({ statusCode: 500 }), false);
  assert.equal(isAuthzFailure(new Error('socket hang up')), false);
});
