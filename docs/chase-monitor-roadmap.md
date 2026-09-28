# Chase monitor — iterations, costs, and what each one buys

Companion to [`chase-monitor-design.md`](chase-monitor-design.md), which covers the
detection model. This file answers a different question: **what does it cost to run,
and what would more money or more engineering actually get us?**

Every dollar figure is worked, not gestured at. Every "free" claim means **$0 marginal
spend**, not "cheap".

**The source roster is private** (see `CLAUDE.md`), so sources are named here only by
class (`chopper` · `newscast` · `episodic`) or by opaque id. The roster, channel ids
and feed URLs are in `.workspace/chase-sources-research.md` (gitignored).

---

## Tier 0 — the free MVP (what is being built now)

**Recurring cost: $0.** No paid API, no subscription, no hosting beyond the container
kennyBot already runs in.

| Resource | Budget | We use | Headroom |
|---|---|---|---|
| YouTube Data API quota | 10,000 units/day (free) | **~1,440** (1 `videos.list`/min) | 86% |
| Bandwidth | — | ~17 MB/day (6 RSS feeds every 10 min) | — |
| RTDB | existing project | a few KB of state + a 200-entry shadow log | — |
| Twitch | existing bot | ≤ 3 messages/hour, hard-capped | — |

**One free API key is required** (`YOUTUBE_API_KEY`, a Google Cloud project with the
YouTube Data API enabled). It costs nothing and never bills — the quota is a hard
ceiling, not a meter. Exceeding it returns errors, it does not generate an invoice.

**Without the key the monitor detects nothing.** This was measured, not assumed: a
keyless recorder run discovered video ids for every org and produced **zero** stream
samples. YouTube's channel RSS lists videos but never says which one is *live*, and
`liveBroadcastContent` / `concurrentViewers` come only from `videos.list`. Since the
whole premise is that we only announce something we know is live, guessing from RSS
would break the requirement rather than degrade it. The bot does not crash or spin —
it stands down cleanly and logs once — but **the key is required, not optional.**

### What Tier 0 detects

| Evidence channel | Works at Tier 0? | Notes |
|---|---|---|
| `title` | ✅ | Requires a title *change*; covers the newscast and episodic classes |
| `audience` | ✅ with API key · ❌ without | The only detector for the `chopper` class |
| `liveness` | ✅ | An `episodic` channel's dark→live transition |
| `editorial` | ✅ | A broadcaster's dedicated chase feed; lagging, so it sustains rather than opens |

### Known gaps at Tier 0

1. **`episodic` new-broadcast latency.** When an `episodic` org spins up a brand-new
   live video, channel RSS can take up to 15 minutes to show it (the feed sends
   `max-age=900` and no `ETag`, so there is no way to poll around it). Closed by
   Tier 1a.
2. **Detection latency ~2.5 min** — up to 60 s poll + 90 s dwell.
3. **No independent source class.** Every Tier 0 signal is ultimately *a newsroom
   deciding to cover something*. Dispatch audio (Tier 2b) is the only genuinely
   independent class available at any price.
4. **The weights are invented.** They are shaped by probing real sources, not measured.
   Shadow mode exists to fix this — see the design doc §5.

---

## Tier 1 — still free, more engineering

### 1a. Suspicion sweep — closes the `episodic` gap

When any org already shows strong evidence, immediately spend one
`search.list?eventType=live` (100 units) on the `episodic` channels, instead of waiting
for RSS.

- **Cost: $0.** At ~5 chases/week that is ~500 units/week against a 10,000/day budget.
- **Buys:** catches an `episodic` broadcast that starts *after* the chase does — which
  is the normal case for that class, since they go live *because* of the chase.
  Probably the single largest recall win available for free.
- **Effort:** small. The expensive call is triggered by cheap evidence, so it never
  runs in the steady-state loop.

### 1b. Faster poll — halves latency

Drop `pollMs` from 60 s to 30 s.

- **Cost: $0.** 2,880 units/day, still 71% headroom.
- **Buys:** ~30 s off detection. Dwell still dominates the latency budget, so consider
  `dwell: 3` at 30 s (45 s) rather than keeping 90 s.
- **Effort:** a config change. Do it *after* shadow data confirms dwell 3 is enough.

### 1c. More orgs

Add a national breaking-news stream, plus any other LA chase channels that prove
reliable in the shadow log. Candidates are tracked in the private roster notes.

- **Cost: $0** — `videos.list` takes up to 50 ids in the same 1-unit call, so
  additional orgs are literally free until 50 streams.
- **Buys:** more independent groups, which is what the scoring model rewards most —
  but only if the addition really *is* an independent newsroom. A second stream from
  a newsroom already on the roster belongs in that org's group, not in a new one;
  otherwise one editorial decision scores twice across two "independent" orgs, which
  is the exact failure the evidence-channel guard exists to prevent.
- **Effort:** one row each in the private roster (`.workspace/chase-sources.json`)
  plus a `groupCap` judgement per org, then `npm run chase:sources` to reload RTDB.
  No code change, and nothing to commit.

### 1d. Backtest harness

Score the shadow log against the broadcaster chase feed (design §1.4) as ground truth
and print a precision/recall table per weight setting.

- **Cost: $0.**
- **Buys:** the ability to change a weight for a *reason*. This is the highest-value
  item in the entire roadmap and it is free — it just takes the two weeks of recording.

---

## Tier 2 — costs real money

### 2a. X / Twitter — ❌ not recommended

The obvious "second signal", and it does not survive arithmetic.

