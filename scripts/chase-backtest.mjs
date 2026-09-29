// CHASE BACKTEST — would the settings we have now have fired on chases that
// already happened?
//
//   npm run chase:backtest                       # the last 120 days
//   npm run chase:backtest -- --days 30          # a shorter window
//   npm run chase:backtest -- --dry-run          # the plan and the quota bill, no calls
//   npm run chase:backtest -- --json             # the whole report as one JSON object
//
// scripts/chase-record.mjs answers the same question by WAITING: start it, leave
// it a fortnight, then run scripts/chase-report.mjs. That is the honest way and it
// stays the primary one — but it costs two weeks before the first number arrives,
// and the whole settings discussion is blocked on that. This gets a first,
// weaker answer TODAY out of evidence that already exists: both platforms keep an
// archive of finished broadcasts with a real start time, a real end time and the
// title the broadcast carried, so a past event can be reconstructed as a timeline
// and pushed through the real evaluator.
//
// IT REPLAYS src/rules/chase.js. Nothing here re-implements scoring, dwell,
// hysteresis or the veto — the same evaluator the bot runs is imported and called,
// exactly as scripts/chase-report.mjs does with recorded ticks. A second copy of
// the rules would only answer questions about the copy.
//
// WHY IT IS WEAKER THAN A RECORDING, in four ways that are printed in the report
// itself rather than left in this comment for nobody to read:
//
//   a) NO HISTORICAL VIEWER COUNTS. `concurrentViewers` exists only while a
//      broadcast is live; no archive serves it afterwards. Every reconstructed
//      sample therefore carries `viewers: null`, which DISABLES the audience
//      channel (V1/V2) for the entire replay. That channel is not being tested
//      here, it is absent — and it is the only detector that works on a
//      permanently-titled chopper cam.
//   b) VOD TITLES ARE POST-HOC. A newsroom renames the archive after the fact, and
//      a retitled archive is systematically MORE chase-explicit than the title that
//      was on screen at the time. Every title-channel result below is therefore an
//      optimistic bound.
//   c) DELETED, UNLISTED AND EXPIRED VODS ARE SIMPLY ABSENT. Twitch archives expire
//      on a retention clock, and newsrooms unlist. A chase whose broadcast is gone
//      cannot be missed by the detector here — it never reaches it.
//   d) EVERY CLUSTER REPLAYS FROM A COLD STATE. There is no continuous baseline, no
//      reopen lockout carried in from the previous event and no `maxPerHour`
//      pressure, because the archives only cover the minutes a broadcast existed.
//
// TWO KINDS OF GROUND TRUTH, REPORTED SEPARATELY — this is the point of the script.
//
//   CIRCULAR (§3): "the cluster's title says pursuit". Firing on that is partly
//   tautological, because the title is the same string the title channel reads. It
//   is still worth measuring — dwell, the veto, the within-org discount and the
//   threshold can all fail on an obviously-titled event — but it is an upper bound
//   on nothing and it is labelled as such everywhere it appears.
//
//   INDEPENDENT (§4): the roster's article feed. Those items are published after
//   the fact by a newsroom that decided a chase was worth writing up, and they are
//   not derived from any stream title. They are DELIBERATELY NOT fed into the
//   replay — the evaluator's editorial channel (A1) is left empty for the whole
//   backtest — because scoring with the same feed that is being used as the answer
//   key would make the independent half circular too.
//
//   The number §4 actually produces is a CEILING: of the chases that were published,
//   how many still have a reconstructable broadcast at all? The detector cannot beat
//   that, and archive decay means it falls off hard with age — which is why it is
//   broken down by age bucket and not reported as one average.
//
// THE ROSTER IS PRIVATE (CLAUDE.md). This file names no outlet, no channel id and no
// feed url; it reads the gitignored roster at runtime, prints opaque org ids, and
// never prints a display name — not even through the evaluator's announcement text,
// which is why `name` is stripped from the settings handed to it. Broadcast TITLES
// are printed, because they are the evidence the title channel scores and a report
// that hides them cannot be checked — so the report's own header says not to paste
// its output into the repo.
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { config } from '../src/config.js';
import { evaluateChase, matchesAny } from '../src/rules/chase.js';
import { parseArticleFeed, partitionSources, twitchReady, SEARCH_UNITS } from '../src/integrations/chaseSources.js';

const MIN_MS = 60_000;
const HOUR_MS = 60 * MIN_MS;
const DAY_MS = 24 * HOUR_MS;

/** Broadcasts this far apart still belong to the same event (the brief the spec was built from). */
const CLUSTER_GAP_MS = 45 * MIN_MS;
/** Replay starts before the first broadcast so the evaluator sees the off->on edge, not a stream already up. */
const PRE_ROLL_MS = 20 * MIN_MS;
const POST_ROLL_MS = 10 * MIN_MS;
/** How close a broadcast has to be to a published chase to count as covering it. */
const GROUND_TRUTH_MS = 12 * HOUR_MS;
/**
 * Longer than this is a 24/7 LOOP, not an event, and it must not SEED a cluster:
 * one multi-day always-on archive would merge every cluster in the window into a
 * single blob and the backtest would measure nothing. Loops are still sampled as
 * background liveness inside other clusters — which is honest, and costs nothing,
 * because a loop carries one unchanging title and a start time hours in the past,
 * so it scores zero on every channel by construction.
 */
const EVENT_MAX_MS = 12 * HOUR_MS;
/** A runaway chain of merges would replay for days of minutes; bound it and say so. */
const MAX_REPLAY_MINUTES = 4320;
/** Real-world base rate the design assumed, design §1.1 — §5 exists to correct it. */
const ASSUMED_RATE_PER_WEEK = [3, 5];
const AGE_BUCKETS = [[0, 30], [30, 60], [60, 120]];

