# kennyBot — Configuration Reference (for the channel owner)

This is the operator's guide to **every tunable** in kennyBot — the stream
features (the timer, reminders, clips) as well as raid-game balance. They all
live in one file: [`src/config.js`](../src/config.js). The engine modules
(`src/rules/*`) are pure and read only what they're handed, so you can retune
everything here without touching any logic.

For day-to-day running — starting a season, re-timing Ghosty's reminder, muting
the bot, switching what `!clip` does — you don't need this file at all: those are
**mod chat commands**, listed in the next section and in the README's command
tables. This doc is for the settings that are baked in at boot: how fast leveling
feels, how rare loot is, how long a timer waits before its first heads-up.

---

## How to change a setting

There are two kinds of settings.

### 1. Edit-and-restart (almost everything)

Most tunables are read from `src/config.js` when the bot boots. To change one:

1. Open `src/config.js`.
2. Find the section and value (the section names below match the file exactly).
3. Edit the number, **save**, and **restart the bot** (stop the container/process
   and start it again). The new value takes effect on the next boot.

Nothing is read live from this file mid-run, so a change has **no effect until
you restart**. That's intentional — it keeps a running raid deterministic.

### 2. Runtime, no restart (a small set, via chat commands / RTDB)

A few settings are stored in Firebase (RTDB) instead of being baked in at boot,
so a mod can change them **while the bot is running**. These are the
"live operations" knobs:

| What | How (chat command) | Where it's stored (RTDB) |
|---|---|---|
| **EXP gate** — on / off / auto | `!exp on` · `!exp off` · `!exp auto` · `!exp status` | `config/expMode` |
| **Chat output mute** — silence sends, keep listening | `!mute on` · `!mute off` · `!mute status` (bare `!mute` toggles) | `config/chatMuted` |
| **Auto drop scheduler** — on/off + interval | `!drops on` · `!drops off` · `!drops every <min>` · `!drops status` | `config/dropScheduler` |
| **Clip mode** — which of `!clip`'s outputs run | `!clipmode horizontal vertical twitch` · `!clipmode local\|all\|off` · `!clipmode status` | `config/clipMode` |
| **Stream timer** — the one mod countdown | `!timer 10m [label]` · `!timer +5` · `!timer -2m` · `!timer pause` / `resume` · `!timer stop` | `config/timer` |
| **Reminders** — schedules, text, on/off | `!reminder` · `!reminder at ghosty 08:00 17:00` · `!reminder every hydration 60` · `!reminder off <id>` | `config/reminders/<id>` |
| **Media slots** — number → OBS media source | `!media inputs` · `!media set 3 <source>` · `!media scene 3 <scene>` · `!media action 3 stop` · `!media clear 3` | `config/media/<n>` |
| **Live status** (set automatically by Twitch) | _(no command — EventSub / Helix poll set it)_ | `config/live` |
| **Active season** | `!season start <id>` · `!season rollover <id>` | `config/season/current` |
| **Active raid / boss / phase** | `!boss set <name>` · `!boss next` · `!raidnight` | `config/raid`, `bosses/...` |

**Important seeding caveat.** For the settings that have *both* a `config.js`
default *and* an RTDB home — the **EXP mode** (`liveGate.defaultExpMode`), the
**drop scheduler** (`loot.scheduler.enabled` / `intervalSec`) and the **clip mode**
(`clip.defaultMode`) — the `config.js` value is only used to **seed RTDB the very
first time** the bot connects to an empty database. After that first boot, the live value lives in RTDB and is
controlled by the chat commands above. Editing those defaults in `config.js`
later and restarting will **not** override what's already in RTDB. Use the chat
commands to change them once the bot has run once.

Everything else in this document is edit-and-restart.

---

## `exp` — chat EXP & leveling

Controls how fast heroes earn EXP and level up by chatting. See the dedicated
**Leveling mechanic** section at the bottom for the full picture; this table is
the per-knob summary.

