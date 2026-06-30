# kennyBot Raid Game — Design & Implementation Spec (v2)

> **Supersedes v1** (`kennyBot-pokemon-raid-spec.md`). v1 used Pokémon as the
> creatures; this version drops that entirely in favor of an **original
> WoW-genre RPG** to avoid the Pokémon/Nintendo IP exposure. The mechanics that
> tested well (catching→loot, chat-EXP→level-up growth, weekly community raid,
> seasons) are preserved and adapted.
>
> **Purpose.** Handoff spec for a Claude Code agent extending
> [`kennyBot`](https://github.com/nikkibreanne/kennyBot) (a tmi.js Twitch chat
> bot for the `nikkibreanne` channel) into the game described below. Open design
> decisions are in **§13** — flag them, don't silently invent answers.
>
> **Companion docs:**
> - `docs/IMPLEMENTATION.md` (this repo) — backend/bot build, Firebase Admin,
>   EventSub-over-WebSocket, command registry, containerized deployment
>   (Docker → GHCR), secrets & token refresh, combat engine, and the POC plan.
> - `docs/raid-game-ui.md` (in the **nikkibreanne.github.io** repo) — the
>   read-only website layer: muster page, live battle replay player, and the
>   Firebase client read pattern (extends the proven OKRAMARKET poll).

---

## 1. Vision & product goal

A chat-driven RPG whose mechanics all reward **active engagement with the
streamer** — chatting, subscribing, sub tenure, cheering bits, and bringing in
new viewers.

Each viewer creates **one persistent character** of a chosen **class** (which
fixes their raid **role**: tank / healer / DPS). They **level up** by being
engaged (mainly by chatting **while the stream is live**), collect **loot** that
drops in chat and from raids, and **equip** it to grow their character's power.
Every week the whole community fields its characters against a single shared
**raid boss** — resolved **asynchronously on the website** on a weekly cadence.
The **chat is the live, interactive growth layer**.

## 2. Theme & IP guardrails

- Theme is **generic high-fantasy MMO** (raids, loot, classes, levels). Game
  *mechanics* and *genre archetypes* are not copyrightable — only specific
  expression is, so this lane is safe in a way the Pokémon version was not.
- **Do not** use Blizzard/WoW-specific expression: no "World of Warcraft" name,
  no Azeroth/zone names, no named WoW bosses (e.g. Lich King), no WoW class
  names used verbatim if distinctive, no WoW art/logos/UI.
- **Do** use original or generic naming for classes, items, and bosses. Invent
  the flavor; reuse the grammar.
- All item/class/boss data is **your own** (a content table you define) — there
  is no external data dependency like the prior PokéAPI requirement.

## 3. Core loops

1. **In-chat growth loop (live, interactive).** While live, chatting earns EXP
   toward a climbing chance to **level up**; **loot drops** appear in chat to
   claim and equip. Subs/bits/channel points accelerate growth.
2. **Weekly community raid (muster → automated raid-night battle).** One shared
   boss per week. Players grow/gear during a **muster** phase and sign up; on
   **raid night** the roster fights the boss in an automated, turn-based battle
   shown live on the website. Composition still matters (need enough
   tanks/healers/DPS). See **§5.8** for the combat model.
3. **Raid tier / season arc (multi-week).** A season = a raid tier that rotates
   the loot table and boss progression, resets gear so newcomers aren't
   permanently behind, and awards veterans a prestige title.

## 4. Characters, classes & roles

- Each viewer has **one persistent character** (`!create <class>`).
- **Class fixes role.** Because each player *is* a single role, the **community
  must self-balance** — enough tanks, enough healers, enough DPS among everyone
  who participates that week. This is a deliberate emergent social dynamic the
  streamer can rally around ("we're short on healers, someone roll one").
- **Placeholder class set** (final list is a human decision — see §13). Original
  names, trinity-covering:
  - **Guardian** — tank (high mitigation/HP rating)
  - **Mender** — healer (high healing throughput rating)
  - **Berserker** — melee DPS
  - **Arcanist** — ranged magic DPS
  - **Ranger** — ranged physical DPS
- A character's **role rating** = base (class + level) + equipped gear bonuses,
  scaled at raid time by the week's **engagement multiplier** (§7).

