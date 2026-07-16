// !offer — give an item and/or credits to another player, one-way (a gift). The
// target just `!offer accept` (or `!offer decline`); nothing is owed back. Shares
// the same engine as !trade (see trade.js); the only difference is that an offer
// may settle with an empty responder side, whereas a trade demands a swap.
import { runExchange } from './trade.js';

export default {
  names: ['offer', 'gift'],
  mod: false,
  cooldownMs: 3_000,
  help: '!offer @user <item|#> [+ credits] — GIVE an item/credits to someone (one-way); they reply !offer accept / decline',
  run: (ctx) => runExchange(ctx, 'offer'),
};
