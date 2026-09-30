// !respec <class> — change class, and with it your battlefield role.
//
// Class was permanent, which made the role-readiness thresholds a diagnosis with
// no treatment: a season short on healers had no way to fix itself, because the
// people already invested couldn't move and newcomers start at level 1. Costs
// credits so it stays a real decision rather than a per-raid optimisation.
//
// Level, EXP and renown survive. Gear does not: the old role's items can't be
// worn any more, so everything equipped goes back to the bag (to trade or
// !salvage) and a fresh starter set for the new role is rolled.
import { getPlayer, respecPlayer } from '../db/players.js';
import { CLASSES } from '../content/classes.js';
import { getBalance, debit, credit } from '../db/wallet.js';
import { config } from '../config.js';

/** Case-insensitive class lookup → the catalog's canonical spelling. */
export function resolveClass(input) {
  const needle = String(input || '').trim().toLowerCase();
  return Object.keys(CLASSES).find((name) => name.toLowerCase() === needle) || null;
}

const classList = () => Object.entries(CLASSES).map(([n, c]) => `${n} (${c.role})`).join(' · ');

export default {
  names: ['respec', 'reclass'],
  mod: false,
  subOnly: true,
  cooldownMs: 10_000,
  help: `!respec <class> — change class/role for ${config.respec.cost} credits (keeps level & renown; gear resets)`,
  async run({ user, args, reply }) {
    const player = await getPlayer(user.id);
    if (!player) {
      reply(`@${user.displayName} no character yet — !create <class>.`);
      return;
    }
    const wanted = resolveClass(args.join(' '));
    if (!wanted) {
      reply(`@${user.displayName} usage: !respec <class> — ${classList()}. Costs ${config.respec.cost} credits.`);
      return;
    }
    if (wanted === player.class) {
      reply(`@${user.displayName} you're already a ${wanted}. 🌱`);
      return;
    }

    const cost = config.respec.cost;
    const paid = await debit(user.id, cost);
    if (!paid.ok) {
      const bal = paid.balance ?? (await getBalance(user.id)) ?? 0;
      reply(`@${user.displayName} respec costs ${cost} credits — you have ${bal}. Earn more with !daily, !salvage, or the OKRAMARKET.`);
      return;
    }

    const res = await respecPlayer(user.id, wanted);
    if (!res.ok) {
      // Never keep the money if the change didn't happen.
      await credit(user.id, cost, { login: user.login, displayName: user.displayName });
      const why = res.reason === 'same-class' ? `you're already a ${wanted}` : res.reason;
      reply(`@${user.displayName} respec failed (${why}) — your ${cost} credits were refunded.`);
      return;
    }

    const moved = res.returned ? ` Your old gear went back to your bag — !salvage or !give what you can't use.` : '';
    reply(
      `@${user.displayName} 🔁 respecced ${res.from.class} → ${res.to.class} (${res.from.role} → ${res.to.role}) for ${cost} credits. ` +
      `Level ${player.level} and renown kept; fresh starter gear equipped.${moved}`,
    );
  },
};
