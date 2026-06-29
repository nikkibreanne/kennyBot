// !drop [item] (mod) — force a loot drop for testing/events (spec §11).
// With no argument, picks a weighted-random item from the season's loot table.
import { setDrop } from '../../db/drops.js';
import { pickDrop } from '../../rules/loot.js';
import { getItem, DEFAULT_LOOT_TABLE } from '../../content/items.js';
import { getSeason } from '../../db/configStore.js';
import { config } from '../../config.js';

export default {
  names: ['drop'],
  mod: true,
  cooldownMs: 0,
  help: '!drop [itemId] — force a loot drop',
  async run({ args, reply }) {
    let itemId = args[0];
    if (itemId && !getItem(itemId)) {
      reply(`Unknown item "${itemId}". Omit it to pick a random drop.`);
      return;
    }
    if (!itemId) {
      const lootTable = getSeason()?.lootTable?.length ? getSeason().lootTable : DEFAULT_LOOT_TABLE;
      itemId = pickDrop(lootTable, getItem, Math.random, config);
      if (!itemId) {
        reply('No droppable items configured.');
        return;
      }
    }

    const drop = await setDrop(itemId);
    const secs = Math.round(config.loot.windowMs / 1000);
    reply(`A ${drop.rarity} ${drop.name} dropped! Type !grab within ${secs}s to roll for it.`);
  },
};