- **Pricing (2026):** no free tier. Pay-per-use at **$0.005 per post read**
  ($5/1,000). The legacy $200/mo Basic tier is closed to new developers.
- **Cost:** a timeline request returns ~10 posts and bills ~10 reads. Polling 3
  accounts every 15 min ≈ 8,600 reads/month ≈ **$43/mo**. Polling 5 accounts every
  minute ≈ **$1,080/mo**.
- **Buys:** very little that we do not already have. Per the design doc §2.2, a
  station's tweet is the *same newsroom* as its stream — it is discounted evidence in
  the same group, and cannot form a quorum on its own. The only genuinely new signal
  would be independent chase-watcher accounts, which are unvetted.
- **Verdict:** poor value at any cadence. The free `editorial` channel (article RSS)
  covers the same evidence channel for $0.

### 2b. Scanner audio → transcription — ⭐ the one upgrade that changes the design

Ingest an LAPD / CHP dispatch feed and transcribe it, matching on pursuit phraseology.

- **Cost, self-hosted:** Broadcastify premium ~**$15–25/year**, plus CPU for
  `whisper.cpp` on hardware that already exists. Effectively **~$2/mo**.
- **Cost, cloud STT:** ~$0.006/min × 24/7 = **~$260/mo**. Do not do this.
- **Buys:** the only **genuinely independent source class** in this entire document.
  Dispatch says "in pursuit" *before* any helicopter is airborne and before any
  producer writes a title — so it both (i) cuts detection latency from minutes to
  near-zero and (ii) adds a group that is not a newsroom, which is exactly what the
  quorum is thin on today. It would also let the threshold be raised (better precision)
  without losing recall.
- **Effort:** significant — audio ingest, a transcription worker, and phrase matching
  with its own false-positive profile. A separate service, not a module in kennyBot.
- **Risk:** many agencies have moved to encrypted radio. **Verify LA-area feed
  availability before building anything** — this is the first thing to check, and it
  may kill the tier outright.

### 2c. Chyron OCR on the live frame — good value, closes a real gap

Sample a video frame from a live stream and read the station's lower-third banner
("PURSUIT", "CHASE", "BREAKING NEWS").

- **Buys:** an evidence channel that observes **what the station is showing**, not what
  it *titled*. That is precisely the `chopper`-class gap — the cam is on a chase under
  a permanently generic title, and today only the audience spike sees it. OCR would
  make that case fire on its own merits.
- **Cost, self-hosted:** `yt-dlp` + `ffmpeg` + `tesseract` = **$0 marginal**, some CPU.
- **Cost, vision model** (`claude-haiku-4-5`, $1.00/MTok in · $5.00/MTok out):
  image tokens ≈ `width × height / 750`.

| Sampling strategy | Frames/day | Input tokens/day | **Cost/month** |
|---|---|---|---|
| Every stream, every minute, 1280×720 (~1,229 tok) | 8,640 | ~11.2M | **~$340** |
| Triggered only (score ≥ 3), 1280×720 (~1,229 tok) | ~120 | ~156K | **~$4.70** |
| Triggered only, **cropped to the lower third** (1280×240, ~410 tok) | ~120 | ~58K | **~$1.80** |

Output is negligible (~20 tokens/call). `claude-sonnet-5` ($2.00/$10.00 per MTok) is
roughly 2× those figures and is not needed to read a chyron.
- **Verdict:** **do the triggered, cropped variant.** ~$2/month for a genuinely new
  evidence channel is the best cost-to-value ratio in this document. It follows the
  same principle as the suspicion sweep — spend only when cheap evidence already
  points somewhere. Never sample on every poll; that is a 180× cost multiplier for
  almost no extra information.

### 2d. Commercial incident feeds — ❌ not evaluated, likely poor fit

Citizen has no public API. Commercial CAD aggregators exist but are priced for
newsrooms and public safety, not a Twitch bot. Revisit only if 2b proves impossible.

---

## Recommended order

| # | Item | Cost | Why this order |
|---|---|---|---|
| 1 | **Tier 0 + record for 2 weeks** ([runbook](chase-monitor-runbook.md)) | $0 | Nothing else can be tuned without data |
| 2 | **1d backtest** | $0 | Turns invented weights into measured ones |
| 3 | **1a suspicion sweep** | $0 | Biggest free recall win |
| 4 | **1b/1c** faster poll, more orgs | $0 | Cheap tuning once the model is trusted |
| 5 | **2c chyron OCR**, triggered + cropped | ~$2/mo | Best value per dollar; closes the chopper gap |
| 6 | **2b scanner**, *if* an unencrypted LA feed exists | ~$2/mo + real effort | The only truly independent source class |
| — | 2a X/Twitter | $43–1,080/mo | Rejected — correlated evidence at a real price |

**Everything through step 4 is free.** The first dollar is spent at step 5, and it is
about two dollars a month.

---

## Cost triggers to watch

The design bills nothing today. These are the things that would change that, so they
are worth naming rather than discovering:

- **YouTube quota** is a ceiling, not a meter — going over returns HTTP 403
  `quotaExceeded` and the monitor degrades. It never generates a bill. If quota ever
  becomes tight, the fix is a quota increase request (free) before anything paid.
- **Do not add `search.list` to any loop.** At 100 units it is 100× a `videos.list`
  call; 7 calls/minute would exhaust the daily quota in a day. It is only ever
  event-triggered.
- **Do not sample video frames on a timer.** As the table in 2c shows, always-on
  sampling is ~$340/mo versus ~$2/mo triggered — a 180× difference for a signal that
  only matters when something is already happening.
