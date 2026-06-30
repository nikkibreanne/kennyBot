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
    // BOSS-battle rewards roll on a HIGHER-rarity table (clearing a raid should
    // feel better than a chat drop — owner request).
    bossRarityWeights: { common: 18, uncommon: 34, rare: 28, epic: 14, legendary: 6 },
    // Claim is a LOTTERY over a window (spec §5.2): every !grab in the window
    // ENTERS the viewer; at window close ONE winner is drawn for the ONE item, so
    // a drop never mints duplicates. TIER-FAIR — every entrant has equal odds in
    // the draw (sub tier gives no loot edge; owner decision).
    windowMs: 60_000, // how long a drop stays open for entries before the draw
    // Overlapping drops QUEUE up (FIFO) instead of clobbering each other; each
    // resolves in turn, one windowMs apart. At most maxQueue drops can be lined
    // up at once (the open one + those waiting); drops past that are ignored.
    maxQueue: 10, // ~10 min of back-to-back drops at a 60s window
    // Auto chat-drop scheduler while live; mod-tunable at runtime via the
    // config/drops/scheduler RTDB path (see !drops command).
    scheduler: { enabled: false, intervalSec: 15 * 60, jitter: 0.3 }, // ~15 min ±30%
  },

  // ── Weekly raid: muster → raid night → automated battle (spec §5.8) ───────
  raid: {
    seasonWeeks: 6, // a season = 6 weekly bosses + a prestige finale (§5.6)
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

  // ── Live gate (spec §5.1) ────────────────────────────────────────────────
  liveGate: {
    pollIntervalMs: 45_000, // Helix poll fallback cadence (30–60s)
    defaultExpMode: 'auto', // on | off | auto  (auto = follow live status)
  },

  // ── Single-instance lease (IMPLEMENTATION §E/§J) ─────────────────────────
  lock: {
    heartbeatMs: 15_000,
    // A lease older than this is considered abandoned (crashed instance) and
    // may be taken over. Must be comfortably > heartbeatMs.
    staleMs: 60_000,
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