| Key | Default | What it controls | Effect of changing it |
|---|---|---|---|
| `perMessage` | `12` | Base EXP granted per qualifying chat message (before sub multipliers). | Higher = everyone levels faster across the board. The simplest "speed up / slow down all leveling" lever. Try 8–20. |
| `cooldownMs` | `30000` (30 s) | Minimum gap between two EXP-earning messages from the same user. Doubles as the anti-flood / anti-offline-farm guard. | Higher = chatting fast no longer pays; slows grinding. Lower = more EXP per active chatter (and more spam-to-grind risk). 15–60 s is sane. |
| `threshold.base` | `100` | EXP needed to fill the bar at **level 1**. | Higher = every level is a bigger climb (slower overall). |
| `threshold.growth` | `1.3` | How much each level's bar grows over the last (geometric). `threshold(L) = round(base × growth^(L−1))`. | The single most important pacing dial for the *late* game. `1.3` keeps a season's top levels reachable in ~6 weeks. Raise toward `1.4` to make high levels much harder; lower toward `1.2` to flatten the curve. |
| `levelUp.base` | `0` | Starting per-message chance to level up *once the bar is full*. **`0` means the message that fills the bar can never be the one that levels you** — no lucky early levels. | Leave at `0` for "no random early levels." Raising it would let a level pop the instant the bar fills (re-introduces luck). |
| `levelUp.k` | `0.34` | How fast the level-up chance climbs per qualifying message after the bar is full. | Higher = levels land sooner/more sharply after the bar fills (more deterministic). Lower = a longer, more random tail. |
| `levelUp.cap` | `1.0` | Maximum per-message level-up chance. | At `1.0` the chance can reach certainty. Rarely worth changing. |
| `levelUp.pressureCap` | `4` | Hard guarantee: a level is **forced** within this many qualifying messages after the bar fills, even if the random rolls keep failing. | Lower (e.g. `1`) = levels the instant the bar fills (fully deterministic). Higher = a longer possible tail before the guaranteed pop. |

> **Note on `expMode` vs `exp`:** whether EXP is granted *at all* is the **live
> gate**, not these numbers. That's `liveGate.defaultExpMode` below (seed default)
> and the runtime `!exp on|off|auto` command. These `exp` numbers only decide
> *how much* and *how fast* once the gate is open.

---

## `rating` — role rating

A hero's "role rating" drives their combat power (HP / attack / healing). It's
`classBase[role] + level × perLevel + equipped-gear bonuses`, plus a small
persistent veteran bonus.

