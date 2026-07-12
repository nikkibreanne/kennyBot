// !market — the OKRAMARKET: concurrent binary YES/NO prediction markets staked in
// credits (Polymarket-style). Mixed public/mod (like !fact): stays `mod:false`
// and gates the management subcommands on isMod inline. Markets are targeted by
// their number (see !market).
//   Public:  !market                       — list the open markets
//            !market suggest <question>     — propose a YES/NO market for approval
//   Mod:     !market open <question>        — open a YES/NO market for wagering
//            !market close <#>              — stop accepting bets on #
//            !market resolve <#> <yes|no>   — pay out # (parimutuel)
//            !market cancel <#>             — void # + refund every bet
//            !market queue                  — review viewer suggestions
//            !market approve <#> / reject <#>
import {
  openMarket, closeMarket, resolveMarket, cancelMarket, listOpenMarkets,
  suggestMarket, listPendingMarketSuggestions, approveMarketSuggestion, rejectMarketSuggestion,
} from '../../db/market.js';
import { config } from '../../config.js';

// Per-user suggest throttle (single instance → in-memory is authoritative).
const SUGGEST_THROTTLE_MS = 30_000;
const lastSuggest = new Map();

const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Format a market's outcomes as "1) Yes  2) No" for chat. */
function optionLine(market) {
  return market.optionOrder.map((k, i) => `${i + 1}) ${market.options[k].label}`).join('  ');
}

