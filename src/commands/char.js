// !char / !me — view your character (class, level, role rating, combat stats).
import { getPlayer, playerRoleRating } from '../db/players.js';
import { levelThreshold } from '../rules/leveling.js';
import { combatStats } from '../rules/combat.js';
import { prestigeMultiplier, prestigeExpMultiplier } from '../rules/rating.js';
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
    const g = player.equipped || {};
    const gname = (slot) => g[slot]?.name || '—';
    const gear = `${gname('weapon')} / ${gname('armor')} / ${gname('trinket')}`;
    const ren = player.renown ? ` · renown ${player.renown}` : '';
    // Prestige is the permanent half and is invisible otherwise — show what it
    // is actually buying, not just the raw number.
    const pr = player.prestige
      ? ` · ⭐ prestige ${player.prestige} (×${prestigeMultiplier(player, config).toFixed(2)} power, ` +
        `×${prestigeExpMultiplier(player, config).toFixed(2)} EXP)`
      : '';
    reply(
      `@${user.displayName} ${player.class} (${player.role}) · Lv ${player.level} · ` +
        `EXP ${player.exp}/${need} · rating ${rating}${ren}${pr} · ${combat} · gear: ${gear}. ` +
        `(!bag for unequipped loot)`,
    );
  },
};