| Key | Default | What it controls | Effect of changing it |
|---|---|---|---|
| `classBase.tank` / `.healer` / `.dps` | `100` / `90` / `80` | The floor rating each role starts with at level 1 (before gear). | Re-tunes the relative baseline of the three roles. Raising one role's base makes that role stronger before anyone has leveled or geared. |
| `perLevel` | `10` | Rating gained per hero level. | Higher = levels matter more for combat (steeper power curve). Combined with gear, +10 rating ≈ a meaningful but not dominant step. |
| `renownPerPoint` | `2` | Permanent rating granted per point of veteran **renown**. Renown is earned by clearing raids and **persists across seasons** (gear resets, renown doesn't). | Higher = veterans get a bigger lasting edge. |
| `renownCap` | `40` | Maximum renown that counts toward the bonus → max permanent bonus is `renownCap × renownPerPoint` = **+80 rating**. | The ceiling on the veteran advantage. Keeps long-time players ahead but never untouchable for newcomers. |

---

## `engagement` — sub / cheer multipliers

A multiplier applied to **both EXP gain and raid combat power**, based on a
viewer's Twitch sub tier. This is how subscribing makes you grow faster and hit
harder. It is deliberately **not** applied to chat-loot grabs (those stay
tier-fair — see `loot.claimChance`).

| Key | Default | What it controls | Effect of changing it |
|---|---|---|---|
| `base` | `1.0` | Multiplier for a non-subscriber. | Leave at `1.0` (the neutral baseline). |
| `subTier.0` / `.1` / `.2` / `.3` | `1.0` / `1.3` / `1.55` / `1.8` | Multiplier by sub tier (0 = none/Prime-as-1, 1/2/3 = Tier 1/2/3). | Raise to make subscribing more rewarding; lower to flatten the sub advantage. These feed straight into how fast subs level and how hard they hit. |
| `cheerPerHundredBits` | `0.0` | Reserved (future): extra multiplier per 100 bits cheered. **Kept `0` so bits can't buy EXP.** | Leave `0` unless you deliberately want bits to grant power (pay-to-win territory). |
| `max` | `2.0` | Hard clamp on the *total* multiplier, so stacked levers can't run away. | The safety cap. Keep it above your highest `subTier` value. |

---

## `loot` — drops & claiming

Controls what drops, how rare it is, and the claim **lottery**. Each drop is a
drawing: everyone who `!grab`s within the window is entered, then **one** winner
is drawn for the **one** item — a drop never mints duplicates, and every entrant
has equal odds (tier-fair, no sub-tier loot edge). Overlapping drops **queue** and
resolve one after another (see `maxQueue`).

| Key | Default | What it controls | Effect of changing it |
|---|---|---|---|
| `rarityWeights` | `common 60, uncommon 25, rare 10, epic 4, legendary 1` | Relative odds of each rarity for **chat drops**. Bigger weight = more common. | Tilt toward rarer items by raising the high-rarity weights. These are *weights*, not percentages — they're normalized against each other. |
| `bossRarityWeights` | `common 18, uncommon 34, rare 28, epic 14, legendary 6` | Same idea but for **boss-battle rewards** — a deliberately richer table so clearing a raid feels better than a chat grab. | Make raid clears more/less rewarding relative to chat drops. |
| `windowMs` | `60000` (60 s) | How long a drop stays **open for entries** before the winner is drawn. | Longer = more time for people to `!grab` into the draw. Shorter = snappier, more exclusive. |
| `maxQueue` | `10` | Most drops that can be lined up at once (the open drop + those waiting). Overlapping drops **queue** and resolve one after another, `windowMs` apart; drops past the cap are ignored. | At 60s windows, `10` ≈ 10 min of back-to-back drops. Raise for longer chains; lower to cap how long a flurry can run. |
| `scheduler.enabled` | `false` | Whether the **automatic** chat-drop loop runs while live. **Runtime-tunable** via `!drops on/off` (RTDB-seeded — see the seeding caveat above). | Turn on to have loot rain on a timer without a mod forcing each `!drop`. Default off so it starts quiet. |
| `scheduler.intervalSec` | `900` (15 min) | Average gap between auto drops. **Runtime-tunable** via `!drops every <min>` (1–240). Enforced floor of 60 s. | Lower = more frequent loot (good for big, gear-hungry chats). |
| `scheduler.jitter` | `0.3` (±30%) | Randomizes the interval so drops aren't clockwork. **Edit-and-restart only** (not stored in RTDB). | Higher = more unpredictable timing; `0` = exact interval. |

> The auto scheduler only fires while the **EXP gate is open** (stream live, or
> `!exp on`) *and* `enabled` is true.

---

## `raid` — weekly raid lifecycle

The muster → raid-night → battle cycle.

| Key | Default | What it controls | Effect of changing it |
|---|---|---|---|
| `seasonWeeks` | `6` | Weeks in a season (weekly bosses + a finale). | Longer/shorter seasons. Used when `!season start` opens a tier. |
| `lockLeadMs` | `900000` (15 min) | How long **before** raid night the roster locks. Gear/levels gained after lock don't affect that battle (fairness + determinism). | Longer = an earlier cutoff to muster; shorter = you can keep gearing closer to the fight. |
| `maxRevealMs` | `480000` (8 min) | Upper bound on how long the battle "reveal" plays out before the bot flips the phase to *done*. | Mostly a safety bound on the replay length; rarely needs tuning. |
| `defaultBossHp` | `6000` | HP for a boss made with `!boss set <name>` that has no explicit HP. Tuned so a modest roster downs it within the turn cap. | Raise for tougher custom bosses, lower for pushovers. (Scripted season bosses carry their own HP from `src/content/`.) |
| `defaultBossAtk` | `90` | Default attack for such a boss. | Higher = the boss hits harder; raises wipe risk for thin rosters. |
| `rosterRefreshMs` | `60000` (60 s) | While muster is **open**, how often the bot re-snapshots each signee from their live record so leveling/gearing up after mustering shows on the site without a re-`!muster`. No-op outside the signup phase; only rewrites cards that actually changed. | Lower = the roster page tracks heroes more promptly (more reads during a signup week); raise to ease load. It never needs to be real-time — the battle uses the **lock**-time snapshot regardless. |

---

## `raidNight` — the weekly time slot

When raid night fires automatically, anchored to a real time zone (DST-aware) so
it always lands at the right wall-clock time regardless of the server's clock.

| Key | Default | What it controls | Effect of changing it |
|---|---|---|---|
| `timeZone` | `'America/Los_Angeles'` | IANA time zone the schedule is anchored to. | Set to your stream's local zone (e.g. `'America/New_York'`, `'Europe/London'`). |
| `dayOfWeek` | `0` (Sunday) | Day of week for raid night. `0 = Sun … 6 = Sat`. | Move raid night to your usual stream day. |
| `hour` | `20` (8 PM) | Hour (24-h clock, local to `timeZone`). | Set your start time. |
| `minute` | `0` | Minute of the hour. | Fine-tune the start time. |

> A mod can always fire a raid early with `!raidnight`, regardless of this slot.

---

## `combat` — the automated battle engine

These shape how the auto-resolved boss fight plays out. Defaults are tuned to
produce dramatic, decisive fights; most owners never need to touch these.

| Key | Default | What it controls |
|---|---|---|
| `turnCap` | `100` | Backstop against an infinite fight. Real fights end via the enrage timer long before this — set high so long back-and-forth fights play out. |
| `enrage.startTurn` | `12` | After this turn the boss's damage starts ramping. |
| `enrage.perTurnMult` | `1.18` | Boss damage is multiplied by `1.18^(turn − startTurn)` — guarantees any stalemate resolves into a real win or wipe. |
| `msPerEvent` | `1200` | Milliseconds per combat event in the replay. **Must match the website replay player** (`arena.html`); don't change one without the other. |
| `variance` | `0.2` | ±20% random swing on damage/heal numbers. |
| `crit.party` / `crit.boss` | `0.16` / `0.12` | Crit chance for heroes / the boss. |
| `crit.mult` / `crit.bossMult` | `1.8` / `1.7` | Crit damage multipliers. |
| `bossTankTargetChance` | `0.4` | How often the boss focuses the tank vs. spreading hits. |
| `defaultBossAtk` | `90` | Fallback boss attack inside the engine. |
| `adds.*` | `hpFactor 1.5, atkFactor 0.35, maxAlive 6, focusChance 0.45` | Stats/behavior of affix "add" critters, derived from the boss's attack so they scale with the season. |
| `ai.healAt` | `0.6` | Healers heal when the lowest ally drops below this HP fraction. |
| `ai.healCritAt` | `0.3` | …and use their strongest heal below this fraction. |
| `ai.dpsPowerBias` | `1.6` | How strongly dps/tank actors favor high-power abilities. |
| `ai.bossAoeBias` | `1.0` | How much the boss favors AoE as more heroes are alive. |
| `stats.hpBase` | `200` | Flat HP every hero starts with before rating. |
| `stats.hpPerRating` | `tank 1.4, healer 1.0, dps 0.8` | HP gained per point of role rating, by role. |
| `stats.atkPerRating` | `tank 0.18, healer 0.12, dps 0.3` | Attack per rating, by role. |
| `stats.healPerRating` | `healer 0.45` (tank/dps `0`) | Healing power per rating — only healers heal. |

Practical levers here: raise a boss's HP (in `raid.defaultBossHp` or the content
files) to make fights longer; nudge `crit.*`/`variance` for more or less swing;
adjust `stats.*PerRating` to rebalance the three roles. Leave `msPerEvent` alone
unless you're also changing the website.

