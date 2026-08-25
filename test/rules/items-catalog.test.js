// The season gear catalog. Two things matter here and they pull in opposite
// directions: the pyramid must stay COMPLETE (that is the whole point of the
// expansion), and the ids must stay STABLE (players' bags and equipped slots
// are keyed by them, and ids are derived from names — so a rename silently
// orphans whatever is holding the item).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ITEMS, SEASON_LOOT, PYRAMID, SLOTS, STARTER_WEAPONS, STARTER_ARMOR } from '../../src/content/items.js';
import { config } from '../../src/config.js';

const ROLES = ['tank', 'healer', 'dps'];
const RARITIES = ['common', 'uncommon', 'rare', 'epic', 'legendary'];

/** Count a season's items by role → slot → rarity. */
function cells(seasonIdx) {
  const g = new Map();
  for (const id of SEASON_LOOT[seasonIdx]) {
    const it = ITEMS[id];
    for (const role of Object.keys(it.bonuses || {})) {
      const key = `${role}/${it.slot}/${it.rarity}`;
      g.set(key, (g.get(key) || 0) + 1);
    }
  }
  return g;
}

test('every season fills the full pyramid — every role, every slot, every rarity', () => {
  for (let s = 0; s < SEASON_LOOT.length; s++) {
    const g = cells(s);
    for (const role of ROLES) {
      for (const slot of SLOTS) {
        for (const rarity of RARITIES) {
          assert.equal(
            g.get(`${role}/${slot}/${rarity}`) || 0,
            PYRAMID[rarity],
            `season ${s + 1} ${role}/${slot} ${rarity}: expected ${PYRAMID[rarity]}`,
          );
        }
      }
    }
  }
});

test('every role has a legendary in every slot — the gap that started this', () => {
  // Before the expansion each season had exactly ONE tank weapon and ONE dps
  // armor, and most role×slot pairs had no legendary at all.
  for (let s = 0; s < SEASON_LOOT.length; s++) {
    for (const role of ROLES) {
      for (const slot of SLOTS) {
        const top = SEASON_LOOT[s]
          .map((id) => ITEMS[id])
          .filter((it) => it.rarity === 'legendary' && it.slot === slot && it.bonuses?.[role]);
        assert.equal(top.length, 1, `season ${s + 1} ${role}/${slot} needs exactly one legendary`);
      }
    }
  }
});

test('a season offers a full 25-item ladder to each role in each slot', () => {
  const perCell = Object.values(PYRAMID).reduce((a, b) => a + b, 0);
  assert.equal(perCell, 25);
  for (let s = 0; s < SEASON_LOOT.length; s++) {
    assert.equal(SEASON_LOOT[s].length, perCell * ROLES.length * SLOTS.length);
  }
});

test('ids are unique, and every loot-table id resolves', () => {
  for (let s = 0; s < SEASON_LOOT.length; s++) {
    const ids = SEASON_LOOT[s];
    assert.equal(new Set(ids).size, ids.length, `season ${s + 1} has a duplicate id`);
    for (const id of ids) assert.ok(ITEMS[id], `${id} is in a loot table but not the catalog`);
  }
  const all = SEASON_LOOT.flat();
  assert.equal(new Set(all).size, all.length, 'an id is shared across seasons');
});

test('ids follow itm_s<season>_<slug> and match their season', () => {
  for (let s = 0; s < SEASON_LOOT.length; s++) {
    for (const id of SEASON_LOOT[s]) {
      assert.match(id, /^itm_s[123]_[a-z0-9_]+$/, `${id} is not a well-formed id`);
      assert.equal(id.startsWith(`itm_s${s + 1}_`), true, `${id} is in season ${s + 1}'s table`);
    }
  }
});

test('the original hand-authored ids all survive — bags are keyed by them', () => {
  // These are in prod players' inventories and equipped slots RIGHT NOW. The
  // expansion must never renumber or drop one.
  const ORIGINALS = [
    'itm_s1_cinder_spade', 'itm_s1_mire_poultice', 'itm_s1_thornnettle_dirk',
    'itm_s1_stoneheart_charm', 'itm_s1_pollenward_mantle', 'itm_s1_ember_token',
    'itm_s1_ashbark_aegis', 'itm_s1_dewmender_scepter', 'itm_s1_stormcaller_edge',
    'itm_s1_blightstalker_hide', 'itm_s1_wardens_bastion', 'itm_s1_choirs_lament',
    'itm_s1_emberforged_blade', 'itm_s1_tyrants_emberseed', 'itm_s1_final_knell_reaper',
    'itm_s1_heart_of_the_grove',
  ];
  for (const id of ORIGINALS) {
    assert.ok(ITEMS[id], `${id} vanished from the catalog — prod bags reference it`);
    assert.ok(SEASON_LOOT[0].includes(id), `${id} fell out of season 1's table`);
  }
  // And their hand-tuned values are untouched by the generator.
  assert.equal(ITEMS.itm_s1_final_knell_reaper.bonuses.dps, 104);
  assert.equal(ITEMS.itm_s1_cinder_spade.bonuses.tank, 10);
});

