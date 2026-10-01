# Chase monitor — launch and unattended monitoring

How to switch the detector on, leave it alone for two weeks, and afterwards decide from
the log whether it works — with nobody watching it in real time.

Design: [`chase-monitor-design.md`](chase-monitor-design.md) ·
costs and next tiers: [`chase-monitor-roadmap.md`](chase-monitor-roadmap.md).

**The shape of it:** the detector never goes straight to chat. It runs through three
gates, and each one is a thing that can be *checked* rather than hoped for.

| Phase | What runs | Duration | Can it speak? |
|---|---|---|---|
| 0 — shakedown | `chase:record` | ~1 hour | no |
| 1 — calibration | `chase:record` unattended | ~2 weeks | no |
| 2 — shadow | the bot, `mode: shadow` | ~1 week | no |
| 3 — live | the bot, `mode: live` | — | yes |

---

## Phase 0 — shakedown (about an hour)

Proves the plumbing before anything is left alone. Nothing here is unattended.

```bash
# 1. Sources. The roster is NOT in the repo; create it once (shape: scripts/chase-sources-load.mjs)
$EDITOR .workspace/chase-sources.json

# 2. A free YouTube Data API key. WITHOUT IT NOTHING IS DETECTED — see below.
echo 'YOUTUBE_API_KEY=...' >> .env

# 3. Record for a few minutes and stop it
npm run chase:record -- .workspace/chase-logs
```

Check three things, in order:

1. **Sources are live.** The console heartbeat should show `N/M live` with `M` equal to
   your roster size and `N` greater than zero. `0/0 live` means no key. `0/N live` means
   the roster's channel ids are wrong.
2. **Viewer counts arrive.** The heartbeat prints concurrent viewers per live source. If
   they are all absent, the `audience` evidence channel is dead and the whole
   `chopper` class is undetectable.
3. **The report parses it.** `npm run chase:report -- .workspace/chase-logs`

> **Without `YOUTUBE_API_KEY` the monitor detects nothing** — not "less". The keyless RSS
> feeds list a channel's videos but never say which one is *live*, and announcing
> something unconfirmed would break the premise rather than degrade it. This is measured,
> not assumed: a keyless run records discovery lines and zero samples.

---

## Phase 1 — unattended calibration (two weeks)

This is the phase that answers "does it work". It records raw, replayable samples **and**
scores them with the real evaluator, so afterwards you can both see what it would have
done and re-run it at different settings.

### Where to run it

**The best answer is: in the bot.** Shadow mode exists for exactly this, and the bot
already runs 24/7 in a container on a machine that does not sleep. Set
`CHASE_LOG_DIR=/data/chase-logs` and it writes the same JSONL the standalone recorder
does, which `chase:report` and `chase:sim` then read unchanged. The monitor ships
`enabled:false` + `mode:'shadow'`, so the feature can be **deployed dark** and switched
on later from chat with no redeploy — nothing reaches viewers until `!chasemon live`.

`/data` is the only writable persistent path in the container: the image runs
`--read-only` as the non-root `node` user and `/tmp` is a tmpfs that evaporates on
restart. It is the same volume as the token store (`-v kennybot-tokens:/data`), which is
why the log rotates daily and prunes past `logRetentionDays` (14 days ≈ 100 MB).

`CHASE_LOG_DIR=/data/chase-logs` is **already baked into the image** — it is a path, not
a credential, and `/data` is the only writable persistent path in the container, so there
is one correct value and nothing to configure. The only env var you must supply is
`YOUTUBE_API_KEY`.

```bash
# as a mod, in chat:
!chasemon on        # still shadow — it cannot speak
!chasemon status    # expect: ON · mode shadow · N sources · key present
```

Pull the evidence back whenever you want a report:

```bash
docker cp kennybot:/data/chase-logs ./chase-logs
npm run chase:report -- ./chase-logs --no-sweep
```

### Running it standalone instead

**Not in an interactive WSL shell.** This is not theoretical — it was measured. A real
overnight run lost **11.8 hours** in ~60-minute steps: the host kept suspending and
waking, the process never died, and no session-stop record was written, so the log looked
continuous. WSL2 freezes when Windows sleeps, which would silently gut the run — and a two-week log with a five-day
hole in it is worse than no log, because the hole is easy to miss. Pick one:

```bash
# A. Alongside the bot, on the host that already runs it (best — same uptime profile)
docker run -d --name chase-record --restart unless-stopped \
  --env-file .env -v "$PWD/.workspace:/app/.workspace" \
  kennybot node scripts/chase-record.mjs .workspace/chase-logs

# B. A systemd user service (survives logout; needs systemd enabled in WSL)
systemd-run --user --unit=chase-record --working-directory="$PWD" \
  node scripts/chase-record.mjs .workspace/chase-logs

# C. tmux, if you accept that a reboot ends it
tmux new -s chase 'npm run chase:record -- .workspace/chase-logs'
```

