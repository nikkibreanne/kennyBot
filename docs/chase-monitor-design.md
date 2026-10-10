# Chase monitor — design proposal

**Status: proposal. Nothing is implemented.** Announce live LA police pursuits in
chat, with a link, from automated detection — running all the time, not only while
the channel is live.

Every factual claim in §1 was probed against the live internet on **2026-09-28**
and is marked ✅ verified or ⚠️ assumed. The design in §2 onward follows from
those probes; several obvious-looking sources did **not** survive them.

**The source roster is private** (see `CLAUDE.md`). This document keeps the whole
method — the probes, the classes, the scoring, the costs — and names no outlet,
personality, channel id or feed URL. The roster itself, the verbatim observed titles
and the per-station reasoning live in `.workspace/chase-sources-research.md`
(gitignored, operator-only).

---

## 1. What the sources actually are

### 1.1 The only live, free, linkable source class is station YouTube live streams ✅

Six LA news organizations run YouTube channels with resolvable, stable channel ids.
Each is referred to here by an **opaque id** and by its **stream class** — the real
roster is operator data, not repo content.

| Org | State at probe | Stream class |
|---|---|---|
| `org1` | **not live** | `episodic` |
| `org2` | live — a rolling news block | `newscast` |
| `org3` | live — a permanently-titled aerial cam | `chopper` |
| `org4` | live — a named news block | `newscast` |
| `org5` | live — a named studio show | `newscast` |
| `org6` | live — a 24/7 incident loop | `chopper` |

**The stream class is the whole design.** "Is it live?" is nearly useless — four of
six are *always* live. What varies per class is which signal actually moves:

- **`chopper`** — an aerial pursuit cam that runs 24/7 under a **generic title that
  does not change when a chase starts**. Title matching cannot detect a chase here.
  What moves is the **concurrent viewer count**.
- **`newscast`** — always live; the title tracks the current show and *does* get
  rewritten to "LIVE: Police pursuit in …" when they cut in. Title is the detector.
- **`episodic`** — `org1` was dark at probe. For this class, **going live at all** is
  the event.

### 1.2 Concurrent viewers are readable and are a huge signal ✅

A `chopper`-class cam sat at **~243 concurrent** on a quiet Monday morning. A live
pursuit puts LA chase streams into the tens of thousands — a 50–100× move. For the
`chopper` class this is the *only* usable detector, and it happens to be the
strongest quantitative signal available anywhere in this design.

`videos.list` returns it officially as `liveStreamingDetails.concurrentViewers`.

### 1.3 CHP's public CAD feed does **not** publish pursuits ❌ — source rejected

`cad.chp.ca.gov/Traffic.aspx` is an ASP.NET WebForms page; a plain POST with the
`__VIEWSTATE` plus the Los Angeles comm-centre selector returns the full LA incident
table with no auth. It works. It is also **useless for this feature**:

- 56 rows returned. Type taxonomy was entirely: `Assist CT with Maintenance` (22),
  `Traffic Hazard` (9), `Trfc Collision-No Inj` (7), `Trfc Collision-1141 Enrt` (7),
  `Hit and Run No Injuries` (4), `Trfc Collision-Unkn Inj` (2),
  `Road/Weather Conditions` (2), `Animal Hazard` (2), `Missing Elderly` (1).
- Zero occurrences of `pursuit`, `chase`, `11-99` or `1033` anywhere in the page.

There is no pursuit incident class in the public feed — consistent with agencies
suppressing in-progress enforcement for officer safety. ⚠️ This is one sample at one
moment; the conclusion is strong but not proven across a week. **Do not build on it.**
(The SoCal comm-centre selector values are recorded in the operator notes, in case a
later need arises.)

### 1.4 News RSS is real but **lagging** — useful as ground truth, not as a trigger ✅

One org on the roster publishes **a broadcaster's dedicated chase feed** — 163 KB,
and it **supports `ETag`/`Last-Modified`**, so conditional GET is nearly free.

Its items read like *"… in custody after chase ends in …"*, *"Driver of a possibly
stolen car in custody after chase through …"*, *"CHP chases speeding motorcyclist
near …"*, *"Suspect wanted for assaulting an officer in custody after a 2-hour LAPD
pursuit"*.

Two things fall out of this:

1. **The vocabulary is `chase` and `pursuit`**, near-universally, plus modifiers
   (`LAPD`, `CHP`, `high-speed`, `stolen`). A short keyword list covers it.
