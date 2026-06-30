# Game content & design backlog

Designed content for the okrafans raid game (campy okra/garden theme, original IP).
The **implemented** content lives in `src/content/` (`items.js`, `abilities.js`,
`bosses.js`); the files here are the **design rationale + future backlog**.

## What's implemented now
- **72 items** across 3 seasons + randomized common starter pools, per-season
  loot tables (`SEASON_LOOT`). Rarity drives magnitude; gear resets each season.
- **Class ability kits** (distinct per class — Arcanist nuke, Berserker execute,
  Ranger metronome, Mender heal+filler, Guardian soak) + a **6-archetype boss
  ability library** (bruiser / caster / swarmer / executioner / warden / tyrant).
- **18 bosses** (3 seasons × 6 weeks; week 6 = finale) with a **boss-HP-scaling**
  formula `scaleBossHp(baseHp, mustered) = clamp(baseHp·(n/15)^0.92, 0.25×, 4×)`
  so fights stay ~12–20 turns from 8 to 40 heroes. Boss **attack stays absolute**,
  so an undermanned/underleveled raid can genuinely fail the harder bosses (the
  intended "chance to fail" — a recommended hero count is surfaced at muster).
- **Veteran renown**, **sub-tier combat power**, **survivor-bonus loot**, and the
  **auto chat-drop scheduler** (see the main README).

## Backlog (designed, not yet wired) — see the per-area docs
- [items.md](items.md) — **set bonuses** ("Garden Collections"), sockets,
  boss-signature drops + bad-luck pity.
- [abilities.md](abilities.md) — advanced combat mechanics needing new engine
  `kind`s + replay-event shapes: **DoT, shields/absorb, taunt, cleanse, interrupt**.
- [bosses.md](bosses.md) — **multi-phase finales** (HP-threshold phase transitions
  for the season capstone). *(Affixes, formerly listed here as needing engine
  support, have since shipped — see Open decisions.)*
- [balance.md](balance.md) — economy/EXP pacing, loot rates, prestige, and the
  **combat-log compaction** plan for dozens of participants (deferred per owner:
  keep full log lines for now; revisit if turnouts hit the dozens).

## Open decisions logged
- **Affixes** — RESOLVED: the affix engine shipped, so a boss's affixes apply
  real combat effects (drought, blight, thorns, overgrowth, frost, summoned adds),
  not flavor-only. See `bosses.md §3` and `src/content/affixes.js`.
- **Combat-log size**: full per-hero lines kept (turn cap raised to 100); compaction
  is backlogged until large turnouts make it necessary.
- **Set bonuses** are the highest-payoff item backlog item (minimal engine surface).