export default {
  names: ['market'],
  mod: false, // mixed: public list/suggest, mod management (gated inline)
  cooldownMs: 2_000,
  help: '!market — list open markets · !market suggest <question> — propose a YES/NO market',
  async run({ user, args, reply }) {
    const sub = (args[0] || 'status').toLowerCase();
    const rest = args.slice(1).join(' ').trim();
    const isMod = user.isMod || user.isBroadcaster;

    // ── public: propose a market ──
    if (sub === 'suggest' || sub === 'propose') {
      if (!rest) {
        reply(`@${user.displayName} usage: !market suggest <yes/no question>  (e.g. !market suggest Will we clear the boss tonight?)`);
        return;
      }
      const now = Date.now();
      if (now - (lastSuggest.get(user.id) || 0) < SUGGEST_THROTTLE_MS) {
        reply(`@${user.displayName} easy — let that one queue up. Try again in a moment.`);
        return;
      }
      const res = await suggestMarket({ userId: user.id, login: user.login, displayName: user.displayName, question: rest });
      if (!res.ok) {
        const why = {
          'too-short': 'question too short',
          'too-long': 'question too long (140 char max)',
        }[res.reason] || res.reason;
        reply(`@${user.displayName} couldn't submit that (${why}).`);
        return;
      }
      lastSuggest.set(user.id, now);
      reply(`@${user.displayName} 🗳️ market suggestion #${res.id} submitted — a mod will review it. Thanks!`);
      return;
    }

    // ── mod: review the suggestion queue ──
    if (sub === 'queue' || sub === 'pending' || sub === 'suggestions') {
      if (!isMod) return;
      const pending = await listPendingMarketSuggestions(6);
      if (!pending.length) { reply('No pending market suggestions.'); return; }
      const list = pending.map((s) => `#${s.id} "${s.question}" —${s.by}`).join('  ·  ');
      reply(`Suggested markets (Yes/No) — ${list}  →  !market approve <#> / !market reject <#>`);
      return;
    }
    if (sub === 'approve' || sub === 'reject') {
      if (!isMod) return;
      const id = parseInt(args[1], 10);
      if (!Number.isFinite(id)) { reply(`Usage: !market ${sub} <#>  (see !market queue)`); return; }
      if (sub === 'approve') {
        const res = await approveMarketSuggestion(id);
        if (!res.ok) {
          const why = {
            'not-found': `no suggestion #${id}.`,
            'already-approved': `#${id} was already approved.`,
            'too-many-open': `max ${res.max} markets already open — resolve or cancel one, then approve #${id}.`,
            'need-question': 'that suggestion is empty.',
          }[res.reason] || res.reason;
          reply(`Can't approve #${id}: ${why}`);
          return;
        }
        reply(`✅ Suggestion #${id} is live → 📈 OKRAMARKET #${res.market.id} "${res.market.question}"  ${optionLine(res.market)}  ·  bet: !bet ${res.market.id} <yes|no> <amount> · board: ${config.siteUrl}/#okramarket`);
      } else {
        const res = await rejectMarketSuggestion(id);
        reply(res.ok ? `🗑️ Suggestion #${id} rejected.` : `Couldn't reject #${id} (${res.reason}).`);
      }
      return;
    }

    // ── mod: open a market directly ──
    if (sub === 'open') {
      if (!isMod) return;
      if (!rest) { reply('Usage: !market open <yes/no question>'); return; }
      const res = await openMarket({ question: rest });
      if (!res.ok) {
        const why = {
          'too-many-open': `max ${res.max} markets already open — resolve or cancel one first.`,
          'need-question': 'give the market a question.',
        }[res.reason] || res.reason;
        reply(`Can't open: ${why}`);
        return;
      }
      reply(`📈 OKRAMARKET #${res.market.id} OPEN — "${res.market.question}"  ${optionLine(res.market)}  ·  bet: !bet ${res.market.id} <yes|no> <amount> · board: ${config.siteUrl}/#okramarket`);
      return;
    }

    if (sub === 'close') {
      if (!isMod) return;
      const id = parseInt(args[1], 10);
      if (!Number.isFinite(id)) { reply('Usage: !market close <#>  (see !market)'); return; }
      const res = await closeMarket(id);
      reply(res.ok ? `🔒 Betting closed on #${id} "${res.question}". Result when ready — !market resolve ${id} <yes|no>.` : `Nothing to close on #${id} (${res.reason}).`);
      return;
    }

    if (sub === 'resolve') {
      if (!isMod) return;
      const id = parseInt(args[1], 10);
      if (!Number.isFinite(id) || !args[2]) { reply('Usage: !market resolve <#> <yes|no>'); return; }
      const res = await resolveMarket(id, args[2]);
      if (!res.ok) {
        const why = {
          'no-market': `no market #${id}.`,
          'already-resolved': `#${id} is already resolved.`,
          'bad-option': 'unknown outcome — use: yes or no.',
        }[res.reason] || res.reason;
        reply(`Can't resolve #${id}: ${why}`);
        return;
      }
      if (res.refunded) {
        reply(`#${id} "${res.winLabel}" wins — but nobody backed it, so all bets were refunded.`);
        return;
      }
      const top = res.top ? ` Top: ${res.top.displayName} (+${res.top.payout.toLocaleString('en-US')})!` : '';
      reply(`🏆 OKRAMARKET #${id} resolved: "${res.winLabel}" wins! ${res.winners.length} winner(s) split ${res.totalPool.toLocaleString('en-US')} credits.${top}`);
      return;
    }

    if (sub === 'cancel') {
      if (!isMod) return;
      const id = parseInt(args[1], 10);
      if (!Number.isFinite(id)) { reply('Usage: !market cancel <#>'); return; }
      const res = await cancelMarket(id);
      reply(res.ok ? `❌ Market #${id} cancelled — ${res.count} bet(s) refunded (${res.refunded.toLocaleString('en-US')} credits returned).` : `Nothing to cancel on #${id} (${res.reason}).`);
      return;
    }

    // ── public: list the open markets ──
    const open = await listOpenMarkets();
    if (!open.length) {
      reply(`No OKRAMARKETs open right now. Got a call to make? !market suggest <yes/no question>`);
      return;
    }
    const shown = open.slice(0, 5);
    const lines = shown.map((m) => `#${m.id} "${clip(m.question, 40)}" [${m.status}] Y:${(m.pools?.yes || 0).toLocaleString('en-US')}/N:${(m.pools?.no || 0).toLocaleString('en-US')}`).join('  ·  ');
    const more = open.length > shown.length ? ` · +${open.length - shown.length} more` : '';
    reply(`📈 OKRAMARKETs (${open.length}) — ${lines}${more} · bet: !bet <#> <yes|no> <amount> · board: ${config.siteUrl}/#okramarket`);
  },
};
