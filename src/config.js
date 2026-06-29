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
    perMessage: 10, // base EXP per qualifying chat message (before multipliers)
    // Per-user cooldown. Does double duty: blocks offline farming AND
    // flood-grinding (spec §6). Enforced in-memory (single instance) and the
    // anchor is persisted to players/<id>.lastExpAt for audit.
    cooldownMs: 30_000,
    // EXP needed to become *eligible* to pity-roll out of a level.
    // threshold(level) = round(base * growth^(level-1)).
    threshold: { base: 100, growth: 1.35 },
    // Pity roll: once at/over threshold, each qualifying message rolls
    // p = min(base + k * levelPressure, cap) to level up. levelPressure climbs
    // by 1 per non-popping message and resets on level-up. pressureCap forces a
    // pop so it ALWAYS eventually levels (the missing cap the spec left open).
    pity: { base: 0.05, k: 0.02, cap: 0.95, pressureCap: 60 },
  },

  // ── Role rating (spec §4) ────────────────────────────────────────────────
  // role rating = classBase[role] + level*perLevel + equipped gear bonuses for
  // that role; scaled at raid time by the engagement multiplier (§7).
  rating: {
    classBase: { tank: 100, healer: 90, dps: 80 },
    perLevel: 10,
  },

  // ── Engagement multipliers (spec §7) ─────────────────────────────────────
  // Levers grant speed/communal benefit, never a guaranteed win.
  engagement: {
    base: 1.0,
    subTier: { 0: 1.0, 1: 1.25, 2: 1.4, 3: 1.6 }, // Twitch sub tiers 1000/2000/3000 → 1/2/3
    cheerPerHundredBits: 0.0, // reserved (Phase 5); kept 0 so bits don't pay-to-win EXP
    max: 2.0, // hard clamp so no stacking lever runs away
  },

  // ── Loot (spec §5.2) ─────────────────────────────────────────────────────
  loot: {
    // Weighted rarity ladder (genre-standard). Weights, not probabilities —
    // normalized at roll time.
    rarityWeights: { common: 60, uncommon: 25, rare: 10, epic: 4, legendary: 1 },
    // Claim is a WINDOW with independent rolls (inclusive), not first-to-type
    // (spec §5.2): each claimer rolls claimChance. A newcomer's first claim is
    // guaranteed (good first impression, spec §5.5) — handled in the command.
    claimChance: 0.6,
    windowMs: 60_000, // how long an active drop stays claimable
    // Auto drop scheduler while live (Phase 3). Random interval in [min,max].
    scheduler: { enabled: false, minMs: 8 * 60_000, maxMs: 20 * 60_000 },
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
  },

  // Fixed weekly raid-night slot (LOCAL server time). Mods can override per week
  // with !raidnight. dayOfWeek: 0=Sun..6=Sat.
  raidNight: { dayOfWeek: 0, hour: 19, minute: 0 },

  // ── Automated combat engine (spec §5.8 / IMPLEMENTATION §L) ───────────────
  combat: {
    turnCap: 20,
    msPerEvent: 1200, // must match the UI replay player (live.html MS_PER_EVENT)
    variance: 0.2, // ±20% damage/heal variance
    crit: { party: 0.16, boss: 0.12, mult: 1.8, bossMult: 1.7 },
    bossTankTargetChance: 0.6,
    defaultBossAtk: 90,
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

  // ── Site link surfaced by !raid / !char ──────────────────────────────────
  siteUrl: 'https://nikkibreanne.github.io',
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
