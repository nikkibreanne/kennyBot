# kennyBot

A customizable **helper bot** for the `nikkibreanne` Twitch channel (dev/test
channel: `scasplte2`). It captures clips, runs a stream countdown, posts
scheduled reminders, keeps a public to-do board, serves the channel's fun facts,
and runs a credits economy with prediction markets — plus a chat **raid game**.
Anything worth changing mid-stream (clip mode, reminder times, the EXP gate) is
a mod chat command backed by RTDB, not a redeploy.

State lives in **Firebase Realtime Database**, written only by this process
through the Admin SDK; the [website](https://okrafans.com) reads it (read-only)
and renders the public pages. The bot is **outbound-only** — it dials Twitch,
Firebase and OBS, and never listens on a port — and ships as a container.

| Feature | Commands | Notes |
|---|---|---|
| **Clips** | `!clip` · `!clipmode` · `!start` | 16:9 + natively-framed 9:16 captured on the streamer's PC over obs-websocket / Aitum |
| **Stream timer** | `!timer` | one countdown, heads-up marks, survives a restart |
| **Reminders** | `!reminder` | schedules are RTDB records, not code — daily / after-live / interval |
| **To-do board** | `!todo` | chat-controlled, rendered on [/todo/](https://okrafans.com/todo/) |
| **Fun facts** | `!fact` | viewer submissions + mod approval → [/info/](https://okrafans.com/info/) |
| **Credits & OKRAMARKET** | `!daily` · `!bet` · `!market` · `!duel` · `!trade` | parimutuel prediction markets; earned, never bought |
| **Raid game** | `!create` · `!muster` · `!raidnight` | the chat RPG: muster → raid night → seeded battle the site replays |
| **Operations** | `!mute` · `!exp` · `!drops` | live mod control over what the bot does |

The raid game is the largest single feature and has the most machinery behind it
(a pure seeded combat engine, a phase machine, a season/leaderboard model), so it
dominates `docs/` and much of `src/` — but it is **one feature of several**, and
most of what kennyBot does day to day has nothing to do with it.

> **Docs** (all in `docs/`):
> [`raid-game-spec.md`](docs/raid-game-spec.md) — the game, incl. §5.8 the
> automated-combat model ·
> [`IMPLEMENTATION.md`](docs/IMPLEMENTATION.md) — the build & deployment contract;
> this is what the `§E` / `§G` / `§L` markers throughout the source refer to ·
> [`CONFIG.md`](docs/CONFIG.md) — every tunable, for the channel owner ·
> [`clip-architecture.md`](docs/clip-architecture.md) — **read before touching
> anything clip-related.**
>
> Operational specifics — hostnames, addresses, credentials, network topology —
> are deliberately **not** in this repo; they live in a private runbook. Local
> scratch notes go in `.workspace/` (gitignored).

## Status

**Running in production** on the `nikkibreanne` channel (containerised, see
Releasing below). Chat, the clip pipeline, the stream utilities and the game loop
are all live; the pieces still in flight are listed at the end of this section.

Implemented and verified — stream side:

- **`!clip` capture**: horizontal 16:9 + natively-framed vertical 9:16 saved on the
  streamer's PC over obs-websocket / Aitum, with a runtime-switchable clip mode —
  see [Clip capture](#clip-capture)
- **`!timer`**: one mod-set countdown with heads-up marks, stored as a deadline so
  a restart resumes it
- **`!reminder`**: scheduled nudges whose schedules are RTDB records, editable from
  chat — see [Scheduled reminders](#scheduled-reminders)
- **`!todo` / `!fact`**: the public to-do board and the fun-facts page, both
  chat-controlled and read-only on the site
- **credits + wagering**: `!daily`, OKRAMARKET parimutuel bets, coin-flip duels,
  item trades/gifts
- **`!mute` / `!exp` / `!clipmode` / `!drops`**: live mod control, no redeploy
- **Twitch Chat Bot badge** via the Helix send path, with automatic IRC fallback so
  the bot can never go silent because a grant is missing

…and the raid game:

- `!create <class>` → character + starter gear (subscriber-gated)
- live-gated chat EXP → seeded, unit-tested level-up (fixed threshold +
  accumulating chance, **no random early levels**)
- **muster → raid night → automated battle**: `!muster` to sign up, roster locks
  on schedule, a pure seeded `simulateBattle` writes the combat-event log the
  site replays; **resolve-on-boot** phase machine (signup→locked→live→done)
- loot drops/`!grab`/`!equip`, sub/cheer/raid levers, EventSub live-detection

Underneath both:

- locked RTDB rules with an automated **client-write-rejection** test
- single-instance lease, persisted Twitch refresh token, graceful shutdown
- a **dev console** + automated harness that drive the whole loop with no Twitch
- **automated releases** from Conventional Commits (release-please), with `main`
  protected for everyone including admins

Verified by `npm test` (139 offline unit tests), `npm run test:emulator` (69 — RTDB
rules + client-write rejection, and the stateful command paths), `npm run test:e2e`
(31 — every registered command driven through the real dispatcher), and
`npm run synthetic` (full muster→battle→victory run with UI-contract assertions).

**Not yet done:** a full-session local recording (see
[`docs/clip-architecture.md`](docs/clip-architecture.md) "Ingest B"), and the
YouTube Shorts / TikTok upload step in the separate okra-clip-archiver.

## Architecture

```
Twitch (chat WSS, Helix, EventSub WSS)  ──►  kennyBot (Node, twurple)  ──►  Firebase RTDB
                                                   │  Admin SDK (bypasses rules)      ▲ read-only
                                                   ▼                                  │
                                            pure engine (rules/*)            Website (GitHub Pages)
                                                   │
                                                   ▼  obs-websocket, over the tailnet
                                     streamer's OBS + Aitum  ──►  16:9 + 9:16 files on their PC
```

The bot is outbound-only in both directions: it *dials* Twitch, Firebase and OBS,
and never listens on a port.

```
index.js                  wiring: auth, chat, live gate, lock, seeds, schedulers, shutdown
src/
  config.js               every tunable — game balance AND the stream features
                          (timer, reminders, clip) — see docs/CONFIG.md
  logger.js               structured JSON logs, secret-scrubbed
  content/                your own data: classes.js (class→role), items.js (catalog +
                          starter gear), facts.js, reminders.js (default schedules)
  rules/                  PURE, RNG/clock-injected, unit-tested: leveling, rating, loot,
                          combat, reminders (what's due now)
  db/                     firebase, configStore (live mirror), players, raid, drops, wallet,
                          market, timer, reminders, todo, facts, lock, tokenStore
  twitch/                 auth (RefreshingAuthProvider), liveGate (Helix poll), eventsub (WS),
                          sender (Helix/IRC send + badge), clips (Helix Create Clip)
  integrations/           obsWebsocket (v5 client + Aitum vendor requests), capture (facade + rate limit)
  events/                 chat (gate→EXP→raid tick + dispatch), twitchEvents (sub/cheer/raid),
                          dropScheduler · timerScheduler · reminderScheduler
  commands/               one module per command + registry; mod/ subdir for mod commands
test/                     rules/*.test.js (offline) · firebase-rules.test.js (emulator) · e2e/ (dispatcher)
scripts/synthetic-chat.js no-stream harness that drives the whole loop
```

## Chat commands

`!kennycommands` prints this list in chat. Aliases are shown after the `/`.

**Clips**

| Command | Who | Effect |
|---|---|---|
| `!clip` | everyone | capture the last ~60s — 16:9 + 9:16 local files by default; a Twitch clip only if the mode says so |
| `!clipmode <targets>` | mod | pick which of `!clip`'s three outputs run — `horizontal` · `vertical` · `twitch`, combined freely (see below) |
| `!start` / `!slate` | mod | set a stream sync point for the clip archiver |

**Around the stream**

| Command | Who | Effect |
|---|---|---|
| `!timer` | everyone | how long is left. One timer at a time (a new one replaces it); the bot posts heads-ups at 5 min + 1 min, then calls time. Stored as a deadline in `config/timer`, so a restart resumes it |
| `!timer <dur> [label]` | mod | set the stream countdown — `10` (minutes), `90s`, `1h30m`, `5:30`; the words after it are the label |
| `!timer +5` / `!timer -2m` | mod | add/remove time without restarting the countdown (bare number = minutes) |
| `!timer pause\|resume\|stop` | mod | freeze / un-freeze / dismiss it |
| `!reminder` | mod | list the scheduled reminders; `on\|off\|test <id>`, `at <id> <HH:MM…>`, `every\|jitter\|after\|lead <id> <min>`, `text\|leadtext <id> <msg>`, `zone`, `channel` — see below |
| `!todo` / `!todos` | mod | date-organised to-do list, published to [okrafans.com/todo](https://okrafans.com/todo/) |
| `!fact` / `!facts` | everyone | a random fact, with its number · `!fact <#>` the one numbered `#` on [/info/](https://okrafans.com/info/) · `!fact suggest <text>` submits one for approval |
| `!kennycommands` / `!kennybot` / `!kcommands` | everyone | the full command list, in chat |

**Credits & wagering**

| Command | Who | Effect |
|---|---|---|
| `!credits` / `!points` / `!bal` / `!balance` | everyone | your credit balance |
| `!daily` | everyone | claim your daily credits |
| `!market` | everyone | list open OKRAMARKETs · `!market suggest <question>` proposes one |
| `!bet` / `!wager` `<market#> <yes\|no> <amount>` | everyone | wager credits on a market |
| `!duel <@user> <amount>` | everyone | coin-flip duel for credits · `!duel accept \| deny` |
| `!trade @user <item\|#> [+ credits]` | everyone | offer a **swap**; the other player counters, then `!trade accept` / `decline` |
| `!offer` / `!gift` `@user <item\|#> [+ credits]` | everyone | **give** an item/credits one-way; they reply `!offer accept` / `decline` |

**Raid game — hero & loot**

| Command | Who | Effect |
|---|---|---|
| `!create <class>` | **subs** | create character (Guardian/Mender/Berserker/Arcanist/Ranger) + starter gear |
| `!char` / `!me` | everyone | view class, level, role rating, combat stats |
| `!bag` / `!inventory` / `!inv` | everyone | view unequipped loot |
| `!equip <item\|#>` | everyone | equip an item from your bag (by name or bag number) |
| `!unequip <slot\|item>` | everyone | bare a slot (weapon/armor/trinket) back into your bag |
| `!grab` / `!loot` | **subs** | enter the drawing for the active loot drop |
| `!muster` | **subs**\* | sign up for this season's raid roster (during muster) / see status |
| `!top [damage]` | everyone | season leaderboard (top 5) |

**Mod / operations**

| Command | Who | Effect |
|---|---|---|
| `!exp on\|off\|auto\|status` | mod | control the EXP gate (`on` bypasses live for testing) |
| `!mute on\|off\|status` | mod | silence the bot's chat output when it gets noisy; it keeps listening, tracking EXP, and holding the lease — bare `!mute` toggles |
| `!drop [itemId]` | mod | force a single loot drop |
| `!drops on\|off\|every <min>\|status` | mod | auto chat-drop scheduler (rarity-weighted, while live) |
| `!boss set <name>` / `!boss next` | mod | custom boss / advance to the next scripted season boss |
| `!raidnight` | mod | lock the roster and run the battle now |
| `!season start <id>` / `!season rollover <id>` | mod | start a tier / roll to the next (gear reset, renown kept) |

\* Viewing raid status is open to everyone, but **mustering** (signing up with
`!muster`) needs an active sub — same as `!create` and `!grab`. A lapsed sub keeps
the hero they built and keeps earning EXP, but must re-sub to muster.

Mustering writes a snapshot of your hero onto the season roster. When a new boss
is scheduled in the same season, participating adventurers roll forward into that
boss's muster roster; starting or rolling over a season clears the roster. While
the muster window is open, the bot re-snapshots signees from their live record on a timer
(`raid.rosterRefreshMs`), so leveling or gearing up after you muster keeps showing
on the site without a re-`!muster`. At **roster lock** (15 min before raid night)
every card is frozen from the live record — that's the loadout that fights.

### Scheduled reminders

kennyBot posts recurring nudges on three schedule shapes. Every schedule is a
**record in RTDB** (`config/reminders/<id>`), not a rule in code — a mod re-times
one from chat with `!reminder` and it takes effect on the next tick.

| id | Schedule | What it does |
|---|---|---|
| `wallpaper` | 30 min after going live, once per stream | "is Wallpaper Engine still running?" |
| `ghosty` | daily 08:00 + 17:00 Pacific, 20-min heads-up | Ghosty's meal times |
| `hydration` | every 60 min of live time, ±10 min jitter | drink some water |

A reminder carries a `channel`: it fires **only** on that Twitch channel, and
`channel: null` fires wherever the bot runs (that's hydration). So "this one is a
Nikki thing" is a property of the data — there's no per-channel branch anywhere
in the code, and `!reminder channel <id> <name|any>` re-points one from chat.

All three are **live-gated** by default. A daily slot missed while offline is
skipped rather than announced hours late, an `afterLive` reminder fires once per
live session (a bot restart mid-stream doesn't repeat it), and an interval that
came due during a long offline stretch is quietly re-armed instead of dumping a
backlog. The defaults are seeded from `src/content/reminders.js` on first boot
and **never** clobbered afterwards, so edited times survive every deploy.

## Local development

Requires **Node ≥ 20** and **Java** (for the Firebase emulator).

```bash
npm install

# 1) Pure engine unit tests — offline, no deps on Twitch/Firebase
npm test

# 2) Locked-rules + client-write-rejection test (boots the RTDB emulator)
npm run test:emulator

# 3) Every command through the real dispatcher (boots the RTDB emulator)
npm run test:e2e

# 4) Drive the entire game loop with no stream (automated muster→battle e2e)
npm run synthetic

# 5) …or drive it interactively by typing chat commands (no Twitch)
npm run dev:console
```

To exercise the bot against a **real Twitch channel** without touching production
state, `npm run dev:live` runs it against a throwaway emulator DB and a separate
token store (`.tokens-dev`) — this is how `!clip` was verified end to end.

### Full local integration (backend + website together)

One Firebase **emulator** is the shared source of truth; the backend writes to
it and the website reads from it. In three terminals:

```bash
# 1) shared emulator
npx firebase emulators:start --only database --project okrafans

# 2) drive the bot (interactive) against the emulator
FIREBASE_DATABASE_EMULATOR_HOST=127.0.0.1:9000 node scripts/dev-console.js
#    e.g.:  !season start t1   ·   /as alice sub   ·   !create Berserker   ·
#           !muster   ·   /as nikki   ·   !raidnight

# 3) serve the website (in the nikkibreanne.github.io repo) and open it
bundle install            # one-time
bundle exec jekyll serve  # → http://localhost:4000/raid/  and  /live/
```

The site auto-detects `localhost` and reads the **same emulator** (a dev-only
`connectDatabaseEmulator` switch in its Firebase init). So `!muster` fills the
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

## Clip capture

> **Full detail: [`docs/clip-architecture.md`](docs/clip-architecture.md).** Read it
> before changing anything clip-related — it records the physical constraints that
> every past design error came from contradicting.

Two **separate ingest** paths feed one **shared processing** stage:

| | **Ingest A — `!clip` capture** (this repo) | **Ingest B — full-session recording** |
|---|---|---|
| Trigger | `!clip` in chat, while live | OBS records the whole session |
| Source | OBS replay buffer (last ~60s) | one long local recording |
| Covers | only moments someone `!clip`ped | any moment, including viewer-clipped ones |
| Needs | OBS reachable while live | disk + sustained encode for hours |

Both feed **okra-clip-archiver** (separate repo), which is *source-agnostic* — it
takes any local video plus timestamps and produces the two-box 9:16 re-cut. Ingest is
separate; processing is shared. **kennyBot never hands files to the archiver.**

Two things that are commonly assumed and are false:

- **A Twitch VOD is not a high-quality source.** It's the broadcast, capped at the
  stream resolution — it can never be "the 4K version". The archiver uses it only to
  *align timestamps* against a local recording.
- **There is no retroactive capture.** The replay buffer holds ~60s, and Twitch clips
  appear minutes later, so reacting to viewer-created clips cannot work. Acting
  *during* the moment is the only option.

Both ingest paths are bounded by the same ceiling: **the OBS canvas resolution and
Recording settings.** Neither exceeds stream quality until those are raised.

### Switching what `!clip` does, live

`!clip` can produce **three independent outputs**, and the mode is the *set* of them
you want — so every combination is one command, with no extra config values:

| Target | What you get |
|---|---|
| `horizontal` | OBS's main replay buffer → **16:9** file on the streamer's PC |
| `vertical` | Aitum's Backtrack output → **9:16** file, natively framed for portrait |
| `twitch` | Helix Create Clip → a public **clip link** posted in chat |

```
!clipmode horizontal vertical         both local files, nothing on Twitch (default)
!clipmode horizontal                  16:9 only
!clipmode vertical twitch             9:16 file + a Twitch link
!clipmode horizontal vertical twitch  everything
!clipmode local                       alias for horizontal+vertical
!clipmode all                         alias for all three
!clipmode off                         !clip disabled
!clipmode status                      what's set, and whether each part can run
```

Order doesn't matter and commas are optional — `vertical,horizontal` stores the same
value as `horizontal vertical`. One unrecognised word rejects the whole line rather
than silently applying part of it, because the symptom of a half-applied mode is a
clip that quietly never gets made.

`vertical` also needs `CAPTURE_VERTICAL_OUTPUT` set (that's the output's *name* —
plumbing); the mode decides *whether* to save it. Both must hold, and `status` says
which one is missing.

Mod-only, takes effect on the **next** `!clip`, and persists across restarts.

This is deliberately a **runtime** setting with **no environment variable**. If the
streamer's OBS dies mid-stream, `local` mode leaves `!clip` with nothing to do;
recovering via SSH, an env-file edit and a container restart is not a route anyone
takes mid-show. The value lives in RTDB (`config/clipMode`), seeded once from
`clip.defaultMode` in `src/config.js` — the same shape as the EXP gate. There is no
second place that can disagree with it.

`!clipmode status` reports the mode *and* whether each half can actually run, and a
switch to a mode nothing is configured for warns immediately rather than leaving a
viewer to discover it.

The one point of contact is `!start` (`src/db/clipSync.js`), which writes a per-stream
sync anchor to RTDB — *data the archiver reads*, not a file handoff, and it works
whether or not local capture is configured.

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
| `TWITCH_SEND_MODE` | chat transport — `auto` (default, Helix + IRC fallback) · `helix` (Chat Bot badge) · `irc` |
| `OBS_WEBSOCKET_URL` / `OBS_WEBSOCKET_PASSWORD` | the streamer's OBS (obs-websocket, over the tailnet) — required for the local capture |
| `CAPTURE_VERTICAL_OUTPUT` | *optional* — Aitum Stream Suite Backtrack output name (e.g. `Vertical Backtrack`); also saves a natively-framed 9:16 clip. Unset = horizontal only |
| `OBS_TIMEOUT_MS` / `CAPTURE_MIN_INTERVAL_MS` / `CAPTURE_BACKEND` | *optional* capture knobs — request deadline, channel-wide gap between local saves, backend |
| `INSTANCE_ID` / `LOG_LEVEL` / `HEARTBEAT_FILE` | optional runtime knobs |

## Production (containerized, outbound-only)

```bash
docker build -t kennybot .       # multi-stage, non-root, no exposed ports
```

CI builds and publishes to **GHCR (private)** on release (see below).
Run per `IMPLEMENTATION.md §E` — `--read-only --tmpfs /tmp`, `--cap-drop ALL`,
`--security-opt no-new-privileges`, memory/cpu caps, `--env-file`, the
service-account JSON mounted read-only, and one writable `/data` volume for the
token store. **Run exactly one instance** (double-running = double awards; the
lease enforces it but don't tempt it).

Deploy the RTDB rules from `database.rules.json` before going live:

```bash
npx firebase deploy --only database --project okrafans
```

## Releasing

Versions are derived from **Conventional Commits** by
[release-please](https://github.com/googleapis/release-please) — nobody edits
`package.json` or pushes a tag by hand.

`main` is protected for **everyone, including admins** (`enforce_admins`), so a
direct push is rejected. All changes land through a PR that passed `ci / test`.

**Merges are squash-only**, which makes the PR title the commit subject on `main`
— and that title is what decides the next version. The `pr-title` check enforces it:

| PR title | Result |
|---|---|
| `fix: …` · `perf: …` | patch — `0.8.0` → `0.8.1` |
| `feat: …` | minor — `0.8.0` → `0.9.0` |
| `feat!: …` / `BREAKING CHANGE:` | minor while pre-1.0, major after |
| `docs:` `test:` `ci:` `build:` `chore:` `refactor:` `revert:` | no release |

A scope is optional: `feat(clip): add CLIP_MODE`.

**The loop.** Merge PRs as normal → release-please opens a single
`chore(main): release X.Y.Z` PR with the version bump and `CHANGELOG.md`, updating
it as more land → merge that PR when you want to ship. The tag, the GitHub release,
and `ghcr.io/nikkibreanne/kennybot:X.Y.Z` + `:latest` all follow automatically.

> **One manual step per release.** The release PR is opened by `GITHUB_TOKEN`, and
> GitHub won't auto-run workflows for its own token's events — so its CI sits in an
> approval-required state until you click **"Approve and run"**. That's deliberate:
> the alternative is storing a PAT, which this repo avoids. For the same reason the
> image is published *inside* `release.yml`'s run rather than by reacting to the tag
> (a `GITHUB_TOKEN`-created tag would trigger nothing, and the release would ship
> with no image and no error).

`publish.yml` still builds on a **hand-pushed** `vX.Y.Z` tag — human-pushed tags do
trigger workflows — as a hotfix escape hatch. Both paths share
`.github/workflows/docker-publish.yml`, so the image is built identically either way.

## Interface contract with the website

The site reads `config/raid` (`{seasonId, weekId, phase, locksAt, startsAt}`),
`bosses/<season>/<week>`, `raids/<season>/<week>/{signups, team, combat, result}`
(the muster roster, aggregates, and the append-only combat-event `log`),
`players/<id>`, `usernames/<login>` (login→id index), and `leaderboard/<season>`.
The combat-log + signup shapes are specified in
[`docs/raid-game-spec.md`](docs/raid-game-spec.md) §5.8 and
[`docs/IMPLEMENTATION.md`](docs/IMPLEMENTATION.md) §L. The UI side (`raid-game-ui.md`)
lives in the **website repo**, not here. **Changing any path/shape means telling the
UI track.**

## Decisions (confirmed with the owner)

Classes = the 5 placeholders · raid resolution = **active automated combat**
(muster → raid night → seeded battle replay) · participation = **subscriber-only**
(a lapsed sub keeps their hero + keeps earning EXP, but `!create`, `!grab`, and
mustering with `!muster` all need an active sub) · loot =
inclusive rolls · slots = weapon/armor/trinket · season = **6 weeks** · EXP =
`auto`. Repo is intended **open source** (security rests on locked RTDB rules +
runtime-injected secrets, not code secrecy).

**Chat surface:** responses stay **sub-verbs** — `!offer accept`, `!trade
counter`, `!duel accept`. Bare `!accept` / `!decline` are deliberately NOT
registered: the channel runs other bots, and claiming names that common risks two
bots answering one message. (A viewer typing `!accept` therefore gets nothing;
that is intended, and the dispatcher logs it at debug so it stays diagnosable.)
No command links the source repo — chat replies point at okrafans.com only.

**Content:** 72 items / 18 bosses (3 seasons) / per-class + boss ability kits live
in `src/content/`; boss HP scales to the mustered roster (`scaleBossHp`).
Sub-tier boosts combat power + EXP; victory loot rewards participants + survivors
+ MVP; veteran **renown** persists across `!season rollover`. Design rationale and
the future backlog (set bonuses, affixes, DoT/shields/taunt, multi-phase finales,
big-raid log compaction) are in [`docs/design/`](docs/design/).
