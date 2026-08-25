// Central, single-source-of-truth tunables for the game engine.
//
// Everything that controls game balance lives here so it can be rebalanced
// without touching logic (IMPLEMENTATION §H.3: "keep the engine pure and
// config-driven"). The pure `rules/*` modules receive the relevant slice of
// this object as an argument — they never import it — so tests can pass their
// own config and stay deterministic.
//
// NOTE: the numeric values below are the spec's documented defaults. They are
// flagged decisions (spec §13), not silently-invented truths — change freely.

/** @typedef {'tank'|'healer'|'dps'} Role */

export const ROLES = /** @type {const} */ (['tank', 'healer', 'dps']);

export const config = {
  // ── Chat EXP & leveling (spec §5.1) ──────────────────────────────────────
  exp: {
    perMessage: 12, // base EXP per qualifying chat message (before multipliers)
    // Per-user cooldown. Does double duty: blocks offline farming AND
    // flood-grinding (spec §6). Enforced in-memory (single instance) and the
    // anchor is persisted to players/<id>.lastExpAt for audit.
    cooldownMs: 30_000,
    // EXP needed to become *eligible* to roll a level-up out of a level.
    // threshold(level) = round(base * growth^(level-1)). 1.30 keeps a full
    // season's finale level reachable in ~6 weeks of chatting.
    threshold: { base: 100, growth: 1.3 },
    // Level-up commit. EXP first fills to threshold(level) with NO chance to
    // level early; THEN a level-up chance ACCUMULATES per qualifying message
    // until it pops. base 0 ⇒ the message that crosses the threshold can never
    // pop (no lucky single-roll levels); the chance then climbs and is
    // GUARANTEED within pressureCap messages. chance = min(base + k*pressure,
    // cap), where pressure = messages spent eligible-but-not-yet-popped (resets
    // on level-up):
    //   pressure 0 (crossing) → 0%   1 → 34%   2 → 68%   3 → 100% (also forced)
    // So a level lands ~1–3 messages after the bar fills: predictable and earned,
    // never random luck. Tighten the tail by raising k or lowering pressureCap;
    // for strictly deterministic "level the instant the bar fills", set k high
    // and pressureCap 1.
    levelUp: { base: 0, k: 0.34, cap: 1.0, pressureCap: 4 },
  },

  // ── Role rating (spec §4) ────────────────────────────────────────────────
  // role rating = classBase[role] + level*perLevel + equipped gear bonuses for
  // that role; scaled at raid time by the engagement multiplier (§7).
  rating: {
    classBase: { tank: 100, healer: 90, dps: 80 },
    perLevel: 10,
    // Veteran reputation (spec §5.6): renown earned by clearing raids grants a
    // small role-rating bonus that PERSISTS across seasons (gear resets, renown
    // doesn't). renownBonus = min(renown, renownCap) * renownPerPoint.
    renownPerPoint: 2,
    renownCap: 40, // max +80 rating — meaningful for vets, never dominant
    // MATCHED SET (rules/rating.js#setBonus): a percentage of gear rating once
    // all three slots are filled with gear this hero can actually use, tiered by
    // the WEAKEST piece worn. Gives the 25-item-per-slot pyramid a goal beyond
    // "biggest number", and makes an empty trinket cost more than the trinket.
    // Small on purpose — verified against the combat sim to move S1 finale win
    // rate by only a few points at full legendary, which no real roster has.
    setBonusPct: { common: 0.02, uncommon: 0.04, rare: 0.07, epic: 0.10, legendary: 0.15 },
  },

  // ── Engagement multipliers (spec §7) ─────────────────────────────────────
  // Levers grant speed/communal benefit, never a guaranteed win.
  // Applies to BOTH EXP gain and raid COMBAT power (owner decision: sub tier
  // boosts power). Higher tiers = faster growth + a stronger hero. Chat loot
  // grabs are deliberately NOT affected (the loot draw is tier-fair — see loot).
  engagement: {
    base: 1.0,
    subTier: { 0: 1.0, 1: 1.3, 2: 1.55, 3: 1.8 }, // Twitch sub tiers 1000/2000/3000 → 1/2/3 (Prime = 1)
    cheerPerHundredBits: 0.0, // reserved (Phase 5); kept 0 so bits don't pay-to-win EXP
    max: 2.0, // hard clamp so no stacking lever runs away
  },

  // ── Loot (spec §5.2) ─────────────────────────────────────────────────────
  loot: {
    // Chat drops: weighted rarity ladder (rarer = much less likely).
    rarityWeights: { common: 60, uncommon: 25, rare: 10, epic: 4, legendary: 1 },
    // RAID REWARDS roll on a HIGHER-rarity table than chat drops (clearing a raid
    // should feel better than catching a drop — owner request).
    bossRarityWeights: { common: 18, uncommon: 34, rare: 28, epic: 14, legendary: 6 },
    // A cleared raid pays EVERY hero on the roster exactly ONE piece of gear,
    // in their own role. How good it can be is the reward for how the fight went:
    // surviving and taking MVP each raise the rarity FLOOR rather than handing
    // out extra items. One roll each keeps it explainable in a sentence and stops
    // bags filling with duplicates (the old participation + survivor + MVP stack
    // paid a surviving MVP three items a week).
    raidRewardFloors: { survivor: 'uncommon', mvp: 'rare' },
    // BITS → a communal chat drop. `minBits` is the trigger (100 fired far too
    // often); above it the cheer buys a rarity FLOOR, so a big cheer cannot roll
    // a common. Bands are [minBits, floor] ascending — the highest one the cheer
    // clears wins. The floor restricts the ladder and re-rolls on the remaining
    // relative weights, so 5000 bits still reaches legendary, it just can't fall
    // below epic. The drop is still a LOTTERY into general chat: the cheerer
    // gets no edge (owner decision), they buy the item for the community.
    cheer: {
      minBits: 500,
      /** @type {[number, 'common'|'uncommon'|'rare'|'epic'|'legendary'][]} */
      floors: [
        [500, 'common'],
        [1000, 'uncommon'],
        [2500, 'rare'],
        [5000, 'epic'],
        [10000, 'legendary'],
      ],
    },
    // Claim is a LOTTERY over a window (spec §5.2): every !grab in the window
    // ENTERS the viewer; at window close ONE winner is drawn for the ONE item, so
    // a drop never mints duplicates. TIER-FAIR — every entrant has equal odds in
    // the draw (sub tier gives no loot edge; owner decision).
    windowMs: 60_000, // how long a drop stays open for entries before the draw
    // Overlapping drops QUEUE up (FIFO) instead of clobbering each other; each
    // resolves in turn, one windowMs apart. At most maxQueue drops can be lined
    // up at once (the open one + those waiting); drops past that are ignored.
    maxQueue: 10, // ~10 min of back-to-back drops at a 60s window
    // SALVAGE (!salvage): turn gear you can't use into credits. Exists because
    // role-locked loot has a floor problem — a trade needs someone who WANTS the
    // item, and 52 dead pieces were sitting in prod bags with no buyer. Values
    // are deliberately below what the piece is worth to the right hero, so
    // trading it to a raider always beats melting it.
    salvage: { common: 8, uncommon: 20, rare: 50, epic: 120, legendary: 300 },
    // Melting an epic or better by fat-fingering a bag number is unrecoverable,
    // so those need `!salvage <#> confirm`.
    salvageConfirmFrom: 'epic',
    // Auto chat-drop scheduler while live; mod-tunable at runtime via the
    // config/drops/scheduler RTDB path (see !drops command).
    scheduler: { enabled: false, intervalSec: 15 * 60, jitter: 0.3 }, // ~15 min ±30%
  },

  // Pending "tell them next time they chat" notices (src/db/notices.js).
  notices: {
    // Minimum gap between notice lines so a post-raid rush can't burst a dozen
    // messages at once. Anyone skipped gets theirs on their next message.
    minGapMs: 4_000,
  },

  // ── Weekly raid: muster → raid night → automated battle (spec §5.8) ───────
  raid: {
    seasonWeeks: 6, // a season = 6 weekly bosses + a prestige finale (§5.6)
    // PRESTIGE at season rollover (§5.6): renown granted for the weeks a hero
    // actually raided that season, so attendance scales the reward instead of
    // everyone getting the same flat lump. Renown is the ONLY veteran stat —
    // "prestige" is a source of it, not a separate number — and it converts at
    // rating.renownPerPoint, so a full 6-week season (~6 prestige + ~6 clear
    // renown) is about +24 rating and three seasons lands near renownCap.
    prestigePerRaid: 1,
    prestigeMax: 10, // safety bound if a season ever runs long (t1 ran 8 weeks)
    // Roster locks this long before raid night; gear/level after lock don't
    // affect this battle (determinism + fairness, IMPLEMENTATION §L.1).
    lockLeadMs: 15 * 60 * 1000,
    // How long after `startsAt` the battle is considered fully revealed (so the
    // bot can flip the phase to "done"). = events * combat.msPerEvent, bounded.
    maxRevealMs: 8 * 60 * 1000,
    defaultBossHp: 6000, // tuned so a modest roster downs it within the turn cap
    defaultBossAtk: 90,
    // While a raid is in the SIGNUP phase, re-snapshot each mustered hero from
    // their live record on this cadence so leveling / gearing up between muster
    // and lock shows on the site without a manual re-!muster. Coarse on purpose
    // (it never needs to be real-time) and a no-op outside the signup phase.
    rosterRefreshMs: 60_000,
  },

  // Fixed weekly raid-night slot, anchored to an explicit IANA time zone (DST-
  // aware) so it fires at the right wall-clock time no matter the server's TZ.
  // Default: Sundays 8:00 PM America/Los_Angeles. dayOfWeek: 0=Sun..6=Sat.
  // Mods can still trigger a raid early with !raidnight.
  raidNight: { timeZone: 'America/Los_Angeles', dayOfWeek: 0, hour: 20, minute: 0 },

  // ── Automated combat engine (spec §5.8 / IMPLEMENTATION §L) ───────────────
  combat: {
    // Hard cap is only a backstop against a pathological infinite loop — the
    // ENRAGE timer is what actually ends real fights (escalating boss damage
    // breaks any stalemate), so normal play never reaches this. Set high so long
    // back-and-forth fights can fully play out.
    turnCap: 100,
    // After `startTurn`, boss damage is multiplied by perTurnMult^(turn-startTurn):
    // a stalemate always resolves into a real victory or wipe, never a cap cutoff.
    enrage: { startTurn: 12, perTurnMult: 1.18 },
    msPerEvent: 1200, // must match the UI replay player (arena.html MS_PER_EVENT)
    variance: 0.2, // ±20% damage/heal variance
    crit: { party: 0.16, boss: 0.12, mult: 1.8, bossMult: 1.7 },
    bossTankTargetChance: 0.4, // boss still favors the tank, but spreads its hits
    defaultBossAtk: 90,
    // Affix critter "adds": stats are derived from the boss's atk so they scale
    // with the season. They attack the party each round and can be killed.
    adds: { hpFactor: 1.5, atkFactor: 0.35, maxAlive: 6, focusChance: 0.45 },
    // Context-aware AI: how actors weight ability choice by the fight state.
    ai: {
      healAt: 0.6, // healer heals when the lowest ally is below this HP fraction
      healCritAt: 0.3, // …and uses its strongest heal when below this
      dpsPowerBias: 1.6, // dps/tank weight damage abilities by power^bias
      bossAoeBias: 1.0, // boss favors AoE more as more heroes are alive
    },
    // hero combat stats derived from role rating, per role:
    stats: {
      hpBase: 200,
      hpPerRating: { tank: 1.4, healer: 1.0, dps: 0.8 },
      atkPerRating: { tank: 0.18, healer: 0.12, dps: 0.3 },
      healPerRating: { tank: 0, healer: 0.45, dps: 0 },
    },
  },

  // ── Mod stream timer (`!timer`) ──────────────────────────────────────────
  // One shared countdown a mod can set from chat ("brb 10", "raid starts in
  // 5m"). Not a game system — it announces heads-ups and a "time's up" line and
  // owns no state beyond config/timer, so a restart resumes it from `endsAt`.
  timer: {
    minMs: 5_000, // shortest settable timer (a 1s timer is just noise)
    maxMs: 12 * 60 * 60 * 1000, // longest — a typo like "!timer 999" can't camp forever
    // Heads-up announcements, fired as the clock CROSSES each mark (longest
    // first).
    warnAtMs: [5 * 60 * 1000, 60 * 1000],
    // A mark is only used when the timer has at least this much runway BEFORE
    // it — otherwise a 5-minute timer would open by shouting "5 minutes left".
    // Expressed as a lead rather than a ratio on purpose: a ratio scales with
    // the mark, so it quietly swallowed sensible cases (at 1.5× the 5-minute
    // mark needed a 7.5-minute timer, and a 6-minute one got no warning).
    warnMinLeadMs: 30_000,
    // If the bot was down when a timer expired, announcing "time's up" minutes
    // late is worse than silence: past this much overdue it's cleared quietly.
    graceMs: 2 * 60 * 1000,
    tickMs: 1_000, // countdown resolution (in-memory read; hits RTDB only on fire)
    maxLabelLen: 60,
  },

  // ── Reminders (`!reminder`) ──────────────────────────────────────────────
  // Scheduled chat nudges — the wallpaper check, Ghosty's meals, hydration. The
  // SCHEDULES are data in RTDB (config/reminders/<id>, seeded from
  // src/content/reminders.js); these are only the engine-wide bounds.
  reminders: {
    tickMs: 20_000, // how often schedules are evaluated — minute-accurate is plenty
    // A daily slot only fires within this long after its wall-clock time, so a
    // bot that boots at noon never announces the 08:00 one.
    dailyGraceMs: 5 * 60_000,
    // How late an `afterLive` reminder may still be announced. Past this the
    // session is marked handled and nothing is said (the bot booted mid-stream).
    afterLiveWindowMs: 2 * 60 * 60_000,
    defaultTimeZone: 'America/Los_Angeles', // when a daily reminder names none
    maxTextLen: 200,
  },

  // ── Live gate (spec §5.1) ────────────────────────────────────────────────
  liveGate: {
    pollIntervalMs: 45_000, // Helix poll fallback cadence (30–60s)
    defaultExpMode: 'auto', // on | off | auto  (auto = follow live status)
  },

  // ── !clip ────────────────────────────────────────────────────────────────
  clip: {
    // Which of !clip's three outputs are produced on a BRAND-NEW database. Any
    // combination of: horizontal (16:9 local file) · vertical (9:16 local file) ·
    // twitch (public clip link). 'local', 'all' and 'off' are shorthands.
    //
    // Default is the two local files and NO Twitch clip: a Twitch clip is capped
    // at your stream resolution, so it can never be the high-quality keepsake —
    // which is the entire point of the command.
    //
    // This seeds config/clipMode once. After that RTDB is the ONLY source and mods
    // change it live with `!clipmode` — same as defaultExpMode above. Editing this
    // value does not move an existing deployment.
    defaultMode: 'horizontal,vertical',
  },

  // ── Single-instance lease (IMPLEMENTATION §E/§J) ─────────────────────────
  lock: {
    heartbeatMs: 15_000,
    // A lease older than this is considered abandoned (crashed instance) and
    // may be taken over. Must be comfortably > heartbeatMs.
    staleMs: 60_000,
  },

  // ── OKRAMARKET points economy (viewer wagering, spec §5.2 extension) ────────
  // credits are the wagering currency (bot-owned ledger; NOT the RPG EXP/loot
  // economy). Balances start with a grubstake; a daily allowance keeps everyone in
  // the game. Markets pay out parimutuel (winners split the pool, no rake).
  economy: {
    grubstake: 500, // starting balance the first time a viewer touches their wallet
    minBet: 1, // smallest wager
    daily: { amount: 200, cooldownMs: 20 * 60 * 60 * 1000 }, // ~once/day claim
    maxOpenMarkets: 8, // how many OKRAMARKET predictions can run concurrently
  },

  // ── Respec (!respec): change class, and therefore role ────────────────────
  // Class was permanent, so a season short on healers had no way to fix itself —
  // the role-readiness thresholds were a diagnosis with no treatment. Costs
  // credits (≈2.5 daily claims) so it's a real decision, and re-rolls starter
  // gear for the new role since the old role's gear no longer works.
  respec: { cost: 500 },

  // ── Season enlistment nudge ───────────────────────────────────────────────
  // `!muster` enlists for a WHOLE season (§5.3), so this is not a weekly
  // reminder — it's aimed at people who have a hero and never opted in at all.
  // Rare on purpose: the streamer asked for infrequent, and viewers are usually
  // not around when the automated battle actually runs.
  musterNudge: {
    enabled: true,
    minGapMs: 3 * 60 * 60 * 1000, // at most once every ~3h of live time
    minUnenlisted: 2, // don't nag on behalf of one person
  },

  // ── Site link surfaced by !muster / !char ──────────────────────────────────
  siteUrl: 'https://okrafans.com',
};

/**
 * EXP gate (spec §5.1). `expMode` is a mod-controlled override over the auto
 * live signal.
 * @param {{expMode?: string, live?: boolean}} cfg
 */
export function shouldGrantExp(cfg) {
  if (cfg?.expMode === 'on') return true; // force on (e.g. offline watch party)
  if (cfg?.expMode === 'off') return false; // hard off
  return Boolean(cfg?.live); // "auto" = follow live status
}
