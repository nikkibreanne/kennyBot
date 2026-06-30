// !grab / !loot — claim the active drop (rolls within the window) (spec §5.2).
// Inclusive window with independent rolls, not first-to-type. A player's first
// ever claim is guaranteed (good first impression, spec §5.5).
import { getPlayer } from '../db/players.js';
import { claimDrop } from '../db/drops.js';

export default {
  names: ['grab', 'loot'],
  mod: false,
  subOnly: true, // subscriber-only loot claims (owner decision)
  cooldownMs: 2_000,
  help: '!grab — roll for the active loot drop',
  async run({ user, reply }) {
    const player = await getPlayer(user.id);
    if (!player) {
      reply(`@${user.displayName} make a character first — !create <class>.`);
      return;
    }

    const guaranteed = (player.stats?.lootClaimed || 0) === 0; // first-claim guarantee
    const res = await claimDrop({ userId: user.id, guaranteed });

    switch (res.status) {
      case 'none':
        reply(`@${user.displayName} there's nothing to grab right now.`);
        break;
      case 'expired':
        reply(`@${user.displayName} too late — that drop expired.`);
        break;
      case 'already':
        reply(`@${user.displayName} you already rolled on this drop.`);
        break;
      case 'claimed':
        if (res.won) reply(`@${user.displayName} you grabbed ${res.item.name} (${res.item.rarity})! It's in your !bag.`);
        else reply(`@${user.displayName} you rolled… and missed this one. Better luck next drop!`);
        break;
      default:
        reply(`@${user.displayName} something went wrong grabbing the drop.`);
    }
  },
};
