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
| **Now playing** | `!song` | reads Spotify (account-scoped, so the bot needn't be on that machine) + an OBS text overlay |
| **On-stream media** | `!media` | play a mapped OBS media source from chat — the same connection, pointed at a source instead of the buffer |
| **OBS control** | `!obs` | scenes, source visibility, filters, audio mute and stream stats, from chat |
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
- **`!media`**: play a mapped OBS media source from chat (sounds, alert clips) over
  that same obs-websocket connection — see [Playing media on stream](#playing-media-on-stream--media)
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

Verified by `npm test` (196 offline unit tests), `npm run test:emulator` (75 — RTDB
rules + client-write rejection, and the stateful command paths), `npm run test:e2e`
(33 — every registered command driven through the real dispatcher), and
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
                                                                  media sources played on stream
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
                          combat, reminders (what's due now), media (slot parsing/validation),
                          spotify (now-playing formatting)
  db/                     firebase, configStore (live mirror), players, raid, drops, wallet,
                          market, timer, reminders, media, todo, facts, lock, tokenStore
  twitch/                 auth (RefreshingAuthProvider), liveGate (Helix poll), eventsub (WS),
                          sender (Helix/IRC send + badge), clips (Helix Create Clip)
  integrations/           obsWebsocket (v5 client + Aitum vendor requests), capture (facade +
                          rate limit), obsMedia (media actions), obsControl (scenes,
                          sources, filters, audio), spotify (now playing, token
                          refresh) — the OBS three all on the same socket
  events/                 chat (gate→EXP→raid tick + dispatch), twitchEvents (sub/cheer/raid),
                          dropScheduler · timerScheduler · reminderScheduler ·
                          spotifyScheduler (writes the now-playing overlay)
  commands/               one module per command + registry; mod/ subdir for mod commands
test/                     rules/*.test.js (offline) · firebase-rules.test.js (emulator) · e2e/ (dispatcher)
scripts/synthetic-chat.js no-stream harness that drives the whole loop
scripts/obs-media.mjs     list/fire OBS media sources without the bot running
```

## Chat commands

`!kennycommands` prints this list in chat. Aliases are shown after the `/`.

**Clips**

| Command | Who | Effect |
|---|---|---|
| `!clip` | everyone | capture the last ~60s — 16:9 + 9:16 local files by default; a Twitch clip only if the mode says so |
| `!clipmode <targets>` | mod | pick which of `!clip`'s three outputs run — `horizontal` · `vertical` · `twitch`, combined freely (see below) |
| `!start` / `!slate` | mod | set a stream sync point for the clip archiver |

**On-stream media** — the same OBS connection, pointed at a media source instead
of the replay buffer.

| Command | Who | Effect |
|---|---|---|
| `!media <n>` | mod | play the OBS media source mapped to slot `n`. Silent in chat on success — the sound *is* the reply; every failure answers |
| `!media` | mod | list what's mapped |
| `!media inputs` | mod | ask OBS which Media Sources exist, spelled exactly as it spells them |
| `!media set <n> <a> \| <b>` | mod | map a slot to one or more sources. Names are the rest of the line (spaces fine); `\|` separates them, because a GIF and its sound are two sources in OBS and one alert in chat |
| `!media add <n> <source>` | mod | append a source to an existing slot |
| `!media scene <n> <scene\|none>` | mod | reveal the source in that scene before playing (for a visual alert); `none` stops revealing it |
| `!media action <n> <action>` | mod | `restart` (default) · `play` · `pause` · `stop` · `next` · `previous` |
| `!media clear <n>` | mod | unmap |
| `!obs` | mod | what's live: current scene, fps, skipped frames |
| `!obs scenes` · `!obs scene <name>` | mod | list scenes · cut to one |
| `!obs sources [scene]` | mod | what's in a scene, and what's visible |
| `!obs show\|hide\|toggle <source>` | mod | flip a source's visibility in the live scene |
| `!obs filters <source>` · `!obs filter on\|off <source> \| <filter>` | mod | list a source's filters · switch one |
| `!obs audio` · `!obs mute\|unmute <input>` | mod | audio inputs with mute state and level · mute one. **Not** `!mute`, which silences the bot |
| `!obs stats` | mod | dropped frames as a rate, CPU, free disk — for when chat says it's buffering |

**Now playing**

| Command | Who | Effect |
|---|---|---|
| `!song` / `!nowplaying` / `!np` | everyone | what's playing on the streamer's Spotify — track, artists, position, and a link |

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

### Playing media on stream — `!media`

The same obs-websocket connection that saves replay buffers can also **play a media
source**, which is all an on-stream alert actually is. `!media 3` restarts the OBS
source mapped to slot 3; if that slot names a scene, the source is revealed there
first, so a visual alert works the same way a sound does.

```
!media inputs                        what OBS actually has, spelled its way
!media set 3 alert-gif | alert-mp3   slot 3 → both, fired together
!media add 3 extra-sound             append to an existing slot
!media scene 3 Alerts                reveal them in "Alerts" first (only if hidden)
!media action 3 stop                 restart (default) · play · pause · stop · next · previous
!media 3                             fire it
```

**One slot, several sources.** OBS keeps a GIF and its sound as separate Media
Sources, so an alert is normally two of them. A slot fires up to five, and the
triggers go out in a single batch rather than one await at a time — putting a
round trip between the picture and the sound is audible. Every scene reveal
happens before any trigger, for the same reason.

**A successful play says nothing in chat.** The sound is the feedback, and an alert
that also posts a line is clutter. Every *failure* replies — so silence means OBS
accepted the request. Verified against a real OBS: a name that doesn't exist, a
scene that doesn't exist, and a slot where only *one* of two names is wrong all
throw and reach chat with the offending name in the message. The one failure OBS
cannot report is a **muted or zero-volume source** — that answers success and is
heard by nobody, so it's the first thing to check when a slot goes quiet.

There is deliberately **no overlay page and no message bus**. That architecture is
what a hosted alert service has to use, because it cannot reach your OBS — this bot
can, and a web page plus a transport to reach it would be strictly more moving parts
than the one request that already works. OBS keeps ownership of compositing, audio
routing and *Show nothing when playback ends* (`clear_on_media_end`, on by default),
which is also why nothing here holds a "hide it later" timer — and why a source can
simply be left visible instead of needing a scene at all.

Slots live in RTDB (`config/media/<n>`) for the same reason the clip mode does:
these names change whenever a source is renamed in OBS, and re-deploying a container
to rename a sound is not a thing anyone does mid-stream. They ship **empty** — a
default slot would name a source that exists on no particular machine, and a slot
pointing at nothing fails live, in front of chat. Map them from `!media inputs`, or
from `node scripts/obs-media.mjs` before the bot is even deployed.

Mod-only, and no cooldown: a soundboard's value is landing on the beat, sometimes
twice. Unlike `!clip`'s local capture — hundreds of MB per trigger, hence its own
rate limit — a media action costs OBS nothing. A connection is opened **per
trigger**; ten fired at once completed in 197ms with none dropped, which is well
past what a soundboard produces.

**Re-firing does not stack, and that is why there is no queue.** A Media Source has
a single playback instance, so `restart` on a source already playing resets it to
frame one — measured against a real OBS, the cursor dropped from 470ms to 104ms on
the second trigger. Ten rapid triggers of one slot are one audible play, not ten.
Different slots *do* overlap, since they are different sources. A queue would only
matter if alerts should wait their turn rather than interrupt, which for a mod
soundboard is the wrong behaviour anyway.

**Not yet wired to Twitch events.** Firing on cheers, subs or channel-point
redemptions needs EventSub topics and broadcaster scopes this bot does not hold
today (it subscribes to `stream.online`/`offline` only, and prod runs on a Helix
poll because the broadcaster token isn't the channel owner's). The mechanism comes
first; the trigger is separate work.

### Driving OBS from chat — `!obs`

The rest of the obs-websocket surface, on that same connection: scenes, source
visibility, filters, audio, and the stream-health numbers.

```
!obs                          current scene, fps, skipped frames
!obs scenes                   list · !obs scene Starting Soon   cut to one
!obs sources                  what's in the live scene, and what's visible
!obs show|hide|toggle <src>   flip a source
!obs filters <source>         list · !obs filter off cam | Chroma Key
!obs audio                    inputs with mute state and level
!obs mute|unmute <input>      OBS audio — NOT !mute, which silences the bot
!obs stats                    dropped frames as a RATE, CPU, free disk
```

One command with sub-verbs rather than eight top-level names: `!obs` alone is the
discoverable index, and it keeps eight words out of a chat namespace shared with
other bots. `!obs mute` sits here precisely *because* `!mute` already exists and
means something entirely different — two mutes at top level is a mistake waiting
for a stressful moment.

Deliberately thin: each verb is one or two obs-websocket requests with no policy
on top, and `!obs scene` accepts any scene name rather than an allowlist. This
exists to learn what OBS exposes; a verb that proves worth keeping can earn its
own command and its own guard rails then. Errors are OBS's own text, passed
through — when a name is wrong, OBS says which one, and that beats anything we
would write.

`!obs stats` reports skipped frames as a **percentage**, because a raw count means
nothing without the total: "312 dropped" reads as alarming and is fine out of two
million.

### Now playing — `!song` and the OBS overlay

`!song` answers what the streamer's Spotify is playing. The Web API is
**account-scoped, not device-scoped**, so this reads that account's playback on any
device — the bot does not need to run on the machine Spotify is on, and nothing is
installed there. You can only ever read your *own* account; there is no endpoint
for "what is user X playing".

**Setup** (once):

1. Register an app at [developer.spotify.com](https://developer.spotify.com/dashboard);
   put the client id + secret in `.env` as `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET`.
2. Add the redirect URI **`http://127.0.0.1:8888/callback`** to the app and save it.
   Spotify explicitly rejects `localhost` — it must be the loopback IP literal.
3. `node scripts/get-spotify-token.mjs` — approve in the browser. The refresh token
   is written to the token store, and printed for `SPOTIFY_REFRESH_TOKEN`.

Only `user-read-currently-playing` is requested. Podcast episodes may additionally
need `user-read-playback-state`; set `SPOTIFY_SCOPES` and re-run the script.

**The overlay.** Set `SPOTIFY_OVERLAY_SOURCE` to the name of an OBS text source and
kennyBot keeps it current. `node scripts/obs-overlay-setup.mjs` creates one and adds
it to every scene — deliberately **one source shown in several scenes**, not a copy
per scene, so a single write updates them all and they cannot drift.

It **writes only when the line changes**: a text source rewritten every poll
re-renders in OBS for nothing. And it **clears** when playback stops or pauses,
rather than freezing the last track — a stale song title is worse than none,
because viewers believe it.

`config.spotify` holds the poll interval, the cache window, and the overlay prefix
(`Now Playing: `). The prefix is applied only to a non-empty line, so a pause
leaves an empty source rather than a bare label.

Spotify's payload has more shapes than "a song is playing", and each one reaches
chat: nothing playing (a **204 with an empty body** — parsing it would throw),
paused (still populated, `is_playing:false`), an **episode** (no `artists` field at
all), an ad, and a local file with no URL. All five are covered in
`test/rules/spotify.test.js` and were exercised against a real account.

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