---

## `liveGate` — the live/EXP gate

| Key | Default | What it controls | Effect of changing it |
|---|---|---|---|
| `pollIntervalMs` | `45000` (45 s) | How often the bot polls Twitch (Helix) for live status as a fallback to EventSub. | Lower = faster live-detection but more API calls; 30–60 s is the safe band. |
| `defaultExpMode` | `'auto'` | The **seed default** for the EXP gate: `on` (always grant), `off` (never), `auto` (follow live status). Stored in RTDB on first boot; thereafter controlled by `!exp`. | Leave `auto` for normal operation. `on` is the offline-testing / watch-party mode. (Change it live with `!exp`, not by editing this after first boot — see the seeding caveat.) |

---

## `clip` — what `!clip` does

| Key | Default | What it controls | Effect of changing it |
|---|---|---|---|
| `defaultMode` | `'horizontal,vertical'` | The **seed default** for `!clip`, as a set of targets: `horizontal` (16:9 local file), `vertical` (9:16 local file), `twitch` (public clip link) — any combination, plus the shorthands `local`, `all`, `off`. Stored in RTDB on first boot; thereafter controlled by `!clipmode`. | Leave it. A Twitch clip is capped at your *stream* resolution, so it can never be the high-quality keepsake — that's the whole point of the local capture. (Change it live with `!clipmode`, not by editing this after first boot — see the seeding caveat.) |

