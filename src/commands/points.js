// !credits / !points — check your credit balance (creates a wallet + grubstake on
// first use). Credits are the OKRAMARKET wagering currency.
import { ensureWallet } from '../db/wallet.js';
import { config } from '../config.js';

export default {
  names: ['credits', 'points', 'bal', 'balance'],
  mod: false,
  cooldownMs: 3_000,
  help: '!credits — your credit balance',
  async run({ user, reply }) {
    const w = await ensureWallet({ userId: user.id, login: user.login, displayName: user.displayName });
    reply(
      `@${user.displayName} 💰 you have ${(w.balance || 0).toLocaleString('en-US')} credits. ` +
        `Wager at the OKRAMARKET (!bet <#> <yes|no> <amount>) · claim your free !daily · board: ${config.siteUrl}/okramarket/`,
    );
  },
};
