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

**Not in an interactive WSL shell.** WSL2 tears down when the terminal closes or the
machine sleeps, which would silently end the run — and a two-week log with a five-day
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
| **Incidents** | Would it have announced? | Compare against ~3–5 covered LA chases/week. Far more = false positives. Far fewer = misses. |
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