Same seeding rule as `defaultExpMode`: **editing this does nothing to an existing
deployment**, because `config/clipMode` is already populated. Use `!clipmode` in chat.

`!clipmode status` also reports whether each half can actually run — useful when
`!clip` is telling viewers clipping isn't set up and you want to know which piece is
missing.

> Clip **length** is not configured here, or anywhere in kennyBot — it comes from
> OBS's Replay Buffer and Aitum's Backtrack settings on the streamer's PC. See
> [`clip-architecture.md`](clip-architecture.md).

---

## `!media` — playing an OBS media source from chat

**There is nothing to configure in `config.js`.** Media slots are runtime-only
records at `config/media/<n>`, mapped from chat with `!media set` — and unlike the
clip mode they ship **empty**, with no seed at all. A default slot would name an OBS
source that exists on no particular machine, and a slot pointing at nothing fails
live, in front of chat.

| Field | Required | What it is |
|---|---|---|
| `inputs` | yes | one or more OBS **source names**, character for character as OBS spells them, fired together. OBS keeps a GIF and its sound as separate sources, so an alert is normally two entries. Max 5 |
| `scene` | no | a scene to reveal that source in *before* playing — this is what makes a visual alert work; omit it for sounds that are always in the active scene |
| `action` | no | `restart` (default) · `play` · `pause` · `stop` · `next` · `previous` |
| `label` | no | a human name, so `!media` reads as more than numbers |

Slot numbers run 1–20. `restart` is the default because it plays from the first
frame whether the source is idle, mid-playback or already **finished** — and
"finished" is the state an alert sits in almost all the time, where plain `play`
does nothing at all.

**Getting the names right is the whole job.** They must match OBS exactly, so use
`!media inputs` (or `node scripts/obs-media.mjs`, which needs only the two `OBS_*`
env vars and not a running bot) rather than typing them from memory. Renaming a
source in OBS silently breaks any slot pointing at it — the next fire replies with
the missing name, which is the intended failure.

Two behaviours worth knowing:

- **A successful play is silent in chat.** The sound is the feedback. Every failure
  replies — so silence means OBS accepted the request, and if you heard nothing the
  problem is on the OBS side.
- **Hiding the source again is OBS's job**, via the Media Source property *Show
  nothing when playback ends* (setting key `clear_on_media_end`, **on by default**).
  kennyBot deliberately holds no "hide it later" timer. Because that default already
  blanks a finished source, you can leave the scene item permanently visible and skip
  the `scene` field entirely — which is the recommended setup.
- **A muted or zero-volume source still reports success.** OBS gives no way to tell,
  so that is the first thing to check when a slot fires and nobody hears anything.

Connection comes from the same `OBS_WEBSOCKET_URL` / `OBS_WEBSOCKET_PASSWORD` the
clip capture uses — one OBS, one place to configure it.

---

## `reminders` — scheduled chat nudges (`!reminder`)

The recurring pings: the Wallpaper Engine check, Ghosty's meal times, the hourly
hydration nudge. **The schedules are not in this file.** Each reminder is a
record in RTDB at `config/reminders/<id>`, seeded once from
[`src/content/reminders.js`](../src/content/reminders.js) and edited from chat
with `!reminder` — so re-timing Ghosty's dinner never needs a deploy, and a time
you changed is **never** overwritten by a later release.

The settings below are only the engine-wide bounds that apply to every reminder.

