# Clip architecture — read this before touching clips

This document exists because the clip pipeline has been **misunderstood repeatedly**,
in both directions: treating two separate workflows as one pipeline, and assuming a
high-quality source exists where it physically cannot. Both mistakes cost real work.

**If you are about to change `!clip`, local capture, `!start`, or anything touching
okra-clip-archiver — read the Physical Constraints section first.** Every design
error so far has come from contradicting one of those facts.

---

## The goal

Vertical **9:16 shorts for YouTube Shorts / TikTok**, cut from stream moments, at
**better quality than Twitch can give**. That last clause is the entire reason any of
this exists. If a change doesn't improve on Twitch's quality, it is not solving the
problem.

---

## Physical constraints (never re-assume these)

These are properties of Twitch and OBS. They are not preferences and cannot be
engineered around.

| # | Fact | Consequence |
|---|---|---|
| 1 | A **Twitch clip** is capped at the **stream** resolution. | `!clip` alone can never exceed what you broadcast. |
| 2 | A **Twitch VOD is the broadcast recording** — also capped at stream resolution. | **A VOD is NEVER a higher-quality source.** It cannot be "the 4K version". |
| 3 | The **OBS canvas (Base Resolution)** is the ceiling for every output. | A 4K camera on a 1080p canvas is downscaled at the door. Nothing downstream recovers it. |
| 4 | The **replay buffer inherits the Recording settings**, not the stream's. | Raising *Recording* quality raises `!clip` capture quality. Raising stream quality does not. |
| 5 | The replay buffer holds only the **last N seconds** (~60s). | **There is no retroactive capture.** |
| 6 | Twitch clips appear **minutes after** the moment. | Watching for viewer-created clips and then capturing **cannot work** — by then the moment has rolled out of the buffer (constraint 5). This was evaluated and rejected. |

**What follows from 5 + 6:** the only way to get an above-stream-quality copy of a
moment is to act **during** the moment (`!clip` → replay buffer) *or* to have been
recording the whole session locally. There is no third option.

---

## The three paths

Two **separate ingest** paths feeding one **shared processing** stage. Ingest is
separate; processing is shared. Do not collapse these into a single pipeline, and do
not claim one feeds the other.

```
INGEST A — real-time                    INGEST B — full-session
!clip in chat, while live               OBS "Start Recording", whole stream
      ↓                                       ↓
OBS replay buffer (last ~60s)           one long local recording
      ↓                                       ↓
one file per !clip                      every moment, retrievable after the fact
      └──────────────┬────────────────────────┘
                     ↓
        SHARED PROCESSING — okra-clip-archiver
              (source-agnostic: takes any local video + timestamps)
                     ↓
              two-box 9:16 re-cut → YouTube Shorts / TikTok
```

| | Ingest A — `!clip` capture | Ingest B — full-session recording |
|---|---|---|
| Trigger | `!clip` in chat, while live | OBS records the whole session |
| Covers | **only** moments someone `!clip`ped | **any** moment, including viewer-clipped ones |
| Needs | OBS reachable while live | disk + sustained encode for hours |
| Cost | ~1 file per clip | tens of GB per hour |
| Status | **built and deployed** | **not established** — depends on her hardware |

**The Twitch VOD is not an ingest source.** Its only role is as a *timestamp
alignment reference* (see `!start` below). Per constraint 2 it can never improve
quality, so it is never the video source.

### Ingest A saves TWO files: horizontal and vertical

Aitum Stream Suite adds a second **1080×1920 canvas** with its own replay buffer,
**Backtrack**. The streamer composes that canvas for portrait — so its capture is a
**natively framed 9:16 clip**, not a crop of the landscape one. That is strictly
better than any after-the-fact crop, which can only guess where the subject was.

Enabled with `CAPTURE_VERTICAL_OUTPUT` (the Backtrack output's name, normally
`Vertical Backtrack`); unset means horizontal only. Both saves ride **one**
obs-websocket connection: Stream Suite exposes its API as obs-websocket *vendor
requests* under the vendor name `aitum-stream-suite`, so this needs no new
transport, no new dependency, and **not Aitum Nexus** (Nexus is a separate
automation product and is not on this path).

