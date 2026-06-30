# kennyBot Raid Game — Backend & Deployment Implementation

Companion to [`raid-game-spec.md`](./raid-game-spec.md) (the design spec).
This doc is the **how**: how the bot is built, how it talks to Twitch and
Firebase, how it ships as a container, and how to stand up a POC of the game
loop. The website read-layer is specified separately in `docs/raid-game-ui.md`
in the **nikkibreanne.github.io** repo.

Where this doc makes a choice the design spec left open (§13), it says so.

> **Scope note.** This describes the application's *deployment contract* — what
> the container needs to run safely — not any particular environment it runs in.
> Concrete hostnames, IPs, paths, registry credentials, and network topology are
> **operational secrets** and live outside version control (a private runbook /
> secrets manager), never in this repo.

---

## A. Deployment model: a stateless, outbound-only container

Once persistence moves to Firebase (§G), the bot holds no durable local state,
so a container is the right unit of deployment: build once in CI, publish to a
registry, pull and run. Redeploys are pull-and-restart; rollbacks are
pull-a-previous-tag.

```
push to master ──► GitHub Actions: docker build + push ──► GHCR (private)
                                                             │  authenticated pull
                                                             ▼
                                                   long-lived container
                                                             │  outbound only
                                                             ▼
                                                   Twitch  +  Firebase
```

Two application-level properties make this safe and simple, and both are design
requirements, not accidents:

1. **Outbound-only** (§B) — the bot initiates every connection and **listens on
   nothing**, so the container publishes no ports and has no inbound attack
   surface.
2. **Stateless** (§G) — state lives in Firebase; the only mutable local artifact
   is the rotating Twitch token (§F), which needs one small writable volume.

---

## B. Outbound-only — and the one decision that preserves it

Every connection the bot needs is one **it initiates**:

| Purpose | Endpoint | Direction | Port |
|---|---|---|---|
| Chat (tmi.js) | `irc-ws.chat.twitch.tv` (WSS) | outbound | 443 |
| Helix REST (live status, user lookups) | `api.twitch.tv` | outbound | 443 |
| Twitch OAuth token refresh | `id.twitch.tv` | outbound | 443 |
| **EventSub events** | `eventsub.wss.twitch.tv` (WSS) | **outbound** | 443 |
| Firebase Admin (RTDB writes) | Google APIs / `*.firebasedatabase.app` | outbound | 443 |

**The load-bearing decision: EventSub over WebSocket, not webhooks.** EventSub
has two transports:

- **Webhook transport** — Twitch sends HTTP POSTs to a public HTTPS URL *you*
  expose. That requires an **inbound** endpoint: a reachable URL, a TLS cert,
  and HMAC signature verification — i.e. a public attack surface to defend.
- **WebSocket transport** — *your* process dials out to `eventsub.wss.twitch.tv`
  and Twitch streams events back down the socket you opened. **Outbound only.**
  No inbound endpoint, no cert, no public surface.

