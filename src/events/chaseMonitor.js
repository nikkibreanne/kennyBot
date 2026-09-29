// LA chase monitor tick (docs/chase-monitor-design.md §3). Two loops on two
// clocks: a fast videos.list poll — 1 YouTube quota unit, and the actual
// detector — and a slow, free RSS sweep whose only job is noticing that a NEW
// broadcast object exists. All of the judgement lives in the pure evaluator
// (src/rules/chase.js); this file supplies the clock, the network, the writes
// and the one call to chat.
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
import { fetchLiveSamples, discoverVideoIds, findLiveVideos, fetchArticles, youtubeKeyPresent, SEARCH_UNITS } from '../integrations/chaseSources.js';
import { getChaseSettings, loadMonitorState, saveMonitorState, logShadowAnnouncement } from '../db/chaseMonitor.js';

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

  // The fast loop has nothing to ask about until discovery has named some video
  // ids, so the RSS sweep runs immediately rather than at its first interval.
  async function sweep() {
    if (stopped || sweeping) return;
    sweeping = true;
    try {
      const settings = await getChaseSettings();
      if (!settings.enabled) return; // off means no traffic at all, free or not
      if (!settings.orgs?.length) return noSources();
      const found = await discoverVideoIds(settings.orgs, logger);
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

      // Then the part RSS cannot do. Ask ONLY about orgs we have no live video for —
      // a source already streaming is tracked for free by the fast loop, so the 100-unit
      // search is spent exclusively on the ones that are dark or newly unknown.
      const now = Date.now();
      const cooldown = Math.max(0, Number(settings.searchCooldownMs) || 30 * 60_000);
      const today = quotaDay();
      if (searchDay !== today) { searchDay = today; searchUnitsToday = 0; }
      const unitCap = Math.max(0, Number(settings.searchDailyUnitCap) || 5000);
      const affordable = Math.max(0, Math.floor((unitCap - searchUnitsToday) / SEARCH_UNITS));
      const askable = settings.orgs
        .filter((o) => !liveVideoIds[o.id] && (rssBlind || now - (lastSearchAt[o.id] || 0) >= cooldown))
        .slice(0, affordable); // the day's budget is a hard stop, not a warning
      if (askable.length) {
        searchUnitsToday += askable.length * SEARCH_UNITS;
        for (const o of askable) lastSearchAt[o.id] = now;
        const live = await findLiveVideos(askable, logger);
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
      if (!settings.enabled) return; // the kill switch, honoured BEFORE any spend
      if (!settings.orgs?.length) return noSources(); // no roster → nothing to ask about

      // Articles are a second, independent newsroom system and a dead feed must
      // not delay the detector, so both are in flight at once. Neither fetcher
      // throws — they return partial results and log.
      // Sticky live ids FIRST — they are the only ids that can actually score — then
      // the RSS candidates fill whatever is left of the one billed call.
      const ids = [...new Set([...Object.values(liveVideoIds), ...Object.values(knownVideoIds).flat()])];
      const [samples, articles] = await Promise.all([
        fetchLiveSamples(settings.orgs, ids, logger),
        fetchArticles(settings.orgs, logger),
      ]);

      // A stream that stopped must leave the sticky set, or the next search for that
      // org never happens and a NEW broadcast is never found.
      for (const s2 of samples || []) {
        if (liveVideoIds[s2.org] === s2.videoId && !s2.live) {
          delete liveVideoIds[s2.org];
          logger.info?.('chase: live stream ended', { org: s2.org });
        }
      }
      for (const s2 of samples || []) if (s2.live) liveVideoIds[s2.org] = s2.videoId;

      const state = await loadMonitorState();
      const result = evaluateChase({
        samples: samples || [],
        articles: articles || [],
        state,
        now: Date.now(),
        cfg: settings,
      });

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
  logger.info?.('chase monitor started', { pollMs, discoveryMs, youtubeKey: youtubeKeyPresent() });

  return () => {
    stopped = true;
    clearInterval(poll);
    clearInterval(discovery);
  };
}