2. **The tense is retrospective** — "in custody after", "ends in". These articles
   land *after* the chase. This feed cannot trigger anything. Its real value is §5.

~19 items over ~1 month suggested roughly 3–5 covered chases per week. **That estimate
was too high.** Measured properly against 120 days of the same feed: **28 published
chases = ~1.6 per week.** The number matters because it is the yardstick the report
judges the firing rate against — at 3–5, a correctly-behaving monitor gets told it is
firing too rarely. `npm run chase:backtest` re-measures it.
That sets the expected announcement volume, and it is small enough that a few false
positives per month would be very visible.

### 1.5 Rejected or unavailable ✅

| Source | Result |
|---|---|
| A second broadcaster's chase feed | HTTP 200 but an empty 891-byte body |
| A third broadcaster's chase feed | HTTP 500 |
| Reddit unauthenticated JSON | **HTTP 403** from a datacenter IP — needs OAuth |
| X / Twitter (chopper-reporter accounts) | API is paid-tier only; rejected on cost |
| Broadcastify scanner audio | Needs live transcription; wildly out of proportion |

### 1.6 Cost mechanics — the part that decides the polling design ✅

| Mechanism | Measured | Consequence |
|---|---|---|
| `videos.list` (`snippet,liveStreamingDetails`, ≤50 IDs) | **1 quota unit**, any number of IDs | The real-time detector |
| `search.list?eventType=live` | **100 quota units** | 100 calls/day total — cannot poll with it |
| Free daily quota | 10,000 units | |
| Channel RSS `feeds/videos.xml?channel_id=` | 20 KB, **no API key, no quota** | Free discovery |
| Channel RSS cache headers | **no ETag, no Last-Modified**, `cache-control: max-age=900` | ⚠️ **RSS is up to 15 min stale** |
| Scraping `youtube.com/channel/<id>/live` | **1.2 MB**, and `Range:` is ignored | Do not poll this |

The RSS staleness finding is the one that shapes everything: **RSS cannot be the
fast path.** It is a 15-minute-granularity discovery channel. And the 1.2 MB watch
page cannot be polled at all — 6 channels × 60 s would be 8.6 GB/day, and scraping
it violates YouTube's ToS besides. The Data API is both cheaper *and* the supported
path; this design uses it exclusively and scrapes nothing in production.

---

## 2. Detection model — weighted signals over a threshold

**This is the model you asked for, and it is the better one.** A weighted sum with
a single threshold is strictly more expressive than the strong-signal +
corroborator rule this document proposed first, and it is tunable with two numbers
instead of a rule table. It needs exactly one structural guard to be safe, below.

### 2.1 The failure mode to guard against is duplicate *measurements*, not orgs

A single organization **may** fire an announcement with enough evidence. What must
never happen is one measurement scoring twice under different names.

Plain additive scoring invites exactly that. If a chopper cam's viewer spike scores 5, and
"the title contains 'chopper'" scores 2, and "the stream is live" scores 2, then
9 points came from **one measurement, restated three ways**. The threshold gets
crossed by a single observation wearing three hats — and no amount of tuning the
threshold fixes it, because the inflation scales with it.

The guard is therefore **not** a per-organization cap. It is: evidence is sorted
into independent **evidence channels**, and **at most one signal scores per channel
per organization** — the highest-tier one that fires. Two signals may stack only
when they are genuinely different observations of the world.

### 2.2 Evidence channels

| Channel | What it observes | Independent of the others because |
|---|---|---|
| `title` | The stream's title **changed** to chase vocabulary | A deliberate editorial act by a producer |
| `audience` | Concurrent viewers vs. trailing baseline | Audience behaviour — nobody chose it |
| `liveness` | A stream we watched go **not-live → live** | A scheduling/ops act, distinct from titling |
| `editorial` | The org's article RSS carries a present-tense chase item | A second newsroom system, published separately |
| `aircraft` | 2+ aircraft **orbiting** one spot, from public ADS-B | Nobody's editorial decision at all — physics, not a newsroom (§2.10) |

`V1`/`V2` are the same measurement at two thresholds, so only the higher scores —
and likewise `T1`/`T2`. That is what "one signal per channel" means concretely.

Four of the five are observations **of a newsroom**. `aircraft` is the only one that
is not, which is what makes it worth having — and also why it is the only one that
cannot speak on its own (§2.10).

