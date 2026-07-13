// !todo (mod) — manage Nikki's public, date-organized to-do list shown on the
// /todo/ page. Mods/broadcaster only: the whole command is `mod:true`, so the
// dispatcher hides it from everyone else. Control is chat-only; the page is
// read-only (viewers just watch the list get worked through).
//   !todo                         — list the current items
//   !todo add [YYYY-MM-DD] <text> — add an item (date optional; defaults to today)
//   !todo remove <#>              — remove/cross off an item by its number
import { addTodo, removeTodo, listTodos, resolveDateToken, cleanTodoText } from '../../db/todo.js';
import { config } from '../../config.js';

const PAGE = () => `${config.siteUrl}/todo/`;

/** "Mon Jul 14" from a YYYY-MM-DD, parsed as a plain calendar date (no TZ shift). */
function dayLabel(date) {
  const [y, m, d] = String(date).split('-').map(Number);
  if (!y || !m || !d) return date;
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

export default {
  names: ['todo', 'todos'],
  mod: true,
  cooldownMs: 2_000,
  help: '!todo add [date] <text> | !todo remove <#> | !todo — mod-only date-organized to-do list (okrafans.com/todo/)',
  async run({ user, args, reply }) {
    const sub = (args[0] || 'list').toLowerCase();

    // ── add ──
    if (sub === 'add' || sub === 'new') {
      let rest = args.slice(1);
      const date = resolveDateToken(rest[0]); // null unless the first token is a date
      if (date) rest = rest.slice(1);
      const text = cleanTodoText(rest.join(' '));
      if (!text) { reply(`@${user.displayName} usage: !todo add [YYYY-MM-DD] <thing to do>`); return; }
      const res = await addTodo({ text, date: date || undefined, by: user.displayName });
      if (!res.ok) {
        reply(`@${user.displayName} couldn't add that (${res.reason === 'too-long' ? '200 char max' : res.reason}).`);
        return;
      }
      reply(`📝 To-do #${res.id} added for ${dayLabel(res.todo.date)}: “${res.todo.text}” → ${PAGE()}`);
      return;
    }

    // ── remove / cross off ──
    if (['remove', 'rm', 'del', 'delete', 'done'].includes(sub)) {
      const id = parseInt(args[1], 10);
      if (!Number.isFinite(id)) { reply(`@${user.displayName} usage: !todo remove <#>  (see !todo)`); return; }
      const res = await removeTodo(id);
      reply(res.ok ? `✅ To-do #${id} crossed off: “${res.text}”` : `Couldn't remove #${id} (${res.reason}).`);
      return;
    }

    // ── list (default) ──
    const todos = await listTodos(8);
    if (!todos.length) { reply(`Nothing on the to-do board. Add one: !todo add <thing> · ${PAGE()}`); return; }
    const line = todos.map((t) => `#${t.id} [${dayLabel(t.date)}] ${t.text}`).join('  ·  ');
    reply(`📝 To-do: ${line}  →  full list: ${PAGE()}`);
  },
};
