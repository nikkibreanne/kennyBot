# Abilities backlog — advanced mechanics & the minimal engine change each needs

Context: the current engine (`src/rules/combat.js`) supports exactly three ability
`kind`s — `damage` (single target), `heal` (lowest ally), `aoe` (whole party) —
each described by `{ name, kind, power, cooldown }`. Damage = `round(atk * power *
variance)` with a flat ±20% variance and a ~16% ×1.8 party crit; healers heal the
single lowest-HP ally; cooldowns tick once per round. Heroes have **no** mechanic
beyond "pick an ability and apply it once." The event log is an append-only array
of typed objects the website replays (`_includes/live.html`); each combat event
already carries a human `text` string plus structured fields (`actor`, `target`,
`amount`, `crit`, `*HpAfter`). Anything new has to (a) be expressible as one or
more `kind` values, (b) stay a **pure function** of `(roster, boss, seed)`, and
(c) emit event objects the replay player can render without a schema rewrite.

Each item below lists the player-facing mechanic, the **minimal** engine change,
the new/changed `kind` or ability field, and how the event log/UI represents it.
Ordered roughly by value-to-effort.

Two cross-cutting prerequisites most of these share (build once, reuse):

- **Per-hero status store.** A `status[uid] = { dots:[], shield:0, taunt:0, … }`
  map alongside `hp`, advanced at a fixed point each round (recommend: start of
  the round, before the party acts, so the UI shows ticks landing first). Pure
  and seed-free — no engine-purity risk.
- **A neutral `effect` event type** (or reuse `type:'action'` with new `kind`s)
  so the replay player has a place to render non-attack happenings (tick, shield
  absorb, taunt, cleanse). The UI already switches on `kind`; adding cases is
  additive, old logs still replay.

---

## TOP 3 (highest value, lowest engine risk)

### 1. Damage-over-time (DoT) — *Arcanist/Ranger/boss identity*
**Mechanic:** an ability applies a bleed/poison that deals damage for N rounds
instead of (or on top of) an up-front hit. Gives the Ranger a "Bramble Snare"
and the Arcanist a "Withering Spores"; lets bosses pressure the raid between
big hits.

**Minimal engine change:** add `kind:'dot'` and two ability fields
`{ ticks:number, tickPower:number }`. On use, push a record onto the target's
`status.dots` (boss for hero DoTs; a hero for boss DoTs). At the round-advance
point, for each active dot apply `round(sourceAtk * tickPower * variance)`,
decrement `ticks`, drop at 0. No crit on ticks (keeps it low-variance, distinct
feel). ~20 lines; reuses the existing damage math and `dmgByUid` accounting so
DoT damage still counts toward MVP.

**Event/UI:** emit `{ type:'action', kind:'dot-apply', … text:'🩸 … afflicts …' }`
on cast and `{ type:'action', kind:'dot-tick', actor, target, amount, bossHpAfter
}` each tick. UI renders ticks as small floating numbers; a stack badge on the
target's portrait shows remaining `ticks`. Fully back-compatible — logs without
dots are unaffected.

### 2. Shields / absorbs — *Guardian & Mender identity, the counter to AoE*
**Mechanic:** a Guardian "Bark Ward" or Mender "Greenhouse Glass" grants an ally
(or self) a temporary absorb that soaks the next chunk of damage. This is the
clean answer to the AoE-heavy boss archetypes (caster/swarmer/tyrant) that
currently can only be answered with raw healing.

**Minimal engine change:** add `kind:'shield'` with `power` scaling the caster's
`heal` (Mender) or `atk`/a new `mit` stat (Guardian) into `status[uid].shield`.
In **every** damage-application path (single-target, aoe, future dot), subtract
from `shield` before `hp`: `const s=Math.min(shield,amount); shield-=s; amount-=s`.
One helper `applyDamage(uid, amount)` that both hero-soak and boss-hit call —
~15 lines, and it *centralizes* damage application (a nice cleanup). Decide a
duration (rounds) or "until consumed"; rounds is simpler and ticks with the
status store.

**Event/UI:** `{ kind:'shield-apply', target, amount:absorbValue }` on cast; on a
hit that's partly absorbed, include `absorbed:n` on the existing damage event so
the UI can show "(-40, 25 absorbed)". Portrait gets a shield overlay bar. Old
logs: `absorbed` simply absent.

### 3. Taunt / threat redirect — *makes the Guardian's soak a real decision*
**Mechanic:** a Guardian "Rooted Stance" forces the boss's single-target attacks
onto the tank for N rounds (raising the current ~60% to ~100%), protecting
squishies during a dangerous window. Today tank targeting is a fixed 60% coin
flip with no agency.