## 5. Mechanics

### 5.1 Chat EXP & leveling (the chatting incentive) — with LIVE GATING

This is the centerpiece, and it carries a hard requirement: **EXP must only
accrue when intended** (default: only while the stream is live), so viewers
can't grind by chatting to an empty offline channel.

**Leveling model** (fixed threshold + accumulating level-up chance — **no random
early levels**):
- Each qualifying chat message grants EXP, **rate-limited per user** (see §6).
- EXP first fills to a level's threshold with **no chance to level early**. Once
  the bar is full, each *further* qualifying message rolls a **climbing
  probability** to level up: `p = base + k * levelPressure`, where `levelPressure`
  accumulates per message past the threshold until it triggers (a cap guarantees
  it eventually pops). Resets on level-up. With `base 0` the threshold-crossing
  message can never pop, so a level lands a few **predictable** messages after the
  bar fills — earned, never a lucky early jackpot.
- Subs/bits apply an **EXP multiplier** (§7).

**Live detection** (tmi.js does NOT expose live status — use the Twitch API):
- **Preferred — EventSub `stream.online` / `stream.offline`.** Subscribe once;
  on `stream.online` set `config/live = true` in Firebase, on `stream.offline`
  set it `false`. Push-based, near-instant, no polling. For `stream.online`,
  check the event `type == "live"` to exclude reruns/premieres/watch-parties.
- **Fallback — poll Helix.** `GET /helix/streams?user_login=nikkibreanne` every
  30–60s; live if the response has data with `type == "live"`. Simpler, slightly
  laggier.

**EXP gate with manual override.** Maintain two config flags: `live` (auto, from
above) and `expMode` (`on` / `off` / `auto`) controlled by a mod command.

```js
function shouldGrantExp(config) {
  if (config.expMode === "on")  return true;   // force on (e.g. offline watch party)
  if (config.expMode === "off") return false;  // hard off
  return config.live;                          // "auto" = follow live status
}

function onChatMessage(user, config) {
  if (!shouldGrantExp(config)) return;
  if (Date.now() - user.lastExpAt < EXP_COOLDOWN_MS) return; // blocks flood + offline farm
  grantExp(user, EXP_PER_MSG * engagementMult(user));
  user.lastExpAt = Date.now();
  maybeLevelUp(user);                          // the level-up roll
}
```

- Mod commands: `!exp on|off|auto|status` flip `config.expMode`. Default `auto`.
- The per-user cooldown does double duty: blocks **offline farming** and
  **spam-flooding** to grind levels.

### 5.2 Loot drops & equipment

- **Loot drops in chat** at semi-random intervals while live (and as raid
  rewards). Viewers claim with `!loot` / `!grab` within a time window.
- Claiming is a **window with independent rolls** (inclusive), not first-to-type
  — same rationale as before (don't reward reflexes/bots; don't exclude
  casuals). Higher-rarity drops may be contested/lottery (§13).
- **Rarity ladder** (genre-standard): common → uncommon → rare → epic →
  legendary, driving stat magnitude.
- **Equipment slots** (proposal — adjust as desired): `weapon`, `armor`,
  `trinket`. Each item has a slot, rarity, stat bonuses, and a **role affinity**
  (gear that boosts tank/heal/dps ratings). Equipping raises the character's
  role rating → raid contribution.
- Items live in an **item catalog** you define per raid tier (§5.4 / §5.5).

### 5.3 The weekly community raid (many-vs-1)

