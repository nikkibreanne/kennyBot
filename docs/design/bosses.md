# okrafans raid game — Boss design backlog & rationale

Companion file to `bosses.js` (same dir). Covers: (1) the difficulty curve, (2)
the HP-scaling math, (3) AFFIX designs + the engine support each needs, (4)
multi-phase finale ideas, (5) known gaps / flagged decisions.

All numbers below were **measured against the real engine** (`src/rules/combat.js`
+ `src/rules/rating.js` + `src/config.js`) via the calibration scripts in this
dir (`calibrate*.mjs`, `sweep-sets.mjs`, `verify-final.mjs`), not hand-waved.
Re-run `node verify-final.mjs` after any edit to re-confirm.

---

## 1. Difficulty curve

### Reference roster (the calibration target)
- **15 active heroes**, role split **3 tank / 3 healer / 9 dps** (~20/20/60 — the
  natural skew of a 5-class trinity with 1 tank + 1 healer + 3 dps classes; the
  spec's sample raid is 3/2/7, same shape).
- **Engagement multiplier 1.0** (non-sub floor) and **gear = 0** (each season
  resets gear, per spec §5.6) — i.e. the *weakest* plausible 15-stack. Real
  raids with subs/gear will out-perform this, which is the intended safety
  margin (bosses should be beatable, not a coin-flip, for the median week).
- **Per-season expected hero level:** S1 ≈ 10, S2 ≈ 16, S3 ≈ 22.

### Target reference win-rate ramp (per season, weeks 1→6)
~100% → ~98% → ~92% → ~80% → ~62% → ~46%. **Week 6 (finale) is the hardest week
in every season.** Measured REF(15) result for the shipped numbers:

| Wk | S1 (L10) | S2 (L16) | S3 (L22) | set | role of the week |
|----|----------|----------|----------|-----|------------------|
| 1  | 100% | 100% | 100% | swarmer/bruiser | loot-piñata warm-up |
| 2  | 100% | 100% | 99%  | bruiser | warm-up, atk up |
| 3  | 94%  | 92%  | 92%  | bruiser/swarmer | first real check |
| 4  | 82%  | 79%  | 78%  | breaker | tank/spike check |
| 5  | 64%  | 60%  | 63%  | caster  | **healer check** (AoE attrition) |
| 6  | 44%  | 47%  | 51%  | finale  | **set-piece, hardest** |

### How difficulty escalates (4 independent levers)
1. **Boss `atk`** climbs within a season and across seasons (finale atk 150 → 175
   → 198). More atk = more wipe pressure.
2. **Ability-set lethality** climbs by week: `swarmer`/`bruiser` (gentle) →
   `breaker` (single-target spikes) → `caster` (heavy AoE attrition) → `finale`.
3. **Fight length** (`baseHp` via `targetTurns` 13→18) climbs — longer fights
   expose the raid to more AoE/attrition ticks.
4. **Muster `thresholds`** climb week→week (finale ≈ 105% of the reference role
   aggregate) so the muster page *demands* a fuller raid before the finale.

### Why `atk` is intentionally NOT monotonic week-to-week
The `caster` set (heavy AoE) is ~2–3× more lethal **per point of atk** than the
`bruiser`/`swarmer` sets (single-target, soaked by the tank). So a 62%-win caster
week needs a *lower* atk integer than the 80%-win breaker week before it. We tune
**`atk` per boss against its set to hit the target win-rate**, and express
difficulty through the **win-rate curve and the muster thresholds** (both
monotonic) — not through the raw `atk` number. Documented at the top of
`bosses.js` so nobody "fixes" the non-monotonicity and breaks the curve.

---

## 2. HP-scaling math

### The problem
The engine **sums every signed-up hero's damage into one party**, so total team
DPS is ~linear in headcount. A fixed boss HP that gives a 15-stack an 18-turn
fight gives a 40-stack a ~7-turn faceroll and a 10-stack a ~27-turn slog (past
the fun window). HP must scale with how many show up.

### Measured team DPS/turn (real engine, REF comp, gear 0, mult 1.0)
| level | n=10 | n=15 | n=40 | per-head |
|-------|------|------|------|----------|
| L10   | 538  | 805  | 2149 | ~53.7 |
| L16   | 715  | 1069 | 2854 | ~71.4 |
| L22   | 891  | 1333 | 3559 | ~89.0 |

**Per-head DPS is flat across roster size** (53.7 at any n) — confirming team DPS
is linear in headcount. (Per-head < a pure-dps figure because the 20/20/60 comp
includes low-damage tanks and near-zero-damage healers; healers spend ~2/3 of
turns healing.) Hero damage also rises ~linearly with level (atk = roleRating ×
{tank .18, healer .12, dps .30}; roleRating = classBase + level×10 + gear), which
is why each season re-calibrates to its expected level.

### baseHp calibration
```
baseHp(season, week) ≈ teamDpsPerTurn[season] × targetTurns[week]
targetTurns:  W1..W6 = 13, 14, 15, 16, 17, 18   (finale longest)
```
e.g. S2 W4: 1069 × 16 ≈ 17,100. Values rounded to the nearest 100 in `bosses.js`.

### The scaling function
```js
scaleBossHp(baseHp, n) = clamp( baseHp × (n / 15)^0.92 , 0.25×baseHp , 4×baseHp )
```
- **Linear core `(n/15)`** keeps turn-count ~constant (since DPS is linear in n).
- **Exponent 0.92** (mild sub-linear compression): big raids kill ~2–3 turns
  faster (a small, deserved reward for a strong muster); small raids get ~1–2
  extra turns of breathing room. Verified band: n10 ≈ 13–20t, n15 ≈ 13–20t,
  n40 ≈ 12–17t — all inside the 12–25 target, comfortably under the engine's
  `turnCap` (60).
- **0.25× floor / 4× ceiling**: a no-show raid never faces an absurdly thin boss;
  a 100-person brigade never inflates HP past the turn budget.
- Multiplier table: n5 0.36× · n10 0.69× · n15 1.00× · n25 1.60× · n40 2.47× ·
  n60 3.58×.

### Wiring (engine integration — small)
At raid lock, set the combat HP from the frozen signup count:
`boss.hp = scaleBossHp(boss.baseHp, team.count)`. `baseHp` lives in content;
`hp` is derived per-raid. Snapshot `hp` into the raid doc so the replay is
deterministic even if the count is later re-read.

---

## 3. AFFIX designs (weekly modifiers — NEED ENGINE SUPPORT)

Affixes are shipped now as **strings on the boss** and are **flavor-only until the
engine implements them** (the combat loop ignores unknown affixes — safe). Each
needs a hook in `simulateBattle`. Ordered roughly by implementation cost.

| affix | flavor | mechanic | engine support needed | cost |
|-------|--------|----------|-----------------------|------|
| `drought` | heat with no rain | **enrage ramp**: boss atk ×(1 + r·turn) | one multiplier on boss-damage using the existing turn counter | S |
| `blight` | withering dust | **healing reduced** ~35% | multiply `heal` events by `(1 - x)` | S |
| `thorns` | brambles bite back | **reflect**: hero takes ~10% of the damage it deals | on party `damage`, subtract a fraction from the actor's hp + emit event | S |
| `overgrowth` | it keeps growing | **boss regen** N HP/turn | add boss heal step each round (clamp to max) + event | S |
| `rot` | spreading decay | **stacking DoT** on hit heroes, ticks each turn | per-hero stack map + a tick phase + event shape | M |
| `slime` | sluggish goo | **hero atk debuff** that stacks | per-hero atk modifier applied in `combatStats`-at-runtime | M |
| `frost` | bitter cold | **cooldown inflation** / chance to skip an action | per-hero cd inflation or a skip RNG in the party loop | M |
| `roots` | tangling runners | each turn a **random hero is rooted** (skips its action) | per-hero skip flag + RNG + 'rooted' event | M |
| `swarm` | pests everywhere | **adds**: extra low-power AoE tick / a second attacker | either a cheap "+1 AoE every k turns" (S) or real add-entities (L) | S→L |
| `burrow` | pops from the warren | boss **untargetable** 1 turn, then a **spike** | boss-invuln flag (party damage no-ops that turn) + a queued spike | M |
| `devour` | swallowed whole | boss **removes the lowest-HP hero** for K turns, then returns it | temp remove/return entity from `party`/`hp` + events | L |
| `finale` | set-piece marker | enables **multi-phase** handling (see §4) | HP-threshold phase hooks + 'phase' event | L |

**Shared prerequisite:** every affix that mutates combat must emit a new event
shape so the website replay (`_includes/live.html`) can render it — coordinate the
event vocabulary with the UI before building any of these. Recommend a generic
`{ type:'affix', affix, text, ... }` event plus affix-specific fields.

**Recommended first slice (cheap, high-flavor):** `drought`, `blight`, `thorns`,
`overgrowth` — all one-liners on existing state, no new entity model.

---

## 4. Multi-phase finale ideas (`affix: 'finale'`)

The finales are tuned as **DPS-races-against-attrition** (REF win ~44–51%). To
make them feel like set-pieces rather than just "big HP", add HP-threshold phases.

### Engine support (one feature, reused by all finales)
- **HP-threshold hooks**: at e.g. 66% and 33% boss HP, run a transition that may
  (a) swap `boss.abilities` to a nastier set, (b) bump `boss.atk` by a factor,
  (c) emit a `{ type:'phase', n, text }` event for the UI, (d) optionally spawn
  adds (needs the `swarm` add-model).
- **Soft enrage**: if not downed by turn T (say 22), apply a growing atk multiplier
  so the fight always resolves and pure-DPS comps are rewarded — guarantees the
  finale can't stalemate to the turnCap.

### Per-finale set-pieces
- **S1 — Scarecrow King (`Jack o' the Rotten Row`)**: P2 at 50% summons a **murder
  of crows** (swarm adds → +AoE). "The crows answer to him now." Healer check.
- **S2 — Cornstalk Colossus**: P3 "**Tassel Storm**" — a guaranteed raid-wide AoE
  every 3 turns (drought-style enrage). Husk-armor in P1 (light damage reduction)
  that the raid must chew through before the burn phase.
- **S3 — Okra Eternal (GRAND FINALE)**: campy 3-phase "Mother Pod":
  1. **Bloom** — single-target devour checks (tank + swap healing).
  2. **Pod Burst** — escalating AoE; classic healer-check phase.
  3. **Eternal** — heal-reduction (`blight`) + soft enrage; "she's *so proud* of
     you" but every failed check makes her **disappointed** (atk ↑). Beat her
     before disappointment wipes the bed.

---

## 5. Known gaps & flagged decisions (per working-style: surfacing these)

1. **Small-raid wipe cliff (most important).** Boss `atk` is *absolute* — it does
   not scale with roster size, but HP does. So `scaleBossHp` keeps *kill-time*
   size-independent but **not survivability**: a 40-stack has 8 healers soaking
   the same AoE a 10-stack faces with 2, so finales are ~100% for n40 but ~5–9%
   for n10. Early weeks are fine at all sizes; **W4+ and finales are effectively
   gated to ≥~15-person musters.** That may be intended (finales *should* demand a
   crowd) — but if small communities should have a shot, we need an **atk-scaling
   knob** too. Options to decide: (a) `atk × g(n)` with g rising gently with n so
   per-capita pressure is ~flat; (b) scale only AoE power by `min(1, n/refHealers)`;
   (c) leave as-is and document finales as "big-muster content." **Open decision —
   needs the human.**
2. **Reference comp assumption.** Everything is calibrated to a 3/3/9 split. A raid
   that musters 0 healers or 0 tanks will wipe regardless of HP — the muster
   `thresholds` are the only warning. Consider a **hard muster gate** (refuse to
   start, or auto-flag) when a role is absent. Open.
3. **Expected-level assumptions (S1 10 / S2 16 / S3 22).** These drive every
   `baseHp`/`atk`. If chat actually levels faster/slower, the whole season is
   mis-tuned. Recommend the bot **log the real locked-roster aggregate roleRating
   each week** and compare to `REFERENCE` so we can re-calibrate from live data
   rather than guesses.
4. **Engagement multiplier set to 1.0 (no subs) in calibration.** A heavily-subbed
   raid (mult up to 2.0) deals up to ~2× the modeled damage → faster, easier
   clears. The HP-scaling only keys off *count*, not *strength*. If sub-heavy
   raids trivialize bosses, add an optional **roleRating-aware** scale term
   (scale HP by `team.power / referencePower`) instead of / in addition to count.
   Flagged.
5. **`turnCap` headroom.** On-disk `turnCap` is 60 (the in-code default printed at
   runtime; an earlier file read showed a stale `20`). All fights land ≤ ~20 turns
   so there's ample headroom — but if soft-enrage finales are added, keep the cap
   ≥ ~30 so the enrage, not the cap, ends the fight.
6. **Ability-set names are intents.** `swarmer/bruiser/breaker/caster/finale` map
   to the companion `BOSS_ABILITY_SETS` library; the representative sets used for
   calibration are in `verify-final.mjs`. If the real library's powers differ,
   **re-run `sweep-sets.mjs`** and re-pick per-boss `atk` to preserve the win curve.