WebSocket is the correct transport here. Use
[`@twurple/eventsub-ws`](https://twurple.js.org/docs/getting-data/eventsub/websocket.html)
(handles welcome/keepalive/reconnect/session-reset for you) or a raw `ws` client
if you want zero deps. The design spec §8 already leans this way; this makes it a
hard requirement.

**Resulting posture:** nothing listens → the container publishes **no ports**
(no `-p`). There is no inbound surface to harden. The remaining risk is entirely
(1) secrets handling and (2) supply chain — both covered below.

---

## C. Building the image

### Dockerfile (multi-stage, slim, non-root)

```dockerfile
# ---- build ----
FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .

# ---- runtime ----
FROM node:20-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app .
USER node                       # never run as root
# no EXPOSE — the bot listens on nothing
CMD ["node", "index.js"]
```

- **`node:20-bookworm-slim`, not `alpine`.** `firebase-admin` pulls in gRPC with
  native bits; glibc (slim) is the path of least resistance. Alpine/musl works
  but is a debugging tax you don't need.
- **Pin the base image by digest** (`node:20-bookworm-slim@sha256:…`) so a
  rebuild is reproducible and a poisoned upstream tag can't silently change your
  base. Bump it deliberately.
- A smaller runtime (`gcr.io/distroless/nodejs20-debian12`, no shell/package
  manager) is a worthwhile hardening step *after* the bot is stable — distroless
  makes interactive debugging harder, so don't start there.

### `.dockerignore` (keep secrets and cruft out of every layer)

```
node_modules
.git
*.env
.env*
*.scas
db.json            # local dev fixture only; real state lives in Firebase
serviceAccount*.json
docs               # project docs — no need to ship them in the runtime image
.workspace         # private/scratch notes (if any)
```

Anything copied into a layer is extractable by anyone who can pull the image.
**No secrets in the image, ever** — they arrive at runtime (§F).

---

## D. CI: build and publish to GHCR

`.github/workflows/publish.yml`:

```yaml
name: publish
on:
  push:
    branches: [master]
    tags: ["v*"]
permissions:
  contents: read
  packages: write          # lets GITHUB_TOKEN push to GHCR — no PAT in CI
jobs:
  docker:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - uses: docker/metadata-action@v5
        id: meta
        with:
          images: ghcr.io/nikkibreanne/kennybot
          tags: |
            type=raw,value=latest,enable={{is_default_branch}}
            type=sha
            type=semver,pattern={{version}}
      - uses: docker/build-push-action@v6
        with:
          context: .
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
```

- CI pushes with the built-in `GITHUB_TOKEN` — no stored credential.
- **Keep the GHCR package private.** Even though the image contains no secrets,
  there's no reason to publish your runtime artifact; private is the
  professional default. The pull side authenticates with a **fine-scoped,
  read-only (`read:packages`) token** held only by the runtime — never a
  broad/admin PAT.
- Tags: `latest` (moving target), `:sha-<x>` (pin / rollback), `:vX.Y.Z`
  (releases). Deploy by **immutable digest or sha tag** in anything you want to
  be reproducible; reserve `latest` for convenience.
- Optional hardening: have CI generate an **SBOM** and **provenance/attestation**
  (`docker/build-push-action` supports `sbom: true`, `provenance: true`) so the
  supply chain is auditable.

---

## E. Runtime contract & operational hardening (host-agnostic)

The container runs the same way anywhere. The requirements below are what the
*application* needs; the specific environment, credentials, and paths stay in a
private runbook outside this repo.

```bash
docker run -d --name kennybot \
  --restart unless-stopped \
  --read-only --tmpfs /tmp \              # immutable rootfs
  --cap-drop ALL \                        # the bot needs no Linux capabilities
  --security-opt no-new-privileges \
  --memory 256m --cpus 0.5 \              # blast-radius cap
  --env-file <your-secrets>.env \         # secrets injected at runtime, not baked in
  -v <firebase-sa-json>:/run/secrets/firebase.json:ro \
  -v <token-store-dir>:/data \            # small writable volume for token rotation (§F)
  ghcr.io/nikkibreanne/kennybot:latest    # pin to a digest/sha in practice
```

Operational requirements:

- **No published ports.** Outbound-only — leave port mapping empty.
- **Single instance — this is a correctness invariant, not tidiness.** Two
  replicas process every chat message twice → double EXP, double loot, races on
  the level-up roll. Run it in exactly one place; never leave a second copy running
  "just in case."
- **Statelessness + one writable volume.** Everything authoritative is in
  Firebase; the only local persistence is the rotating token store (§F). Do not
  bind-mount `db.json` into production — it's a dev-only fixture.
- **Least privilege.** Non-root user (set in the image), `--cap-drop ALL`,
  `no-new-privileges`, read-only rootfs. The bot needs no capabilities, no
  privileged access, and no host devices.
- **Health.** No HTTP endpoint exists, so a port probe is meaningless. The image
  ships a **connection-aware** file-based `HEALTHCHECK`: the bot writes a JSON
  snapshot `{ts, chatConnected, live}` to `HEARTBEAT_FILE` on each activity tick,
  and the check reports **unhealthy if the heartbeat is stale OR `chatConnected`
  is false** — so a "process alive but chat socket dead" zombie is restarted
  rather than trusted on a dead connection.
- **Logs.** Write structured logs to stdout/stderr; never log tokens, the
  service-account JSON, or full user PII. Scrub secrets from error output.
- **Updates.** Prefer deliberate, tag-pinned rollouts for a live-stream-facing
  bot over fully automatic image pulls — a surprise rollout mid-stream is worse
  than a delayed one.

---

## F. Secrets & the Twitch token problem (this is what kills 24/7 bots)

### Secrets the container needs
| Secret | Used by | Injection |
|---|---|---|
| Bot account OAuth (**refresh token** + client id/secret) | tmi.js / twurple | env / `--env-file` |
| Twitch **app** client id + secret | Helix + EventSub-WS | env |
| Firebase **service-account JSON** | firebase-admin | mounted read-only file; point `GOOGLE_APPLICATION_CREDENTIALS` at it |

Rules:
- **Never** commit or bake any of these into the image. `.gitignore` already
  covers `*.env`; add `serviceAccount*.json`.
- Prefer **mounting** the Firebase JSON read-only over inlining it in an env var
  (keeps a multi-line credential out of shell history and process listings).
- Treat the service account as **high-value**: it bypasses all Firebase rules.
  Give it the **minimum role** needed (RTDB read/write for this DB only — not
  project Owner). Rotate it if it's ever exposed. Consider a credential
  dedicated to the bot, separate from any used elsewhere.
- The pull credential for GHCR is `read:packages` only — never reuse a PAT with
  write/admin scope on the runtime.

### The token-refresh trap (the #1 silent-failure cause)
A Twitch **user access token expires in ~4 hours.** The current bot uses a static
`process.env.oauthToken`, which will silently die a few hours into the first
unattended run — the bot stays "connected" but can no longer act.

**Fix:** store a **refresh token**, not an access token, and refresh on demand.
Twurple's
[`RefreshingAuthProvider`](https://twurple.js.org/docs/auth/providers/refreshing.html)
does this automatically and fires `onRefresh` with the new token — **you must
persist that new token durably**, or a restart re-uses a stale one. Persist it to
the small writable volume (`/data`), or to a rules-locked
`config/secrets/botToken` path that only the Admin SDK can read/write. This token
store is the one piece of mutable local state a "stateless" container still
needs: it must survive restarts and be writable.

(If chat stays on tmi.js, drive its auth from a twurple `RefreshingAuthProvider`
and feed tmi the current access token; or migrate chat to `@twurple/chat` so one
auth provider covers chat + Helix + EventSub.)

---

## G. Backend restructure (Pokémon bot → game engine)

The current `index.js` mixes I/O and logic in one `switch`. Before adding game
systems, restructure so the **game math is pure and testable** and **commands are
modular**:

```
index.js                 # wiring: connect tmi + eventsub, load config, route events
src/
  config.js              # constants (EXP_PER_MSG, cooldowns, levelUp k/base, drop rates…)
  db/
    firebase.js          # Admin SDK init (GOOGLE_APPLICATION_CREDENTIALS)
    players.js           # get/create/update player (transactions)
    raid.js              # boss + contribution reads/writes
  rules/                 # PURE functions — no I/O, unit-tested, RNG injected
    leveling.js          # exp grant, level-up roll p = base + k*pressure (fixed threshold, no early levels)
    rating.js            # role rating = base(class,level) + gear, * engagementMult
    loot.js              # rarity roll, drop selection
    raidResolve.js       # aggregate contributions vs thresholds + HP → downed/wiped
  events/
    chat.js              # tmi message → shouldGrantExp gate → grantExp/levelUp
    twitchEvents.js      # tmi subscription/cheer/raided → multipliers/communal drops
    eventsub.js          # stream.online/offline → config/live ; (channel points later)
  commands/              # one module per command, registered in a map
    create.js grab.js char.js bag.js equip.js raid.js
    mod/ exp.js drop.js boss.js season.js
```

Migrations from the current code:
- **Persistence: `lowdb`/`db.json` → `firebase-admin`.** Don't extend the
  Pokémon schema; target the spec §9 model. Keep `db.json` only as a throwaway
  local fixture.
- **Dispatch: `switch` → a registry** (`Map<string, handler>`) — a new command is
  a new file, not a longer conditional.
- **Channel: hardcoded `scasplte2` → env (`TWITCH_CHANNEL`).** Keep `scasplte2`
  as dev/test, `nikkibreanne` as prod.
- **RNG injectable.** `rules/*` take an `rng` arg (default `Math.random`) so the
  level-up roll/loot are deterministic under test.
- **Idempotency.** All counters (EXP, loot, raid damage) use RTDB **transactions**
  / atomic increments so a duplicated or echoed Twitch message can't
  double-award. Single instance + transactions = safe.
- **Input handling.** Treat all chat text as untrusted: validate/whitelist
  command args (e.g. `!create <class>` against the known class set, `!equip
  <item>` against the player's own inventory), never interpolate raw chat into
  queries or `eval`, and clamp/bound any numeric inputs.

Document the env contract in the README (names only, no values):
`TWITCH_CHANNEL`, bot client id/secret + refresh token, Twitch **app** client
id/secret, `GOOGLE_APPLICATION_CREDENTIALS`, `FIREBASE_DB_URL`.

---

## H. POC of the game loop — what to build and what to watch for

**Scope the POC to the smallest *closed* loop that proves both the plumbing and
the fun.** Skip loot, equip, seasons, channel points for v0. Minimal vertical
slice:

1. `!create <class>` → writes a character to Firebase (`players/<id>`).
2. Live-gated chat → EXP grant (per-user cooldown) → level-up (fixed threshold +
   accumulating chance, no random early levels).
3. One boss with an HP pool; each chatter's role rating contributes; aggregate
   ticks boss HP down.
4. The website reads Firebase and renders a **live HP bar + your character card**
   (read-only; see the UI doc).

That slice exercises every hard edge: bot→Firebase write path, the **live gate**,
the website read path, and the async raid math.

Priorities:

1. **Prototype the live gate first — the riskiest unknown.** tmi.js can't report
   live status and EXP integrity depends on it. Build the cheap **Helix poll
   fallback** (`GET /helix/streams?user_login=…`, 30–60 s) as a safety net first,
   then add EventSub-WS `stream.online/offline`. Ship the `expMode on|off|auto`
   mod override from day one so you can test offline (`expMode=on`).
2. **Lock Firebase rules before building on them** (§I). The poll's wide-open
   rules are a trap. Decide the rule model on day one and **verify a malicious
   client write is rejected** before stacking game logic on top. Strongly
   consider a **100% read-only client** for v0 (all writes via chat → Admin SDK):
   simplest, safest, removes a whole class of cheating.
3. **Keep the engine pure and config-driven.** EXP/cooldown/leveling/boss-HP/
   thresholds all live in config so you can rebalance without a redeploy. Pure
   `rules/*` + seeded RNG = test the curves without Twitch.
4. **Build a no-stream test harness.** Run against the `scasplte2` test channel,
   use mod commands (`!drop`, `!exp on`, `!boss set`) to force states, and/or a
   tiny script that emits synthetic chat events. Don't go live to test.
5. **Make the weekly loop fast-forwardable + resolve-on-boot.** The real raid
   resolves over a week — unobservable in one sitting. Add a dev command/script
   that sets `endsAt = now` and triggers resolution. **On startup, check whether
   any raid's `endsAt` has passed and resolve it then** — never rely on an
   in-memory `setTimeout` surviving a restart. (An in-process timer/`node-cron`
   is fine for the live tick; the authoritative trigger is stored `endsAt`
   compared at boot.)
6. **Idempotency from the start** (§G) — cheap now, painful to retrofit.
7. **Know the free-tier ceiling.** Firebase RTDB Spark tier: **100 concurrent
   connections**, 1 GB stored, 10 GB/mo egress. Each website viewer holding an
   `onValue` listener is a connection — a popular stream can brush the cap. Fine
   for POC; for launch, go Blaze or have the bot snapshot read-state to a static
   JSON the site fetches (UI doc, "scaling the read path"). Flag it; don't
   silently hit it.
8. **Twitch app setup is bureaucratic, not hard — do it early.** EventSub-WS and
   Helix need a registered Twitch **application** and the bot account authorizing
   the right scopes. It blocks the live gate, so unblock it first.

---

## I. Firebase security rules (game state)

The OKRAMARKET poll uses wide-open rules. **Do not reuse them.** Game state is
**client-read-only**; all authoritative writes go through the Admin SDK (which
bypasses rules). Starting point:

```jsonc
{
  "rules": {
    // the poll keeps its own path; game state is locked down:
    "config":         { ".read": true,  ".write": false },
    "config/secrets": { ".read": false, ".write": false }, // botToken etc. — Admin only
    "items":          { ".read": true,  ".write": false },
    "drops":          { ".read": true,  ".write": false },
    "players":        { ".read": true,  ".write": false },
    "bosses":         { ".read": true,  ".write": false },
    "raids":          { ".read": true,  ".write": false },
    "leaderboard":    { ".read": true,  ".write": false }
  }
}
```

- `".write": false` blocks **client** writes; the Admin SDK ignores rules, so the
  bot writes freely. That asymmetry *is* the anti-cheat model.
- A future site-initiated action (e.g. equip from the site) must **not** open a
  write path — route it through a chat command or a small validated Cloud
  Function that writes via Admin. Keep the client read-only.
- `config/secrets` is reachable by **no client** via rules → only the Admin SDK
  touches the persisted bot token.
- Add `.validate`/index rules and migrate off the poll's open rules as part of
  Phase 0, not later.

---

## J. Open risks / watch-list

- **Token refresh persistence** (§F) — most likely cause of a silent 24/7
  failure. Get it right before leaving it unattended.
- **Single-instance invariant** (§E) — double-running = double-awarding.
- **Service-account blast radius** (§F) — minimum role, rotate on exposure.
- **Free-tier connection cap** (§H.7) — a launch-day problem, not a POC one.
- **EventSub session resets** — Twitch periodically reconnects WS sessions;
  `@twurple/eventsub-ws` handles re-subscription, a raw `ws` client must handle
  `session_reconnect` itself.
- **Clock/timezone for weekly close** — store explicit `endsAt` epoch ms; resolve
  by comparison at boot, never by a wall-clock timer a restart can lose.

---

## K. Sandboxing & surface-area reduction (for an outbound-only workload)

**Do not add a reverse proxy (nginx etc.).** A reverse proxy guards *inbound*
listeners; this bot listens on nothing (§B), so there's nothing to proxy — it
would only add a daemon, a config, and a CVE stream to the attack surface. The
right "chokepoint" instinct points at **egress**, not ingress (§K.4).

For an outbound-only workload, hardening is three independent levers:

### K.1 Minimal image (fewer binaries = less to exploit)
- Use a **distroless** runtime (`gcr.io/distroless/nodejs20-debian12:nonroot`) —
  no shell, no apt, no busybox. A compromised process has almost no tools to
  pivot with. Pin by **digest**; run as the image's nonroot user.
- **Scan in CI** (Trivy or Grype) and fail the build on HIGH/CRITICAL; run
  `npm audit` and `npm ci --omit=dev`. Emit an SBOM + provenance (§D).
- Result: image carries only Node + the app + prod deps — nothing else.

### K.2 Kernel-level container sandbox (runtime isolation)
Extends the §E flags. The goal is that a compromised bot can't touch the host:
- Already in §E: `--read-only` rootfs + `--tmpfs /tmp`, `--cap-drop ALL`,
  `--security-opt no-new-privileges`, memory/CPU limits, non-root.
- Add: **never** `--privileged`, never `seccomp=unconfined` (keep Docker's
  default seccomp + AppArmor/SELinux profiles on; tighten with a custom profile
  if you want). `--pids-limit 128` (fork-bomb cap), sane `ulimits`.
- **`userns-remap`** so container-root maps to an unprivileged host uid.
- **Never mount the Docker socket.** Only mounts are the read-only secret file
  and the single writable token volume (§F) — nothing else from the host.
- **Strongest tier (matches "sandboxed on my network"):** run the container
  under **gVisor (`runsc`)** or **Kata Containers** (syscall/VM sandbox so a
  kernel exploit hits the sandbox, not the host), or simply give it **its own
  VM** with no shared kernel and no other workloads. A dedicated micro-VM is the
  cleanest mental model for "isolated appliance."

### K.3 Secrets at rest
- Mount secret files **read-only, mode 0400**, owned by the container's nonroot
  uid. The token store (§F) is the *only* writable mount; scope it to just the
  token file's directory.

### K.4 Egress control + network isolation (the real win — your "proxy", aimed outward)
This is where the chokepoint belongs. Two parts:

1. **Network isolation.** Put the container on a **dedicated, isolated network**
   with no route to the rest of the internal LAN — only to the gateway. If the
   bot is ever compromised, it can't scan or pivot to other hosts. This directly
   delivers the "sandboxed on my internal network" goal: blast radius = one
   container that can reach the internet and nothing else local.

2. **Egress allowlist.** Restrict outbound to *only* the domains the app
   legitimately needs — everything else denied, so a compromised bot can't
   exfiltrate or reach a C2. The full set (this is part of the deployment
   contract, so it's safe to record here):

   | Purpose | Hosts |
   |---|---|
   | Chat (IRC/WSS) | `irc-ws.chat.twitch.tv`, `*.chat.twitch.tv` |
   | Helix + OAuth | `api.twitch.tv`, `id.twitch.tv` |
   | EventSub WS | `eventsub.wss.twitch.tv` |
   | Firebase / Google | `*.googleapis.com`, `oauth2.googleapis.com`, `www.googleapis.com`, `*.firebaseio.com`, `*.firebasedatabase.app` |

   - **Cleanest enforcement (by hostname):** a tiny **forward-proxy sidecar**
     (Squid or tinyproxy) holding the allowlist; point the bot at it via
     `HTTPS_PROXY`/`HTTP_PROXY`. `CONNECT` tunnels TLS, so it covers **both**
     HTTPS (Helix/Firebase) and WSS (chat/EventSub). This is the "proxy" you
     actually want — outbound, allowlisting by domain, no IP-range maintenance.
     **App-integration cost:** Node's `fetch`/undici honor `HTTPS_PROXY`, but
     `ws`/twurple need an explicit `https-proxy-agent` wired into the client —
     budget a small amount of code for that.
   - **Lower-effort alternative:** an L4 firewall on the isolated network
     allowing only `:443` egress + DNS allowlisting. Less app-intrusive, coarser
     (can't easily pin to specific Google hostnames since IPs shift).

   (Concrete firewall/VLAN/proxy-host configuration is operational — keep it in
   the private runbook, not in this repo.)

### K.5 What a reverse proxy *would* be for (and the only edge case)
The single scenario where an HTTP front-end matters: if you later add a
health/metrics **HTTP endpoint**. Even then, bind it to **loopback / an
internal-only network**, never publish it — no public reverse proxy required.
The current design uses a **file-based heartbeat** healthcheck (§E) specifically
to avoid opening any listener at all. Keep it that way unless you have a concrete
need.

**Recommended default stack:** distroless + digest pin + CI scan (K.1), the §E
flags + `userns-remap` + `--pids-limit` (K.2), dedicated isolated network +
forward-proxy egress allowlist (K.4). That's "very secure" without going
overboard. Reach for gVisor / dedicated VM (K.2) only if you want maximum
isolation.

---

## L. Combat engine & the live battle (active resolution — spec §5.8)

The weekly raid resolves as an **automated, seeded, turn-based battle** emitted
as an **append-only event log** that the website replays. This section is the
authoritative engine + data-model contract. (The website ships a *reference*
demo generator in `_includes/arena.html` — `genDemoBattle()` — that mirrors this
shape for preview; the **authoritative engine lives here in kennyBot.**)

### L.1 Weekly lifecycle / phase machine
`config/raid.phase`: `signup → locked → live → done`.
- **signup** — viewers `!raid` to enlist; bot snapshots nothing yet.
- **locked** (at `locksAt`) — freeze each signee's **loadout snapshot** (class,
  level, role rating, derived combat stats, equipped items) into
  `raids/<s>/<w>/signups/<uid>`, and compute `raids/<s>/<w>/team` aggregates.
  Lock matters: gear/level changes after lock don't affect this battle
  (determinism + fairness).
- **live** (at `startsAt`) — the battle is revealed (see L.4).
- **done** — write `combat.result` + distribute loot; flip phase.

Drive transitions by stored timestamps compared **at boot + on a timer**
(resolve-on-boot if overdue — §H.5), never by a timer that a restart can lose.

### L.2 The engine (pure + seeded)
Put it in `rules/raidResolve.js` (or `rules/combat.js`) as a **pure function**:
`simulateBattle(rosterSnapshot, bossDef, seed) → { events[], result }`.
- Derive each hero's combat stats from role rating (class+level+gear,
  engagement-scaled): `maxHp`, `atk`, `heal`, plus role.
- Round loop with **initiative** (party then boss, or stat+RNG). Each actor picks
  a random **off-cooldown** ability; **seeded RNG** drives hit/crit/variance and
  target selection (tanks taunt/mitigate, healers heal lowest ally, DPS focus
  boss; boss alternates single-target / AoE gated by affix + enrage — §5.3).
- End on boss HP 0 (**victory**) or party wipe / turn cap (**defeat**).
- **Seeded, no I/O, RNG injected** → unit-test exact logs from fixed seeds, tune
  balance offline, and reproduce any reported battle. Store the `seed` so a
  battle is re-derivable.

### L.3 Data model (extends §9)
```jsonc
"config": {
  "raid": { "seasonId": "t1", "weekId": "w1", "phase": "live",
            "locksAt": 0, "startsAt": 0 }       // active-raid pointer + schedule
},
"raids": {
  "<seasonId>": { "<weekId>": {
    "signups": {                                 // loadout snapshot, frozen at lock
      "<twitchUserId>": {
        "displayName": "viewer", "class": "Guardian", "role": "tank",
        "level": 18, "roleRating": 320, "maxHp": 520,
        "power": 140, "defense": 300, "healing": 0,
        "equipped": { "weapon": {"name":"Bramble Maul","rarity":"rare"},
                      "armor":  {"name":"Husk Plate","rarity":"epic"},
                      "trinket": null }
      }
    },
    "team": {                                    // aggregate, computed at lock
      "count": 12, "byRole": {"tank":3,"healer":2,"dps":7},
      "roleRating": {"tank":900,"healer":560,"dps":2200},
      "power": 2100, "defense": 1450, "healing": 900
    },
    "combat": {
      "seed": 20260629, "status": "live",        // pending | live | done
      "startsAt": 0, "bossMaxHp": 1000000,
      "result": { "downed": false, "bossHpRemaining": 260000, "mvp": "<uid>" },
      "log": {                                   // append-only, ascending integer keys
        "0": { "type":"start", "text":"The Ashen Warden awakens!" },
        "1": { "type":"turn", "n":1 },
        "2": { "type":"action", "side":"party", "actor":"<uid>", "actorName":"viewer",
               "ability":"Cleave", "kind":"damage", "target":"boss",
               "targetName":"The Ashen Warden", "amount":540, "crit":false,
               "text":"⚔️ viewer uses Cleave on The Ashen Warden for 540!" },
        "N": { "type":"end", "outcome":"victory", "text":"The okra-patch wins!" }
      }
    }
  } }
}
```
- `kind`: `damage` (target `boss` or `<uid>`), `aoe` (hits whole party), `heal`,
  `buff`/`shield`. Include the rendered `text` (engine owns the battle "voice")
  **and** structured fields (so the UI can drive bars/animation).
- **Keep events compact.** A battle is ~tens–low-hundreds of events; RTDB handles
  it, but don't bloat each node. Optionally stamp running HP (`bossHpAfter`,
  `targetHpAfter`) so the UI shows exact bars without recomputing (the UI
  recomputes from `amount` if absent).
- Same **client-read-only** rules as all game state (§I).

### L.4 Execution: precompute-and-reveal (recommended) vs live-tick
- **Precompute-and-reveal (recommended).** At `startsAt`, run `simulateBattle`
  once, write the full `log` + `result`, set `startsAt`/`status`. The website
  reveals events on a paced timer keyed to `startsAt` (it computes how many
  events should be visible by now). Pros: no long-running loop, restart-safe,
  instantly replayable, identical UX. The site already implements this player.
- **Live-tick (alternative).** A server loop writes one turn's events every N
  seconds. Pros: truly streamed. Cons: long-running stateful loop, restart
  fragility, must guard idempotency. **Same event-log contract**, so you can
  start with precompute and switch later without touching the UI.

Either way: the engine is authoritative server-side; the client only reads.

### L.5 Testing
- Unit-test `simulateBattle` with fixed seeds → assert deterministic logs,
  victory/defeat conditions, cooldown respect, target logic, threshold effects.
- Mod/dev command to **force a raid now** (set `locksAt`/`startsAt` to now,
  simulate, write log) so a full raid-night is testable in seconds locally
  against `scasplte2` (§H.4–5).