### 2.3 Grouping and scoring

Signals are still grouped by news organization — six of them on the current roster,
`org1` … `org6` — because **cross-org agreement is worth more than within-org
agreement** and the arithmetic should say so:

```
groupScore = highest channel + 0.6 * (every other channel in that org)
totalScore = sum of groupScore across orgs          # full additive across orgs
```

Within an org, later channels are discounted (0.6) because one newsroom deciding to
cover a chase drives all of its systems at once — real corroboration, but partly
correlated. Across orgs there is no discount, because two newsrooms are two
independent decisions.

`aircraft` belongs to no org, so it forms its own single-channel group and is added
without a discount — it is independent of every newsroom by construction. It is also
**gated**: see §2.10.

This also answers "the stream **and** a tweet": same org, so same group, discounted
rather than counted as two independent confirmations — and X is rejected on cost
regardless (§2.9). The article-RSS `editorial` channel is the free stand-in.

### 2.4 Signal weights, threshold, and worked cases

| ID | Channel | Signal | Pts |
|---|---|---|---|
| **T1** | `title` | Title **changed** to match `/\b(pursuit\|chase)\b/i` | 5 |
| **T2** | `title` | Title **changed** to weak vocab (`high-speed`, `fleeing`, `standoff`, `suspect`) | 2 |
| **V1** | `audience` | Viewers ≥ **8×** the 30-min trailing median **and** ≥ `minViewers` | 5 |
| **V2** | `audience` | Viewers ≥ **3×** the 30-min trailing median **and** ≥ `minViewers` | 2 |
| **L1** | `liveness` | A **witnessed** off→on transition within 10 min (any class) | 5 |
| **A1** | `editorial` | Org's article RSS has a present-tense chase item < 15 min old | 2 |
| **C1** | `aircraft` | 2+ aircraft orbiting one spot — **only once something else names a chase** (§2.10) | 3 |
| **N1** | — | Negative marker in title (§2.5) | **org → 0** |

**Title signals score against the stream's *resting* title, not against the last
poll.** A `chopper` cam sits permanently under a generic aerial-cam title; matching
static title words would score that stream forever, so a title must differ from what
that stream normally sits at. But a naive poll-to-poll diff is true for exactly
**one** poll, and `dwell` (§2.6) needs the score held for three — under
that reading *every* "fires" row below is unreachable and only a multi-org audience
spike could ever announce. So the stored title is advanced **only while the live
title is not chase vocabulary**. An unchanged title always equals its resting title
and scores 0 forever; a retitle to "pursuit" keeps scoring until the newsroom puts
the old title back. This is why the `chopper` class still leans on `audience`.

| Knob | Default | Why |
|---|---|---|
| `threshold` | **8** | Precision-first, per §6.1 |
| `groupCap` | **10** | Above `threshold` — a single org *can* fire |
| `dwell` | **3 polls (~90 s)** | §2.6 — the real false-positive filter |
| `clearScore` | **6** | Hysteresis. Deliberately **above** a lone standing title (T1=5) |
| `maxIncidentMs` | **3 h** | Hard backstop — nothing stays open past this, whatever it scores |

Worked cases:

| Scenario | Score | Fires? | |
|---|---|---|---|
| A `chopper` org retitles to "pursuit" **and** spikes 8× | 5 + 0.6·5 = **8** | **yes** | ✅ one org, two independent channels |
| An `episodic` org goes live, titles it "pursuit", spikes | 5 + 0.6·(5+5) = 11, capped **10** | **yes** | ✅ |
| An `episodic` org on a **brand-new broadcast** (no baseline) | 5 + 0.6·5 = **8** | **yes** | ✅ the realistic case — see below |
| One org retitles to "pursuit"; a second org spikes 8× | 5 + 5 = **10** | **yes** | ✅ two orgs |
| A `chopper` org spikes 60×, title unchanged | **5** | no | ✅ a spike alone is a fire, a protest, *or* a chase |
| The same 60× spike **with 2 aircraft orbiting** | **5** | no | ✅ both signals are fire-compatible — §2.10 |
| A `newscast` retitles to "pursuit", no spike, **aircraft overhead** | 5 + 3 = **8** | **yes** | ✅ this is what §2.10 buys |
| A `newscast` org retitles to "pursuit", viewers only 3× | 5 + 0.6·2 = **6.2** | no | ⚠️ see below |
| A `chopper` org live + "chopper" in static title + 3× | **2** | no | ✅ the §2.1 stacking attack, defused |
| An `episodic` org live, titled "Raw video: chase ends in crash" | N1 → **0** | no | ✅ retrospective clip |
| Two orgs both weak (V2 each) | 2 + 2 = **4** | no | ✅ |