The recorder is built for this: it appends (never truncates), rotates daily into
`chase-YYYY-MM-DD.jsonl`, survives the network being down for hours, and backs off
rather than hammering a failing source. A restart extends the record instead of
destroying it, so option A's `--restart unless-stopped` is safe.

### Telling it is alive without watching it

Three signals, cheapest first — none of them require reading the log:

```bash
# is the process there at all
docker ps --filter name=chase-record          # or: systemctl --user status chase-record

# has it written anything in the last few minutes
ls -l --time-style=+%H:%M .workspace/chase-logs/

# what did it think of the last ten minutes
tail -n 20 .workspace/chase-logs/chase-$(date +%F).jsonl
```

The log carries `session` lines on start and stop and a `health` line every 30 minutes,
so a gap is always attributable to either a clean stop or a crash. **You do not need to
interpret any of this by hand** — the report's COVERAGE section does it.

### Weekly, for about a minute

```bash
npm run chase:report -- .workspace/chase-logs --no-sweep
```

`--no-sweep` matters for the weekly check: the what-if sweep replays every recorded
tick through the evaluator once per grid cell, which is ~100s on a fortnight of data.
Skip it until the end, when you are actually tuning.

Read only two sections and stop:

- **COVERAGE.** If coverage is not ~100%, fix that before reading anything else. Every
  other number is computed over whatever the log actually contains, so a run with holes
  produces confident-looking numbers about a fraction of the fortnight.
- **INCIDENTS.** How many fired, and what it would have said.

---

## Reading the report at the end

Six sections. What each is actually for:

| Section | The question it answers | What to do about it |
|---|---|---|
| **Coverage** | Did it actually run? | Anything under ~95% — find the gap and re-run. Nothing below is trustworthy until this is clean. |
| **Source health** | Is every source pulling its weight? | A source never seen live, or never returning viewers, is a broken roster row — not a quiet source. |
| **Score distribution** | Is it awake at all? | All-zero scores means detection never engaged; suspect the key or the roster before touching weights. |
| **Incidents** | Would it have announced? | Compare against the **measured** ~1.6 covered LA chases/week (`chase:backtest` prints it). Far more = false positives. Far fewer = misses. |
| **Near misses** | Where is recall being lost? | Grouped by the missing evidence channel — the most actionable output in the report. |
| **What-if sweep** | What should the settings be? | Re-runs the **real** evaluator over the recorded samples at a grid of thresholds and dwells. |

**The what-if sweep is the point of the whole exercise.** Every weight in
`config.chase` is currently invented — shaped by probing real sources, but not measured.
The sweep replaces "this feels about right" with "at threshold 8 / dwell 3 this fortnight
would have produced N incidents". Tune from that table, not from intuition.

**Report output is private.** It prints the exact text an incident *would* have
announced, and that text contains the source's on-air name — because the live bot
resolved it from the loaded roster when it recorded the line. The logs live under
`.workspace/` and are gitignored for that reason. Don't paste raw report output into
anything public; `--json` output has the same property.

**Backtest first, it is same-day.** `npm run chase:backtest` reconstructs past
broadcasts from both platforms' VOD metadata and replays them through the real
evaluator, so a weight change can be judged immediately instead of after a fortnight.
Its limits are real and printed in its own output — no historical viewer counts, so the
`audience` channel is untested; VOD titles are often renamed after the fact, which
inflates recall; and deleted VODs remove events entirely (coverage decays ~100% / 57% /
28% across the last 30 / 60 / 120 days).

**Ground truth.** The report can say how often it fired; it cannot say whether those
were real chases. For that, check the incidents against a published chase feed over the
same dates — a broadcaster's dedicated chase tag is a free, human-curated list of real
pursuits (the specific one is in the private research notes). That comparison is what
turns a firing rate into a precision/recall number.

---

## Phase 2 — shadow mode on the real bot

Calibration proves the *model*. Shadow proves the *production path*: real settings from
RTDB, the real scheduler, the real mute handling.

```bash
npm run chase:sources          # load the private roster into RTDB
# in chat, as a mod:
!chasemon on                   # still shadow — it cannot speak yet
!chasemon status               # expect: ON · mode shadow · N sources · key present
```

It ships **double-locked**: `enabled:false` *and* `mode:'shadow'`. Turning it on does not
make it talk. Would-be announcements go to RTDB under `chaseMonitor/shadow` (trimmed to
the most recent 200), and `!chasemon status` shows whether anything is building.

