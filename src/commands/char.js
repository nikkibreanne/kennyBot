// !char / !me — view your character (class, level, role rating, combat stats).
import { getPlayer, playerRoleRating } from '../db/players.js';
import { levelThreshold } from '../rules/leveling.js';
import { combatStats } from '../rules/combat.js';
import { config } from '../config.js';

export default {
  names: ['char', 'me'],
  mod: false,
  cooldownMs: 3_000,
  help: '!char — view your character',
  async run({ user, reply }) {
    const player = await getPlayer(user.id);
    if (!player) {
      reply(`@${user.displayName} you have no character yet — !create <class> to start (subscribers).`);
      return;
    }
    const need = levelThreshold(player.level, config);
    const rating = playerRoleRating(player);
    const cs = combatStats(rating, player.role, config);
    const combat =
      player.role === 'healer'
        ? `HP ${cs.maxHp} · heal ${cs.heal}`
        : `HP ${cs.maxHp} · atk ${cs.atk}`;
    reply(
      `@${user.displayName} ${player.class} (${player.role}) · Lv ${player.level} · ` +
        `EXP ${player.exp}/${need} · rating ${rating} · ${combat}`,
    );
  },
};
