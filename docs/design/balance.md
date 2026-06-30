# okrafans Raid Game — Balance & Scaling Design Doc

Status: design backlog (no code changed). Targets the live engine in
`src/config.js`, `src/rules/{leveling,rating,combat}.js`, `src/db/raid.js`,
`src/content/*`. All numbers below were computed against an **earlier config snapshot**
(perMessage 10, cooldown 30s, threshold base 100 / growth 1.35, defaultBossHp
6000, turnCap 20) plus the **current** level-up commit (levelUp base 0 / k 0.34 /
cap 1.0 / pressureCap 4). The committed engine has since moved on — now
**perMessage 12, growth 1.30, turnCap 100** — so treat the EXP/timing tables
below as directional, not exact; the authoritative live values are in
[`docs/CONFIG.md`](../CONFIG.md).

Design targets: **25–50 active heroes**, **3 seasons × 6 weeks**, gear resets
per season, veterans keep prestige. Class fixes role (Guardian=tank,
Mender=healer, Berserker/Arcanist/Ranger=dps), and **every signed-up hero is
summed into one party that all act each turn**.

---

## 0. How the engine actually wires together (verified, with one gotcha)

The combat path is:

```
player record ──roleRating()──► rr = classBase[role] + level*10 + Σ gear[role]
                 (rules/rating.js)
rr ──combatStats()──► { maxHp = 200 + rr*hpPerRating[role],
   (rules/combat.js)     atk   = round(rr * atkPerRating[role]),
                         heal  = round(rr * healPerRating[role]) }
buildSnapshot() (db/raid.js) freezes maxHp/atk/heal per hero at lock.
simulateBattle() loops turns: EVERY alive hero acts once/turn, then the boss acts.
```

Key constants:

| role   | classBase | hpPerRating | atkPerRating | healPerRating |
|--------|-----------|-------------|--------------|---------------|
| tank   | 100       | 1.4         | 0.18         | 0             |
| healer | 90        | 1.0         | 0.12         | 0.45          |
| dps    | 80        | 0.8         | 0.30         | 0             |

`combat.stats.hpBase = 200`. perLevel rating = 10. Ability `power` multiplies
the actor's atk/heal; crit party 0.16×1.8, boss 0.12×1.7; variance ±20%.

**GOTCHA / flagged decision — engagement multiplier does NOT touch combat.**
`buildSnapshot()` calls `roleRating()` (raw class+level+gear), *not*
`contribution()`. So the sub engagement multiplier (1.0→1.6×) only accelerates
**EXP/leveling** (`applyChatTick` → `applyChatExp`); it is *not* applied to
combat power. This contradicts spec §4 (`contribution = rating × engagement`)
and the unused-in-combat `contribution()` helper.
**Recommendation: keep combat on raw `roleRating` (no engagement) — it is the
correct anti-pay-to-win choice — and treat the spec text as superseded.** Subs'
benefit is *speed* (faster leveling) + a proposed loot-claim edge (§3), never a
direct combat multiplier. Document this so it isn't "fixed" back into pay-to-win
later.

---

## 1. Boss-HP & combat scaling for 25–50 players

### 1.1 The core problem: party power is O(N), boss is O(1)

Because every hero acts each turn, **total party damage-per-turn (DPT) scales
linearly with roster size**, but boss HP is a static constant and boss output
does **not** scale with N:

- Boss single-target hit damages **one** hero/turn.
- Boss AoE (`power 0.7`) hits everyone — but healing *also* scales with N
  (more Menders), so per-capita attrition actually *falls* as the raid grows.

Net: **bigger raid ⇒ strictly easier**, and the static HP (5000→12000 across
the season) is tuned for "a modest roster," so 25–50 heroes trivialize it.

Worked numbers (effective DPT ≈ Σ atk × ~1.25 for avg ability power × crit;
variance averages out):

- A mid-season DPS (level 5, starter + 1 uncommon trinket): rr ≈ 80+50+18+20 =
  168 → atk 50 → ~63 effective dmg/turn.
- A plausible **30-player** roster (≈18 dps, 6 tank, 6 healer, early gear):
  team.power (Σ atk) ≈ **~900–1300**, so effective DPT ≈ **1150–1600/turn**.