test('starter gear is untouched and stays out of the season tables', () => {
  const starters = [...Object.values(STARTER_WEAPONS), ...Object.values(STARTER_ARMOR)].flat();
  assert.equal(starters.length, 24);
  for (const id of starters) {
    assert.ok(ITEMS[id], `${id} missing`);
    assert.equal(SEASON_LOOT.flat().includes(id), false, `${id} must not be a season drop`);
  }
});

test('every item is well-formed and pays out to exactly its own role', () => {
  for (const [id, it] of Object.entries(ITEMS)) {
    assert.ok(it.name, `${id} has no name`);
    assert.ok(SLOTS.includes(it.slot), `${id} has slot "${it.slot}"`);
    assert.ok(RARITIES.includes(it.rarity), `${id} has rarity "${it.rarity}"`);
    assert.ok(ROLES.includes(it.role), `${id} has role "${it.role}"`);
    const paid = Object.keys(it.bonuses || {});
    assert.deepEqual(paid, [it.role], `${id} pays out to ${paid} but is a ${it.role} item`);
    assert.ok(it.bonuses[it.role] > 0, `${id} grants no rating`);
  }
});

test('rarity is worth more than the tier below it, in every season and slot', () => {
  for (let s = 0; s < SEASON_LOOT.length; s++) {
    for (const role of ROLES) {
      for (const slot of SLOTS) {
        const byRarity = RARITIES.map((rarity) => {
          const vals = SEASON_LOOT[s]
            .map((id) => ITEMS[id])
            .filter((it) => it.slot === slot && it.bonuses?.[role] && it.rarity === rarity)
            .map((it) => it.bonuses[role]);
          return { rarity, min: Math.min(...vals), max: Math.max(...vals) };
        });
        for (let i = 1; i < byRarity.length; i++) {
          assert.ok(
            byRarity[i].min > byRarity[i - 1].max,
            `season ${s + 1} ${role}/${slot}: ${byRarity[i].rarity} (min ${byRarity[i].min}) does not beat every ${byRarity[i - 1].rarity} (max ${byRarity[i - 1].max})`,
          );
        }
      }
    }
  }
});

test('a tier is a spread, not nine identical items', () => {
  // Nine commons that all grant the same number is nine cosmetic reskins.
  const vals = SEASON_LOOT[0]
    .map((id) => ITEMS[id])
    .filter((it) => it.role === 'tank' && it.slot === 'weapon' && it.rarity === 'common')
    .map((it) => it.bonuses.tank);
  assert.ok(new Set(vals).size > 1, 'commons in a tier should differ');
  assert.ok(Math.max(...vals) - Math.min(...vals) <= 6, 'but only slightly — not a second rarity ladder');
});

test('later seasons out-scale earlier ones at the same rarity', () => {
  for (const rarity of RARITIES) {
    const peak = SEASON_LOOT.map((ids) =>
      Math.max(...ids.map((id) => ITEMS[id]).filter((it) => it.rarity === rarity).map((it) => Object.values(it.bonuses)[0])),
    );
    assert.ok(peak[1] > peak[0], `season 2 ${rarity} must beat season 1`);
    assert.ok(peak[2] > peak[1], `season 3 ${rarity} must beat season 2`);
  }
});

test('a full legendary loadout stays in the band the hand-tuned gear set', () => {
  // Gear should dominate a season's power budget without making level/renown
  // irrelevant — the original S1 legendaries were ~100 a slot, so ~300 a set.
  for (const role of ROLES) {
    const best = SLOTS.map((slot) =>
      Math.max(...SEASON_LOOT[0].map((id) => ITEMS[id]).filter((it) => it.slot === slot && it.bonuses?.[role]).map((it) => it.bonuses[role])),
    ).reduce((a, b) => a + b, 0);
    assert.ok(best >= 280 && best <= 320, `${role}'s best S1 set is +${best}, outside the established band`);
    // Renown stays a perk next to gear, never a replacement for it.
    assert.ok(best > config.rating.renownCap * config.rating.renownPerPoint);
  }
});
