// !trade / !offer — hand items and/or credits between players. Both share one
// engine (src/db/trade.js); they differ only in the settlement rule:
//   !offer @user <item|#> [+ credits]  — a one-way GIFT. The target may just
//                                        `!offer accept` (nothing owed back).
//   !trade @user <item|#> [+ credits]  — a SWAP. The target must put an item or
//                                        credits up first (`!trade counter …`);
//                                        a bare accept with an empty side is rejected.
// Because you can't see another player's bag, each side only ever stakes from its
// OWN inventory. Items go by !bag number or (case-insensitive) name; credits are
// the number after a "+". One active exchange per person, so the sub-verbs
// (accept / counter / decline) need no target and work for whichever you started.
import { openTrade, counterTrade, acceptTrade, declineTrade, getTradeFor, cleanLogin, TRADE_TTL_MS } from '../db/trade.js';
import { getItem } from '../content/items.js';

const MINS = Math.round(TRADE_TTL_MS / 60000);

/** True if a stake puts nothing on the table. */
const stakeEmpty = (s) => !s || (!s.itemId && !(s.credits > 0));

/** Split a stake string into an item reference and a credit amount (after "+"). */
function parseStake(str) {
  const s = String(str || '').trim();
  if (!s) return { itemRef: '', credits: 0 };
  const plus = s.indexOf('+');
  if (plus === -1) return { itemRef: s, credits: 0 };
  const credits = parseInt(s.slice(plus + 1).trim(), 10);
  return { itemRef: s.slice(0, plus).trim(), credits: Number.isFinite(credits) ? credits : 0 };
}

/** "Squallpiercer Bow (rare · dps +49)" for a staked item. */
function describeItem(itemId, itemName) {
  const it = getItem(itemId);
  if (!it) return itemName || itemId;
  const bonus = it.bonuses?.[it.role];
  return `${it.name} (${it.rarity} · ${it.role}${bonus ? ` +${bonus}` : ''})`;
}

/** Human summary of one side's stake: item, credits, both, or "nothing". */
function describeStake(stake) {
  const parts = [];
  if (stake?.itemId) parts.push(describeItem(stake.itemId, stake.itemName));
  if (stake?.credits > 0) parts.push(`${stake.credits} credits`);
  return parts.length ? parts.join(' + ') : 'nothing';
}

/** Display name of whoever must act next. */
function turnName(t) {
  return t.turn === t.from.login ? t.from.name : t.to.name;
}

/** Map a db failure reason to friendly chat text. */
function reasonText(res) {
  switch (res.reason) {
    case 'need-target': return 'usage: !trade @user <item # or name> [+ credits].';
    case 'self': return "you can't trade with yourself.";
    case 'you-busy': return "you're already in an exchange — finish it (!trade) or !trade decline.";
    case 'target-busy': return 'they’re already in another exchange right now.';
    case 'no-character': return 'you need a character to stake an item — !create <class>.';
    case 'not-owned': return "that item isn't in your bag — check !bag and use its number.";
    case 'insufficient': return `you don't have that many credits (you have ${res.balance ?? 0}).`;
    case 'bad-amount': return 'credits must be a positive whole number.';
    case 'empty': return 'put something on the table — an item and/or credits.';
    case 'none': return 'you have nothing pending. Start one: !trade @user <item #> (swap) or !offer @user <item> (give).';
    case 'not-your-turn': return `it's @${res.waitingOn}'s turn to respond.`;
    case 'need-counter': return 'a trade needs something back — reply !trade counter <item # or credits>, or !trade decline.';
    case 'from-missing-item':
    case 'to-missing-item': return 'someone no longer has the staked item — cancelled.';
    case 'from-broke':
    case 'to-broke': return "someone can't cover the credits — cancelled.";
    case 'from-no-character':
    case 'to-no-character': return 'the item needs a character to land in — recipient has none.';
    default: return 'that didn’t work.';
  }
}

/**
 * Shared handler for !trade (openKind='trade') and !offer (openKind='offer').
 * The sub-verbs (accept/counter/decline/show) act on the caller's one active
 * exchange regardless of how it was opened; only OPEN uses openKind.
 */