const YT_SEARCH_URL = 'https://www.googleapis.com/youtube/v3/search';
const YT_VIDEOS_URL = 'https://www.googleapis.com/youtube/v3/videos';
const TWITCH_TOKEN_URL = 'https://id.twitch.tv/oauth2/token';
const TWITCH_USERS_URL = 'https://api.twitch.tv/helix/users';
const TWITCH_VIDEOS_URL = 'https://api.twitch.tv/helix/videos';
const HTTP_TIMEOUT_MS = 20_000;
/** videos.list takes 50 ids for one unit; search.list returns at most 50 per page. */
const MAX_IDS = 50;

// ── arguments ────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`
  usage: node scripts/chase-backtest.mjs [options]

    --days N        how far back to reconstruct (default 120)
    --dry-run       print the plan and the estimated quota spend, make no calls
    --json          emit the whole report as one JSON object (diffable between runs)
    --no-sweep      skip the threshold/dwell sweep, which replays every cluster
                    once per grid cell

  Reads the PRIVATE roster from .workspace/chase-sources.json (or
  $CHASE_SOURCES_FILE). Needs YOUTUBE_API_KEY for the YouTube sources and
  TWITCH_CLIENT_ID + TWITCH_CLIENT_SECRET for the Twitch ones; a platform whose
  credentials are missing is skipped with a warning instead of crashing the run.
`);
  process.exit(0);
}
const JSON_OUT = argv.includes('--json');
const NO_SWEEP = argv.includes('--no-sweep');
const DRY_RUN = argv.includes('--dry-run');

function flagNumber(name, fallback) {
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return Number(eq.split('=')[1]);
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && argv[i + 1] != null && !argv[i + 1].startsWith('-')) return Number(argv[i + 1]);
  return fallback;
}
const DAYS = flagNumber('days', 120);
if (!Number.isFinite(DAYS) || DAYS <= 0) {
  console.error('\n  --days needs a positive number of days\n');
  process.exit(1);
}

// ── small formatters (same shapes as scripts/chase-report.mjs) ───────────────

const pad2 = (n) => String(n).padStart(2, '0');
const round2 = (n) => Math.round(n * 100) / 100;
const pct = (n, d) => (d > 0 ? `${((100 * n) / d).toFixed(0)}%` : '—');

/** Local time — the person reading this lives in the timezone the chases are in. */
function stamp(ms) {
  if (!Number.isFinite(ms)) return '—';
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
const day = (ms) => (Number.isFinite(ms) ? stamp(ms).slice(0, 10) : '—');

function dur(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const m = Math.round(ms / MIN_MS);
  if (m < 90) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h ${pad2(m % 60)}m` : `${(h / 24).toFixed(1)}d`;
}

/** Titles are evidence and get printed, but they are not allowed to wreck the columns. */
function clip(text, width) {
  const one = String(text ?? '').replace(/\s+/g, ' ').trim();
  return one.length <= width ? one : `${one.slice(0, width - 1)}…`;
}

function wrap(text, width) {
  const out = [];
  let line = '';
  for (const word of String(text).split(/\s+/)) {
    if (line && line.length + 1 + word.length > width) { out.push(line); line = word; } else line = line ? `${line} ${word}` : word;
  }
  if (line) out.push(line);
  return out;
}

// Printed as it is computed, not buffered: the fetches take a while and the replay
// takes longer, and a report that shows nothing until the end looks hung.
const say = (text = '') => { if (!JSON_OUT) console.log(text); };
/** Progress and warnings, which must survive --json — so they go to stderr there. */
const note = (text = '') => { if (JSON_OUT) console.error(text); else console.log(text); };
function section(n, title) {
  say('');
  say(`  ${'═'.repeat(72)}`);
  say(`  ${n} · ${title}`);
  say(`  ${'═'.repeat(72)}`);
}

/** No credential ever reaches a log line, an error message or this report. */
const redact = (s) => String(s)
  .replace(/key=[^&\s]+/gi, 'key=***')
  .replace(/client_secret=[^&\s]+/gi, 'client_secret=***')
  .replace(/\bBearer\s+[\w.+/=-]+/gi, 'Bearer ***');

// ── the roster ───────────────────────────────────────────────────────────────

const SOURCES_FILE = process.env.CHASE_SOURCES_FILE || '.workspace/chase-sources.json';

function loadRoster() {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(SOURCES_FILE, 'utf8'));
  } catch (err) {
    console.error(`\n  cannot read the source roster at ${SOURCES_FILE}`);
    console.error(`  ${err.message}`);
    console.error('\n  That file is gitignored and is NOT in the repo (CLAUDE.md). See');
    console.error('  scripts/chase-sources-load.mjs for its shape, or set CHASE_SOURCES_FILE.\n');
    process.exit(1);
  }
  const orgs = Array.isArray(parsed) ? parsed.filter((o) => o?.id && (o.channelId || o.login)) : [];
  if (!orgs.length) {
    console.error(`\n  ${SOURCES_FILE} holds no usable sources — every entry needs an id and a channelId or login.\n`);
    process.exit(1);
  }
  return orgs;
}

// ── reconstruction: YouTube ──────────────────────────────────────────────────

async function getJson(url, init) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  if (!res?.ok) {
    const body = await res.text().catch(() => '');
    const reason = (() => {
      try { return JSON.parse(body)?.error?.message || JSON.parse(body)?.message || ''; } catch { return ''; }
    })();
    throw new Error(redact(`HTTP ${res?.status ?? 0}${reason ? ` — ${reason}` : ''}`));
  }
  return res.json();
}

/**
 * Past broadcasts for one YouTube channel.
 *
 * `search.list` with `eventType=completed` is the only call that lists finished
 * broadcasts, and it costs 100 units against a 10,000/day budget — which is why
 * this is a backtest you run occasionally and never a loop. One page, 50 ids: the
 * archive is deeper than that for a busy channel, and the truncation is REPORTED
 * rather than paged through, because each further page is another 100 units.
 *
 * `videos.list` then turns those ids into real timelines. Both `actualStartTime`
 * and `actualEndTime` are present for a completed broadcast; anything missing one
 * is still live or was never a broadcast, and is dropped rather than guessed at.
 */