- Week-1 boss HP 5000 ⇒ **downed in 3–4 turns.** Week-6 finale 12000 ⇒ ~8 turns.
  At 50 players the boss dies before its AoE ever lands twice.

So **HP must scale off the locked roster's power**, and the fight should target
a *turn count*, not a fixed HP.

### 1.2 Recommended HP-scaling formula

Scale boss HP off `team.power` (already computed by `computeTeam()` at lock — it
is exactly Σ of every hero's `power`/atk tile, i.e. raw per-turn atk sum). Target
a fight length in turns, with a per-week difficulty factor.

```
effectiveDPT   ≈ team.power × COMBAT_EFFICIENCY        (≈1.25: avg ability power × crit)
bossHp(week)   = clamp( base + team.power × perPower × weekFactor[week],
                        min, max )
```

with, in `config.raid.hpScaling`:

```js
hpScaling: {
  enabled: true,
  base: 1500,                                   // flat floor so a tiny party still has a fight
  perPower: 12,                                 // ≈ COMBAT_EFFICIENCY(1.25) × targetTurns(≈10)
  weekFactor: [0.85, 0.95, 1.05, 1.20, 1.40, 1.60], // wk1..finale difficulty ramp
  min: 4000,
  max: 60000,
}
```

`perPower = 12` means: at `weekFactor 1.0` the boss has ~`12 × team.power` HP,
which at `effectiveDPT = 1.25 × team.power` dies in ~`12/1.25 ≈ 9.6` turns. The
`weekFactor` ladder then stretches that from ~8 turns (wk1) to ~15 turns
(finale), comfortably inside a raised turnCap (§1.4) with margin for hero deaths.

**Sanity checks (turns-to-kill is invariant to roster size — exactly the goal):**

| scenario | team.power | weekFactor | bossHp | effDPT | turns |
|----------|-----------:|-----------:|-------:|-------:|------:|
| 25 plyr, wk1, early gear   | ~745  | 0.85 | 9,099  | ~931  | ~9.8 |
| 30 plyr, wk1               | ~1290 | 0.85 | 14,658 | ~1613 | ~9.1 |
| 50 plyr, wk1, strong       | ~1500 | 0.85 | 16,800 | ~1875 | ~9.0 |
| 50 plyr, **finale**, geared| ~2500 | 1.60 | 49,500 | ~3125 | ~15.8 |
| 5 plyr (clamp)             | ~150  | 0.85 | 4,000 (min) | ~190 | ~21 → wipe |

The 5-player row shows the floor working: a tiny raid *should* struggle against
a tier boss and likely wipe — which is correct, and motivates recruiting.

### 1.3 Where to compute it

`SEASON_BOSSES[i].hp` becomes the **fallback/base only**. Compute the real HP
from the frozen team at **lock or run** time, where `team.power` is known:

- In `lockRaid()` you already write `computeTeam(frozen)`. After that, derive
  `scaledHp = scaleBossHp(team.power, weekNumber, config)` and persist it on the
  boss record (e.g. `boss.hp` = scaled, keep `boss.baseHp` for audit).
- `runBattle()` then simulates against the scaled `boss.hp` unchanged.

Add a tiny pure helper in `rules/combat.js` (testable, no I/O):

```js
export function scaleBossHp(teamPower, weekNumber, config) {
  const s = config.raid.hpScaling;
  if (!s?.enabled) return null; // caller keeps static boss.hp
  const wf = s.weekFactor[Math.max(0, Math.min(s.weekFactor.length - 1, weekNumber - 1))];
  const hp = s.base + (teamPower || 0) * s.perPower * wf;
  return Math.round(Math.min(s.max, Math.max(s.min, hp)));
}
```

This keeps the engine pure and config-driven (IMPLEMENTATION §H.3) and stays
deterministic — HP is a function of the *frozen* roster, so the seeded battle is
still fully reproducible.

### 1.4 turnCap + enrage (so scaled fights always resolve)

With HP now targeting ~9–16 turns, the current `turnCap: 20` is too tight for
the finale (15 turns + variance + hero deaths dropping DPT can brush 20 and
produce a *false* wipe). Two coupled changes:

- **Raise `turnCap` 20 → 30** to give scaled fights headroom.
- **Add an enrage ramp** so a stalled fight ends in a *deliberate* wipe, never an
  arbitrary cap, and under-geared rosters get punished:

```js
combat: {
  turnCap: 30,
  enrage: { fromTurn: 14, dmgPerTurn: 0.18 }, // boss dmg ×(1 + 0.18*(turn-14)) past turn 14
}
```

In `simulateBattle`, multiply boss `amount` by
`1 + max(0, turn - enrage.fromTurn) * enrage.dmgPerTurn`. Because §1.2 targets
≤~15 turns, enrage bites only the finale and rosters that are genuinely behind —
exactly when you *want* a wipe to be possible.

### 1.5 The log-size blow-up and the fix

Today each turn emits **one `action` event per alive hero** plus the boss action
plus a `turn` marker. For 50 heroes × ~16 scaled turns that is **~800–1000+
events** in a single RTDB `combat/log` node (~150–250 KB), which the website must
download and replay in full. At `msPerEvent 1200` that is 16+ minutes of replay
(clamped by `maxRevealMs` to 8 min, so the tail is never even seen). This balloons
storage, RTDB write size, and client load.

**Recommended fix — per-turn party round-up (Option A).** Collapse the N
per-hero party actions into **one `party_round` event per turn**. The engine
keeps its internal `dmgByUid` map (so the leaderboard + MVP are unchanged — they
are computed from the full detail *before* compaction), but the *log* only
carries the aggregate plus a small "spotlight":

```js
{
  type: 'party_round', n: turn,
  totalDamage: 1243, bossHpAfter: 13557,
  healing: 410, healers: 6,
  spotlight: [ // top-K damagers this turn (config.combat.log.spotlight, e.g. 3)
    { actor, actorName, ability, amount, crit },
    ...
  ],
  others: 22,            // "...and 22 more heroes strike"
  fallen: [ {uid,name}, ... ]
}
```

The boss action stays its own event (it is the dramatic beat). This takes
~51 events/turn → ~3 events/turn (turn marker + party_round + boss action). A
16-turn, 50-player finale becomes **~50 events ≈ 60 s replay** — small node,
fast download, full fight visible under `maxRevealMs`. UI text reads e.g.
*"The raid unleashes 1,243 damage! ⚔️ Topdps CRITs for 142… and 22 more strike."*

Config:

```js
combat: { log: { mode: 'roundup', spotlight: 3 } }
```

**Lower-effort fallback (Option B — spotlight cap, no new event type):** keep
per-hero `action` events but only emit them for a seeded/top-K subset
(`config.combat.log.spotlight`, e.g. 8 heroes: likely top damagers + a rotating
sample) and emit one summary line for the rest each turn. Caps events at
`(spotlight + 1)` per turn without a new schema.

**Do NOT** "sample a representative party and scale results" (a tempting third
option): it breaks per-player damage attribution, which the leaderboard
(`damageByUid` in `db/raid.js`) and MVP loot bonus depend on. Always simulate
the *full* roster; only compact the *log*.

> **Contract flag:** event shapes are a hard contract with the website replay
> player (`_includes/arena.html`). Adding `party_round` requires a coordinated UI
> change. If the UI can't change yet, ship Option B (no new event type) first.

---

## 2. Leveling pacing

### 2.1 The curve, exactly

`threshold(L) = round(100 × 1.35^(L-1))`. EXP/qualifying message = 10 (×1.25–1.6
for subs). Cooldown 30 s ⇒ **hard cap 2 qualifying msgs/min = 120/hr = 360 per
3 h stream** (only if you chat every 30 s the whole time). Realistic engaged
raider during a chat-RPG stream: a qualifying msg every ~60–90 s ⇒ **~120–180
qualifying msgs / 3 h**.

| reach level | cumulative EXP | msgs @10 (non-sub) |
|------------:|---------------:|-------------------:|
| 5  | 663    | 66   |
| 6  | 995    | 100  |
| 7  | 1,443  | 144  |
| 8  | 2,048  | 205  |
| 10 | 3,968  | 397  |
| 12 | 7,468  | 747  |
| 15 | 18,796 | 1,880 |

**Level-up tail:** after the bar fills you must *roll* out, but with `base 0` the
threshold-crossing message can never pop — the chance then climbs (0% → 34% → 68%
→ forced at pressure 4), so a level lands ~**1–3 messages after the bar fills**:
no random early levels, just a short predictable tail. These messages still bank
EXP (the remainder carries), so the tail costs nothing in progress.

### 2.2 What's reachable

**From scratch in one 3 h stream:**

- Realistic (~150 msgs): **~level 6–7.**
- Hardcore (360 msgs cap): **~level 8–9.**
- Tier-3 sub (16 EXP/msg, ~150 msgs ≈ 2,400 EXP): **~level 8.**

**Streams to a milestone (realistic ~150/stream):** level 10 ≈ **3 streams**;
level 15 ≈ **12–14 streams** (≈ a full 6-week season at 2–3 streams/wk). Hardcore
hits 15 in ~5–6 streams.

**"Competitive" level vs the boss ladder.** Define competitive ≈ "your combat
stats meaningfully move the team DPT bar," cross-referenced with gear (gear is
worth a lot: +10 atk for a dps ≈ ~7 levels):

