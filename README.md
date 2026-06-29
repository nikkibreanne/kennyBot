# kennyBot

A Twitch chat bot and **raid-game backend** for the `nikkibreanne` channel
(dev/test channel: `scasplte2`). Subscribers create a character, earn EXP by
chatting while live, level up and gear up over the week (**muster**), and sign
up for a weekly raid. At a scheduled **raid night** the roster locks and an
automated, seeded turn-based **battle plays out** — the backend writes it as an
append-only combat-event log that the [website](https://okrafans.com) replays
turn-by-turn (spec §5.8). Authoritative game state lives in **Firebase Realtime
Database**; the website reads it (read-only). The bot is **outbound-only** and
ships as a container.

> Design & implementation specs live in `docs/` (public): `raid-game-spec.md`
> (the game, incl. §5.8 the active automated-combat model) and `IMPLEMENTATION.md`
> (the build, incl. §L the combat engine). Private/local notes go in `.workspace/`
> (gitignored).

## Status

**Implemented and verified locally** against the Firebase emulator:

- `!create <class>` → character + starter gear (subscriber-gated)
- live-gated chat EXP → seeded, unit-tested **pity-roll** level-up
- **muster → raid night → automated battle**: `!raid` to sign up, roster locks
  on schedule, a pure seeded `simulateBattle` writes the combat-event log the
  site replays; **resolve-on-boot** phase machine (signup→locked→live→done)
- loot drops/`!grab`/`!equip`, sub/cheer/raid levers, EventSub live-detection
- locked RTDB rules with an automated **client-write-rejection** test
- single-instance lease, persisted Twitch refresh token, graceful shutdown
- a **dev console** + automated harness that drive the whole loop with no Twitch

Verified by `npm test` (30 engine tests), `npm run test:emulator` (rules), and
`npm run synthetic` (full muster→battle→victory e2e with UI-contract assertions).

## Architecture

```
Twitch (chat WSS, Helix, EventSub WSS)  ──►  kennyBot (Node, twurple)  ──►  Firebase RTDB
                                                   │  Admin SDK (bypasses rules)      ▲ read-only
                                                   ▼                                  │
                                            pure engine (rules/*)            Website (GitHub Pages)
```

```
index.js                  wiring: auth, chat, live gate, lock, resolve-on-boot, shutdown
src/
  config.js               all game tunables (EXP/pity/rating/loot/raid) — rebalance here
  logger.js               structured JSON logs, secret-scrubbed
  content/                your own data: classes.js (class→role), items.js (catalog + starter gear)
  rules/                  PURE, RNG-injected, unit-tested: leveling, rating, loot, raidResolve
  db/                     firebase, configStore (live mirror), players, raid, drops, lock, tokenStore
  twitch/                 auth (RefreshingAuthProvider), liveGate (Helix poll), eventsub (WS)
  events/                 chat (gate→EXP→raid tick + dispatch), twitchEvents (sub/cheer/raid)
  commands/               one module per command + registry; mod/ subdir for mod commands
test/                     rules/*.test.js (offline) + firebase-rules.test.js (emulator)
scripts/synthetic-chat.js no-stream harness that drives the whole loop
```

## Chat commands

| Command | Who | Effect |
|---|---|---|
| `!create <class>` | **subs** | create character (Guardian/Mender/Berserker/Arcanist/Ranger) + starter gear |
| `!char` / `!me` | everyone | view class, level, role rating, combat stats |
| `!bag` / `!inventory` | everyone | view unequipped loot |
| `!equip <item>` | everyone | equip an owned item into its slot |
| `!grab` / `!loot` | **subs** | roll for the active drop (independent rolls within the window) |
| `!raid` | everyone* | sign up for this week's raid (during muster) / see status |
| `!exp on\|off\|auto\|status` | mod | control the EXP gate (`on` bypasses live for testing) |
| `!drop [item]` | mod | force a single loot drop |
| `!drops on\|off\|every <min>` | mod | auto chat-drop scheduler (rarity-weighted, while live) |
| `!boss set <name>` / `!boss next` | mod | custom boss / advance to the next scripted season boss |
| `!raidnight` | mod | lock the roster and run the battle now |
| `!season start <id>` / `!season rollover <id>` | mod | start a tier / roll to the next (gear reset, renown kept) |

\* A lapsed sub keeps the hero they built and can still muster + fight; only
`!create` and `!grab` need an active sub.

## Local development

Requires **Node ≥ 20** and **Java** (for the Firebase emulator).

```bash
npm install

# 1) Pure engine unit tests — offline, no deps on Twitch/Firebase
npm test

# 2) Locked-rules + client-write-rejection test (boots the RTDB emulator)
npm run test:emulator

# 3) Drive the entire game loop with no stream (automated muster→battle e2e)
npm run synthetic

# 4) …or drive it interactively by typing chat commands (no Twitch)
npm run dev:console
```

### Full local integration (backend + website together)

One Firebase **emulator** is the shared source of truth; the backend writes to
it and the website reads from it. In three terminals:

```bash
# 1) shared emulator
npx firebase emulators:start --only database --project okrafans

# 2) drive the bot (interactive) against the emulator
FIREBASE_DATABASE_EMULATOR_HOST=127.0.0.1:9000 node scripts/dev-console.js
#    e.g.:  !season start t1   ·   /as alice sub   ·   !create Berserker   ·
#           !raid   ·   /as nikki   ·   !raidnight

# 3) serve the website (in the nikkibreanne.github.io repo) and open it
bundle install            # one-time
bundle exec jekyll serve  # → http://localhost:4000/raid/  and  /live/
```

The site auto-detects `localhost` and reads the **same emulator** (a dev-only
`connectDatabaseEmulator` switch in its Firebase init). So `!raid` fills the
muster roster on `/raid/`, and `!raidnight` plays the battle out on `/live/`.

### Running the bot locally

Copy `.env.example` → `.env` and fill it in (see the env contract below). For a
local run without real Firebase, start the emulator and set
`FIREBASE_DATABASE_EMULATOR_HOST=127.0.0.1:9000`, then:

```bash
npx firebase emulators:start --only database --project okrafans   # terminal 1
node index.js                                                     # terminal 2
```

Test offline with `!exp on` (bypasses the live gate) and the mod commands
(`!boss set …`, `!drop`, `!boss endnow`) — you never need to go live to test.

## Environment contract

Names only — **never commit values** (`.env*` and `serviceAccount*.json` are
gitignored). Secrets arrive at runtime, never baked into the image.

| Var | Purpose |
|---|---|
| `TWITCH_CLIENT_ID` / `TWITCH_CLIENT_SECRET` | Twitch **app** creds (token refresh, Helix, EventSub) |
| `TWITCH_BOT_USERNAME` | bot login (to ignore its own echoes) |
| `TWITCH_BOT_REFRESH_TOKEN` | one-time bootstrap refresh token for the bot account (`chat:read chat:edit`); the persisted store takes over after |
| `TWITCH_CHANNEL` | channel to join (`scasplte2` dev, `nikkibreanne` prod) |
| `TWITCH_BROADCASTER_REFRESH_TOKEN` | *optional* — enables EventSub live detection; omit to use the Helix poll |
| `GOOGLE_APPLICATION_CREDENTIALS` | path to the mounted Firebase service-account JSON |
| `FIREBASE_DATABASE_URL` / `FIREBASE_PROJECT_ID` | RTDB URL + project (`okrafans`) |
| `FIREBASE_DATABASE_EMULATOR_HOST` | *local only* — targets the emulator; leave empty in prod |
| `TOKEN_STORE_DIR` | dir for the persisted refresh-token store (the `/data` volume) |
| `INSTANCE_ID` / `LOG_LEVEL` / `HEARTBEAT_FILE` | optional runtime knobs |

## Production (containerized, outbound-only)

```bash
docker build -t kennybot .       # multi-stage, non-root, no exposed ports
```

CI builds and publishes to **GHCR (private)** on push (`.github/workflows/publish.yml`).
Run per `IMPLEMENTATION.md §E` — `--read-only --tmpfs /tmp`, `--cap-drop ALL`,
`--security-opt no-new-privileges`, memory/cpu caps, `--env-file`, the
service-account JSON mounted read-only, and one writable `/data` volume for the
token store. **Run exactly one instance** (double-running = double awards; the
lease enforces it but don't tempt it).

Deploy the RTDB rules from `database.rules.json` before going live:

```bash
npx firebase deploy --only database --project okrafans
```

## Interface contract with the website

The site reads `config/raid` (`{seasonId, weekId, phase, locksAt, startsAt}`),
`bosses/<season>/<week>`, `raids/<season>/<week>/{signups, team, combat, result}`
(the muster roster, aggregates, and the append-only combat-event `log`),
`players/<id>`, `usernames/<login>` (login→id index), and `leaderboard/<season>`.
The combat-log + signup shapes are specified in `docs/raid-game-spec.md §5.8` /
`docs/IMPLEMENTATION.md §L` and the UI's `docs/raid-game-ui.md`. **Changing any
path/shape means telling the UI track.**

## Decisions (confirmed with the owner)

Classes = the 5 placeholders · raid resolution = **active automated combat**
(muster → raid night → seeded battle replay) · participation = **subscriber-only**
(a lapsed sub keeps playing; only `!create`/`!grab` need an active sub) · loot =
inclusive rolls · slots = weapon/armor/trinket · season = **6 weeks** · EXP =
`auto`. Repo is intended **open source** (security rests on locked RTDB rules +
runtime-injected secrets, not code secrecy).

**Content:** 72 items / 18 bosses (3 seasons) / per-class + boss ability kits live
in `src/content/`; boss HP scales to the mustered roster (`scaleBossHp`).
Sub-tier boosts combat power + EXP; victory loot rewards participants + survivors
+ MVP; veteran **renown** persists across `!season rollover`. Design rationale and
the future backlog (set bonuses, affixes, DoT/shields/taunt, multi-phase finales,
big-raid log compaction) are in [`docs/design/`](docs/design/).