**Minimal engine change:** add `kind:'taunt'` (no `power`; uses `cooldown` + a
`duration`). On use set `status[tankUid].taunt = duration`. In the boss
single-target branch, if any alive hero has `taunt>0`, target that hero instead
of rolling `bossTankTargetChance`. Decrement in the status advance. ~8 lines,
touches only the boss-target selection line.

**Event/UI:** `{ kind:'taunt', actor:tank, text:'🛡️ … draws the boss’s ire!' }`
and a "taunt" icon on the tank for the duration; boss hits during the window
already render normally (just always aimed at the tank). Trivial to display.

---

## ALSO VALUABLE (more engine surface)

### 4. Multi-target / smart heal — *Mender scaling into AoE fights*
**Mechanic:** a "Wildflower Bloom" that heals the **N lowest** allies, or the
whole party for a reduced amount — the direct counter to swarm/caster AoE that
out-paces single-target healing.

**Minimal engine change:** add `kind:'heal-aoe'` (party heal, like `aoe` but
restorative) and/or `kind:'heal-smart'` with a `targets:N` field. Reuse the
existing lowest-ally sort to pick the N lowest. ~12 lines; the healer-selection
weighting in the new hero AI needs a rule ("prefer party heal when ≥K allies
hurt") — coordinate with whoever builds the weighted AI.

**Event/UI:** `kind:'heal-aoe'` emits one event with a `targets:[{uid,amount,
hpAfter}]` array (or N separate `heal` events for zero UI change). Prefer N
separate events for the first cut — no replay-player change at all.

### 5. Cleanse / dispel — *pairs with DoT (#1); answer to debuffs*
**Mechanic:** a Mender "Compost Cleanse" removes DoTs/debuffs from the lowest or
most-stacked ally. Only meaningful once DoTs (#1) exist, so schedule after it.

**Minimal engine change:** add `kind:'cleanse'` that clears `status[uid].dots`
(and any future debuff fields) on the chosen ally. ~6 lines **on top of** the
status store. Selection: target the ally with the most stacks (new sort key).

**Event/UI:** `{ kind:'cleanse', target, removed:n, text:'🧺 … wipes away the
blight' }`; UI just clears the stack badge. Back-compatible.

### 6. Interrupt — *counterplay to the boss's signature cooldown move*
**Mechanic:** a Ranger "Pinning Shot" or Berserker "Stagger" that, if it lands
the round the boss's big cooldown ability is about to fire, pushes that ability's
cooldown back (or cancels the cast) — turning the boss's telegraphed slam into a
real "interrupt it!" moment.

**Minimal engine change:** this is the **biggest** lift because the boss picks
its ability *after* the party acts and has no concept of "casting/telegraph." Two
sub-changes: (a) a one-round telegraph — at the **end** of a round the boss
announces next round's ability into `boss.casting`; (b) `kind:'interrupt'` heroes
can target `boss.casting`, and on success bump that ability's cooldown / clear
`casting`. ~30–40 lines and it changes the round structure (a telegraph event +
a resolve event), so the replay player needs a new "casting" banner state. Highest
risk to the pure/deterministic loop — do last, behind tests.

**Event/UI:** `{ type:'cast', actor:'boss', ability, text:'⚠️ … is charging
Blightfall!' }` at end of round, then either the normal action next round or
`{ kind:'interrupt', actor, target:'boss', text:'⛔ … interrupts Blightfall!' }`.
UI shows a boss cast bar — the one genuinely new UI component on this list.

---

## Engine-AI note to carry into the weighted-selection work
The boss currently selects its ability **randomly** among those off cooldown;
only the *hero* AI is becoming power-weighted. The boss ability library
(`BOSS_ABILITY_SETS`) relies on that randomness — its AoEs are deliberately
**lower power** than the set's single-target basic (per-target they should hurt
less), and cooldown paces them. If a future weighted boss AI is added, a
strictly-lower-power AoE would never be picked. Fix at that time with either an
explicit per-ability `weight`, or score by **expected total damage**
(`power × expectedTargets`, where AoE's `expectedTargets` = alive party size) so
party-wide moves compete fairly with focused hits. The same `weight` field would
also let DoTs/shields/taunts (which have no comparable `power`) participate in a
weighted picker — so adding an optional `weight?:number` to the Ability shape is
a cheap, forward-compatible hook to land alongside mechanic #1.
