// !duel — challenge another viewer to a credit wager, settled by a fair coin flip.
//   !duel <@user> <amount>  — throw down the gauntlet
//   !duel accept            — take the challenge waiting on you (both sides staked)
//   !duel deny              — decline it
//   !duel                   — show the challenge waiting on you (if any)
// Open to everyone (credits, not the sub-only raid game). Winner takes the whole
// pot; credits are only moved between the two duelists — never minted.
import { challenge, accept, deny, getPendingFor, cleanLogin, DUEL_TTL_MS } from '../db/duel.js';
import { config } from '../config.js';

const n = (v) => (v || 0).toLocaleString('en-US');
const ttlMin = Math.round(DUEL_TTL_MS / 60_000);

export default {
  names: ['duel'],
  mod: false,
  cooldownMs: 3_000,
  help: '!duel <@user> <amount> — wager credits on a coin-flip duel · !duel accept | deny',
  async run({ user, args, reply }) {
    const sub = (args[0] || '').toLowerCase();

    // ── accept ──
    if (sub === 'accept' || sub === 'yes') {
      const res = await accept({ toId: user.id, toLogin: user.login, toName: user.displayName });
      if (!res.ok) {
        if (res.reason === 'none') reply(`@${user.displayName} you have no duel to accept right now.`);
        else if (res.reason === 'challenger-broke') reply(`@${user.displayName} ${res.fromName} can't cover that wager anymore — duel's off.`);
        else if (res.reason === 'insufficient') reply(`@${user.displayName} you don't have enough credits for that wager (balance: ${n(res.balance)}).`);
        else reply(`@${user.displayName} couldn't start the duel — try again.`);
        return;
      }
      reply(`⚔️ ${res.winnerName} beat ${res.loserName} in a duel and takes the ${n(res.pot)}-credit pot! 💰 (balance: ${n(res.winnerBalance)})`);
      return;
    }

    // ── deny ──
    if (sub === 'deny' || sub === 'decline' || sub === 'no') {
      const res = await deny({ toLogin: user.login });
      reply(res.ok
        ? `🏳️ @${user.displayName} declined ${res.fromName}'s duel. Another time.`
        : `@${user.displayName} you have no duel to decline.`);
      return;
    }

    // ── no args → show any challenge waiting on you ──
    if (!sub) {
      const pending = await getPendingFor(user.login);
      reply(pending
        ? `@${user.displayName} ${pending.fromName} has challenged you to a ${n(pending.amount)}-credit duel — !duel accept or !duel deny.`
        : `@${user.displayName} usage: !duel <@user> <amount> to challenge someone to a credit duel.`);
      return;
    }

    // ── otherwise: challenge — !duel <@user> <amount> ──
    const targetDisplay = String(args[0]).replace(/^@+/, '');
    const res = await challenge({
      fromId: user.id, fromLogin: user.login, fromName: user.displayName,
      toRaw: args[0], amount: args[1],
    });
    if (!res.ok) {
      switch (res.reason) {
        case 'need-target': reply(`@${user.displayName} who are you challenging? !duel <@user> <amount>`); break;
        case 'self': reply(`@${user.displayName} you can't duel yourself. 🪞`); break;
        case 'bad-amount': reply(`@${user.displayName} wager a whole number of credits (min ${n(res.min)}). !duel <@user> <amount>`); break;
        case 'insufficient': reply(`@${user.displayName} you don't have that many credits (balance: ${n(res.balance)}).`); break;
        case 'target-busy': reply(`@${user.displayName} ${cleanLogin(args[0])} already has a duel pending (from ${res.challenger}). Wait for it to settle.`); break;
        default: reply(`@${user.displayName} couldn't set up that duel.`);
      }
      return;
    }
    reply(`⚔️ @${targetDisplay}, ${user.displayName} challenges you to a ${n(res.amount)}-credit duel! Type "!duel accept" to throw down or "!duel deny" to bow out. (expires in ${ttlMin} min)`);
  },
};
