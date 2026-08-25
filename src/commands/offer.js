// !offer — give an item and/or credits to another player, one-way (a gift). The
// target just `!offer accept` (or `!offer decline`); nothing is owed back. Shares
// the same engine as !trade (see trade.js); the only difference is that an offer
// may settle with an empty responder side, whereas a trade demands a swap.
import { runExchange } from './trade.js';

export default {
  names: ['offer', 'gift', 'give'],
  mod: false,
  cooldownMs: 3_000,
  // The recipient answers the bot's own prompt with `!offer accept`, often right
  // after looking at it with a bare `!offer` (or mistyping it once). Keying the
  // cooldown per sub-verb keeps those from cancelling each other out.
  cooldownPerSubcommand: true,
  help: '!offer @user <item|#> [+ credits] (aka !give / !gift) — GIVE an item/credits to someone (one-way); they reply !offer accept / decline',
  run: (ctx) => runExchange(ctx, 'offer'),
};
