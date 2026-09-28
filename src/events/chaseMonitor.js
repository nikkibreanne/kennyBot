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
import { fetchLiveSamples, discoverVideoIds, fetchArticles, youtubeKeyPresent } from '../integrations/chaseSources.js';
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
      if (found && typeof found === 'object') knownVideoIds = { ...knownVideoIds, ...found };
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
      const [samples, articles] = await Promise.all([
        fetchLiveSamples(settings.orgs, knownVideoIds, logger),
        fetchArticles(settings.orgs, logger),
      ]);

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
