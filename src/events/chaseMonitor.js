// LA chase monitor tick (docs/chase-monitor-design.md §3). Two loops on two
// clocks: a fast poll — 1 YouTube quota unit plus 1 Twitch point, and the actual
// detector — and a slow, free RSS sweep whose only job is noticing that a NEW
// broadcast object exists. All of the judgement lives in the pure evaluator
// (src/rules/chase.js); this file supplies the clock, the network, the writes
// and the one call to chat.
//
// The roster spans TWO PLATFORMS and they are scheduled differently, because they
// cost differently. YouTube is rationed — RSS discovery on the slow clock, a paid
// search behind a cooldown and a daily cap, a sticky set so a stream found once is
// never paid for again. Twitch needs none of that: one call covers every Twitch
// source for one point against 800 per MINUTE, so it simply runs on every tick with
// no discovery loop at all. Everything YouTube-shaped below therefore operates on
// the YOUTUBE half of the roster only — the budget arithmetic is wrong otherwise,
// since it would reserve units for orgs that are never searched.
//
// Four invariants, in the order they matter:
//   * a tick NEVER throws — a monitor failure must not reach chat and must not
//     take the process with it;
//   * state is persisted BEFORE the announcement, so a crash between the two
//     costs an announcement rather than repeating one forever;
//   * `enabled: false` returns before any fetch — switched off means zero
//     YouTube quota spent, not "polled and discarded";
//   * nothing from a source ever reaches chat. The only string sent is the one
//     the pure evaluator built; API errors, keys and quota state go to the log.
import { config } from '../config.js';
import { evaluateChase } from '../rules/chase.js';
import {
  fetchLiveSamples, discoverVideoIds, findLiveVideos, fetchArticles, fetchTwitchSamples,
  partitionSources, youtubeKeyPresent, twitchReady, SEARCH_UNITS,
} from '../integrations/chaseSources.js';
import { getChaseSettings, loadMonitorState, saveMonitorState, logShadowAnnouncement } from '../db/chaseMonitor.js';
import { createChaseLog } from '../integrations/chaseLog.js';

/**
 * @param {{ send: { say: (t: string) => Promise<void> }, logger?: any }} deps
 *   `send` is the mute-aware wrapper — a muted bot stays silent while detection
 *   keeps running, so unmuting never replays a chase that has already ended.
 * @returns {() => void} stop function
 */