async function youtubeBroadcasts(orgs, key, spend) {
  const out = [];
  const perOrg = new Map();
  const warnings = [];
  for (const org of orgs) {
    let ids = [];
    try {
      const qs = new URLSearchParams({
        part: 'id',
        channelId: org.channelId,
        eventType: 'completed',
        type: 'video',
        maxResults: String(MAX_IDS),
        order: 'date',
        key,
      });
      const json = await getJson(`${YT_SEARCH_URL}?${qs}`);
      spend.units += SEARCH_UNITS;
      ids = (json?.items || []).map((i) => i?.id?.videoId).filter((v) => typeof v === 'string' && v);
    } catch (err) {
      warnings.push(`${org.id}: completed-broadcast search failed — ${err.message}`);
      continue;
    }
    perOrg.set(org.id, { returned: ids.length, capped: ids.length >= MAX_IDS, kept: 0, noTimes: 0, oldestFetched: null });
    if (!ids.length) continue;

    for (let i = 0; i < ids.length; i += MAX_IDS) {
      const chunk = ids.slice(i, i + MAX_IDS);
      try {
        const qs = new URLSearchParams({ part: 'snippet,liveStreamingDetails', id: chunk.join(','), key });
        const json = await getJson(`${YT_VIDEOS_URL}?${qs}`);
        spend.units += 1;
        for (const item of json?.items || []) {
          const details = item?.liveStreamingDetails || {};
          const start = Date.parse(details.actualStartTime || '');
          const end = Date.parse(details.actualEndTime || '');
          if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
            perOrg.get(org.id).noTimes += 1;
            continue;
          }
          out.push({
            org: org.id,
            platform: 'youtube',
            start,
            end,
            title: typeof item?.snippet?.title === 'string' ? item.snippet.title : '',
          });
          const seen = perOrg.get(org.id);
          seen.kept += 1;
          seen.oldestFetched = seen.oldestFetched == null ? start : Math.min(seen.oldestFetched, start);
        }
      } catch (err) {
        warnings.push(`${org.id}: videos.list failed for ${chunk.length} id(s) — ${err.message}`);
      }
    }
  }
  return { broadcasts: out, perOrg, warnings };
}

// ── reconstruction: Twitch ───────────────────────────────────────────────────

/** "1h20m26s", "20m26s", "47s" — helix writes durations this way and nothing else. */
function parseTwitchDuration(text) {
  const s = String(text ?? '');
  const grab = (unit) => {
    const m = new RegExp(`(\\d+)${unit}`).exec(s);
    return m ? Number(m[1]) : 0;
  };
  const ms = ((grab('h') * 60 + grab('m')) * 60 + grab('s')) * 1000;
  return ms > 0 ? ms : null;
}

/**
 * Past broadcasts for the Twitch sources. An APP access token, exactly as
 * src/integrations/chaseSources.js mints one — public reads only, no user — and the
 * secret travels in the BODY, never in a URL that an error message would echo.
 */
async function twitchBroadcasts(orgs) {
  const out = [];
  const perOrg = new Map();
  const warnings = [];

  let token;
  try {
    const json = await getJson(TWITCH_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        client_id: (process.env.TWITCH_CLIENT_ID || '').trim(),
        client_secret: (process.env.TWITCH_CLIENT_SECRET || '').trim(),
        grant_type: 'client_credentials',
      }).toString(),
    });
    token = typeof json?.access_token === 'string' ? json.access_token : '';
  } catch (err) {
    return { broadcasts: out, perOrg, warnings: [`twitch: app token rejected — ${err.message}`] };
  }
  if (!token) return { broadcasts: out, perOrg, warnings: ['twitch: token response carried no token'] };

  const headers = {
    'Client-Id': (process.env.TWITCH_CLIENT_ID || '').trim(),
    Authorization: `Bearer ${token}`,
    accept: 'application/json',
  };

  const byLogin = new Map(orgs.map((o) => [String(o.login).trim().toLowerCase(), o]));
  let users = [];
  try {
    const qs = new URLSearchParams();
    for (const login of byLogin.keys()) qs.append('login', login);
    const json = await getJson(`${TWITCH_USERS_URL}?${qs}`, { headers });
    users = Array.isArray(json?.data) ? json.data : [];
  } catch (err) {
    return { broadcasts: out, perOrg, warnings: [`twitch: users lookup failed — ${err.message}`] };
  }

  for (const user of users) {
    const org = byLogin.get(String(user?.login || '').toLowerCase());
    if (!org || !user?.id) continue;
    perOrg.set(org.id, { returned: 0, capped: false, kept: 0, noTimes: 0, oldestFetched: null });
    try {
      const qs = new URLSearchParams({ user_id: String(user.id), type: 'archive', first: '100' });
      const json = await getJson(`${TWITCH_VIDEOS_URL}?${qs}`, { headers });
      const rows = Array.isArray(json?.data) ? json.data : [];
      perOrg.get(org.id).returned = rows.length;
      perOrg.get(org.id).capped = rows.length >= 100;
      for (const v of rows) {
        const start = Date.parse(v?.created_at || '');
        const ms = parseTwitchDuration(v?.duration);
        if (!Number.isFinite(start) || ms == null) { perOrg.get(org.id).noTimes += 1; continue; }
        out.push({
          org: org.id,
          platform: 'twitch',
          start,
          end: start + ms,
          title: typeof v?.title === 'string' ? v.title : '',
        });
        const seen = perOrg.get(org.id);
        seen.kept += 1;
        seen.oldestFetched = seen.oldestFetched == null ? start : Math.min(seen.oldestFetched, start);
      }
    } catch (err) {
      warnings.push(`${org.id}: videos archive failed — ${err.message}`);
    }
  }
  const missing = [...byLogin.values()].filter((o) => !perOrg.has(o.id));
  for (const o of missing) warnings.push(`${o.id}: no such Twitch user, or the account is gone`);
  return { broadcasts: out, perOrg, warnings };
}