- **One shared raid boss per week**, with:
  - a large **HP pool**
  - **role thresholds**: minimum collective tank rating (or the community
    "wipes"), minimum collective healing (to outlast the boss's AoE), and an
    **enrage timer** requiring enough collective DPS to beat by week's end
  - an optional **affix** (themed weekly modifier) that buffs/penalizes certain
    classes or damage types
- **Every participating character contributes** its role rating, scaled by the
  week's engagement multiplier (§7). Thresholds become **team-readiness** signals
  shown during muster.
- **Resolution is the automated raid-night battle (§5.8)** — not a passive
  weekly tally. (An earlier draft resolved by aggregating total damage ≥ boss HP
  at week close; that was superseded by §13.2's decision.) The website shows
  muster/readiness during the week, then the live battle + downed/wiped result on
  raid night.
- The required-composition design means a lopsided community (all DPS, no
  healers) will struggle — the intended social pressure to recruit/diversify.

### 5.4 Engagement levers (sub, bits, channel points)

Design rule: levers grant **depth, growth speed, and communal benefit — never a
guaranteed win** (avoid pay-to-win resentment and gambling optics).

- **Subscribing:** EXP multiplier; extra loot rolls; a weekly sub-only drop.
  **Sub tenure** (3/6/12 months) unlocks prestige cosmetics / titles — rewards
  sub *length*.
- **Bits/cheers:** trigger a **channel-wide loot drop** everyone can claim
  (spending becomes a gift to the whole chat) and/or a temporary EXP boost.
- **Channel points:** spend on extra loot rolls, level-pressure boosts, or to
  revive a fallen raid contributor. Channel points accrue from watch time, tying
  passive viewing to the game.
- **Audience growth:** a **Twitch raid-in or new sub triggers a communal
  legendary drop** for the whole chat — existing viewers benefit from (and
  therefore welcome) new arrivals.

> **Event source note:** tmi.js emits `subscription`, `resub`, `subgift`,
> `cheer` (bits), and `raided` directly — handle those in kennyBot.
> **Channel-point custom-reward redemptions** and **stream online/offline**
> require **Twitch EventSub** (scopes: `channel:read:redemptions`; stream events
> need the app subscription). Live detection (§5.1) is the first EventSub need;
> channel points can come later (§12).

### 5.5 New player onboarding

- First-time `!create <class>` makes the character and grants a **starter gear
  set** appropriate to the class. A newcomer's **first loot claim should
  succeed** (good first impression).

### 5.6 Raid tiers / seasons

- A season = a **raid tier**: a themed multi-week arc (≈6–8 weekly bosses) with
  its own **loot table** and boss progression, culminating in a finale.
- Season transition: award veterans a **prestige title** (the "cleared on time"
  equivalent); **reset gear** so newcomers start fresh and the meta doesn't
  calcify (character + level may carry or partially reset — see §13).
- Season launch is the natural **invite-a-friend growth moment**; consider a
  referral bonus active at season start.

### 5.7 Optional separate mode: solo challenge

Lower priority, isolated domain. A 1v1 "your character vs a scaling boss"
challenge for *different* rewards. Build only after the core loop ships.

### 5.8 Combat model & the live battle (active, automated resolution)

> **Resolves §13.2 (passive vs active) → ACTIVE, AUTOMATED, turn-based.** The
> weekly raid is no longer a silent tally; it plays out as an automated D&D/MMO-
> style battle the community watches on the website. Players don't issue
> per-turn commands — the engine drives it — so it stays async-friendly and
> fair, but it *resolves visibly* as a live (or replayable) battle.

**Two-phase weekly cadence:**
1. **Muster / prep (most of the week).** Chat to grow your hero (EXP/levels),
   claim and equip loot, and **sign up** for the raid (`!raid`). The website
   shows a **countdown to raid night**, the **roster** (who's in, their gear),
   and **team readiness** (aggregate power/defense/healing vs. boss thresholds).
2. **Raid night (scheduled time).** Roster locks; the engine runs the battle;
   the website renders it live as a combat log; result + loot distribution post
   at the end. Latecomers and absentees can watch the **replay**.

**The battle engine (D&D/MMO grammar):**
- **Initiative order** each round (party then boss, or stat+RNG ordering).
- On its turn each actor (party member or boss) **randomly selects an available
  ability** subject to **per-ability turn cooldowns**; **seeded RNG** drives
  hit/miss/crit, damage variance, and target choice.
- **Role-aware behavior:** tanks mitigate/taunt, healers heal the lowest ally,
  DPS focus the boss; the boss alternates single-target and AoE (gated by the
  enrage/affix design in §5.3). Continue until **boss HP 0 (victory)** or the
  **party is wiped / a turn cap is hit (defeat)**.
- Each hero's combat stats (HP / attack / healing) derive from **role rating =
  class + level + equipped gear**, engagement-scaled (§7). The §5.3 thresholds
  become **team-readiness signals** during muster.

**Determinism = the whole design's backbone.** A battle is a **pure function of
(roster snapshot at lock, boss definition, seed)**. Seeding makes it
**reproducible, unit-testable, auditable, and replayable** — and cheat-proof,
since the authoritative engine runs server-side and the client only reads.

**Output = an append-only, ordered combat-event log.** The engine emits a typed
event stream (`start` / `turn` / `action` / `end`); the website is a **replay
player** that reveals events on a timer synced to the battle start, so everyone
sees the same moment, latecomers catch up, and finished battles re-watch. This
is the well-trodden "battle protocol + replay" pattern (see
`IMPLEMENTATION.md §L` for the engine + event schema, and the UI doc for the
player). **Recommended execution: precompute the full battle at lock and reveal
it on a paced timer** (robust, replay-native); a live per-turn tick loop is an
alternative with the *same* event-log contract.

## 6. Anti-abuse & fairness

- **Live gating + EXP cooldown** (§5.1): no offline farming, no flood-grinding.
- **Idempotent loot claims**: never double-award on duplicate/echoed messages.
- **Per-user cooldowns** on commands.
- **Gate meaningful rewards** behind account age / watch time / sub status to
  defeat alt-account farming.
- **Bot/spam resistance** on high-value drops: randomized timing + the claim
  *window*; consider a lightweight check on legendaries.
- **No real-money random-advantage**: don't let bits directly buy a private
  random-outcome advantage with external value. Communal bit-triggered drops
  (shared benefit) are fine.

## 7. Security (Firebase rules) — important

The existing `nikkibreanne.github.io` OKRAMARKET poll uses **wide-open** RTDB
rules. **Do NOT copy that for game state.** Characters, levels, gear, and raid
standings will be cheated if writable from the client.

- **All authoritative writes go through the backend** (kennyBot / EventSub
  listener) via the **Firebase Admin SDK** (service account).
- The **website client is read-only** for game state. Viewer-initiated writes
  (e.g. equipping gear from the site) go through a bot-validated intent path or a
  small Cloud Function — never direct client writes to authoritative state.
- Lock RTDB rules accordingly.

## 8. Architecture

```
            ┌──────────────────────────────────────────────────┐
            │                 Firebase RTDB                     │
            │  (authoritative game state; bot-write/client-read) │
            └──────────────────────────────────────────────────┘
                 ▲ write (Admin SDK)              ▲ read-only
                 │                                │
   ┌─────────────┴───────────┐        ┌───────────┴────────────────────┐
   │ kennyBot (Node, tmi.js)  │        │ Website (nikkibreanne.github.io) │
   │ - loot drops + !grab      │        │ - async weekly raid UI (HP bar)  │
   │ - chat EXP + level-up rolls│        │ - character / gear management    │
   │ - !create / class / equip  │        │ - leaderboards                   │
   │ - sub/bits/raid events      │        └──────────────────────────────────┘
   └─────────────┬───────────┘
                 │ EventSub (same Node process or sibling)
                 ▼
   ┌─────────────────────────────────────────────┐
   │ Twitch EventSub                              │
   │ - stream.online / stream.offline (LIVE gate) │
   │ - channel point redemptions (later)          │
   └─────────────────────────────────────────────┘
```

- **kennyBot (tmi.js):** loot drops, claims, chat-EXP, level-up rolls,
  `!create`/class/equip, raid contribution commands; consumes tmi.js
  `subscription`/`cheer`/`raided` for multipliers & communal drops. Writes via
  Admin SDK.
- **EventSub listener** (add `@twurple/eventsub-ws` or raw EventSub WebSocket):
  `stream.online`/`stream.offline` first (drives the live gate), channel points
  later. Can live in the same Node process.
- **Firebase RTDB:** source of truth.
- **Website (Jekyll/GitHub Pages):** async weekly raid visualization, character
  & gear management, leaderboards — reads Firebase. (OKRAMARKET poll already
  proves the client-side Firebase render pattern.)

## 9. Firebase data model (sketch)

> Extended by the combat model — see `IMPLEMENTATION.md §L.3` for the full
> `config/raid`, `signups`, `team`, and `combat` log shapes. The `config` and
> `raids` blocks below reflect the active-battle model (§5.8).

```jsonc
{
  "config": {
    "live": false,                 // set by EventSub stream.online/offline
    "expMode": "auto",             // on | off | auto (mod-controlled)
    "season": {
      "current": { "id": "t1", "name": "Tier 1", "startsAt": 0, "endsAt": 0,
                   "lootTable": ["itm_001", "itm_002"] }
    },
    "raid": {                      // active-raid pointer + schedule (drives the UI)
      "seasonId": "t1", "weekId": "w1",
      "phase": "signup",           // signup | locked | live | done
      "locksAt": 0, "startsAt": 0  // signups close / raid-night battle time
    }
  },

  "drops": {
    "active": { "itemId": "itm_017", "rarity": "epic", "expiresAt": 0 }
  },

  "items": {                       // your own catalog (no external dependency)
    "itm_017": {
      "name": "Emberforged Blade",
      "slot": "weapon",
      "rarity": "epic",
      "role": "dps",
      "bonuses": { "dps": 45 }
    }
  },

  "players": {
    "<twitchUserId>": {
      "displayName": "viewer",
      "createdAt": 0,
      "class": "Guardian",
      "role": "tank",
      "level": 14,
      "exp": 5200,
      "levelPressure": 0.0,
      "subTier": 0,
      "subMonths": 0,
      "lastExpAt": 0,              // rate-limit anchor
      "equipped": { "weapon": "itm_009", "armor": "itm_022", "trinket": null },
      "inventory": ["itm_017", "itm_031"],
      "stats": { "messages": 0, "lootClaimed": 0, "raidsParticipated": 0 }
    }
  },

  "bosses": {
    "<seasonId>": {
      "<weekId>": {
        "name": "The Ashen Warden",
        "hp": 1000000,
        "thresholds": { "tank": 500, "healer": 300, "dps": 800 },
        "affix": "inferno",
        "startsAt": 0,
        "endsAt": 0,
        "status": "active"         // active | downed | wiped
      }
    }
  },

  "raids": {                       // loadout snapshots + team aggregate + battle log
    "<seasonId>": {                // full shapes: IMPLEMENTATION.md §L.3
      "<weekId>": {
        "signups": {               // frozen at lock (config/raid.locksAt)
          "<twitchUserId>": {
            "displayName": "viewer", "class": "Guardian", "role": "tank",
            "level": 18, "roleRating": 320, "maxHp": 520,
            "power": 140, "defense": 300, "healing": 0,
            "equipped": { "weapon": { "name": "Bramble Maul", "rarity": "rare" } }
          }
        },
        "team": {                  // aggregate computed at lock
          "count": 12, "byRole": { "tank": 3, "healer": 2, "dps": 7 },
          "roleRating": { "tank": 900, "healer": 560, "dps": 2200 },
          "power": 2100, "defense": 1450, "healing": 900
        },
        "combat": {                // seeded, append-only battle log (the live page replays it)
          "seed": 20260629, "status": "live", "startsAt": 0, "bossMaxHp": 1000000,
          "result": { "downed": false, "bossHpRemaining": 260000, "mvp": "<uid>" },
          "log": { "0": { "type": "start", "text": "…" } }   // integer keys, ascending
        }
      }
    }
  },

  "leaderboard": {
    "<seasonId>": { "<twitchUserId>": { "damage": 0, "lootClaimed": 0 } }
  }
}
```

## 10. kennyBot implementation notes (existing repo)

Current repo: `index.js` (tmi.js client), `db.json` (local persistence),
`package.json`, `package-lock.json`, `.gitignore`, `README.md`. Uses `dotenv`
for OAuth secrets; channel is configurable.

- **Migrate persistence from `db.json` → Firebase** (Admin SDK). Keep `db.json`
  only for local dev/fixtures if useful.
- Add `firebase-admin`; load the service-account credential via env/dotenv,
  never commit it. Add EventSub deps (`@twurple/*` or ws) when wiring live
  detection.
- Move command handlers into a registry (one module per command) rather than a
  growing `if/else` in `index.js`.
- Document required env vars in the README (`TWITCH_OAUTH`, `TWITCH_CHANNEL`,
  Twitch app client id/secret for Helix/EventSub, `FIREBASE_*`).

## 11. Chat commands (initial set)

| Command | Who | Effect |
|---|---|---|
| `!create <class>` | everyone | create character + grant starter gear |
| `!grab` / `!loot` | everyone | claim the active drop (rolls within window) |
| `!char` / `!me` | everyone | view character (class, level, role rating) |
| `!bag` / `!inventory` | everyone | view unequipped loot |
| `!equip <item>` | everyone | equip an item into its slot |
| `!raid` | everyone | current boss + your contribution + link to site |
| `!exp on\|off\|auto\|status` | mod | control the EXP gate (§5.1) |
| `!drop <item>` | mod | force a loot drop (testing/events) |
| `!boss set <name>` | mod | set the weekly boss |
| `!season start <id>` | mod | start a new raid tier |

(EXP-on-message and level-up rolls are passive — no command.)

## 12. Phased roadmap

- **Phase 0 — Foundation.** Migrate `db.json` → Firebase (Admin SDK). `!create`
  + class/role + starter gear. Lock RTDB rules.
- **Phase 1 — Live gate.** EventSub `stream.online`/`stream.offline` → `config/live`
  (Helix poll fallback). `expMode` flag + `!exp` mod command.
- **Phase 2 — Growth.** Chat-EXP with cooldown + the level-up roll, gated by §5.1.
- **Phase 3 — Loot.** Item catalog, drop scheduler + `!grab` window, `!bag`/`!equip`,
  role-rating from class+level+gear.
- **Phase 4 — Community raid.** Weekly boss, contribution aggregation, async
  resolution at week close, website HP bar + character/gear UI.
- **Phase 5 — Engagement levers.** tmi.js sub/cheer/raid → EXP multipliers +
  communal drops. Then EventSub channel points.
- **Phase 6 — Raid tiers/seasons.** Rotating loot table + bosses, gear reset +
  prestige, referral moment.
- **Phase 7 — (Optional) solo challenge mode.**

## 13. Open questions for the human (James) to decide

1. **Class list & role mapping** (blocks `!create` and raid-comp math): confirm
   the placeholder set (Guardian/Mender/Berserker/Arcanist/Ranger) or provide
   your own, and the tank/heal/DPS mapping.
2. ~~**Raid resolution:** fully passive vs active?~~ **DECIDED:** active,
   **automated** turn-based battle (the engine drives it — players don't issue
   per-turn commands), resolved as a seeded, replayable combat-event log shown
   live on the website. See §5.8, `IMPLEMENTATION.md §L`, and the UI doc.
3. **Prizes:** in-game only (loot, leaderboard, prestige titles) vs real rewards
   (gift subs, merch, shoutouts)? Affects anti-abuse strictness.
4. **Loot contention:** inclusive (everyone who claims rolls) vs contested/first,
   and whether legendaries differ.
5. **Equipment slots:** confirm the `weapon`/`armor`/`trinket` set or expand.
6. **Season reset:** does character/level carry between tiers, or partial reset?
   Gear assumed reset.
7. **EXP default:** confirm `expMode = auto` (EXP only while live) as the default.
8. **Hosting:** ~~confirm kennyBot + EventSub run 24/7.~~ **DECIDED (2026-06):**
   kennyBot ships as a Docker image built in CI and published to **GHCR
   (private)**, then pulled and run 24/7 as a long-lived container in a private
   self-managed environment (details kept out of version control). EventSub uses
   the **WebSocket transport** so the bot stays **outbound-only** — no inbound
   ports or public endpoint. See `docs/IMPLEMENTATION.md` §§ A–F.

## 14. IP note

This direction is **much safer** than the Pokémon version. Game mechanics and
generic genre archetypes (raiding, loot tiers, leveling, tank/healer/DPS) are
not copyrightable — only specific expression is. Keep all class names, item
names, boss names, art, and UI **original or generic**, and avoid any
Blizzard/WoW-specific expression (the WoW name, Azeroth/zone names, named WoW
bosses, WoW class names used verbatim, WoW art/logos). Staying in the genre's
*grammar* while inventing your own *flavor* keeps you clear of the trademark and
copyright issues that made the Pokémon version untenable.
