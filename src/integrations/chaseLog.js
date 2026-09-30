// Append-only JSONL log for the chase monitor, written from inside the BOT.
//
// WHY THIS EXISTS. Calibration needs a continuous, replayable record of what the
// detector saw. `scripts/chase-record.mjs` produces one, but it has to run somewhere
// that stays awake — and on a developer laptop it does not: a real overnight run lost
// 11.8 hours to the host suspending, in ~60-minute steps, without the process ever
// dying. The bot already runs 24/7 in a container on a machine that does not sleep, so
// the honest place to collect two weeks of evidence is the bot itself, in shadow mode.
//
// The format is deliberately IDENTICAL to the recorder's, so `npm run chase:report` and
// `scripts/chase-sim.mjs` consume this with no changes.
//
// CONTAINER CONSTRAINTS this is shaped by (see the Dockerfile and the README):
//   * the image runs `--read-only` as the non-root `node` user, so the ONLY writable
//     persistent path is the `/data` volume (`-v kennybot-tokens:/data`);
//   * `/tmp` is a tmpfs and evaporates on restart, which is useless for a fortnight;
//   * therefore the intended setting is `CHASE_LOG_DIR=/data/chase-logs`.
//
// Unset `CHASE_LOG_DIR` and nothing is written and nothing is created — file logging is
// opt-in, so an existing deployment is untouched until someone asks for it.
import { appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

/** Local calendar day, used for the filename and the rollover check. */
function dayKey(now = Date.now()) {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * @param {{ dir?: string, retentionDays?: number, logger?: any }} opts
 * @returns {{ write: (record: object) => void, enabled: boolean, path: () => string|null }}
 */
export function createChaseLog({ dir, retentionDays = 14, logger = console } = {}) {
  const root = String(dir || '').trim();
  if (!root) return { write() {}, enabled: false, path: () => null };

  let day = null;
  let file = null;
  // A log that cannot be written must not take the monitor with it, and must not
  // complain once a minute for a fortnight either.
  let warned = false;
  let broken = false;

  /** Keep the volume bounded. ~7 MB/day, so the default is ~100 MB. */
  function prune() {
    try {
      const keep = Math.max(1, Number(retentionDays) || 14);
      const cutoff = Date.now() - keep * 86400_000;
      for (const name of readdirSync(root)) {
        if (!/^chase-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)) continue; // never touch anything else
        const full = join(root, name);
        if (statSync(full).mtimeMs < cutoff) unlinkSync(full);
      }
    } catch (err) {
      logger.warn?.('chase log: prune failed', { err: String(err?.message || err) });
    }
  }

  function rollover(now) {
    const key = dayKey(now);
    if (key === day) return;
    mkdirSync(root, { recursive: true });
    day = key;
    file = join(root, `chase-${key}.jsonl`);
    prune(); // once per day, on the rollover, rather than on every write
  }

  return {
    enabled: true,
    path: () => file,
    write(record) {
      if (broken) return;
      try {
        rollover(record?.at || Date.now());
        appendFileSync(file, `${JSON.stringify(record)}\n`);
      } catch (err) {
        // Say it ONCE. A disk that is full or a volume that is not mounted would
        // otherwise produce a log line every tick, which is its own outage.
        if (!warned) {
          warned = true;
          broken = true;
          logger.error?.('chase log: writing disabled after a failure — detection continues', {
            dir: root, err: String(err?.message || err),
          });
        }
      }
    },
  };
}
