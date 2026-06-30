// !grab / !loot — enter the active drop's LOTTERY (spec §5.2). Every grab within
// the window enters you exactly once; when the window closes a single winner is
// drawn and gets the single item, so a drop never mints duplicates. You need a
// character to enter (loot has to land somewhere).
import { getPlayer } from '../db/players.js';
import { enterDrop } from '../db/drops.js';

export default {
  names: ['grab', 'loot'],
  mod: false,
  subOnly: true, // subscriber-only loot claims (owner decision)
  cooldownMs: 2_000,
  help: '!grab — enter the drawing for the active loot drop',
  async run({ user, reply }) {
    const player = await getPlayer(user.id);
    if (!player) {
      reply(`@${user.displayName} make a character first — !create <class>.`);
      return;
    }

    const res = await enterDrop({ userId: user.id, displayName: user.displayName });

    switch (res.status) {
      case 'none':
        reply(`@${user.displayName} there's nothing to grab right now.`);
        break;
      case 'expired':
        reply(`@${user.displayName} too late — that drop's window has closed.`);
        break;
      case 'already':
        reply(`@${user.displayName} you're already in the running for ${res.item?.name ?? 'this drop'}. 🎲`);
        break;
      case 'entered':
        reply(`@${user.displayName} 🎲 you're entered for ${res.item.name} (${res.item.rarity})! ${res.count} in the running — one winner is drawn when the window closes.`);
        break;
      default:
        reply(`@${user.displayName} something went wrong entering the drop.`);
    }
  },
};
