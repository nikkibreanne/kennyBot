// !daily — claim the daily credit allowance (bootstraps a wallet + starter
// grubstake for first-timers). Wagering currency for the OKRAMARKET.
import { claimDaily } from '../db/wallet.js';

function human(ms) {
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export default {
  names: ['daily'],
  mod: false,
  cooldownMs: 5_000,
  help: '!daily — claim your daily credits',
  async run({ user, reply }) {
    const res = await claimDaily({ userId: user.id, login: user.login, displayName: user.displayName });
    if (res.ok) {
      reply(
        `@${user.displayName} 💰 +${res.amount.toLocaleString('en-US')} credits!` +
          `${res.firstTime ? ' (plus a starter grubstake — welcome!)' : ''} ` +
          `Balance: ${res.balance.toLocaleString('en-US')}. Wager it: !bet <option> <amount>`,
      );
    } else if (res.reason === 'cooldown') {
      reply(`@${user.displayName} already claimed today — next !daily in ${human(res.retryMs)}. Balance: ${(res.balance || 0).toLocaleString('en-US')}.`);
    } else {
      reply(`@${user.displayName} couldn't claim right now — try again in a moment.`);
    }
  },
};