- **Week-1 boss:** competitive ≈ **level 4–6** → reachable in a single stream.
  Low barrier — newcomers contribute on night one. 
- **Week-6 finale:** competitive ≈ **level 10–14** → the season-long grind for
  regulars; casuals still contribute and still get victory loot (communal, on
  theme), they just won't top the leaderboard.

### 2.3 Recommended tweak

The `1.35` growth is steep at the top: level 11 already needs ~270 msgs, level
14 ~495. For a **6-week** window where leveling is the *persistent* progression
(gear resets each season), the late curve risks making week-6 competitiveness
unreachable for anyone but hardcore chatters.

- **Primary: `threshold.growth` 1.35 → 1.30** (recommended, then monitor). Keeps
  the early game nearly identical (L2 100→100, L5 ~571 vs 663) but eases the top
  (L11 threshold 1,379 vs 2,011; reaching L15 ~13.0k vs 18.8k EXP — ~30% fewer
  messages), so dedicated regulars can realistically be finale-ready by week 6.
- **Alternative lever** (if you'd rather not change curve *shape*):
  `perMessage 10 → 12`. Flat +20% to everyone; simpler to reason about but also
  speeds the early game (which is already fast).
- **Leave the level-up commit as-is.** base/k/cap/pressureCap are well-designed;
  `base 0` keeps levels free of lucky early pops and the `pressureCap` guarantee
  correctly prevents anyone getting stuck below a level.
- **Leave the 30 s cooldown as-is.** The 360/stream cap is a healthy anti-flood
  ceiling and is not the binding constraint for realistic chatters.

---

## 3. Loot economy

### 3.1 Live drop cadence

`loot.scheduler` is **`enabled: false`** today — the live drop loop does not run.
That's the #1 loot gap. With `minMs 8m / maxMs 20m` (avg ~14 m), a 3 h stream is
~13 drops. Each drop is a 60 s window; **claims are independent per claimer**
(`rollClaim`, p 0.6, first-ever claim guaranteed), so a single drop can be
claimed by *many* heroes at once — one drop ⇒ ~60% of everyone who `!grab`s gets
a copy.

Implication: live drops are **very generous and floor-inclusive** (good for
25–50 players, everyone gears up), but because only **3 slots** matter and only
the *best* item per slot counts, dupes are inert. **The season power ceiling is
controlled by the item pool's magnitudes and the week's loot table — NOT by drop
frequency.** So: keep drops generous, gate *power* via content.

- **Enable the scheduler** (`enabled: true`).
- Slightly widen interval to curb pure bag-bloat: `minMs 10m / maxMs 22m`
  (avg ~16 m ⇒ ~11 drops/3 h). Optional, low-stakes.

### 3.2 Sub / engagement effect on loot

Engagement currently affects EXP only (combat is raw rr, §0). For loot, subs
should get **speed, not quality** (no pay-to-win item ceiling). Concrete, simple:
give subs **extra independent claim rolls** in the window — same rarity odds,
just better odds of landing *a* copy faster:

```js
loot: { subClaimRerolls: { 0: 0, 1: 1, 2: 1, 3: 2 } }  // by subTier
```

`rollClaim` then rolls `(1 + rerolls)` times; tier-3 P(claim) = 1 − 0.4³ ≈ 0.94
vs 0.60 non-sub. The **rarity** of the dropped item is unchanged and rolled
fairly, so subs gear faster but never get strictly better items.

### 3.3 Gear power across 6 weeks (and a content gap to flag)

Starter gear gives +18 role rating (weapon+armor). Current drop pool magnitudes:

| rarity | tank | healer | dps |
|--------|------|--------|-----|
| uncommon trinket | 18 | 18 | 20 |
| rare    | armor 34 | — | weapon 38 |
| epic    | — | — | weapon 60 |
| legendary | — | trinket 95 | — |

**The pool is thin and role-lopsided:** dps has a clean weapon ladder
(12→38→60), but tank tops out at a rare armor, and healer's only upgrade above
uncommon is a *legendary* trinket (rarity weight 1). Across 6 weeks this gives
dps a smooth ramp while tanks/healers plateau or jackpot. This is **content, not
config** — flag it:

- Build a **per-role × per-slot rarity ladder** in `content/items.js` so each
  role has a meaningful upgrade each week (e.g. every role gets uncommon→rare→epic
  options across weapon/armor/trinket).
- **Week-gate the loot table**: early weeks drop common→rare, late weeks unlock
  epic/legendary (instead of one static `DEFAULT_LOOT_TABLE` all season; rarity
  weights alone gate magnitude today, which works but gives no week *pacing*).
  `setSeason` already carries a `lootTable`; extend `setupRaidWeek`/season to
  swap it per week.

Intended arc: starter (+18) → end of season a dps at ~epic weapon + uncommon
trinket ≈ +86 role rating ≈ +20 atk ≈ ~7 levels of power from gear — which is why
gear must reset each season (§3.4) or the meta calcifies.

### 3.4 Season gear-reset + prestige carry (concrete, simple mechanic)

Today this is explicitly **unimplemented** (`mod/season.js` comment: "Gear reset
/ prestige carryover … is a later phase — flagged, not silently done"). Proposal:

**On `!season start` (a `rolloverSeason` step):**
1. **Archive** each player's `equipped` + `inventory` to a `history/<prevSeason>`
   node (audit / nostalgia), then **reset** `equipped → starterEquipped(role)`,
   `inventory → []`. Newcomers and veterans start the gear race even.
2. **Reset `level/exp/levelPressure` to 1/0/0** (gear *and* level reset keeps the
   meta fresh — spec §5.6 open question §13, resolved toward full reset).
3. **Bank prestige** — the *only* thing that carries:

```js
// player.prestige : integer, +1 per season meeting the clear bar
// criteria: raidsParticipated-this-season >= raid.prestigeClearThreshold (e.g. 3),
//           OR participated in the finale victory.
```

**Prestige's effect — a single capped additive "renown" bonus folded into the
existing `roleRating` sum** (so it flows through combat, snapshots, everything
with zero new plumbing):

```js
// config.rating
renownPerRank: 8,   // role-rating per prestige rank
renownCap: 40,      // hard cap so veterans can't snowball across many seasons
// config.raid
prestigeClearThreshold: 3,
```

```js
// rules/rating.js roleRating(): add one term
const renown = Math.min(config.rating.renownCap,
                        (player.prestige || 0) * config.rating.renownPerRank);
return Math.round(base + level*perLevel + gearBonus(...) + renown);
```

A 3-season veteran gets +24 rr (~2–3 permanent levels of edge) — a real "I've
been here" reward, but the **cap (40)** means a newcomer is at most ~4 levels
behind on day one and closes the gap within a stream or two. Pair with a
cosmetic **title** by rank (1 = Veteran, 2 = Champion, 3 = Ascended) surfaced on
`!char` and the site. Keep prestige earned from **cleared content only** (not
sub tenure) so it stays non-pay-to-win; `subMonths` is already tracked and can
drive a purely *cosmetic* tenure badge if desired.

---

## 4. Concrete `config.js` changes to make now

Small, high-leverage set. (Items marked **+** are new keys.)

| key | old | new | why |
|-----|-----|-----|-----|
| `combat.turnCap` | 20 | **30** | Give HP-scaled fights (~9–16 turns) headroom so the finale doesn't false-wipe at the cap. |
| `combat.enrage` **+** | — | `{ fromTurn: 14, dmgPerTurn: 0.18 }` | Guarantee resolution: stalled / under-geared fights end in a real wipe, not an arbitrary cap. |
| `combat.log` **+** | — | `{ mode: 'roundup', spotlight: 3 }` | Collapse N per-hero events/turn → ~3/turn; kills the 50×20 ≈ 1000-event log blow-up (needs UI contract update). |
| `raid.hpScaling` **+** | — | `{ enabled:true, base:1500, perPower:12, weekFactor:[0.85,0.95,1.05,1.2,1.4,1.6], min:4000, max:60000 }` | Scale boss HP off frozen `team.power` so 25–50 players get a real, ~constant-length fight instead of a 3-turn faceroll. |
| `raid.defaultBossHp` | 6000 | 6000 (now **fallback only**) | Used only when `hpScaling.enabled` is false or team.power is unknown. `SEASON_BOSSES[].hp` likewise become base/fallback. |
| `exp.threshold.growth` | 1.35 | **1.30** | Keep level 10–14 (finale-competitive) attainable for regulars inside a 6-week season; ~30% fewer msgs to L15. Monitor; alt lever = `exp.perMessage 10→12`. |
| `loot.scheduler.enabled` | false | **true** | Actually run the live drop loop — it's off today. |
| `loot.scheduler.minMs / maxMs` | 8m / 20m | **10m / 22m** | Mild widen (~11 drops/3 h) to curb dupe bag-bloat; cadence isn't the power lever (item pool is). Optional. |
| `loot.subClaimRerolls` **+** | — | `{ 0:0, 1:1, 2:1, 3:2 }` | Subs gear *faster* (extra independent claim rolls) without better item *quality* — speed, not pay-to-win. |
| `rating.renownPerRank` **+** | — | `8` | Prestige carry: capped flat role-rating per past-season rank, folded into `roleRating`. |
| `rating.renownCap` **+** | — | `40` | Cap so veterans can't snowball season-over-season and lock out newcomers. |
| `raid.prestigeClearThreshold` **+** | — | `3` | Raid nights participated to earn a prestige rank at season rollover. |

**Non-config (flag, do not silently change):**
- `buildSnapshot()` keeps using raw `roleRating` (no engagement) — confirm this
  is intended (it is, for anti-pay-to-win); update spec §4 text accordingly.
- Adding `party_round` is a **website replay contract** change (`arena.html`);
  coordinate or ship Option B (spotlight cap, no new event type) first.
- Item pool (`content/items.js`) needs a per-role × per-slot rarity ladder +
  week-gated loot tables — content work, tracked separately.
- Implement `rolloverSeason` (archive gear → reset equipped/level → bump
  prestige) in the season flow; today it's an explicit TODO.

### 4.1 Rollout order (lowest risk first)
1. `loot.scheduler.enabled: true` (turns on a built-but-dark feature).
2. `combat.turnCap 30` + `combat.enrage` (safe; only matters at long fights).
3. `raid.hpScaling` + `scaleBossHp()` helper + wire into `lockRaid`/`runBattle`
   (the big one — test with synthetic 25/50-player rosters).
4. `combat.log` round-up (needs UI; Option B fallback if UI lags).
5. `exp.growth 1.30` (monitor week-3/week-6 reachability before/after).
6. Prestige + gear reset at season rollover (before season 2 starts).

---

## Appendix — quick verification hooks

- **Unit-test `scaleBossHp`** with team.power ∈ {150, 745, 1500, 2500} × each
  weekFactor; assert downed turn ∈ [8, 18] against a synthetic roster of matching
  power (reuse `scripts/synthetic-chat.js` / dev-console to build 25/50 rosters).
- **Log size:** assert `Object.keys(combat.log).length` for a 50×16 fight is
  ~< 60 under round-up (vs ~850 today).
- **MVP/leaderboard invariance:** confirm `damageByUid()` totals are identical
  with round-up vs per-hero logging (the engine's internal `dmgByUid` is the
  source of truth, not the emitted events).
- **Level-up tail:** Monte-Carlo `rollLevelUp` confirms a level pops ~1–3 messages
  after the bar fills (forced by `pressureCap`), with no early pops at `base 0`.
</content>
</invoke>
