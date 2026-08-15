// SUBATHON chat wiring — Twitch money events → ledger credits.
//
// Everything here comes off the CHAT connection, not EventSub, because there is
// no broadcaster-owned token for the target channel (index.js logs `eventsub
// disabled — broadcaster token is not the channel owner`). USERNOTICEs and the
// `bits` tag are delivered to every joined client and need no scopes, so this
// works with what we have.
//
// The cost of that choice is dedupe. A gift bundle arrives as ONE
// `onCommunitySub` carrying the count, followed by a separate `onSubGift` per
// recipient; crediting both pays double. EventSub's `is_gift` flag would settle
// it in one field, and we don't have it — so we count the bundle and swallow
// exactly that many individual gifts from the same gifter, which still lets a
// LONE gift pay.
//
// The pending-bundle map is persisted to RTDB and re-read on the first event of
// each run. A bug found mid-stream means a restart, and a restart part-way
// through a large bundle would otherwise come back up empty and credit the
// remaining recipients a second time.
//
// WITH NO SUBATHON RUNNING THIS MODULE DOES NOTHING. Every handler returns on a
// mirror read; there is no subscription, no timer and no traffic. It is attached
// on every stream and only wakes up once `scripts/subathon.mjs start` has
// written a record.
//
// Every handler is failure-isolated: a subathon that can't write must never take
// chat down with it. A missed credit is recoverable from the CLI; a dead bot is
// not recoverable at 4am.

import { getSubathonState } from '../db/configStore.js';
import { creditSubathon } from '../db/subathon.js';
import { database, PATHS } from '../db/firebase.js';
import { planToProduct, noteGiftBomb, consumeGiftSub } from '../rules/subathon.js';

/**
 * @param {{ chat: import('@twurple/chat').ChatClient, logger: any }} deps
 * @returns {() => void} cleanup
 */
export function attachSubathonEvents({ chat, logger }) {
  const listeners = [];

  // Working copy of the pending-bundle map. Seeded from the config mirror the
  // first time an event lands on a given run, then written through: within a
  // burst of gift USERNOTICEs the mirror has not caught up yet, so the local
  // copy is what the next event in the burst must see.
  //
  // Seeding lazily (rather than holding an RTDB listener) is what keeps this
  // module inert between events: with no subathon running it does nothing at
  // all, no subscription and no traffic.
  let pending = {};
  let syncedFor = null;

  const active = () => {
    const state = getSubathonState();
    if (!state?.active) return null;
    if (syncedFor !== state.startedAt) {
      // New run, or the first event after a restart — adopt whatever was
      // persisted. `start` writes the whole node, so a fresh run has none.
      pending = state.pendingGifts || {};
      syncedFor = state.startedAt;
      logger.info?.('subathon ledger active', { startedAt: state.startedAt });
    }
    return state;
  };

  const savePending = async (next) => {
    pending = next; // local first — the next event in a burst must see it
    try {
      await database().ref(`${PATHS.subathon()}/pendingGifts`).set(next);
    } catch (err) {
      // Losing the persisted copy only costs us dedupe across a restart, which
      // the operator can correct. Never let it stop the credit.
      logger.warn?.('subathon pending-gift persist failed', { err: String(err) });
    }
  };

  /** One place for "price it, write it, log it" so every path logs identically. */
  async function credit(contribution, meta) {
    const state = active();
    if (!state) return;
    try {
      const entry = await creditSubathon(state, contribution, meta);
      // Deliberately no monetary figure here. Logs get pasted around, and the
      // rate card plus a worth value is enough to reconstruct channel revenue.
      // Seconds and band are what an operator needs to debug a credit anyway.
      logger.info('subathon credit', {
        kind: entry.kind, who: entry.who, seconds: entry.seconds, band: entry.band, id: entry.id,
      });
    } catch (err) {
      // Loud, because this is money and the operator needs to know to re-enter it.
      logger.error('subathon credit FAILED — re-enter from the CLI', {
        kind: meta?.kind, who: meta?.who, err: String(err),
      });
    }
  }

  const attach = (name, handler) => {
    if (typeof chat[name] === 'function') listeners.push(chat[name](handler));
    else logger.warn?.('chat event not available in this twurple version', { event: name });
  };

  // Direct subs and resubs. A gifted sub does NOT arrive here — it comes through
  // onSubGift with the gifter attributed — so there's no overlap to dedupe.
  const onSubLike = (kind) => async (_ch, user, info) => {
    if (info?.isPrime === false && info?.plan == null) return;
    await credit(
      { product: planToProduct(info?.plan) },
      { kind, who: info?.displayName || user, note: info?.isPrime ? 'prime' : null },
    );
  };
  attach('onSub', onSubLike('sub'));
  attach('onResub', onSubLike('resub'));

  // The bundle: credit the WHOLE thing here, then swallow its parts below.
  attach('onCommunitySub', async (_ch, user, info) => {
    if (!active()) return; // also seeds `pending` on the first event of a run
    const count = Math.max(1, Number(info?.count) || 1);
    const gifter = info?.gifterDisplayName || info?.gifter || user || null;
    await savePending(noteGiftBomb(pending, info?.gifter || user, count, Date.now()));
    await credit(
      { product: planToProduct(info?.plan), count },
      { kind: 'giftbomb', who: gifter, note: `${count} × ${info?.plan || '1000'}` },
    );
  });

  // An individual gift. Credited only when it is NOT part of a bundle we already
  // paid for — which is the case for a one-off gift to a single person.
  attach('onSubGift', async (_ch, _recipient, info) => {
    if (!active()) return; // MUST come first: it seeds `pending` from the mirror
    const { credit: shouldCredit, pending: next } = consumeGiftSub(pending, info?.gifter, Date.now());
    await savePending(next);
    if (!shouldCredit) return; // part of a bundle already credited in full
    const months = Math.max(1, Number(info?.giftDuration) || 1);
    await credit(
      { product: planToProduct(info?.plan), months },
      {
        kind: 'subgift',
        who: info?.gifterDisplayName || info?.gifter || 'anonymous',
        note: months > 1 ? `${months}-month gift` : null,
      },
    );
  });

  // Upgrades are new money that produces no sub event of its own.
  attach('onPrimePaidUpgrade', async (_ch, user, info) => {
    await credit({ product: planToProduct(info?.plan) }, { kind: 'upgrade', who: info?.displayName || user });
  });
  attach('onGiftPaidUpgrade', async (_ch, user, info) => {
    await credit({ product: 't1' }, { kind: 'upgrade', who: info?.displayName || user });
  });
  attach('onStandardPayForward', async (_ch, user, info) => {
    await credit({ product: 't1' }, { kind: 'payforward', who: info?.displayName || user });
  });

  // Bits ride on an ordinary chat message rather than a dedicated event. This is
  // a second onMessage listener alongside the game handler, which twurple allows.
  attach('onMessage', async (_ch, user, _text, msg) => {
    const bits = Number(msg?.bits) || 0;
    if (bits <= 0) return;
    await credit({ product: 'bits', bits }, { kind: 'bits', who: msg?.userInfo?.displayName || user });
  });

  return () => {
    for (const l of listeners) l?.unbind?.();
  };
}
