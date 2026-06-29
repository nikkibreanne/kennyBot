// !equip <item> — equip an item from your bag into its slot (spec §11).
// Accepts an item id or a (case-insensitive) item name, but only from the
// player's OWN inventory — untrusted input is validated, never trusted
// (IMPLEMENTATION §G).
import { getPlayer, equipItem } from '../db/players.js';
import { getItem } from '../content/items.js';

function resolveOwnedItem(player, input) {
  const inventory = Array.isArray(player.inventory) ? player.inventory : [];
  const needle = input.trim().toLowerCase();
  // exact id match first
  if (inventory.includes(input)) return input;
  // then by item name
  return inventory.find((id) => (getItem(id)?.name || '').toLowerCase() === needle) ?? null;
}

export default {
  names: ['equip'],
  mod: false,
  cooldownMs: 3_000,
  help: '!equip <item> — equip an item from your bag',
  async run({ user, args, reply }) {
    const input = args.join(' ').trim();
    if (!input) {
      reply(`@${user.displayName} usage: !equip <item name> — see !bag.`);
      return;
    }
    const player = await getPlayer(user.id);
    if (!player) {
      reply(`@${user.displayName} no character yet — !create <class>.`);
      return;
    }
    const itemId = resolveOwnedItem(player, input);
    if (!itemId) {
      reply(`@${user.displayName} that item isn't in your bag. Check !bag.`);
      return;
    }

    const res = await equipItem(user.id, itemId);
    if (!res.ok) {
      const why = res.reason === 'not-owned' ? "you don't own that" : res.reason;
      reply(`@${user.displayName} couldn't equip: ${why}.`);
      return;
    }
    reply(`@${user.displayName} equipped ${res.item.name} (${res.item.slot}).`);
  },
};
