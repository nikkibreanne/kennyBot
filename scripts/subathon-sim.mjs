// SUBATHON SIMULATOR — fires fake Twitch money events through the REAL handler.
//
// You cannot gift yourself a sub, and testing a large bundle for real costs real
// money, so this drives src/events/subathonEvents.js directly with the same info
// objects twurple builds from IRC. Everything downstream — dedupe, band pricing, the
// ledger writes — is the production path; only the socket is faked.
//
//   npx firebase emulators:exec --only database --project okrafans \
//     "node scripts/subathon-sim.mjs"
//
// What it proves, in order: a plain sub pays, a resub pays, a LONE gift pays, a
// 20-sub bundle pays ONCE (not 21 times), bits pay, and a restart part-way
// through a bundle does not re-credit recipients already covered.
//
// The rate card here is INVENTED. The real one is private and lives outside the
// repository — see the header of src/rules/subathon.js.

import assert from 'node:assert/strict';
import { initFirebase, closeFirebase, database, PATHS } from '../src/db/firebase.js';
import { startConfigMirror, getSubathonState } from '../src/db/configStore.js';
import { attachSubathonEvents } from '../src/events/subathonEvents.js';
import { startSubathon, clearSubathon, subathonStatus } from '../src/db/subathon.js';
import { ledgerSeconds } from '../src/rules/subathon.js';