**`L1` is not gated on stream class, and that matters.** A chopper cam is *not* a 24/7
stream — measured, it sat dark while its org's separate round-the-clock news loop ran.
It goes up **because** something is happening, which makes a witnessed off→on
transition the earliest signal available anywhere in this design. Gating L1 to a class
would have discarded it. The gate was also protecting nothing: a stream that never goes
off never transitions, so it scores 0 here by construction. What L1 *does* require is a
**witnessed** transition — a stream found already running scores nothing, which is what
stops a restart reading the whole roster as freshly live.

**Why `L1` is 5 and not 3.** An `episodic` station going dark→live *and* titling it a
pursuit is two independent editorial acts. It also has to be able to fire, and at
`L1: 3` it could not: a new broadcast mints a **new `videoId`**, so `baselines` for it
is empty and the `audience` channel is disabled for `minSamples × pollMs` ≈ 20 minutes.
The `episodic` class's realistic opening score was therefore 6.8 — below threshold,
for the whole class, permanently. That was a structural miss, not a taste call.

Row 5 is the strictest remaining case: a newsroom deliberately writing "pursuit"
but without an audience move. It is left below threshold because titles get reused,
pre-scheduled and mistyped, and `dwell` cannot catch a *persistent* wrong title.
Shadow data (§5) decides whether `T1` deserves 6 — **or** `aircraft` resolves it
without touching `T1` at all, which is the better answer and the last row above:
the question "is this title describing something happening right now" is exactly what
a second, non-editorial observation can answer.

### 2.5 Negative markers (zero the group)

`recap` · `yesterday` · `bodycam` · `dashcam` · `raw video` · `full video` ·
`caught on camera` · `highlights` · `watch:` — the retrospective-clip false
positives, which §1.4 shows are the *common* case in these feeds.

### 2.6 Dwell is still what actually removes false positives

A title glitch, a stale cache, or a one-off fetch failure lasts **one poll**. A real
LA pursuit runs 10–60 minutes. **Require `totalScore >= threshold` on `dwell`
consecutive polls (default 3 ≈ 90 s).**

This is worth more than any weight in §2.3 and costs 90 seconds of latency on a
half-hour event. If one knob survives review, it is this one.

### 2.7 Incident lifecycle — announce once, not once per poll

- **Open** when the score holds ≥ `threshold` for `dwell` polls → announce **once**.
- **Sustain** while the score stays ≥ `clearScore` (hysteresis: hard to start, easy
  to continue — which is how chases actually behave).
- **Close** after `clearPolls` (default 5 ≈ 5 min) below `clearScore`, **or**
  unconditionally once the incident is older than `maxIncidentMs` (default 3 h).
  An open incident blocks every new one, so an incident that cannot close does not
  merely linger — it silently switches the monitor off with no error anywhere. Two
  independent guards, because one of them is the one we thought of: `clearScore: 6`
  sits above a lone standing title (a station that leaves "LIVE: Police pursuit" up
  for hours after the chase ended scores 5 and cannot pin the incident), and the age
  cap catches whatever that misses.
- **Re-open lockout** `reopenCooldownMin` (default 20 min), so the ragged tail of one
  chase cannot flap into a second announcement.

**An incident's duration is not the event's duration, and nobody should read it as
one.** Observed on 2026-10-09: the broadcast ran 44 minutes, the incident opened at
minute 3 and closed at minute 15. Nothing ended — `liveness` only scores within 10
minutes of the witnessed transition, so for a source where liveness is the *only*
signal (a `titleIsShowName` chase channel, §2.4) the score necessarily returns to 0
about ten minutes in and `clearPolls` closes the incident five polls later. Every such
incident is ~12 minutes by construction.

That is the right behaviour for *announcing* — one announcement, at the start, which is
what the streamer needs — but it means the monitor has no idea whether the chase is
still running, and `chase:report`'s incident durations measure the scoring window
rather than the event. Answering "is it still going?" would need a signal that persists
through the event, which is what the `aircraft` channel (§2.10) could eventually
provide and the editorial feed partly does.