// ── clustering ───────────────────────────────────────────────────────────────

/**
 * An EVENT is several newsrooms pointing at the same thing at once, so broadcasts
 * that overlap — or that start within CLUSTER_GAP_MS of the previous one ending —
 * are one cluster. Only event-length broadcasts seed clusters (see EVENT_MAX_MS);
 * the loops are still sampled inside whatever cluster they overlap.
 */
function clusterBroadcasts(broadcasts) {
  const seeds = broadcasts
    .filter((b) => b.end - b.start <= EVENT_MAX_MS)
    .sort((a, b) => a.start - b.start);
  const clusters = [];
  let current = null;
  for (const b of seeds) {
    if (!current || b.start - current.end > CLUSTER_GAP_MS) {
      current = { start: b.start, end: b.end, members: [b] };
      clusters.push(current);
    } else {
      current.end = Math.max(current.end, b.end);
      current.members.push(b);
    }
  }
  return clusters;
}

/**
 * One StreamSample per ROSTER ENTRY per minute — including the orgs that were dark,
 * which is not padding: `live: false` is what mints the resting title and the
 * off->on edge the liveness channel scores. `viewers` is null on every sample and
 * always will be (see limit (a)).
 */
function buildTicks(cluster, roster, broadcasts) {
  const from = cluster.start - PRE_ROLL_MS;
  const wanted = Math.round((cluster.end + POST_ROLL_MS - from) / MIN_MS) + 1;
  const minutes = Math.min(wanted, MAX_REPLAY_MINUTES);
  const live = new Map();
  for (const org of roster) {
    live.set(org.id, broadcasts
      .filter((b) => b.org === org.id && b.end >= from && b.start <= cluster.end + POST_ROLL_MS)
      .sort((a, b) => a.start - b.start));
  }
  const ticks = [];
  for (let i = 0; i < minutes; i += 1) {
    const at = from + i * MIN_MS;
    const samples = roster.map((org) => {
      const b = (live.get(org.id) || []).find((x) => x.start <= at && x.end >= at) || null;
      return {
        org: org.id,
        videoId: b ? `${org.id}-${b.start}` : `${org.id}-off`,
        streamClass: org.streamClass || 'newscast',
        live: Boolean(b),
        title: b ? b.title : '',
        viewers: null, // never available historically — the audience channel is OFF
        startedAt: b ? b.start : null,
        at,
      };
    });
    ticks.push({ at, samples });
  }
  return { ticks, truncated: wanted > minutes };
}

/**
 * One cluster through the REAL evaluator, with `articles` deliberately empty: the
 * article feed is the independent answer key in §4 and must not also be an input.
 */
function replay(ticks, cfg) {
  let state = null;
  let peak = 0;
  let peakGroups = null;
  let openedAt = null;
  let openScore = 0;
  let opens = 0;
  for (const tick of ticks) {
    const res = evaluateChase({ samples: tick.samples, articles: [], state, now: tick.at, cfg });
    state = res.state;
    if (res.score > peak) { peak = res.score; peakGroups = res.groups; }
    if (res.opened) {
      opens += 1;
      if (openedAt == null) { openedAt = tick.at; openScore = round2(res.score); }
    }
  }
  // The PEAK tick's breakdown, not the opening one: the question a cluster line has
  // to answer is which newsrooms carried the event, and an incident opens on the
  // third tick over the line — often before the second org has joined it.
  const groups = peakGroups || {};
  return {
    peak: round2(peak),
    openedAt,
    openScore,
    opens,
    contributors: Object.entries(groups)
      .filter(([, g]) => Number(g?.score) > 0)
      .sort((a, b) => b[1].score - a[1].score)
      .map(([id, g]) => ({ org: id, score: round2(g.score) })),
    vetoed: Object.entries(groups).filter(([, g]) => g?.vetoed).map(([id]) => id),
  };
}

// ── the run ──────────────────────────────────────────────────────────────────