| Key | Default | What it controls | Effect of changing it |
|---|---|---|---|
| `tickMs` | `20000` (20 s) | How often schedules are checked. | A daily slot can land up to this late. Minute-accuracy is all these need; lower only burns CPU. |
| `dailyGraceMs` | `300000` (5 min) | How long after its wall-clock time a daily slot may still fire. Past it, the slot is skipped. | This is what stops a bot that boots at noon from announcing the 08:00 meal. Raise it if you'd rather have a slightly late ping than none; a per-reminder `graceMs` overrides it. |
| `afterLiveWindowMs` | `7200000` (2 h) | How late an "N minutes after going live" reminder may still be announced. Past it the session is marked handled and nothing is said. | Only matters when the bot boots hours into a stream. |
| `defaultTimeZone` | `'America/Los_Angeles'` | The zone a daily reminder uses when it names none of its own. | Per-reminder `timeZone` (set with `!reminder zone <id> <IANA>`) always wins. |
| `maxTextLen` | `200` | Longest message text accepted from chat; longer is clipped with `…`. | Keeps a pasted paragraph out of a recurring announcement. |

### The reminder record

One of three `kind`s. Fields not used by a kind are simply ignored.

| Field | Applies to | Meaning |
|---|---|---|
| `id` | all | Short name mods type: `!reminder off ghosty`. |
| `enabled` | all | `false` makes it inert without deleting it (`!reminder on\|off <id>`). |
| `channel` | all | Fires **only** on this Twitch channel. `null` = any channel the bot runs in. This is what makes a reminder channel-specific — there is no per-channel code. |
| `liveOnly` | all | Default `true`: nothing is announced while the channel is offline. |
| `text` | all | What it says. |
| `afterMs` | `afterLive` | How long into a live session it fires. Once per session. |
| `times` / `timeZone` | `daily` | Wall-clock `HH:MM` times in an IANA zone (DST-aware — 08:00 stays 08:00 across the change). |
| `leadMs` / `leadText` | `daily` | An optional heads-up this long before each slot. `0` disables it; without `leadText` the wording is generated. |
| `graceMs` | `daily` | Per-reminder override of `dailyGraceMs`. |
| `everyMs` / `jitterMs` | `interval` | Period of **live** time between pings, ± the jitter (jitter is capped at half the period). |
| `state` | all | Bot-managed: what has already fired. Persisted so a restart can't repeat an announcement. Don't hand-edit. |

---

## `timer` — the mod stream countdown (`!timer`)

The chat-set countdown for breaks and intermissions ("brb 10", "starting in 5").
It isn't part of the game: no EXP, no credits, no live gate — a mod can set one
before going live. There is only ever **one** timer; setting another replaces it.

The countdown is stored as an absolute deadline in RTDB (`config/timer`), so a
bot restart resumes the same timer instead of losing it. What a restart *does*
reset is which heads-up marks have already been announced — deliberately, so a
restart can't make the bot repeat a "1 minute left" it already posted.

| Key | Default | What it controls | Effect of changing it |
|---|---|---|---|
| `minMs` | `5000` (5 s) | Shortest timer that can be set. | Below a few seconds a timer is just chat noise. Rarely worth changing. |
| `maxMs` | `43200000` (12 h) | Longest timer that can be set, and the ceiling `!timer +X` can push one to. | The guard against a typo (`!timer 999`) camping a countdown for weeks. |
| `warnAtMs` | `[300000, 60000]` (5 min, 1 min) | The heads-up announcements, fired as the clock **crosses** each mark. | Add marks for a chattier countdown (e.g. `[600000, 300000, 60000]`), or set `[]` for a silent timer that only speaks when it's up. |
| `warnMinLeadMs` | `30000` (30 s) | How much runway a timer must have **before** a mark for that mark to be used. A 5-minute timer therefore skips the 5-minute heads-up (it would fire at once), while a 6-minute timer gets it a minute in. | Raise it to suppress heads-ups that land soon after a timer starts; lower it toward `0` to let every mark fire whenever it's crossed. Judged against the time left when the timer was set or last adjusted, so `!timer +5` re-qualifies a timer that had grown too short. |
| `graceMs` | `120000` (2 min) | How overdue an expired timer may be and still get its "time's up" announced. Past this it's cleared silently. | This only matters when the bot was down at the moment a timer expired. Raise it if you'd rather hear a late call than none; lower it to keep the bot from ever announcing stale news. |
| `tickMs` | `1000` (1 s) | Countdown resolution. Each tick reads memory only — RTDB is touched just when the timer actually fires. | Higher = a "time's up" that can land that much late. Little reason to change. |
| `maxLabelLen` | `60` | Longest timer label; longer ones are clipped with `…`. | Keeps a pasted paragraph out of every heads-up line. |