### 2.8 Baselines: a 30-minute trailing median, not a 24-hour one

A 24-hour median is wrong because viewership is strongly diurnal — 6 pm is ~10× 3 am
on the same stream, so a flat daily baseline reads *every evening* as a spike. A
**30-minute trailing median** tracks the diurnal curve for free and still sees a
chase, because a chase spike is fast.

- **Absolute floor** (`minViewers`, default 500): 3 → 24 viewers is 8× and means
  nothing. Ratio *and* floor must both clear.
- **Cold start**: under `minSamples` (default 20) the viewer signals are **disabled**,
  not defaulted-on. A restart must never fire an announcement.

### 2.9 X / Twitter is rejected on cost

Checked because it was raised as a candidate second signal. **There is no free tier
as of 2026** — the API is pay-per-use at roughly **$0.005 per post read**, and the
legacy $200/mo Basic tier is closed to new developers. Any polling cadence worth
having costs real money every month, which fails the "no recurring cost" constraint.

Per §2.2 this costs less than it appears: a station's tweet was never going to be
independent of that station's stream anyway. The free stand-in is **A1**, the org's
own article RSS — lagging, so it mostly helps *sustain* and *close* an incident
rather than open one.

### 2.10 Aircraft corroboration (ADS-B) — the only non-editorial channel

Public ADS-B (OpenSky, free, no auth, ~400 calls/day anonymous) gives aircraft
positions over the LA basin. Aircraft covering an incident fly one of **two**
distinguishable shapes, and the channel looks for both.

**Orbiting** — holding over one spot. This is a chase that has *stopped* (a bailout,
a standoff), a fire, or a crash scene:

```
net displacement / path length < 0.4    # went nowhere despite flying far
cumulative heading change     > 60°     # and kept turning
low and slow                            # below cruise altitude and speed
cluster = 2+ orbiting aircraft within 5 km of each other
```

**Pursuing** — following a vehicle. This is a chase still *running*, and it is the
exact opposite geometry:

```
net displacement / path length > 0.6    # went somewhere, in a line
speed 18-75 m/s                         # road speed: 40-170 mph
path >= 2 km                            # and covered real ground doing it
low                                     # same altitude ceiling
cluster = 2+ such aircraft, close at BOTH ends of the window, headings within 60°
```

The second shape exists because the first could not see a real one. On 2026-10-09 the
monitor caught a televised 44-minute CHP pursuit (the 405 through Huntington Beach,
then the 5 at Irvine) and the aircraft channel reported **zero** orbiting aircraft. It
was not a tuning miss: a helicopter matching a car at 100 mph has a `loiter` near 0.9
against a required `< 0.4`, and a freeway is straight so its `turnDeg` stays near 0
against a required `> 60`. It failed both axes by construction. The orbit test
describes the *tail* of an event; the useful moment is the pursuit itself.

Two corrections came out of the same miss:

- **The box was too small.** `bbox.lamin` was 33.6, which cuts the basin off at the
  Orange County line — that chase ran on toward San Juan Capistrano (~33.50) and left
  coverage entirely. Now 33.35, which reaches past San Clemente without pulling in San
  Diego approach traffic. Catalina (AVX) joins the airport exclusions because the
  widened box now contains it and the island runs a helicopter shuttle.
- **The reading now records raw counts.** That miss logged `orbiting: 0` and nothing
  else, so "the API returned nothing" and "the API returned a full sky the detector
  rejected" were indistinguishable in the log — opposite fixes, identical evidence.
  `aircraftSeen` and `tracked` separate them.

**Precision is handled differently for the two shapes, and deliberately so.** An orbit
cluster can lean on proximity because its measured background rate is zero — two
aircraft circling one spot essentially does not happen by chance. A pursuit cluster
cannot: LA has busy low-level helicopter corridors, a live sample holds roughly 15-20
aircraft that are low and at road speed, and "two within 5 km heading roughly alike" is
an ordinary afternoon. So a pursuit link additionally requires **co-movement** — the
pair must be close at the *start* of the window as well as the end. Two aircraft
following the same vehicle stay together throughout; two crossing or converging are
close for a single sample. That test, not the heading tolerance, is what provides the
precision, which is why a missing start position refuses the link rather than falling
back to proximity.

