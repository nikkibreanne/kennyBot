# Okrafans Raid Game — Item Catalog: Design Rationale & Backlog

Companion to `items.js`. Explains *why* the numbers are what they are, then lists
future item ideas with the **engine support each would require** (since the
current engine only understands flat per-role `bonuses`).

---

## 1. What was produced

| Pool | Count | Notes |
|---|---|---|
| Starter gear (common) | **24** | 4 weapons + 4 armors per role (tank/healer/dps), season-agnostic |
| Season 1 — *The Ashen Sprout* | 16 | ember/mire/thorn flavor, ramp ×1.0 |
| Season 2 — *The Drowned Bloom* | 16 | tide/brine/storm/glass, ramp ×1.25 |
| Season 3 — *The Hallowed Harvest* | 16 | astral/gilded/void/okra-finale, ramp ×1.5 |
| **Total** | **72** | |

Exports: `ITEMS` (id→item), `STARTER_WEAPONS`/`STARTER_ARMOR` (role→[ids]),
`SEASON_LOOT` (3 arrays), plus parity helpers `getItem`, `itemObject`,
`getStarterEquipped(role, rng)`, and `DEFAULT_LOOT_TABLE` (= Season 1).

---

## 2. Shape & engine constraints honored

- **Item shape matches `src/content/items.js` exactly**: `ITEMS` is `id →
  { name, slot, rarity, role, bonuses }`. The `id` lives in the map *key*, not
  inside the object; `itemObject()` re-attaches it for storage on a player.
- **`bonuses` is single-keyed** `{ [role]: number }`. `rules/rating.js#gearBonus`
  only sums the bonus whose key equals the wearer's role, so a multi-key item
  would silently let one piece buff every role — avoided. Cross-role/off-role
  gear is a *backlog* idea, not snuck in here.
- **Magnitudes only** — no new fields (no `level req`, `set`, `sockets`, `procs`).
  Anything the engine can't read today is in the backlog below, gated on the
  named engine change.

## 3. Magnitude ladder & season ramp

Base bands (Season 1), then ×1.25 (S2) and ×1.5 (S3), staying inside the
per-tier bands. dps numbers sit a hair above tank/healer at equal rarity,
matching the existing catalog's convention (e.g. starter dps weapon 12 vs tank
10); this is cosmetic, *not* a balance lever — see §4.

| Rarity | S1 band | S2 band (×1.25) | S3 band (×1.5) |
|---|---|---|---|
| common | 8–12 | 10–15 | 12–18 |
| uncommon | 18–24 | 23–30 | 27–36 |
| rare | 34–42 | 43–53 | 51–63 |
| epic | 55–70 | 69–88 | 83–105 |
| legendary | 90–110 | 113–138 | 135–165 |

Because gear **resets every season**, the S2/S3 ramp keeps each fresh season's
chase feeling like a real power climb rather than re-earning last season's gear.

## 4. Key balance decisions

1. **Gear is a meaningful-but-not-dominant slice of `roleRating`.** `roleRating
   = classBase + level*10 + gear`. A fully epic-geared S1 dps ≈ 64+38+62 = **164**
   gear; at ~level 15 that's 80 + 150 + 164 = 394, so gear ≈ 42% of rating.
   Leveling (chat engagement) and gear stay in the same order of magnitude, so
   the loot loop matters without letting a lucky legendary trivialize a boss.
2. **A bonus is role-fair regardless of role.** Because a bonus adds *directly*
   to `roleRating` (which already applies role-specific combat multipliers
   downstream: tank hp×1.4, dps atk×0.30, healer heal×0.45), +60 is worth the
   same "rating" to every role. So I did **not** inflate dps numbers to
   compensate for its lower classBase (80 vs tank 100); the ±2 dps nudge is
   flavor only.
3. **Loot tables intentionally include commons.** `rules/loot.js#pickDrop` rolls
   a rarity off `rarityWeights` (common is weighted **60**), then picks uniformly
   among table items *of that rarity*; if none match it **falls back to a uniform
   pick over the whole table**. A table with no commons therefore dumps ~60% of
   drops into that uniform fallback and massively over-drops rares/epics/
   legendaries. Each season table here spans common→legendary so the ladder
   actually drives drop frequency. (The live `DEFAULT_LOOT_TABLE` in
   `src/content/items.js` has *no* commons — flagged in §6, not edited here.)