// A MADE-UP rate card — the real one is private and never enters this repo.
// Round numbers so every expectation below is checkable by eye.
const RATES = {
  values: { t1: 2, t2: 4, t3: 10, bit: 0.01, dollar: 1 },
  bands: { alpha: 100, beta: 50 },
  schedule: [{ fromHours: 0, band: 'alpha' }, { fromHours: 10, band: 'beta' }],
  se: 100,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const quiet = { debug() {}, info() {}, warn() {}, error: (m, x) => console.error('  [err]', m, x?.err || '') };

/** A fake ChatClient: records handlers so the sim can invoke them like Twitch would. */
function fakeChat() {
  const handlers = new Map();
  const make = (name) => (fn) => {
    if (!handlers.has(name)) handlers.set(name, []);
    handlers.get(name).push(fn);
    return { unbind() { handlers.set(name, handlers.get(name).filter((f) => f !== fn)); } };
  };
  return {
    onSub: make('onSub'), onResub: make('onResub'), onSubGift: make('onSubGift'),
    onCommunitySub: make('onCommunitySub'), onPrimePaidUpgrade: make('onPrimePaidUpgrade'),
    onGiftPaidUpgrade: make('onGiftPaidUpgrade'), onStandardPayForward: make('onStandardPayForward'),
    onMessage: make('onMessage'),
    async fire(name, ...args) {
      for (const fn of handlers.get(name) || []) await fn(...args);
    },
  };
}

async function ledgerNow() {
  const snap = await database().ref(PATHS.subathonLedger()).get();
  return Object.values(snap.val() || {});
}

async function step(label, fn, expectSeconds) {
  const before = ledgerSeconds(await ledgerNow());
  await fn();
  await sleep(120); // let the appends land
  const after = ledgerSeconds(await ledgerNow());
  const got = after - before;
  const ok = got === expectSeconds;
  console.log(`  ${ok ? '✓' : '✗'} ${label.padEnd(46)} ${String(got).padStart(6)}s  (expected ${expectSeconds}s)`);
  assert.equal(got, expectSeconds, label);
}

async function main() {
  if (!process.env.FIREBASE_DATABASE_EMULATOR_HOST) {
    console.error('Refusing to run against production. Use: firebase emulators:exec --only database …');
    process.exit(1);
  }
  initFirebase();
  await clearSubathon();
  await startConfigMirror(quiet);
  await sleep(200); // mirror warm

  // The feature is opt-in per event. With no record written, the wiring is
  // attached but must do nothing at all — this runs on every ordinary stream.
  console.log('\n  NO SUBATHON RUNNING — the wiring must be inert\n');
  const idleChat = fakeChat();
  const idleDetach = attachSubathonEvents({ chat: idleChat, logger: quiet });
  await step('a sub credits nothing', () =>
    idleChat.fire('onSub', '#c', 'v', { plan: '3000', displayName: 'V' }), 0);
  await step('a gift bundle credits nothing', async () => {
    await idleChat.fire('onCommunitySub', '#c', 'g', { count: 5, plan: '1000', gifter: 'g' });
    await idleChat.fire('onSubGift', '#c', 'r', { plan: '1000', gifter: 'g', giftDuration: 1 });
  }, 0);
  await step('bits credit nothing', () =>
    idleChat.fire('onMessage', '#c', 'c', 'x', { bits: 5000, userInfo: { displayName: 'C' } }), 0);
  idleDetach();

  await startSubathon({ baseHours: 4, rates: RATES });
  await sleep(200); // mirror picks up the new record

  const chat = fakeChat();
  let detach = attachSubathonEvents({ chat, logger: quiet });
  await sleep(150);

  console.log('\n  opening band — the whole run stays under the first threshold\n');

  await step('tier-1 sub', () =>
    chat.fire('onSub', '#c', 'viewer1', { plan: '1000', displayName: 'Viewer1', isPrime: false }), 200);

  await step('prime sub prices as tier 1', () =>
    chat.fire('onSub', '#c', 'viewer2', { plan: 'Prime', displayName: 'Viewer2', isPrime: true }), 200);

  await step('tier-3 resub', () =>
    chat.fire('onResub', '#c', 'viewer3', { plan: '3000', displayName: 'Viewer3', months: 12 }), 1000);

  await step('LONE gift sub (no bundle) still pays', () =>
    chat.fire('onSubGift', '#c', 'lucky', { plan: '1000', gifter: 'santa', gifterDisplayName: 'Santa', giftDuration: 1 }), 200);

  await step('6-month gift pays six times', () =>
    chat.fire('onSubGift', '#c', 'lucky2', { plan: '1000', gifter: 'santa2', gifterDisplayName: 'Santa2', giftDuration: 6 }), 1200);

  // The big one: the bundle is credited once, and the individual
  // USERNOTICEs that follow must add nothing.
  await step('20-sub bundle pays ONCE', async () => {
    await chat.fire('onCommunitySub', '#c', 'bomber', { count: 20, plan: '1000', gifter: 'bomber', gifterDisplayName: 'Bomber' });
    for (let i = 0; i < 20; i += 1) {
      await chat.fire('onSubGift', '#c', `r${i}`, { plan: '1000', gifter: 'bomber', gifterDisplayName: 'Bomber', giftDuration: 1 });
    }
  }, 4000);

  await step('a later lone gift from the same gifter pays', () =>
    chat.fire('onSubGift', '#c', 'later', { plan: '1000', gifter: 'bomber', gifterDisplayName: 'Bomber', giftDuration: 1 }), 200);

  await step('5000 bits', () =>
    chat.fire('onMessage', '#c', 'cheerer', 'PogChamp5000', { bits: 5000, userInfo: { displayName: 'Cheerer' } }), 5000);

  await step('a chat message with no bits credits nothing', () =>
    chat.fire('onMessage', '#c', 'talker', 'hello', { bits: 0, userInfo: { displayName: 'Talker' } }), 0);

  // Restart part-way through: 10 of 20 recipients delivered, then the bot dies.
  console.log('\n  RESTART MID-BUNDLE\n');
  await step('bundle of 20 credited, 10 parts delivered', async () => {
    await chat.fire('onCommunitySub', '#c', 'bomber2', { count: 20, plan: '1000', gifter: 'bomber2', gifterDisplayName: 'Bomber2' });
    for (let i = 0; i < 10; i += 1) {
      await chat.fire('onSubGift', '#c', `x${i}`, { plan: '1000', gifter: 'bomber2', gifterDisplayName: 'Bomber2', giftDuration: 1 });
    }
  }, 4000);

  detach();
  const chat2 = fakeChat();
  detach = attachSubathonEvents({ chat: chat2, logger: quiet });
  await sleep(250); // the pending map reloads from RTDB

  await step('remaining 10 parts still swallowed after restart', async () => {
    for (let i = 10; i < 20; i += 1) {
      await chat2.fire('onSubGift', '#c', `x${i}`, { plan: '1000', gifter: 'bomber2', gifterDisplayName: 'Bomber2', giftDuration: 1 });
    }
  }, 0);

  detach();
  const s = subathonStatus(getSubathonState(), Date.now());
  console.log(`
  ledger      ${s.entries} entries, ${s.grantedSeconds}s granted
  clock       ${Math.round(s.remainingMs / 1000)}s remaining
  correction  ${s.owedSeconds}s outstanding

  ✓ all checks passed
`);
}

main()
  .catch((err) => { console.error('\n  SIM FAILED:', err?.message || err); process.exitCode = 1; })
  .finally(async () => { try { await closeFirebase(); } catch { /* already closed */ } });