Watch for a week. If shadow incidents track the calibration run's rate, the production
path agrees with the model.

---

## Phase 3 — live

```
!chasemon live
```

That is the only remaining gate. Then:

- `!chase` — anyone can ask what is happening now, or what most recently did.
- `!chasemon status` — enabled, mode, threshold, dwell, source count, key presence, and
  either the open incident or the dwell counter.

**Rollback is one word.** `!chasemon off` stops announcements immediately and mid-incident
without corrupting state, and drops network traffic to zero — it does not poll and
discard. `!chasemon shadow` is the softer step: keep detecting, stop speaking.

---

## Checking on it — start here

```bash
npm run chase:doctor
```

Reads the monitor's own state out of RTDB and says whether it is alive, what it can see,
and what is wrong if anything. **You do not need host access to answer "is it working".**
It is the first thing to run, and it exists because answering that question ad-hoc took
several attempts and the failure modes are not guessable.

A healthy deployment looks like this — note that **a score of 0 is the expected result**,
since real chases are ~1.7/week:

```
  OK    enabled, mode "shadow"
  OK    6 source(s) loaded
  OK    ticking — last observation 0 min ago
  OK    39 stream(s) tracked, 2 live right now
        2 stream(s) have a usable viewer baseline (needs 20 samples)
  Healthy.
```

### Getting onto the host

Only needed for the on-disk evidence. There is **no `faraday` entry in `~/.ssh/config`**,
the user is **`root`**, and the key is a dedicated passphrase-free one:

```bash
ssh -o BatchMode=yes -i ~/.ssh/faraday_ed25519 root@faraday
```

`BatchMode=yes` matters: without it a wrong key or user leaves ssh waiting on a prompt
that never arrives, and the command hangs rather than failing. There is **no `docker` or
`tailscale` CLI inside WSL** — Docker Desktop integration is off — so drive Docker over
SSH instead of looking for a local binary:

```bash
docker -H ssh://root@faraday ps
docker -H ssh://root@faraday cp kennybot:/data/chase-logs ./chase-logs
npm run chase:report -- ./chase-logs --no-sweep
```

The container is `kennybot`, the image is `ghcr.io/nikkibreanne/kennybot`, and the
evidence is `/data/chase-logs/chase-YYYY-MM-DD.jsonl` inside it.

### Five things that have already misled someone

1. **"1 sample per poll" looks healthy and is not.** A Twitch source is polled by login
   and never discovered, so before the first discovery sweep the monitor reports one
   sample and zero live — which reads as a quiet city rather than a blind detector. If
   `chase:doctor` says only one stream is tracked, discovery has not run.
2. **`:latest` is not necessarily the newest tag.** Compare digests before concluding a
   fix is deployed:
   `docker -H ssh://root@faraday image inspect <image>:latest --format '{{.Id}}'`
3. **Every operator script needs `import 'dotenv/config'`.** Without it `initFirebase`
   fails with "FIREBASE_DATABASE_URL is required in production" even though `.env` has
   it. One script shipped without it and the symptom was exactly that.
4. **A scratch script in `/tmp` cannot resolve `node_modules`.** Write it inside the repo
   and delete it afterwards, or the import of `dotenv` fails with ERR_MODULE_NOT_FOUND.
5. **Never put a source identity in the repo while debugging.** Outlet names, channel ids
   and logins are private (CLAUDE.md). Print org ids and classes; the privacy test will
   catch a slip, but only once it is staged.

## When something looks wrong

| Symptom | Almost always |
|---|---|
| `0/0 live` in the heartbeat | No `YOUTUBE_API_KEY`. Nothing can be detected. |
| `0/N live`, key present | Roster channel ids are wrong. |
| Scores always 0, sources live | Titles never change and no viewer baseline yet — the `audience` channel needs `minSamples` polls (~20 min) before it can score at all. |
| Never fires, near misses cluster | Read NEAR MISSES by channel; usually one evidence channel is structurally absent. |
| Fires constantly | Check VETO handling in the report — retrospective clips are the common false positive. |
| `⚠ NO SOURCES LOADED` | `npm run chase:sources` has not been run against this environment. |
| An incident seems stuck open | It cannot be: `clearScore` sits above a lone standing title and `maxIncidentMs` caps the age. If one ever does, that is a bug worth reporting. |
| Coverage below 100% | The recorder died. `session` lines say whether it was a clean stop. |

**Quota.** The `health` lines carry `quotaUnits` — real `videos.list` calls, one unit
each, against a free 10,000/day budget. Expect ~1,440/day. If that number climbs toward
the budget, something is polling far more often than `pollMs`, and the fix is never to
add `search.list` to a loop: at 100 units a call it would exhaust the day's quota in
under two hours.