4. **dps-weighted breadth, balanced legendaries.** 3 of 5 classes are dps
   (Berserker/Arcanist/Ranger), so each season's drop pool is dps-heavy (6 dps
   vs 4 tank / 4 healer items in the non-legendary tiers) to match expected
   roster composition. Legendaries are kept *role-balanced* (2 tank / 2 healer /
   2 dps across the 3 seasons) so no single role is starved of a chase item, and
   so a stacked-dps raid can't farm an outsized share of legendaries.
5. **Every role can fully gear every season.** Each season's 16 drops guarantee
   each role at least one weapon, one armor, AND one trinket (validated), since
   starter gear only covers weapon+armor — trinkets must come from drops.
6. **Randomized starter gear** (`getStarterEquipped`) gives newcomers a tiny bit
   of identity/variety on `!create` without affecting balance (all starters are
   commons within a 6–12 spread).

---

## 5. BACKLOG — future item ideas (each tagged with required engine support)

### A. Set bonuses ("Garden Collections")
Themed N-piece sets (e.g. *Drowned Court* 3-set) granting an extra role-rating
or combat bonus once enough pieces are equipped.
- **Engine support:** add an optional `set: "<setId>"` field on items + a
  `SETS` table (`{ setId: { thresholds: { 2: bonus, 4: bonus } } }`); extend
  `rules/rating.js#gearBonus` (or a new `setBonus()`) to count equipped pieces
  per set and add threshold bonuses to `roleRating`. Players already store
  denormalized equipped objects, so the set id rides along for free.

### B. Sockets & gems
Items with sockets; players slot consumable gems (small role-rating or
combat-stat boosts) for build customization.
- **Engine support:** `sockets: number` on items; a `gems` catalog; per-equipped-
  item `socketedGems` storage; sum gem bonuses in `gearBonus`. Needs a `!socket`
  command + inventory model for gems.

### C. Off-role / hybrid affixes
Multi-key `bonuses` (e.g. a healer trinket that also gives a little tank rating
for off-spec flexibility), or a small universal "+all roles" stat.
- **Engine support:** `gearBonus` already sums only `bonuses[player.role]`, so a
  second key is simply ignored today — safe but inert. To make it *count*,
  decide the rule (does off-role gear help? a hybrid "support" value?) and adjust
  `gearBonus`. **Low effort, high design-risk** — would weaken the
  one-stat-per-role clarity, so deliberately deferred.

### D. Combat-stat affixes (crit / lifesteal / mitigation)
Items that tweak the *combat* layer (e.g. +crit chance, +damage variance floor,
boss-aggro reduction) instead of flat rating.
- **Engine support:** `rules/combat.js` derives every stat from `roleRating`
  today. Would need per-hero stat *modifiers* threaded from equipped gear into
  the combat sim (e.g. `crit`, `mitigation`, `lifesteal` deltas) and the replay
  UI to surface them. Largest lift; highest gameplay upside.

### E. Item levels / upgrade tracks
Let a dropped item be upgraded (e.g. spend duplicate drops or a currency) to
raise its bonus within a band.
- **Engine support:** per-equipped-item `upgradeLevel`; compute effective bonus
  as `base + upgradeLevel*step` in `itemObject`/`gearBonus`. Needs a currency +
  `!upgrade` command.

### F. Boss-specific signature drops & weekly bad-luck protection
Tie each of the 6 weekly bosses to 1–2 signature items, and add pity so a player
who's gone N weeks without an epic+ gets a bumped roll.
- **Engine support:** a `bossId → [itemIds]` map consulted alongside the season
  table in `pickDrop`; a per-player `dropPity` counter feeding `rollRarity`.

### G. Cosmetic-only "garden trophies"
Campy okra/flower cosmetics with `bonuses: {}` purely for `!char`/site flair.
- **Engine support:** essentially none — `gearBonus` ignores empty bonuses. Just
  needs the UI to display cosmetics and a non-gear inventory bucket so they don't
  occupy weapon/armor/trinket slots.

### Suggested priority
1. **(C-flag aside) Loot-table commons fix** for the live `DEFAULT_LOOT_TABLE`
   (see §4.3) — a real latent drop-rate bug, ~1 line, do first.
2. **Set bonuses (A)** — biggest collectible/chase payoff for the least engine
   surface (one additive pass in rating).
3. **Boss signature drops + bad-luck pity (F)** — makes each of the 6 weekly
   bosses feel distinct and smooths the 25–50-player drop experience.

> Note: items #2–#3 above are *feature* recommendations; #1 is a bug flag on
> existing code I was asked not to edit.
