# kennyBot Raid Game — Agent Handoff (bot / backend track)

You are picking up the **bot/backend** side of the kennyBot raid game. A separate
track is concurrently building the **website UI** (`nikkibreanne.github.io`).
**Do not edit the website repo.** Your interface to it is Firebase (the §9 data
model) + the RTDB security rules — see "Interface contract" below.

## Read first (authoritative — in this repo's `docs/`)
1. `docs/raid-game-spec.md` — the game **design** (what to build). §13 is a list
   of **open questions for the human — flag them, don't silently invent answers.**
2. `docs/IMPLEMENTATION.md` — the **how**: backend restructure (§G),
   Firebase/EventSub/Docker/GHCR, secrets & token refresh (§F), security rules
   (§I), hardening (§K), combat engine (§L), and the **POC plan (§H)**.

Those two are the source of truth. This note just orients, sequences, and sets
guardrails — it does not restate them.

> Project docs are committed in `docs/`. Keep **secrets and infra/host/topology
> detail** out of all committed files (and the repo); genuinely-private/scratch
> notes can go in the gitignored `.workspace/` if needed.

## Current repo state
Old Pokémon-catch demo: `index.js` (tmi.js@1.4.5 + lowdb `db.json`), one
`client.on("chat")` switch, channel hardcoded to the test channel `scasplte2`,
secrets via `dotenv`. No Firebase, no Docker, no tests. **Do not extend the
Pokémon schema** — rebuild toward the spec's §9 model; keep `db.json` only as a
throwaway local fixture.

## Hard constraints (already decided — do not relitigate)
- **Outbound-only.** EventSub via the **WebSocket** transport, never webhooks. No
  inbound listeners/ports. (IMPLEMENTATION §B.)
- **Persistence = Firebase RTDB via Admin SDK** (service account). Shared project
  `okrafans` (same project the website poll uses).
- **Game state is client-read-only.** All authoritative writes go through the
  Admin SDK; lock the RTDB rules (IMPLEMENTATION §I). The poll's **wide-open
  rules must NOT be reused** for game paths. Verify a malicious client write is
  rejected before building on top.
- **Single bot instance** (two = double EXP/loot). Idempotent writes via RTDB
  **transactions** / atomic increments.
- **Twitch auth = a refresh token persisted across restarts** (a static access
  token dies in ~4h and silently bricks the bot). IMPLEMENTATION §F.
- **Secrets only at runtime** — never commit or bake into the image. Add
  `serviceAccount*.json` to `.gitignore`.
- Channel from **env** (`TWITCH_CHANNEL`); keep `scasplte2` as the dev/test
  default, `nikkibreanne` for prod.

## Build order (Phase 0 + the POC vertical slice — see IMPLEMENTATION §G/§H)
1. **Restructure** `index.js` → command registry + pure `rules/` modules (RNG
   injectable) + `db/` (Firebase Admin). One module per command.
2. **Firebase Admin init** + the §9 data model; **lock the rules** and verify a
   client write is rejected.
3. **`!create <class>`** → player record + starter gear.
4. **Live gate:** Helix poll fallback first (cheap safety net), then EventSub-WS
   `stream.online`/`stream.offline` → `config/live`; `!exp on|off|auto` override
   (default `auto`).
5. **Chat EXP** with per-user cooldown → level-up (fixed threshold +
   accumulating chance, **no random early levels**; pure, unit-tested, seeded RNG).
6. **Raid lifecycle + automated battle** (active resolution — spec §5.8,
   `IMPLEMENTATION.md §L`). Phase machine `signup → locked → live → done`:
   `!raid` to enlist; freeze loadout snapshots + team aggregate at `locksAt`; run
   the **seeded, pure, turn-based battle engine** (`simulateBattle`) at
   `startsAt`; write the **append-only combat event log** + result; distribute
   loot. **Resolve-on-boot if overdue** — never rely on an in-memory timer.

That slice + the website read layer = the first demonstrable end-to-end loop.
(The website already renders the muster page + a **live battle replay player**;
it ships a reference engine `genDemoBattle()` you can mirror — but the
**authoritative engine lives here in kennyBot.**)

## Testing (local-first — this is the agreed approach)
- **Local first.** Don't go live to test: set `expMode=on` to bypass the live
  gate, use mod commands (`!drop`, `!boss set`, `!exp`) to force states, and/or a
  small script that emits synthetic chat events.
- **Twitch integration**, when ready, runs against the owner's personal channel
  **twitch.tv/scasplte2** (already the code's default channel).
- **Engine is pure + seeded** → unit-test the EXP curve, level-up roll, loot rolls,
  and raid resolution with no Twitch/Firebase dependency.
- **Firebase:** prefer the **emulator suite** or a separate test DB path so
  testing doesn't pollute prod game state.

## Interface contract with the UI track (don't break silently)
The website **reads** these paths (shapes per spec §9 + the combat extensions in
`IMPLEMENTATION.md §L`):
- `config/raid` — active-raid pointer + schedule: `{seasonId, weekId, phase, locksAt, startsAt}`.
- `bosses/<seasonId>/<weekId>` — boss def (name, hp, affix, thresholds).
- `raids/<seasonId>/<weekId>/signups/<uid>` — frozen loadout snapshots (class, role, level, roleRating, maxHp, power/defense/healing, equipped items w/ rarity).
- `raids/<seasonId>/<weekId>/team` — aggregate (count, byRole, roleRating, power, defense, healing).
- `raids/<seasonId>/<weekId>/combat` — `{seed, status, startsAt, bossMaxHp, result, log}`; `log` is append-only with **ascending integer keys**; event shape in §L.3.
- `players/<twitchUserId>`, `leaderboard/<seasonId>`, `usernames/<login>`.

**If you change a path or field shape, tell the human** so the UI track updates.
This is the shared contract between the two tracks.

**Refinements the UI needs (it falls back gracefully without them, but implement
them for full function):**
1. **Username index:** maintain `usernames/<lowercaseLogin> = <twitchUserId>` on
   `!create`, so the site can look up a hero by Twitch name (no other login→id
   mapping exists). Same client-read-only rules.
2. **Combat-log keys must sort numerically** (`0,1,2,…`) — the player orders by
   `Number(key)`. Use zero-padded keys or plain integers, not Firebase push-ids
   (which sort lexicographically and would scramble at 10+).
3. **Optional but nice:** stamp running HP on events (`bossHpAfter`,
   `targetHpAfter`) so HP bars are exact; the UI recomputes from `amount` if
   absent.
3. **Live HP:** for the bar to tick down *through* the week (not only at close),
   keep `raids/<s>/<w>/result.bossHpRemaining` (and per-player
   `contributions.*.damageDealt`) updated as damage accrues. The UI renders from
   `result` if present, else sums `contributions`.

## Definition of done — milestone 1
A viewer can `!create`, earn EXP and level up while gated live (or with
`expMode=on`), and contribute to a boss whose HP ticks down in Firebase — and the
website can read all of that. Engine logic is unit-tested; rules are locked and
the client-write rejection is verified; everything runs locally against
`scasplte2`.

## Surface to the human before hard-coding (spec §13)
Class list & role mapping, raid resolution (passive vs active), prizes,
loot contention model, equipment slots, season reset policy, EXP default.
The spec proposes sensible defaults — confirm, don't assume.

## Also pending a human decision
Making this repo **private** (recommended — it currently exposes anti-cheat /
economy internals). History was scanned and is clean (no secret ever committed),
so going private needs no rotation. Don't act on this yourself; it's the owner's call.