An orbit cannot be seen in one snapshot, so a reading is **3 passes ~70 s apart**,
tracked by `icao24` — ~140 s wall clock, longer than a 60 s tick. It is therefore
sampled asynchronously **on suspicion** (`suspicionFloor: 5`, the same
cheap-earns-expensive rule as the `search.list` sweep in §3) and read by a later
tick, never awaited. 18 LA-basin airports are excluded at an 8 km radius, or every
holding pattern at LAX would read as a chase.

**The weight is 3, below the threshold of 8, and that is structural.** A cluster can
never fire an announcement. It cannot even nominate one: an announcement needs a
stream to link to, and this source has none. Either shape scores the same 3, and a sky
holding **both** still scores once — one channel in one group, so two shapes cannot pay
twice any more than two spiking streams can (§2.1).

**It is also gated — a cluster scores 0 until something else has named a chase.**
This is not belt-and-braces; it is the §2.1 error in a subtler form, and it was
caught only by testing it:

| | score | |
|---|---|---|
| Fire-titled stream, 60× spike, **no** aircraft reading | 5 | silent |
| Fire-titled stream, 60× spike, **2 aircraft orbiting** | **8** | **announced a police chase over a wildfire** |

A 60× audience spike and a helicopter cluster are *both* fire-compatible — news
choppers converge on a brush fire exactly as they do on a pursuit, and the live
shadow logs contain precisely that audience shape from a named fire on 2026-10-03.
Summing two non-specific observations produced a confident, specific, wrong answer.
Neither observation was faulty; the arithmetic was.

So `aircraft` only scores once some channel has supplied chase **vocabulary** — a
title match, weak or strong, or a source whose going-live *is* the statement
(`titleIsShowName`). Aircraft then answers the question editorial evidence cannot:
*is this happening right now?* Measured against the worked cases in §2.4, the gate
costs **no** recall — every genuine-chase row still fires, and the strictest
near-miss (row 5, a bare retitle) now reaches 8 and fires where it previously
could not.

What remains unmeasured is the **background rate** for both shapes: how often 2+
aircraft orbit one spot, or travel together at road speed, in LA with no pursuit at
all. The pursuit shape's rate is the more suspect of the two, for the reasons above. `npm run chase:report` prints that as a
calibration section (§7) rather than asserting a number nobody has yet collected.
Until it is collected, the weight does not rise.

Operationally this channel is the only one with a chat kill switch —
`!chasemon aircraft off` — because it depends on a third party that can begin
answering nonsense without warning, and the alternative would be a redeploy. Its
weight and floor are **not** tunable from chat: those are calibration, and calibration
belongs in a reviewed commit.

---

## 3. Polling — cheap always, expensive only on suspicion

Three loops, total steady-state cost **1 API unit/minute plus ~17 MB/day**:

1. **Fast loop — 60 s, 1 quota unit.** One `videos.list` over the pinned persistent
   stream IDs plus any discovered candidates (≤50 IDs in one call). Returns title,
   `liveBroadcastContent` and `concurrentViewers` for all of them. This is the
   real-time detector. **1,440 units/day — 14% of the free quota.**
2. **Discovery loop — 10 min, free.** Six channel RSS feeds → new live video IDs.
   Accepts the 15-minute cache staleness from §1.6 because its only job is noticing
   that a *new* broadcast object exists. ~17 MB/day.
3. **Suspicion sweep — event-driven, 100 units.** When any channel produces strong
   evidence, immediately spend one `search.list?eventType=live` on the `episodic`
   channels to catch a brand-new `episodic` broadcast that RSS will not show for
   another 15 minutes. At ~5 chases/week this is ~500 units/week.

The expensive call is *triggered by* the cheap evidence — that closes the `episodic`
cold-start gap without paying for it 1,440 times a day. Budget ≈ 1,500 units/day
against 10,000, leaving room to drop the fast loop to 30 s if detection latency
proves too high.

---

## 4. Shape in this repo

Follows the existing split exactly — pure rules in `src/rules/`, IO in `src/db/` and
`src/integrations/`, the clock in `src/events/` (the `reminderScheduler.js` /
`rules/reminders.js` pair is the direct template).

