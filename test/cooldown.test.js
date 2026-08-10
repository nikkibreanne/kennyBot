// Per-user COMMAND COOLDOWN behaviour, driven through the real chat dispatcher
// against the emulator.
//
// This is the one thing no other test covered, and it cost a live stream: a gift
// was made with `!offer`, the recipient glanced at it with a bare `!offer`, and
// their `!offer accept` a second later was dropped by the 3s cooldown — no chat
// reply, no log line, so it looked like the bot was broken. Every other test
// here deliberately sidesteps cooldowns (the e2e harness rebuilds the handler per
// message; mute.test.js uses a fresh user id per send), so the gap was invisible.
//
// ONE handler is used throughout, exactly like production, so the cooldown map
// actually accumulates.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { initFirebase, database, closeFirebase } from '../src/db/firebase.js';
import { startConfigMirror, setExpMode } from '../src/db/configStore.js';
import { createMessageHandler } from '../src/events/chat.js';
import { createPlayer, getPlayer, addLoot } from '../src/db/players.js';
import { seedCuratedFacts } from '../src/db/facts.js';

const host = process.env.FIREBASE_DATABASE_EMULATOR_HOST;
const runOrSkip = host ? test : test.skip;

const ITEM = 'itm_s1_thornnettle_dirk';
const giver = { id: 'u_cd_giver', login: 'nikkibreanne', name: 'NikkiBreAnne' };
const taker = { id: 'u_cd_taker', login: 'okrafan', name: 'OkraFan' };

const sent = [];
const drops = []; // what the dispatcher logged when it dropped a command
const logger = {
  info() {}, warn() {}, error() {},
  debug: (msg, meta) => { if (String(msg).includes('cooldown')) drops.push(meta); },
};
const sender = { say: (t) => { sent.push(t); return Promise.resolve(); }, action: () => Promise.resolve() };

let handler;

/** Send one chat line and return what the bot said ('' when it stayed silent). */
async function say(user, text) {
  sent.length = 0;
  await handler('#nikkibreanne', user.login, text, {
    userInfo: {
      userId: user.id, userName: user.login, displayName: user.name,
      isMod: false, isBroadcaster: false, isSubscriber: true,
    },
  });
  return sent.join(' ⏎ ');
}

before(async () => {
  if (!host) return;
  initFirebase();
  await startConfigMirror(logger);
  await setExpMode('off'); // keep level-up chatter out of the assertions
});
after(async () => { if (host) await closeFirebase(); });

beforeEach(async () => {
  if (!host) return;
  drops.length = 0;
  for (const p of ['players', 'usernames', 'trades', 'wallets', 'counters', 'facts']) {
    await database().ref(p).remove().catch(() => {});
  }
  // A FRESH handler per test — otherwise one test's cooldowns leak into the next.
  // Within a test it is reused, which is the whole point.
  handler = createMessageHandler({ sender, channel: '#nikkibreanne', botUserId: 'bot', logger, onActivity() {} });
  await createPlayer({ userId: giver.id, login: giver.login, displayName: giver.name, className: 'Berserker', isSubscriber: true });
  await addLoot(giver.id, ITEM);
  await createPlayer({ userId: taker.id, login: taker.login, displayName: taker.name, className: 'Guardian', isSubscriber: true });
});

runOrSkip('offer: looking at a gift does not swallow the accept that follows', async () => {
  assert.match(await say(giver, `!offer @${taker.login} ${ITEM}`), /offers you/);
  assert.match(await say(taker, '!offer'), /Offer:/, 'recipient checks what it is…');
  const accept = await say(taker, '!offer accept'); // …immediately after, no gap
  assert.match(accept, /received/, 'the accept must not be eaten by the bare !offer');
  assert.deepEqual((await getPlayer(taker.id)).inventory, [ITEM], 'and the gift actually lands');
});

runOrSkip('offer: a fumbled sub-verb does not swallow the retype', async () => {
  await say(giver, `!offer @${taker.login} ${ITEM}`);
  const typo = await say(taker, '!offer acept');
  assert.match(typo, /pending offer/i, 'a typo with an exchange open points at the response verbs');
  assert.doesNotMatch(typo, /usage: !offer @user/, 'not the open-a-new-one syntax');
  assert.match(await say(taker, '!offer accept'), /received/);
  assert.deepEqual((await getPlayer(taker.id)).inventory, [ITEM]);
});

runOrSkip('offer: the same sub-verb repeated IS still rate-limited, and says so in the log', async () => {
  await say(giver, `!offer @${taker.login} ${ITEM}`);
  assert.match(await say(taker, '!offer accept'), /received/);
  assert.equal(await say(taker, '!offer accept'), '', 'a second accept is dropped — that is what the cooldown is for');
  assert.deepEqual(
    drops.map((d) => `${d.command}:${d.sub}`), ['offer:accept'],
    'and a dropped command is never silent in the logs',
  );
});

runOrSkip('cooldown is per sub-verb only where a command opts in', async () => {
  await seedCuratedFacts();
  assert.match(await say(taker, '!fact'), /./, 'first !fact answers');
  assert.equal(await say(taker, '!fact 2'), '', '!fact does not opt in — the whole command shares one window');
  assert.deepEqual(drops.map((d) => d.command), ['fact']);
});

runOrSkip('cooldowns are per user, not global', async () => {
  await say(giver, `!offer @${taker.login} ${ITEM}`);
  // The giver just used !offer; the taker's own !offer must be unaffected.
  assert.match(await say(taker, '!offer'), /Offer:/);
  assert.deepEqual(drops, [], 'nothing was dropped');
});