export async function runExchange({ user, args, reply }, openKind) {
  const sub = (args[0] || '').toLowerCase();

  // ── accept ──
  if (['accept', 'yes', 'ok'].includes(sub)) {
    const res = await acceptTrade({ byId: user.id, byLogin: user.login, byName: user.displayName });
    if (!res.ok) { reply(`@${user.displayName} ${reasonText(res)}`); return; }
    const { from, to, fromStake, toStake } = res;
    if (stakeEmpty(toStake)) {
      reply(`🎁 @${to.name} received ${describeStake(fromStake)} from @${from.name}! (see !bag)`);
    } else {
      reply(`✅ Trade done! @${from.name}: ${describeStake(fromStake)}  ⇄  @${to.name}: ${describeStake(toStake)}. 🤝 (see !bag)`);
    }
    return;
  }

  // ── decline / cancel (either party) ──
  if (['decline', 'deny', 'no', 'cancel', 'reject'].includes(sub)) {
    const res = await declineTrade({ byLogin: user.login });
    if (!res.ok) { reply(`@${user.displayName} nothing to call off.`); return; }
    reply(`🚫 @${user.displayName} called off the ${res.trade.kind === 'offer' ? 'offer' : 'trade'} with @${res.otherName}.`);
    return;
  }

  // ── counter (put your own stuff up; flips the turn) ──
  if (sub === 'counter') {
    const { itemRef, credits } = parseStake(args.slice(1).join(' '));
    if (!itemRef && !(credits > 0)) { reply(`@${user.displayName} usage: !trade counter <item # or name> [+ credits]`); return; }
    const res = await counterTrade({ byId: user.id, byLogin: user.login, byName: user.displayName, itemRef: itemRef || null, credits });
    if (!res.ok) { reply(`@${user.displayName} ${reasonText(res)}`); return; }
    const t = res.trade;
    reply(`🔄 @${user.displayName} counters. Table: @${t.from.name} ${describeStake(t.fromStake)}  ⇄  @${t.to.name} ${describeStake(t.toStake)}. @${turnName(t)} — !trade accept / counter / decline.`);
    return;
  }

  // ── bare: show the pending exchange ──
  if (!sub) {
    const t = await getTradeFor(user.login);
    if (!t) { reply(`@${user.displayName} nothing pending. Start one: !trade @user <item # or credits> (swap) or !offer @user <item> (give).`); return; }
    const me = cleanLogin(user.login);
    const mine = t.from.login === me ? t.fromStake : t.toStake;
    const mustCounter = t.kind === 'trade' && stakeEmpty(mine);
    let move;
    if (t.turn !== me) move = `waiting on @${turnName(t)}`;
    else if (mustCounter) move = 'your move — !trade counter <item # or credits> / decline';
    else move = `your move — !${t.kind} accept / counter / decline`;
    reply(`${t.kind === 'offer' ? '🎁 Offer' : '🤝 Trade'}: @${t.from.name} ${describeStake(t.fromStake)}  ⇄  @${t.to.name} ${describeStake(t.toStake)}. ${move}.`);
    return;
  }

  // ── otherwise: open a new exchange (args[0] is the target) ──
  const { itemRef, credits } = parseStake(args.slice(1).join(' '));
  if (!itemRef && !(credits > 0)) { reply(`@${user.displayName} usage: !${openKind} @user <item # or name> [+ credits]  (see !bag)`); return; }
  const res = await openTrade({ fromId: user.id, fromLogin: user.login, fromName: user.displayName, toRaw: args[0], itemRef: itemRef || null, credits, kind: openKind });
  if (!res.ok) { reply(`@${user.displayName} ${reasonText(res)}`); return; }
  const t = res.trade;
  if (openKind === 'offer') {
    reply(`🎁 @${t.to.name} — @${t.from.name} offers you ${describeStake(t.fromStake)}, yours to keep! Reply: !offer accept · !offer decline. (expires ${MINS} min)`);
  } else {
    reply(`🤝 @${t.to.name} — @${t.from.name} wants to trade for ${describeStake(t.fromStake)}. Put something up to swap: !trade counter <your item # or credits> · !trade decline. (expires ${MINS} min)`);
  }
}

export default {
  names: ['trade'],
  mod: false,
  cooldownMs: 3_000,
  help: '!trade @user <item|#> [+ credits] — offer a SWAP; the other player must !trade counter <item|#> [+ credits] before !trade accept (or !trade decline)',
  run: (ctx) => runExchange(ctx, 'trade'),
};