async function main() {
  const roster = loadRoster();
  const { youtube: ytOrgs, twitch: twOrgs } = partitionSources(roster);
  const key = (process.env.YOUTUBE_API_KEY || '').trim();
  const ytUsable = Boolean(key) && ytOrgs.length > 0;
  const twUsable = twitchReady() && twOrgs.length > 0;
  const now = Date.now();
  const windowFrom = now - DAYS * DAY_MS;
  const weeks = (DAYS * DAY_MS) / (7 * DAY_MS);

  const strongVocab = config.chase.strongVocab || [];
  const negativeVocab = config.chase.negativeVocab || [];
  // The evaluator's own settings, with the private roster layered on and every
  // DISPLAY NAME stripped: `name` reaches only announcementText, and nothing in this
  // report may print an outlet name (CLAUDE.md).
  const CFG = {
    ...config.chase,
    orgs: roster.map((o) => ({
      id: o.id,
      streamClass: o.streamClass,
      ...(o.groupCap ? { groupCap: o.groupCap } : {}),
    })),
  };

  note('');
  note('  CHASE MONITOR — BACKTEST AGAINST THE ARCHIVES');
  note(`  window      last ${DAYS} days · ${day(windowFrom)} → ${day(now)}`);
  note(`  settings    src/config.js · threshold ${CFG.threshold} · dwell ${CFG.dwell} · clear ${CFG.clearScore}/${CFG.clearPolls} · cap ${CFG.groupCap}`);
  note(`  roster      ${roster.length} source(s) from ${SOURCES_FILE} — ${ytOrgs.length} youtube · ${twOrgs.length} twitch`);
  note('  NOTE        this output carries real broadcast titles. It is operational');
  note('              data like the recorder\'s logs: do not paste it into the repo.');
  note('');

  // The bill, before anything is spent. search.list is 100 units a channel and the
  // free daily budget is 10,000, so this is a number an operator has to see first.
  const estimate = ytUsable ? ytOrgs.length * (SEARCH_UNITS + 1) : 0;
  note('  PLAN');
  note(`    youtube   ${ytUsable ? `${ytOrgs.length} source(s) · search.list ${SEARCH_UNITS}u each + videos.list 1u per 50 ids` : 'SKIPPED'}`);
  if (!ytUsable && ytOrgs.length) note('              no YOUTUBE_API_KEY — those sources contribute nothing to this run');
  note(`    twitch    ${twUsable ? `${twOrgs.length} source(s) · users + videos, 1 point each against 800/min` : 'SKIPPED'}`);
  if (!twUsable && twOrgs.length) note('              no TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET — those sources contribute nothing');
  note(`    feeds     ${roster.filter((o) => o.articleFeed).length} article feed(s) · free, keyless, the independent ground truth`);
  note(`    ESTIMATED YOUTUBE SPEND  ~${estimate} units of the 10,000/day quota`);
  note('');

  if (DRY_RUN) {
    note('  --dry-run: nothing was fetched and no quota was spent.');
    note('');
    return;
  }
  if (!ytUsable && !twUsable) {
    note('  neither platform is usable — no broadcast can be reconstructed. The article');
    note('  feed below still measures the base rate, but §2 and §3 will be empty.');
    note('');
  }

  const spend = { units: 0 };
  const warnings = [];
  let broadcasts = [];
  const perOrg = new Map();

  if (ytUsable) {
    note(`  fetching ${ytOrgs.length} youtube archive(s)…`);
    const yt = await youtubeBroadcasts(ytOrgs, key, spend);
    broadcasts.push(...yt.broadcasts);
    for (const [k, v] of yt.perOrg) perOrg.set(k, { ...v, platform: 'youtube' });
    warnings.push(...yt.warnings);
  }
  if (twUsable) {
    note(`  fetching ${twOrgs.length} twitch archive(s)…`);
    const tw = await twitchBroadcasts(twOrgs);
    broadcasts.push(...tw.broadcasts);
    for (const [k, v] of tw.perOrg) perOrg.set(k, { ...v, platform: 'twitch' });
    warnings.push(...tw.warnings);
  }

  const feeds = roster.filter((o) => o.articleFeed);
  const articles = [];
  const feedNotes = [];
  for (const org of feeds) {
    try {
      const res = await fetch(org.articleFeed, {
        headers: { accept: 'application/rss+xml, application/xml;q=0.9, */*;q=0.8' },
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
      if (!res?.ok) { feedNotes.push(`${org.id}: article feed rejected (HTTP ${res?.status ?? 0})`); continue; }
      const items = parseArticleFeed(await res.text(), org.id);
      feedNotes.push(`${org.id}: ${items.length} item(s) in the feed`);
      articles.push(...items);
    } catch (err) {
      feedNotes.push(`${org.id}: article feed unreachable — ${redact(err?.message || err)}`);
    }
  }

  const beforeWindow = broadcasts.length;
  broadcasts = broadcasts.filter((b) => b.end >= windowFrom && b.start <= now);

  // ── 1. what was reconstructed ──────────────────────────────────────────────
  section(1, 'WHAT WAS RECONSTRUCTED');
  say('');
  say(`  spent ${spend.units} YouTube quota unit(s) · ${beforeWindow} broadcast(s) reconstructed, `
    + `${broadcasts.length} inside the ${DAYS}-day window`);
  say('');
  const rows = [];
  for (const org of roster) {
    const mine = broadcasts.filter((b) => b.org === org.id);
    const meta = perOrg.get(org.id) || null;
    const durations = mine.map((b) => b.end - b.start).sort((a, b) => a - b);
    rows.push({
      org: org.id,
      platform: org.platform === 'twitch' ? 'twitch' : 'youtube',
      streamClass: org.streamClass || 'newscast',
      broadcasts: mine.length,
      loops: mine.filter((b) => b.end - b.start > EVENT_MAX_MS).length,
      first: mine.length ? Math.min(...mine.map((b) => b.start)) : null,
      last: mine.length ? Math.max(...mine.map((b) => b.end)) : null,
      medianDurMs: durations.length ? durations[durations.length >> 1] : null,
      listed: meta?.returned ?? 0,
      oldestFetched: meta?.oldestFetched ?? null,
      // A capped listing only LOSES data when its oldest entry is newer than the
      // window start; a channel whose 50 archives already reach past it lost nothing.
      archiveTruncated: Boolean(meta?.capped) && Number(meta?.oldestFetched) > windowFrom,
      droppedNoTimes: meta?.noTimes ?? 0,
    });
  }
  say('  org        platform   class     listed   in window   loops   median   earliest     latest');
  say(`  ${'─'.repeat(88)}`);
  for (const r of rows) {
    say(`  ${r.org.padEnd(10)} ${r.platform.padEnd(9)} ${String(r.streamClass).padEnd(9)} `
      + `${String(r.listed).padStart(6)} ${String(r.broadcasts).padStart(11)} ${String(r.loops).padStart(7)} `
      + `${(r.medianDurMs == null ? '—' : dur(r.medianDurMs)).padStart(8)}   ${day(r.first).padEnd(12)} ${day(r.last)}`);
  }
  say('');
  say('  listed = archive entries the platform returned · in window = those with a');
  say(`  usable start/end pair inside the last ${DAYS} days.`);
  const truncated = rows.filter((r) => r.archiveTruncated);
  if (truncated.length) {
    say('');
    say('  ARCHIVE TRUNCATED — the listing returned a full page AND its oldest entry is');
    say('  inside the window, so these sources have earlier broadcasts that were never');
    say(`  fetched (another page is another ${SEARCH_UNITS} units). Events before the date below`);
    say('  are missing for them, and every recall figure here is computed without them:');
    for (const r of truncated) {
      say(`    ${r.org.padEnd(10)} listing capped at ${r.listed} · nothing before ${day(r.oldestFetched)} was fetched`);
    }
  }
  const noTimes = rows.filter((r) => r.droppedNoTimes);
  if (noTimes.length) {
    say('');
    for (const r of noTimes) say(`  ${r.org.padEnd(10)} ${r.droppedNoTimes} archive entry(ies) dropped — no usable start/end pair`);
  }
  if (warnings.length) {
    say('');
    say('  FETCH WARNINGS');
    for (const w of warnings) say(`    ${w}`);
  }
  const loops = broadcasts.filter((b) => b.end - b.start > EVENT_MAX_MS).length;
  if (loops) {
    say('');
    for (const l of wrap(`${loops} broadcast(s) run longer than ${EVENT_MAX_MS / HOUR_MS}h. Those are 24/7 loops, not events: `
      + 'they cannot seed a cluster (one of them would merge the whole window into a single blob), '
      + 'but they are still sampled as background liveness inside the clusters they overlap.', 72)) say(`  ${l}`);
  }
  say('');

  // ── 2. per-cluster replay ──────────────────────────────────────────────────
  const clusters = clusterBroadcasts(broadcasts);
  const sweepCells = [];
  const thresholds = [6, 7, 8, 9, 10];
  const dwells = [2, 3, 4];
  if (!NO_SWEEP) {
    for (const t of thresholds) {
      for (const d of dwells) sweepCells.push({ threshold: t, dwell: d, fired: 0, firedTitled: 0, firedUntitled: 0 });
    }
  }

  section(2, 'PER-CLUSTER REPLAY — what the current settings would have done');
  say('');
  const totalMinutes = clusters.reduce((a, c) => a + Math.min(
    Math.round((c.end + POST_ROLL_MS - (c.start - PRE_ROLL_MS)) / MIN_MS) + 1, MAX_REPLAY_MINUTES,
  ), 0);
  say(`  ${clusters.length} cluster(s) · ~${totalMinutes} minute-ticks through src/rules/chase.js`
    + `${NO_SWEEP ? '' : `, then ${sweepCells.length} more times for the sweep (--no-sweep skips that)`}…`);
  say('');
  say('  FIRED   an incident opened · MISS   chase-titled and never opened');
  say('  FIRED*  opened with NO chase word in any title — a candidate false positive');
  say('  —       neither');
  say('');

  const results = [];
  let truncatedClusters = 0;
  for (const cluster of clusters) {
    const titles = cluster.members.map((m) => m.title);
    const strongTitles = titles.filter((t) => matchesAny(t, strongVocab));
    const negative = titles.some((t) => matchesAny(t, negativeVocab));
    const chaseTitled = strongTitles.length > 0 && !negative;
    const { ticks, truncated: cut } = buildTicks(cluster, roster, broadcasts);
    if (cut) truncatedClusters += 1;

    const main = replay(ticks, CFG);
    for (const cell of sweepCells) {
      // clearScore must never exceed the threshold, or an incident opens and can
      // never close — which would report as a tuning result instead of a stuck one.
      const res = replay(ticks, {
        ...CFG,
        threshold: cell.threshold,
        dwell: cell.dwell,
        clearScore: Math.min(CFG.clearScore, cell.threshold),
      });
      if (res.openedAt != null) {
        cell.fired += 1;
        if (chaseTitled) cell.firedTitled += 1; else cell.firedUntitled += 1;
      }
    }

    const row = {
      at: cluster.start,
      endsAt: cluster.end,
      orgs: [...new Set(cluster.members.map((m) => m.org))],
      broadcasts: cluster.members.length,
      chaseTitled,
      negativeTitled: negative,
      fired: main.openedAt != null,
      firedAfterMs: main.openedAt == null ? null : main.openedAt - cluster.start,
      openScore: main.openScore,
      peak: main.peak,
      contributors: main.contributors,
      vetoed: main.vetoed,
      title: strongTitles[0] || titles[0] || '',
      replayTruncated: cut,
    };
    results.push(row);

    const mark = row.fired
      ? `FIRED${chaseTitled ? '' : '*'} +${Math.round(row.firedAfterMs / MIN_MS)}m`
      : chaseTitled ? 'MISS' : '—';
    const who = row.contributors.length
      ? row.contributors.map((c) => c.org).join(',')
      : row.orgs.join(',');
    say(`  ${stamp(row.at)}  ${mark.padEnd(12)} ${String(row.peak.toFixed(1)).padStart(5)}  `
      + `${clip(who, 12).padEnd(12)}  ${clip(row.title, 40)}`);
  }
  if (!clusters.length) say('  no clusters — nothing was reconstructed inside the window.');
  if (truncatedClusters) {
    say('');
    say(`  ${truncatedClusters} cluster(s) hit the ${MAX_REPLAY_MINUTES}-minute replay cap and were cut short.`);
  }
  say('');

  // ── 3. circular ground truth ───────────────────────────────────────────────
  const titled = results.filter((r) => r.chaseTitled);
  const untitled = results.filter((r) => !r.chaseTitled);
  const titledFired = titled.filter((r) => r.fired);
  const untitledFired = untitled.filter((r) => r.fired);

  section(3, 'CIRCULAR GROUND TRUTH — clusters whose own title says "chase"');
  say('');
  for (const l of wrap('READ THIS AS PARTLY TAUTOLOGICAL. The label here is "some broadcast in the '
    + 'cluster carries the strong vocabulary", and the strong vocabulary is exactly what the title '
    + 'channel scores. A high number means dwell, the veto, the discount and the threshold did not '
    + 'get in the way of an obvious event — it does NOT mean the detector found anything the label '
    + 'did not already contain. §4 is the half that is not circular.', 72)) say(`  ${l}`);
  say('');
  say(`  chase-titled clusters      ${titled.length}`);
  say(`  ...of which FIRED          ${titledFired.length}  (${pct(titledFired.length, titled.length)})`);
  say(`  other clusters             ${untitled.length}`);
  say(`  ...of which fired anyway   ${untitledFired.length}  (${pct(untitledFired.length, untitled.length)}) ← candidate false positives`);
  const vetoedMisses = titled.filter((r) => !r.fired && r.vetoed.length).length;
  const missedNoScore = titled.filter((r) => !r.fired && r.peak === 0).length;
  const missedShort = titled.filter((r) => !r.fired && r.peak > 0 && r.peak < CFG.threshold).length;
  if (titled.length > titledFired.length) {
    say('');
    say('  why the misses missed');
    say(`    scored nothing at all            ${missedNoScore}`);
    say(`    scored, but under threshold ${String(CFG.threshold).padEnd(3)} ${missedShort}`);
    say(`    an org was vetoed as a recap     ${vetoedMisses}`);
  }
  say('');

  // ── 4. independent ground truth ────────────────────────────────────────────
  const published = articles
    .filter((a) => Number.isFinite(a.publishedAt) && a.publishedAt > 0)
    .filter((a) => a.publishedAt >= windowFrom && a.publishedAt <= now)
    .filter((a) => matchesAny(a.title, strongVocab) && !matchesAny(a.title, negativeVocab))
    .sort((a, b) => a.publishedAt - b.publishedAt);

  // Several write-ups of one chase are one chase. Items inside six hours of each
  // other collapse into a single EVENT, and both counts are reported, because the
  // raw item count is what the feed literally contains and the event count is what
  // the base rate in §5 is supposed to mean.
  const events = [];
  for (const a of published) {
    const last = events[events.length - 1];
    if (last && a.publishedAt - last.at <= 6 * HOUR_MS) { last.items += 1; continue; }
    events.push({ at: a.publishedAt, items: 1, title: a.title });
  }
  const distance = (at) => broadcasts.reduce((best, b) => {
    const d = at < b.start ? b.start - at : at > b.end ? at - b.end : 0;
    return d < best ? d : best;
  }, Infinity);
  for (const e of events) {
    e.nearestMs = distance(e.at);
    e.covered = e.nearestMs <= GROUND_TRUTH_MS;
    e.ageDays = (now - e.at) / DAY_MS;
  }

  section(4, 'INDEPENDENT GROUND TRUTH — chases the newsroom published afterwards');
  say('');
  for (const l of wrap('These items are published after the fact and are NOT derived from any stream '
    + 'title, so they are a real answer key. They are deliberately NOT fed into the replay — the '
    + 'evaluator\'s editorial channel (A1) is empty for this whole backtest — because scoring with '
    + 'the answer key would make this half circular too.', 72)) say(`  ${l}`);
  say('');
  for (const n of feedNotes) say(`  ${n}`);
  if (!feeds.length) say('  no roster entry carries an articleFeed — there is no independent answer key.');
  say('');
  say(`  published chase items in window   ${published.length}`);
  say(`  distinct published chases         ${events.length}  (items within 6h collapsed)`);
  say(`  ...with ANY broadcast within 12h  ${events.filter((e) => e.covered).length}  (${pct(events.filter((e) => e.covered).length, events.length)})`);
  say('');
  say('  BY AGE — this is the number that matters');
  say('  age bucket     published   with a broadcast   coverage');
  say(`  ${'─'.repeat(60)}`);
  const buckets = AGE_BUCKETS.map(([lo, hi]) => {
    const mine = events.filter((e) => e.ageDays >= lo && e.ageDays < hi);
    return { from: lo, to: hi, published: mine.length, covered: mine.filter((e) => e.covered).length };
  });
  for (const b of buckets) {
    say(`  ${`${b.from}-${b.to} days`.padEnd(14)} ${String(b.published).padStart(9)} ${String(b.covered).padStart(18)}   ${pct(b.covered, b.published).padStart(5)}`);
  }
  say('');
  for (const l of wrap('A LOW NUMBER IN THE OLDER BUCKETS IS ARCHIVE DECAY, NOT DETECTOR BLINDNESS. '
    + 'Twitch archives expire on a retention clock and newsrooms unlist old streams, so the further '
    + 'back you look the more events have no reconstructable broadcast AT ALL — the detector never '
    + 'gets to see them here. The 0-30 day bucket is the only one where this figure is close to a '
    + 'fair test, and the whole column is a CEILING on backtest recall before the evaluator runs.', 72)) say(`  ${l}`);
  say('');

  // ── 5. measured base rate ──────────────────────────────────────────────────
  const feedSpan = published.length
    ? { from: published[0].publishedAt, to: published[published.length - 1].publishedAt }
    : null;
  const spanWeeks = feedSpan ? Math.max((feedSpan.to - feedSpan.from) / (7 * DAY_MS), 1 / 7) : 0;
  const measured = feedSpan ? events.length / spanWeeks : 0;
  const feedCapped = feeds.length && articles.length >= 50;

  section(5, 'MEASURED BASE RATE — how often a chase actually gets published');
  say('');
  if (!feedSpan) {
    say('  no published chase items in the window — nothing to measure a rate from.');
  } else {
    say(`  feed items span            ${day(feedSpan.from)} → ${day(feedSpan.to)}  (${spanWeeks.toFixed(1)} weeks)`);
    say(`  distinct published chases  ${events.length}`);
    say(`  MEASURED                   ${measured.toFixed(1)} per week`);
    say(`  design §1.1 assumed        ${ASSUMED_RATE_PER_WEEK[0]}-${ASSUMED_RATE_PER_WEEK[1]} per week`);
    say('');
    for (const l of wrap(measured < ASSUMED_RATE_PER_WEEK[0]
      ? `The assumption is HIGH: this measures ${measured.toFixed(1)}/week against an assumed `
        + `${ASSUMED_RATE_PER_WEEK[0]}-${ASSUMED_RATE_PER_WEEK[1]}. Every "too rarely" verdict computed against the assumed rate `
        + 'is therefore too harsh, and the docs should be corrected from this number.'
      : `This measures ${measured.toFixed(1)}/week against an assumed ${ASSUMED_RATE_PER_WEEK[0]}-${ASSUMED_RATE_PER_WEEK[1]}, `
        + 'which is in the same range the design assumed.', 72)) say(`  ${l}`);
    say('');
    for (const l of wrap('CAVEATS ON THIS NUMBER: it counts what ONE newsroom chose to write up, which is a '
      + 'floor on chases that happened and not a census'
      + `${feedCapped ? '; and the feed returned a full page, so it is capped at its most recent items and cannot see further back than its own oldest entry' : ''}`
      + '. It is still a much better yardstick than an assumption, because it was measured.', 72)) say(`  ${l}`);
  }
  say('');

  // ── 6. sweep ───────────────────────────────────────────────────────────────
  section(6, 'THRESHOLD / DWELL SWEEP — over the reconstructed clusters');
  say('');
  if (NO_SWEEP) {
    say('  skipped (--no-sweep)');
    say('');
  } else if (!clusters.length) {
    say('  nothing to sweep.');
    say('');
  } else {
    say(`  each cell is  hits/${titled.length} chase-titled · fp = clusters that fired with no chase word`);
    say(`  ${clusters.length} cluster(s), replayed once per cell. Recall here is the CIRCULAR kind (§3).`);
    say('');
    const W = 19;
    say(`  threshold │${dwells.map((d) => `dwell ${d}`.padStart(Math.ceil((W + 7) / 2)).padEnd(W)).join('│')}`.trimEnd());
    say(`  ──────────┼${dwells.map(() => '─'.repeat(W)).join('┼')}`);
    for (const t of thresholds) {
      const cells = dwells.map((d) => {
        const cell = sweepCells.find((c) => c.threshold === t && c.dwell === d);
        const here = t === CFG.threshold && d === CFG.dwell ? '*' : ' ';
        return `${here}${cell.firedTitled}/${titled.length} fp${cell.firedUntitled} ${(cell.fired / weeks).toFixed(1)}/wk`.padEnd(W);
      });
      say(`  ${String(t).padStart(9)} │${cells.join('│')}`.trimEnd());
    }
    say('');
    say(`  * = the current settings (threshold ${CFG.threshold}, dwell ${CFG.dwell}).`);
    say(`  Weights, vocabulary and every other knob are the current src/config.js values;`);
    say('  only threshold and dwell move, with clearScore clamped to the threshold so an');
    say('  incident can always close. The /wk figure divides by the whole window, so it is');
    say('  diluted by however much of the archive has already decayed (§4).');
    say('');
  }

  // ── the limits, again, at the bottom where the conclusions are ─────────────
  section(7, 'WHAT THIS BACKTEST CANNOT TELL YOU');
  say('');
  const limits = [
    'NO HISTORICAL VIEWER COUNTS. concurrentViewers exists only while a broadcast is '
      + 'live; no archive serves it afterwards. Every sample above carried viewers:null, so the '
      + 'AUDIENCE channel (V1=5 / V2=2) was switched off for the entire replay. It is not being '
      + 'tested here — it is absent. A MISS above may be an event the live monitor catches on '
      + 'the audience channel alone, and a chopper-class source has no other detector.',
    'VOD TITLES ARE POST-HOC AND FLATTER US. A newsroom renames the archive after the '
      + 'fact, and the renamed title is systematically more chase-explicit than what was on '
      + 'screen at the time. Both the §3 recall and the §6 sweep are therefore OPTIMISTIC.',
    'DELETED, UNLISTED AND EXPIRED BROADCASTS ARE INVISIBLE. Twitch archives expire on a '
      + 'retention clock and newsrooms unlist. Those events cannot be missed by the detector '
      + 'here because they never reach it — which is exactly what the age buckets in §4 measure.',
    'EVERY CLUSTER REPLAYS FROM A COLD STATE. No baseline continuity, no reopen lockout '
      + 'carried in from the previous event, no maxPerHour pressure — the archives only cover '
      + 'the minutes a broadcast existed, so there is no between-events timeline to carry.',
    'THE EDITORIAL CHANNEL (A1) IS NEVER SCORED HERE, on purpose: the article feed is the '
      + 'answer key in §4 and cannot also be an input.',
  ];
  for (const [i, l] of limits.entries()) {
    for (const line of wrap(`(${'abcde'[i]}) ${l}`, 72)) say(`  ${line}`);
    say('');
  }
  say('  A recorded fortnight (npm run chase:record → npm run chase:report) has none of');
  say('  these limits. This is the answer available today, not the better one.');
  say('');

  if (JSON_OUT) {
    console.log(JSON.stringify({
      window: { days: DAYS, from: windowFrom, to: now },
      settings: { threshold: CFG.threshold, dwell: CFG.dwell, clearScore: CFG.clearScore, clearPolls: CFG.clearPolls },
      platforms: { youtube: ytUsable, twitch: twUsable },
      quotaUnits: spend.units,
      reconstruction: { total: beforeWindow, inWindow: broadcasts.length, perOrg: rows, warnings },
      clusters: results,
      circular: {
        chaseTitled: titled.length,
        fired: titledFired.length,
        otherClusters: untitled.length,
        otherFired: untitledFired.length,
        note: 'partly circular — the label is the same vocabulary the title channel scores',
      },
      independent: {
        items: published.length,
        events: events.length,
        covered: events.filter((e) => e.covered).length,
        buckets,
        note: 'a CEILING on backtest recall; low old buckets are archive decay, not blindness',
      },
      baseRate: { measuredPerWeek: round2(measured), assumedPerWeek: ASSUMED_RATE_PER_WEEK, spanWeeks: round2(spanWeeks), feedCapped: Boolean(feedCapped) },
      sweep: NO_SWEEP ? null : { thresholds, dwells, cells: sweepCells, chaseTitled: titled.length },
      limits,
    }, null, 2));
  }

  if (!broadcasts.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`\n  BACKTEST FAILED: ${redact(err?.message || err)}\n`);
  process.exitCode = 1;
});
