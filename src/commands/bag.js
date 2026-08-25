// !bag / !inventory — view unequipped loot (spec §11).
import { getPlayer } from '../db/players.js';
import { getItem } from '../content/items.js';

export default {
  names: ['bag', 'inventory', 'inv'],
  mod: false,
  cooldownMs: 3_000,
  help: '!bag — view your unequipped loot',
  async run({ user, reply }) {
    const player = await getPlayer(user.id);
    if (!player) {
      reply(`@${user.displayName} no character yet — !create <class>.`);
      return;
    }
    const inventory = Array.isArray(player.inventory) ? player.inventory : [];
    if (inventory.length === 0) {
      reply(`@${user.displayName} your bag is empty. !grab drops while live to fill it.`);
      return;
    }
    // Mark what this hero cannot use. Gear pays out only through its own role,
    // so an off-role piece is worth 0 to them — flagging it here is what turns a
    // dead bag slot into a trade.
    const usable = (id) => typeof getItem(id)?.bonuses?.[player.role] === 'number';
    const names = inventory
      .slice(0, 12)
      .map((id, i) => `${i + 1}. ${getItem(id)?.name || id}${usable(id) ? '' : ' ⛔'}`)
      .join('  ');
    const more = inventory.length > 12 ? ` (+${inventory.length - 12} more)` : '';
    const dead = inventory.filter((id) => !usable(id)).length;
    const hint = dead
      ? ` ⛔ = not for a ${player.role} (${dead}) — !give @user <#> to pass it on.`
      : '';
    reply(`@${user.displayName} bag: ${names}${more}. !equip <#> to wear one · !trade @user <#> to trade.${hint}`);
  },
};
