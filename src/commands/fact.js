// !fact — NIKKI FACTS. Public: `!fact` shows a random approved fact;
// `!fact suggest <text>` queues one for mod approval. Mod-only:
// `!fact pending`, `!fact approve <#>`, `!fact reject <#>`. Mixed public/mod, so
// it stays `mod:false` and gates the moderation subcommands on isMod inline.
import { suggestFact, listPendingFacts, approveFact, rejectFact, randomApprovedFact, cleanFactText } from '../db/facts.js';
import { config } from '../config.js';

// Per-user suggest throttle (single instance → in-memory is authoritative).
const SUGGEST_THROTTLE_MS = 20_000;
const lastSuggest = new Map();

export default {
  names: ['fact', 'facts'],
  mod: false,
  cooldownMs: 3_000,
  help: '!fact — a random Nikki fact · !fact suggest <text> — suggest one for approval',
  async run({ user, args, reply }) {
    const sub = (args[0] || '').toLowerCase();
    const isMod = user.isMod || user.isBroadcaster;

    // ── mod: review queue ──
    if (sub === 'pending' || sub === 'queue') {
      if (!isMod) return;
      const pending = await listPendingFacts(8);
      if (!pending.length) { reply('No pending fact suggestions.'); return; }
      const list = pending.map((f) => `#${f.id} "${f.text}" (${f.by})`).join('  ·  ');
      reply(`Pending — ${list}  →  !fact approve <#> / !fact reject <#>`);
      return;
    }
    if (sub === 'approve' || sub === 'reject') {
      if (!isMod) return;
      const id = parseInt(args[1], 10);
      if (!Number.isFinite(id)) { reply(`Usage: !fact ${sub} <#>  (see !fact pending)`); return; }
      if (sub === 'approve') {
        const res = await approveFact(id);
        reply(res.ok ? `✅ Fact #${id} approved — it's live at ${config.siteUrl}/info/` : `Couldn't approve #${id} (${res.reason}).`);
      } else {
        const res = await rejectFact(id);
        reply(res.ok ? `🗑️ Fact #${id} rejected.` : `Couldn't reject #${id} (${res.reason}).`);
      }
      return;
    }

    // ── public: suggest a fact ──
    if (sub === 'suggest' || sub === 'add') {
      const text = cleanFactText(args.slice(1).join(' '));
      if (!text) { reply(`@${user.displayName} usage: !fact suggest <your fact about Nikki>`); return; }
      const now = Date.now();
      if (now - (lastSuggest.get(user.id) || 0) < SUGGEST_THROTTLE_MS) {
        reply(`@${user.displayName} whoa, let the last one settle — try again in a moment.`);
        return;
      }
      const res = await suggestFact({ userId: user.id, login: user.login, displayName: user.displayName, text });
      if (!res.ok) {
        const why = res.reason === 'too-short' ? 'too short' : res.reason === 'too-long' ? 'too long (200 char max)' : res.reason;
        reply(`@${user.displayName} couldn't submit that (${why}).`);
        return;
      }
      lastSuggest.set(user.id, now);
      reply(`@${user.displayName} fact #${res.id} submitted for approval — thanks! It'll show at ${config.siteUrl}/info/ once a mod okays it.`);
      return;
    }

    // ── public: a random Nikki fact ──
    const fact = await randomApprovedFact();
    reply(
      fact
        ? `NIKKI FACT: ${fact.text}${fact.by ? ` (— ${fact.by})` : ''}  ·  suggest yours: !fact suggest <text>`
        : `No facts yet — be the first! !fact suggest <your fact>  (${config.siteUrl}/info/)`,
    );
  },
};
