// !salvage <#|name> | !salvage offrole — melt gear you can't use into credits.
//
// Role-locked loot has a floor problem: a trade needs someone who actively WANTS
// the piece, and prod bags were holding 52 items their owner could never equip
// with no buyer in sight. Salvage gives every item a guaranteed price so a dead
// drop is never worthless — deliberately BELOW what it's worth to the right
// hero, so handing it to a raider who can use it always beats melting it.
import { getPlayer, removeFromBag } from '../db/players.js';
import { getItem, resolveOwnedItem } from '../content/items.js';
import { credit } from '../db/wallet.js';
import { config } from '../config.js';

const RARITY_ORDER = ['common', 'uncommon', 'rare', 'epic', 'legendary'];

/** Credits an item melts for, or 0 if it isn't a known item. */
export function salvageValue(itemId, getIt = getItem) {
  const it = getIt(itemId);
  return it ? (config.loot.salvage[it.rarity] ?? 0) : 0;
}

/** Melting an epic+ by fat-fingering a bag number is unrecoverable. */
export function needsConfirm(rarity) {
  const floor = RARITY_ORDER.indexOf(config.loot.salvageConfirmFrom);
  return floor >= 0 && RARITY_ORDER.indexOf(rarity) >= floor;
}

export default {
  names: ['salvage', 'melt'],
  mod: false,
  cooldownMs: 3_000,
  cooldownPerSubcommand: true,
  help: '!salvage <item|#> [confirm] — melt an item for credits · !salvage offrole confirm — melt everything your role can’t use',
  async run({ user, args, reply }) {
    const player = await getPlayer(user.id);
    if (!player) {
      reply(`@${user.displayName} no character yet — !create <class>.`);
      return;
    }
    const inventory = Array.isArray(player.inventory) ? player.inventory : [];
    if (!inventory.length) {
      reply(`@${user.displayName} your bag is empty — nothing to salvage.`);
      return;
    }

    const first = (args[0] || '').toLowerCase();
    const confirmed = args.some((a) => String(a).toLowerCase() === 'confirm');

    // ── bulk: everything this hero can never wear ──
    if (first === 'offrole' || first === 'junk') {
      const dead = inventory.filter((id) => {
        const it = getItem(id);
        return it && typeof it.bonuses?.[player.role] !== 'number';
      });
      if (!dead.length) {
        reply(`@${user.displayName} nothing in your bag is off-role — it's all usable. 🌱`);
        return;
      }
      const total = dead.reduce((sum, id) => sum + salvageValue(id), 0);
      if (!confirmed) {
        reply(
          `@${user.displayName} that would melt ${dead.length} off-role item${dead.length === 1 ? '' : 's'} for ${total} credits. ` +
          `Someone might want them — try !bag and !give first. To go ahead: !salvage offrole confirm`,
        );
        return;
      }
      const removed = await removeFromBag(user.id, dead);
      if (!removed.length) {
        reply(`@${user.displayName} nothing was salvaged — your bag changed. Try !bag again.`);
        return;
      }
      const paid = removed.reduce((sum, id) => sum + salvageValue(id), 0);
      const balance = await credit(user.id, paid, { login: user.login, displayName: user.displayName });
      reply(`@${user.displayName} ♻️ melted ${removed.length} off-role item${removed.length === 1 ? '' : 's'} for ${paid} credits. Balance: ${balance}.`);
      return;
    }

    // ── single item ──
    const input = args.filter((a) => String(a).toLowerCase() !== 'confirm').join(' ').trim();
    if (!input) {
      reply(`@${user.displayName} usage: !salvage <item name or bag #> — or !salvage offrole to melt everything you can't wear.`);
      return;
    }
    const itemId = resolveOwnedItem(inventory, input);
    if (!itemId) {
      reply(`@${user.displayName} that item isn't in your bag. Check !bag. (Equipped gear must be !unequip'd first.)`);
      return;
    }
    const item = getItem(itemId);
    const value = salvageValue(itemId);

    if (needsConfirm(item.rarity) && !confirmed) {
      const usable = typeof item.bonuses?.[player.role] === 'number';
      const warn = usable ? " — and your hero CAN wear that" : '';
      reply(
        `@${user.displayName} ${item.name} is ${item.rarity}${warn}. Melting it is permanent (${value} credits). ` +
        `To go ahead: !salvage ${input} confirm`,
      );
      return;
    }

    const removed = await removeFromBag(user.id, [itemId]);
    if (!removed.length) {
      reply(`@${user.displayName} couldn't salvage that — it left your bag. Check !bag.`);
      return;
    }
    const balance = await credit(user.id, value, { login: user.login, displayName: user.displayName });
    reply(`@${user.displayName} ♻️ melted ${item.name} (${item.rarity}) for ${value} credits. Balance: ${balance}.`);
  },
};