The vendor requests that matter:

| Request | Params |
|---|---|
| `get_canvas` · `get_outputs` · `version` | — |
| `get_scenes` | `{canvas: "Vertical"}` (case-sensitive) |
| `start_output` / `stop_output` | `{output: "Vertical Backtrack"}` |
| `save_backtrack` | `{output: "Vertical Backtrack"}` |

⚠ **`save_backtrack` returning `{"success": true}` does not mean a file exists** —
see invariant 5. Setting it up requires a **recording path, a length, and a video
encoder** on that output in the Aitum settings; miss any and it silently writes
nothing. **OBS's own log is the source of truth** (`Wrote replay buffer to '…'`) —
check it before believing either the API or a filesystem listing.

### Clip length — set in OBS, not in kennyBot

**kennyBot has no length setting.** It says "save"; it gets whatever is buffered.
Length is entirely OBS-side, in **three independent places that must be aligned**:

| What | Where | Note |
|---|---|---|
| Horizontal | OBS → Settings → Output → **Replay Buffer → Maximum Replay Time** | `RecRBTime` in the profile |
| Vertical | Aitum settings → Outputs → Backtrack → **Maximum Replay Time** | plus **Maximum Memory**, a second cap |
| Twitch clip | — | **not controllable.** Twitch decides (~30s) |

If the two buffers disagree, one `!clip` yields a pair of files covering *different
spans of time*, which makes them painful to cut together. Aitum's own docs say to
match them.

Both are also capped by **memory**: a buffer holds `min(time, size)`, so a generous
Maximum Replay Time with a small Maximum Memory silently yields short clips. A
vertical clip coming out shorter than the horizontal is normal if the Backtrack
output was started later — the buffer simply hasn't filled yet.

### Why Ingest A currently carries the load

Ingest B was the original plan for the archiver — re-cut any moment from a
full-quality recording. That premise **only holds if such a recording exists**. Until
that is confirmed on the broadcaster's machine, `!clip` is the *only* path to
above-stream quality, which makes Ingest A the primary path, not a convenience.

---

## What kennyBot does and does not do

**Does:**
- `!clip` → triggers the local capture and/or a Twitch clip, per the live clip mode
  (`src/commands/clip.js`)
- Talks obs-websocket to save the replay buffer (`src/integrations/obsWebsocket.js`)
- Rate-limits local captures channel-wide (`src/integrations/capture.js`)
- `!start` → writes a per-stream sync anchor to RTDB (`src/db/clipSync.js`)

**Does NOT:**
- process, re-cut, transcode, or upload video
- move, rename, or manage captured files
- hand files to okra-clip-archiver — **there is no handoff**

The only thing kennyBot produces *for* the archiver is the `!start` sync anchor:
**data** the archiver reads to align Twitch clip timestamps against a local
recording. It is most useful with Ingest B, and works whether or not local capture is
configured.

---

## Component map

| Concern | Where |
|---|---|
| `!clip` command, clip-mode routing | `src/commands/clip.js` |
| `!clipmode` (mod, live switch) | `src/commands/mod/clipmode.js` |
| Capture facade (backend-agnostic, rate limit) | `src/integrations/capture.js` |
| obs-websocket v5 client + replay-buffer sequence | `src/integrations/obsWebsocket.js` |
| Aitum vertical Backtrack (vendor requests) | `src/integrations/obsWebsocket.js` (`verticalBacktrackSequence`) |
| Twitch clip creation (Helix) | `src/twitch/clips.js` |
| `!start` sync anchor | `src/commands/start.js`, `src/db/clipSync.js` |
| Clip mode (runtime) | RTDB `config/clipMode` · default `clip.defaultMode` in `src/config.js` |
| Config contract | `.env.example` (`OBS_*`, `CAPTURE_*`) |
| Vertical re-cut, job queue, uploads | okra-clip-archiver (**separate repo**) |

---

## Invariants — breaking these is a regression

1. **The clip mode defaults to `local`.** `!clip` does not create a Twitch clip unless
   explicitly asked. It must never silently fall back to Twitch when capture is
   unconfigured — that defeats the mode. (`test/rules/clip-command.test.js`)