```
src/rules/chase.js                pure: (samples, baselines, state, now) -> { evidence, incident, announce }
src/integrations/chaseSources.js  fetchers: videos.list, channel RSS, news RSS
src/events/chaseMonitor.js        the tick loop — clock, IO, send (mirrors reminderScheduler.js)
src/db/chaseMonitor.js            RTDB: baselines, incident state, announce log
src/commands/chase.js             !chase — current or most recent incident
src/commands/mod/chasemon.js      !chasemon on|off|status|threshold|sources — mod-only
test/rules/chase.test.js          offline unit tests (npm test — no network, no emulator)
scripts/chase-record.mjs          sample recorder / shadow collector (§7.1)
scripts/chase-sim.mjs             replay a recorded timeline against the emulator (§7.3)
scripts/chase-sources-load.mjs    npm run chase:sources — private roster -> RTDB (§4)
docs/chase-monitor.md             architecture doc (replaces this proposal once built)
```

**`npm test` only runs the `test/rules/` tree.** Putting the whole quorum / dwell /
hysteresis / baseline model in a pure evaluator means all of the logic that is
actually hard is covered by the **offline** suite, with no network and no emulator.
That is the main argument for this file layout.

Config follows the `clipMode` precedent: static weights and vocabulary in
`src/config.js` under a `chase:` block; the live-tunable bits (`enabled`, `mode`,
`threshold`, `groupCap`, `dwell`, cooldowns) in RTDB `config/chaseMonitor`, seeded
once from `config.js` and thereafter owned by `!chasemon`.

**The source roster is not one of those, and is not in the repo at all.** It is
private (`CLAUDE.md`), so `src/config.js` ships `chase.orgs: []`; the real table lives
in `.workspace/chase-sources.json` (gitignored) and is loaded into RTDB
`config/chaseMonitor/orgs` by `npm run chase:sources`. `getChaseSettings()` layers
RTDB over `config.js`, so a fresh clone starts with **no sources and an inert
monitor** — and `!chasemon` says exactly that. Adding, removing or re-capping a source
is an operator edit to that file plus a reload; it is never a code change.

**`enabled` seeds to `false` and `mode` seeds to `shadow`** — the monitor cannot post
until someone deliberately turns it on twice. **One new env var, `YOUTUBE_API_KEY`**
— nothing else, and no secrets in the repo. The announcement goes through the
existing mute-aware `send` wrapper.

### Invariants (each gets a test)

1. A monitor failure never breaks chat — every fetch wrapped, per-source failures
   isolated the way `reminderScheduler` isolates each reminder.
2. Chat replies never leak API errors, keys, quota state, or source internals.
3. Announcements respect `!mute`.
4. **One announcement per incident** — never per poll, never per stream.
5. **At most one signal scores per evidence channel per organization** — `V1`/`V2`
   and `T1`/`T2` can never both count. One measurement, one score.
6. Signals from one organization take diminishing returns (0.6); signals from
   different organizations are fully additive. A single org *can* cross the
   threshold, but only from ≥ 2 independent evidence channels.
7. The score must hold ≥ `threshold` for `dwell` consecutive polls.
8. Title signals require a title **change**; a static title scores nothing, forever.
9. The announce rate limit is **channel-wide**, not per-user (as with `!clip`).
10. Viewer signals stay disabled until a baseline exists — no cold-start firing.
11. **An incident always closes** — by hysteresis or by `maxIncidentMs`. A stuck
    incident blocks all new ones, which is a silent total failure.
12. `enabled: false` is the default, and the kill switch is honoured mid-incident:
    flipping it off stops announcements immediately without corrupting state.

## 5. Calibrate before it ever posts — shadow mode

> Operational procedure — how to launch it, leave it unattended, and read the log two
> weeks later — is in [`chase-monitor-runbook.md`](chase-monitor-runbook.md).


**This is the highest-value item here.** `mode: shadow` runs the full pipeline and
writes every would-be announcement to RTDB **without sending anything to chat** —
the same data `scripts/chase-record.mjs` (§7.1) collects, now scored. Run it two
weeks, then score the log against the broadcaster chase feed from §1.4 — which is a
**free, retrospective, human-curated list of real
LA chases**, i.e. a labelled ground-truth dataset that costs nothing and needs no
annotation work.

That converts every weight and threshold in §2 from a guess into a measurement, and
it is the only honest way to answer "how many false positives will this produce?"
Right now nobody knows, including this document. Flip to `mode: live` once the
shadow log looks right.

---

## 6. Decisions taken

1. **Precision over recall to start.** Ship strict; loosen only against shadow-mode
   data. The known cost is §2.4 row 3.
