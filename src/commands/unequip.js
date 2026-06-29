// !unequip <slot|item> — bare an equipped slot (weapon/armor/trinket) or a named
// equipped item; the item returns to your bag. NOT sub-gated: managing your own
// gear is always free (sub perks live on the engagement multiplier, not gear).
import { getPlayer, unequipItem } from '../db/players.js';
import { SLOTS } from '../content/items.js';

export default {
  names: ['unequip'],
  mod: false,
  cooldownMs: 3_000,
  help: '!unequip <slot|item> — bare a slot (weapon/armor/trinket) back into your bag',
  async run({ user, args, reply }) {
    const input = args.join(' ').trim();
    if (!input) {
      reply(`@${user.displayName} usage: !unequip <slot|item> — slots: ${SLOTS.join(', ')}. See !char.`);
      return;
    }
    const player = await getPlayer(user.id);
    if (!player) {
      reply(`@${user.displayName} no character yet — !create <class>.`);
      return;
    }

    const res = await unequipItem(user.id, input);
    if (!res.ok) {
      if (res.reason === 'no-character') {
        reply(`@${user.displayName} no character yet — !create <class>.`);
        return;
      }
      // 'not-found' (unknown slot/item) or 'empty' (slot already bare).
      if (res.reason === 'not-found' || res.reason === 'empty') {
        reply(`@${user.displayName} nothing equipped there — check !char for your gear.`);
        return;
      }
      reply(`@${user.displayName} couldn't unequip: ${res.reason || 'unknown'}.`);
      return;
    }
    reply(`@${user.displayName} unequipped ${res.item.name} (${res.item.slot}) — it's back in your !bag.`);
  },
};