2. **Capture failure never breaks chat.** A PC that's off, OBS closed, or a dead
   tailnet resolves as `{ ok: false, reason }` — it never throws out of `!clip`.
3. **Chat replies leak nothing about the rig.** No file path, no OBS, no second
   machine, not even that a local recording exists. Diagnostics go to the log.
   (guarded by a regression test)
4. **The local-capture rate limit is channel-wide**, deliberately separate from
   `!clip`'s per-user cooldown — N viewers clipping in a minute must not write N
   large files.
5. **The vertical capture reports `requested`, never `saved`.** Aitum answers
   `{"success": true}` on *acceptance*, and exposes no way to read back the written
   path — so acceptance must never be promoted to "a file exists". Verified the hard
   way: a misconfigured output returned success for 90 minutes while writing nothing.
   (`test/rules/capture.test.js` asserts the result carries neither `path` nor `saved`)
6. **A vertical failure never costs the horizontal capture.** It runs after the
   horizontal save and is caught separately.
7. **No real addresses, hostnames or credentials in the repo** — this is public. Use
   placeholders (`ws://<obs-host>:4455`).

---

## Current state

| Thing | State |
|---|---|
| `!clip` local capture (horizontal) | built, deployed, verified against a real OBS |
| `!clip` vertical capture (Aitum Backtrack) | built, **verified end to end** — one `!clip` wrote a 1920×1080 and a 1080×1920 file one second apart |
| clip mode default `local` | live on faraday (v0.8.0) |
| Local capture on prod | **inert** — no `OBS_WEBSOCKET_URL` set; boot log warns |
| Chat Bot badge on the prod channel | **falling back to IRC** — bot is not yet a moderator there |
| Full-session recording (Ingest B) | not established |
| okra-clip-archiver | processing half built; ingest source unsettled |

**The clip mode is runtime config with NO environment variable.** It lives in RTDB
at `config/clipMode`, seeded once from `clip.defaultMode` in `src/config.js`, and
mods change it from chat with `!clipmode local|twitch|both`. This exists because the
streamer's OBS can die mid-stream, and recovering by SSH + env edit + container
restart is not a route anyone takes mid-show. Deliberately **one** source of truth —
an env var and a DB value that can disagree is a trap, and the EXP gate
(`liveGate.defaultExpMode`) already establishes this shape.

`CAPTURE_*` and `OBS_*` remain env-only — they describe the deployment's topology
(which machine, which credentials), not an operational choice a mod should make.

---

## Unknowns — do not design around guesses

The broadcaster's OBS configuration is **unknown**, and it determines whether Ingest B
is possible at all. Until answered, treat quality claims as unverified:

- What camera / capture device, and at what resolution?
- OBS → Settings → Video → **Base (Canvas) Resolution**? (constraint 3 — this is the ceiling)
- OBS → Settings → Output → is Recording quality **"Same as stream"**? (constraint 4)
- Does she ever click **Start Recording** alongside Start Streaming?
- Free disk space on the recording drive?

### Test-rig caveat

The maintainer's own machine has a **1080p camera**. It can prove *mechanism* —
that `!clip` triggers OBS, that a file lands, that the sequence is correct — but it
can **never** prove *quality*. Do not treat a passing test there as evidence that the
4K path works. As of the last check its canvas was 1920×1080, 30fps, recording set to
"Same as stream", so its captures were 1080p at ~6 Mbps: identical to Twitch.

---

## Rejected designs (do not re-propose)

| Idea | Why it fails |
|---|---|
| Watch for viewer-created clips, then capture | Constraints 5 + 6 — the moment is gone from the buffer before the clip exists |
| Re-cut 4K from the Twitch VOD | Constraint 2 — a VOD is the broadcast, never higher quality |
| Have the archiver consume `!clip` captures as a pipeline stage | Separate ingest by design; the archiver is source-agnostic and does not depend on kennyBot |
| Point OBS at a network share to write captures directly | A stall on the share stalls the encoder and risks the live stream. Record locally, sync afterwards. |
