// !bet <market#> <yes|no> <amount> — wager credits on an OKRAMARKET. The market
// number targets one of the concurrently-open markets (see !market). You back
// ONE side per market; betting again on the same side adds to your stake. If
// exactly one market is open you can omit the number: !bet yes <amount>.
// Payouts are parimutuel (see market.js).
import { placeBet, listOpenMarkets } from '../db/market.js';

const OUTCOMES = new Set(['yes', 'no', 'y', 'n']);

export default {
  names: ['bet', 'wager'],
  mod: false,
  cooldownMs: 2_000,
  help: '!bet <market#> <yes|no> <amount> — wager credits on an OKRAMARKET',
  async run({ user, args, reply }) {
    let marketId;
    let optionKey;
    let amount;

    if (OUTCOMES.has((args[0] || '').toLowerCase())) {
      // No-number form — only works when exactly one market is open.
      [optionKey, amount] = args;
      const open = (await listOpenMarkets()).filter((m) => m.status === 'open');
      if (open.length === 0) { reply(`@${user.displayName} no market is open right now.`); return; }
      if (open.length > 1) {
        const list = open.map((m) => `#${m.id} ${m.question}`).join(' · ');
        reply(`@${user.displayName} which one? use !bet <#> ${optionKey.toLowerCase()} <amount> — open: ${list}`);
        return;
      }
      marketId = open[0].id;
    } else {
      [marketId, optionKey, amount] = args;
    }

    if (marketId == null || marketId === '' || !optionKey || amount == null) {
      reply(`@${user.displayName} usage: !bet <market#> <yes|no> <amount> — see open markets with !market (or the site).`);
      return;
    }

    const res = await placeBet({ userId: user.id, login: user.login, displayName: user.displayName, marketId, optionKey, amount });
    if (res.ok) {
      reply(
        `@${user.displayName} ✅ bet on #${res.marketId} "${res.optionLabel}"! Your stake there: ${res.staked.toLocaleString('en-US')} · ` +
          `balance: ${res.balance.toLocaleString('en-US')} credits`,
      );
      return;
    }

    const msg = {
      'no-market': `no market #${marketId} is open — see !market.`,
      closed: 'betting is closed on that market.',
      'bad-amount': 'enter a whole amount of at least 1.',
      insufficient: `not enough credits (you have ${(res.balance || 0).toLocaleString('en-US')}). Claim !daily.`,
      'no-wallet': 'get some credits first — !daily.',
      'bad-option': 'pick a side: yes or no.',
      'already-other-side': `you're already backing "${res.optionLabel}" on that market — no hedging in this universe!`,
    }[res.reason] || 'that bet did not go through.';
    reply(`@${user.displayName} ${msg}`);
  },
};