---

## `lock` — single-instance lease

kennyBot must run as exactly one instance (two = double EXP/loot). A lease in
RTDB enforces this.

| Key | Default | What it controls | Effect of changing it |
|---|---|---|---|
| `heartbeatMs` | `15000` (15 s) | How often the running instance renews its lease. | Rarely changed. |
| `staleMs` | `60000` (60 s) | A lease older than this is treated as abandoned (a crashed instance) and can be taken over. **Must be comfortably larger than `heartbeatMs`.** | Lower = faster failover after a crash, but raise the risk of a false takeover during a hiccup. Keep it ≥ ~3× `heartbeatMs`. |

---

## `siteUrl`

| Key | Default | What it controls |
|---|---|---|
| `siteUrl` | `'https://okrafans.com'` | The website link the bot surfaces in `!muster` / `!char` replies. Set it to your published site. |

---

## The leveling mechanic, explained

Leveling is the part owners most often want to tune by *feel*, so here's exactly
how it works. It's deliberately **predictable and earned — never a lucky fluke.**

### Two phases per level

1. **Fill the bar.** Each qualifying chat message grants `exp.perMessage` EXP
   (scaled up for subs by the `engagement` multiplier). Until the bar reaches
   `threshold(level)`, there is **zero chance to level up** — you're just filling.
2. **The accumulating level-up chance.** Once the bar is full, *each further
   qualifying message* rolls a chance to actually level up. That chance **starts
   at `levelUp.base` and climbs by `levelUp.k` every message:**

   ```
   chance = min( base + k × pressure , cap )
   ```

   where `pressure` is the number of qualifying messages you've spent eligible
   but not-yet-leveled (it resets to 0 when you level). With the defaults
   (`base 0, k 0.34, cap 1.0, pressureCap 4`):

   | message after the bar fills (`pressure`) | level-up chance |
   |---|---|
   | the bar-filling message itself (`0`) | **0%** — never levels here |
   | +1 | 34% |
   | +2 | 68% |
   | +3 | 100% (and force-guaranteed by `pressureCap`) |

So a level lands **about 1–3 messages after the bar fills** — predictable and
earned, never a random early jackpot. Because `base = 0`, the message that
crosses the threshold can *never* be the one that pops, so there are **no lucky
single-roll early levels.** The leftover EXP past the threshold carries into the
next level, so no message is wasted.

### How it feels in practice

For a **Tier-1 subscriber** (engagement ×1.3, so ~16 EXP per message with the
default `perMessage 12`), with the default `threshold` curve:

| Level-up | Approx. qualifying messages |
|---|---|
| L1 → L2 | ~9 |
| … climbing each level … | … |
| L9 → L10 | ~51 |
| **Total to reach L10** | **~203 messages** |

Non-subscribers (×1.0, ~12 EXP/message) take proportionally a bit longer; higher
sub tiers are faster still. Remember the **30 s cooldown**: only one message every
30 seconds earns EXP, so ~203 messages is real, sustained chatting across multiple
streams — exactly the season-long grind it's meant to be.

### Making it stricter or looser

- **Faster / slower overall:** raise / lower `exp.perMessage`. This is the
  blunt, everyone-feels-it lever.
- **Harder *high* levels (without touching the early game):** raise
  `exp.threshold.growth` (e.g. `1.3 → 1.35`). Lower it to flatten the late curve.
- **More deterministic levels (less tail randomness):** raise `levelUp.k` and/or
  lower `levelUp.pressureCap`. At `pressureCap: 1` a level lands the **instant**
  the bar fills, every time — fully deterministic.
- **Looser tail (more drawn-out, more random):** lower `levelUp.k` and raise
  `levelUp.pressureCap`.
- **Do not** raise `levelUp.base` unless you *want* to re-introduce the chance of
  a level popping the moment the bar fills (i.e. lucky early levels). `0` is what
  keeps leveling free of luck.
