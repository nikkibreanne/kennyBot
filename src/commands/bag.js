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
    const names = inventory
      .map((id) => getItem(id)?.name || id)
      .slice(0, 12)
      .join(', ');
    const more = inventory.length > 12 ? ` (+${inventory.length - 12} more)` : '';
    reply(`@${user.displayName} bag: ${names}${more}. !equip <item> to wear one.`);
  },
};