export function startChaseMonitor({ send, logger = console }) {
  // The roster is PRIVATE and lives only in RTDB (CLAUDE.md) — `config.chase.orgs`
  // is [] in this repo. So it is read per tick from settings, not captured at start:
  // that also means `npm run chase:sources` takes effect without a restart.
  let warnedNoSources = false;
  let tickNo = 0;
  // Was the monitor enabled last time we looked? The discovery sweep is primed at
  // startup, but if the monitor is OFF then (which is how it ships) that primed sweep
  // returns having done nothing, and `!chasemon on` then waits up to a full
  // discoveryMs — ten minutes — before any YouTube video id is known. Observed in
  // production: enabled at ~00:00, first useful poll at 00:06. Twitch sources are
  // unaffected (polled by login, never discovered), which is exactly why the symptom
  // was "1 sample per poll" rather than nothing at all.
  let wasEnabled = false;
  // Opt-in JSONL, in the SAME format scripts/chase-record.mjs writes, so
  // `npm run chase:report` reads the bot's own evidence unchanged. Unset
  // CHASE_LOG_DIR and nothing is written or created. In the container the only
  // writable persistent path is the /data volume — see the module header.
  const chaseLog = createChaseLog({
    dir: process.env.CHASE_LOG_DIR,
    retentionDays: config.chase.logRetentionDays,
    logger,
  });
  /** @type {Record<string, string[]>} orgId -> candidate video ids, from the RSS sweep */
  let knownVideoIds = {};
  /**
   * orgId -> the video id that org was last seen LIVE on. This is the sticky set, and
   * it is what makes the whole thing work: channel RSS lists recent UPLOADS, so a
   * stream that has been live for hours is pushed out by newer clips and vanishes from
   * discovery (measured: 4 of 6 real sources were live with their video absent from
   * the feed entirely). Once a live video is known it is polled every tick by the
   * 1-unit videos.list call for free, and only dropped when it reports not-live — so a
   * 24/7 stream costs one search to find and nothing to keep.
   * @type {Record<string, string>}
   */
  let liveVideoIds = {};
  /** When each org was last searched, so a persistently-dark org is not hammered. */
  let lastSearchAt = {};
  /** Search units spent today, and which day that is. Quota resets midnight Pacific. */
  let searchUnitsToday = 0;
  let searchDay = null;
  /** The quota day, in the zone Google resets on — not the host's local midnight. */
  const quotaDay = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date());
  let polling = false;
  let sweeping = false;
  let stopped = false;

  /** Enabled but with an empty roster is a real misconfiguration — say so once. */
  function noSources() {
    if (!warnedNoSources) {
      warnedNoSources = true;
      logger.warn?.('chase: enabled but NO sources loaded — run `npm run chase:sources`; monitor is inert');
    }
  }

  if (chaseLog.enabled) {
    logger.info?.('chase: logging evidence to disk', { dir: process.env.CHASE_LOG_DIR });
    chaseLog.write({ kind: 'session', at: Date.now(), event: 'start', source: 'bot', pid: process.pid });
  }

  // The fast loop has nothing to ask about until discovery has named some video
  // ids, so the RSS sweep runs immediately rather than at its first interval.
  async function sweep() {
    if (stopped || sweeping) return;
    sweeping = true;
    try {
      const settings = await getChaseSettings();
      if (!settings.enabled) return; // off means no traffic at all, free or not
      if (!settings.orgs?.length) return noSources();
      // Discovery is a YOUTUBE problem. A Twitch source is polled by login on every
      // tick, so it is never discovered, never searched and never sticky.
      const { youtube: ytOrgs } = partitionSources(settings.orgs);
      if (!ytOrgs.length) return;
      const found = await discoverVideoIds(ytOrgs, logger);
      // MERGED per org, not replaced: an org whose feed failed is absent from the
      // result rather than empty, so merging keeps that org's last good ids
      // instead of forgetting a live stream because one request timed out.
      // A sweep returning NOTHING means the free path is blind (YouTube's RSS edge
      // throttles with a 404). That is when the paid search stops being a backstop and
      // becomes the only way to notice a new broadcast, so the per-org cooldown is
      // waived for this sweep. The daily unit cap still binds.
      const rssBlind = !found || Object.keys(found).length === 0;
      if (rssBlind) logger.warn?.('chase: RSS discovery blind this sweep — waiving the search cooldown');
      if (found && typeof found === 'object') knownVideoIds = { ...knownVideoIds, ...found };
      chaseLog.write({ kind: 'discovery', at: Date.now(), ids: found || {} });

      // Then the part RSS cannot do. Ask ONLY about orgs we have no live video for —
      // a source already streaming is tracked for free by the fast loop, so the 100-unit
      // search is spent exclusively on the ones that are dark or newly unknown.
      const now = Date.now();
      const cooldown = Math.max(0, Number(settings.searchCooldownMs) || 30 * 60_000);
      const today = quotaDay();
      if (searchDay !== today) { searchDay = today; searchUnitsToday = 0; }
      const unitCap = Math.max(0, Number(settings.searchDailyUnitCap) || 5000);
      const affordable = Math.max(0, Math.floor((unitCap - searchUnitsToday) / SEARCH_UNITS));
      const askable = ytOrgs
        // Blind RSS SHORTENS the cooldown, it does not remove it (see config).
        .filter((o) => {
          const cd = rssBlind ? Math.max(0, Number(settings.searchBlindCooldownMs) || 60 * 60_000) : cooldown;
          return !liveVideoIds[o.id] && now - (lastSearchAt[o.id] || 0) >= cd;
        })
        .slice(0, affordable); // the day's budget is a hard stop, not a warning
      if (askable.length) {
        searchUnitsToday += askable.length * SEARCH_UNITS;
        for (const o of askable) lastSearchAt[o.id] = now;
        const live = await findLiveVideos(askable, logger);
        chaseLog.write({ kind: 'search', at: now, asked: askable.map((o) => o.id), found: Object.keys(live), units: askable.length * SEARCH_UNITS });
        for (const [orgId, videoId] of Object.entries(live)) {
          liveVideoIds[orgId] = videoId;
          logger.info?.('chase: found a live stream', { org: orgId });
        }
      }
    } catch (err) {
      logger.error?.('chase discovery failed', { err: String(err?.stack || err) });
    } finally {
      sweeping = false;
    }
  }

  async function tick() {
    if (stopped || polling) return; // a slow fetch must not overlap the next tick
    polling = true;
    try {
      const settings = await getChaseSettings();
      if (!settings.enabled) { wasEnabled = false; return; } // the kill switch, honoured BEFORE any spend
      // Just switched on: discover NOW rather than at the next ten-minute boundary.
      if (!wasEnabled) {
        wasEnabled = true;
        logger.info?.('chase: enabled — priming discovery rather than waiting for the next sweep');
        sweep().catch(() => {}); // deliberately not awaited: a slow sweep must not delay this tick
      }
      if (!settings.orgs?.length) return noSources(); // no roster → nothing to ask about

      // Three independent systems, so all three are in flight at once and a dead one
      // cannot delay the detector. None of the fetchers throws — they return partial
      // results and log.
      // Sticky live ids FIRST — they are the only ids that can actually score — then
      // the RSS candidates fill whatever is left of the one billed call.
      const { youtube: ytOrgs, twitch: twOrgs } = partitionSources(settings.orgs);
      const ids = [...new Set([...Object.values(liveVideoIds), ...Object.values(knownVideoIds).flat()])];
      const [ytSamples, twSamples, articles] = await Promise.all([
        fetchLiveSamples(ytOrgs, ids, logger),
        fetchTwitchSamples(twOrgs, logger),
        fetchArticles(settings.orgs, logger),
      ]);

      // The sticky set is YOUTUBE-only state: it exists to avoid paying 100 units to
      // re-find a stream. Twitch samples must stay out of it, or a Twitch stream id
      // would be posted to videos.list and a Twitch org would consume a YouTube
      // search slot it can never use.
      // A stream that stopped must leave the sticky set, or the next search for that
      // org never happens and a NEW broadcast is never found.
      for (const s2 of ytSamples || []) {
        if (liveVideoIds[s2.org] === s2.videoId && !s2.live) {
          delete liveVideoIds[s2.org];
          logger.info?.('chase: live stream ended', { org: s2.org });
        }
      }
      for (const s2 of ytSamples || []) if (s2.live) liveVideoIds[s2.org] = s2.videoId;

      // One flat list from here on: the evaluator scores a TICK, and which platform
      // an observation came from is not something it needs to know.
      const samples = [...(ytSamples || []), ...(twSamples || [])];

      const state = await loadMonitorState();
      const at = Date.now();
      const result = evaluateChase({
        samples,
        articles: articles || [],
        state,
        now: at,
        cfg: settings,
      });

      // The RAW samples are what make the log replayable at other settings later, so
      // they are written verbatim and BEFORE the score — the same order, and the same
      // record shapes, that scripts/chase-record.mjs uses.
      tickNo += 1;
      chaseLog.write({ kind: 'poll', tick: tickNo, at, samples, articles: articles || [] });
      const scoreLine = { kind: 'score', tick: tickNo, at, score: result.score, over: result.state.overCount, under: result.state.underCount, open: Boolean(result.state.incident) };
      if (result.score > 0) scoreLine.groups = result.groups; // keep quiet ticks small
      chaseLog.write(scoreLine);
      if (result.opened && result.state.incident) {
        const inc = result.state.incident;
        chaseLog.write({ kind: 'incident', at, event: 'open', id: inc.id, org: inc.org, url: inc.url, score: result.score });
      }
      if (result.announce) chaseLog.write({ kind: 'announce', at, incidentId: result.announce.incident?.id, text: result.announce.text });
      if (result.closed) chaseLog.write({ kind: 'incident', at, event: 'close', id: state?.incident?.id ?? null, durationMs: state?.incident?.openedAt ? at - state.incident.openedAt : null, peakScore: state?.incident?.peakScore ?? null });

      // BEFORE anything is said. The dwell, cooldown and per-hour guards are all
      // counts held in this record; losing it after speaking is what would make
      // the bot announce the same chase on every poll.
      await saveMonitorState(result.state);

      if (result.opened) logger.info?.('chase incident opened', { id: result.state.incident?.id, score: result.score });
      if (result.closed) logger.info?.('chase incident closed', { score: result.score });
      if (!result.announce) return;

      // Anything that is not exactly 'live' stays quiet: the fail-safe direction
      // for a garbled setting is saying nothing.
      if (settings.mode === 'live') {
        send.say(result.announce.text);
        logger.info?.('chase announced', { id: result.announce.incident?.id, score: result.score });
      } else {
        await logShadowAnnouncement(result.announce.incident, result.score, result.groups);
        logger.info?.('chase (shadow) would have announced', { text: result.announce.text, score: result.score });
      }
    } catch (err) {
      // Everything ends here: a dead feed, an RTDB blip, a bad settings value.
      // The monitor skips this poll and tries again in a minute; chat is untouched.
      logger.error?.('chase tick failed', { err: String(err?.stack || err) });
    } finally {
      polling = false;
    }
  }

  // Floors, not just defaults: a mistyped interval is the one config error here
  // that costs money-equivalent quota rather than accuracy. 1 unit/minute is the
  // budget the design is costed against (~14% of the free daily quota).
  const pollMs = Math.max(15_000, Number(config.chase.pollMs) || 60_000);
  const discoveryMs = Math.max(60_000, Number(config.chase.discoveryMs) || 10 * 60_000);

  const poll = setInterval(() => { tick().catch(() => {}); }, pollMs);
  poll.unref?.();
  const discovery = setInterval(() => { sweep().catch(() => {}); }, discoveryMs);
  discovery.unref?.();
  sweep().catch(() => {});

  // A boolean, never the key. Which evidence channels are even possible depends
  // on this, so an operator reading the log should not have to guess.
  logger.info?.('chase monitor started', {
    pollMs, discoveryMs, youtubeKey: youtubeKeyPresent(), twitch: twitchReady(),
  });

  return () => {
    stopped = true;
    clearInterval(poll);
    clearInterval(discovery);
  };
}