2. **Always on, announcing even to an empty channel** — deliberate. The only reason
   to reconsider would be a recurring cost, and there is none: the steady-state
   spend is 1,440 of 10,000 free YouTube quota units per day and ~17 MB of
   bandwidth. Nothing in this design bills. (X / Twitter would have — §2.9 — which
   is the one place that constraint changed the answer.)
3. **Weighted signals over a threshold**, per §2. A single organization may fire an
   announcement on its own with enough evidence; the guard is per-evidence-channel
   deduplication (§2.1), not a per-organization cap.
4. **A mod-operated kill switch**, `!chasemon on|off`, defaulting to **off**.

## 7. Building it locally — emulator first, no live posting

Nothing here needs Twitch, and nothing should post to a real channel until the
shadow log looks right. Four pieces, in dependency order:

### 7.1 `scripts/chase-record.mjs` — build the fixture (do this first)

Polls the real sources on the §3 cadence and appends every raw `videos.list`
sample to a JSONL file. **It never scores and never posts.** Start it today: it is
zero-risk, it needs no emulator, and until a real chase is in the file everything
downstream is guesswork. This is also the shadow-mode collector, so it is not
throwaway scaffolding.

Two weeks of samples is the deliverable that makes §2's weights arguable instead of
invented.

### 7.2 `test/rules/chase.test.js` — the logic, offline

`npm test` runs the `test/rules/` tree with no network and no emulator, so putting
the evaluator in `src/rules/chase.js` puts the entire hard part — grouping, the cap,
diminishing returns, dwell, hysteresis, negative markers, cold start — under the
**offline** suite. Fixtures are hand-written sample timelines in the style of
`test/rules/enlist-reminder.test.js`; every row of the §2.4 worked-cases table
becomes a test case.

### 7.3 `scripts/chase-sim.mjs` — replay against the emulator

Replays a recorded (or synthetic) timeline through the **real** evaluator and the
**real** RTDB writes, printing what the bot would have said and when. Follows the
`subathon-sim.mjs` precedent exactly — "fires fake events through the REAL handler …
only the socket is faked" — because the same reasoning applies: you cannot schedule
a police chase to test against.

```
npx firebase emulators:exec --only database --project okrafans \
  "node scripts/chase-sim.mjs .workspace/chase-samples.jsonl"
```

Add `"test:chase"` to `package.json` beside the existing emulator scripts. Recorded
fixtures go in `.workspace/` (gitignored) — they are large and they are operational
data, not repo content.

### 7.4 `scripts/dev-console.js` meta-commands — drive it by hand

Extend the existing console with `/chase` verbs so the pipeline can be exercised
without waiting for anything real:

```
/chase spike org3 60       # force a 60× viewer ratio on one stream
/chase title org2 LIVE: Police pursuit in Compton
/chase live org1           # flip an episodic channel not-live -> live
/chase score               # print the per-group breakdown and the total
/chase reset
```

`/chase score` printing the **per-group breakdown** is the important one — when a
threshold behaves unexpectedly, the question is always *which group contributed
what*, and a bare total cannot answer it.

### 7.5 Order of work

1. `chase-record.mjs` → start collecting immediately.
2. `src/rules/chase.js` + `test/rules/chase.test.js` → the model, offline, green.
3. `src/db/chaseMonitor.js`, `src/integrations/chaseSources.js`,
   `src/events/chaseMonitor.js` → wire it, emulator only.
4. `chase-sim.mjs` + `/chase` console verbs → tune against real recorded samples.
5. `!chasemon` + `!chase` → the operator surface.
6. Shadow mode on the real bot for two weeks.
7. Flip to live.

## 8. Still open

1. **Non-broadcast chase channels** — `chopper`-class aggregators with no newsroom
   behind them — are often *first* to a scene but less editorially reliable. Give them
   a lower `groupCap` than the broadcasters, or treat them like any other group? The
   roster supports a per-org `groupCap` override for exactly this.
2. **Re-announce on a long chase?** A 2-hour pursuit announced at minute 3 is
   invisible to someone arriving at minute 40. Off by default; `!chase` covers it.
3. **CHP CAD** is rejected on one sample (§1.3). `chase-record.mjs` can log it
   passively for a week at near-zero cost to confirm pursuits truly never appear.
4. **The §2.3 weights are invented.** They are a starting point shaped by the probes
   in §1, not measurements. §5 is how they stop being invented.
