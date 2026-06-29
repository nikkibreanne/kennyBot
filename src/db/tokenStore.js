// Persisted Twitch refresh-token store (IMPLEMENTATION §F — the #1 silent-failure
// cause for 24/7 bots). A user access token dies in ~4h; twurple's
// RefreshingAuthProvider refreshes it and fires onRefresh with NEW token data
// that MUST be persisted durably, or a restart re-uses a stale token.
//
// File-backed, matching the single writable runtime volume (Docker -v …:/data).
// Writes are atomic (tmp + rename) and locked down to 0600. One file per Twitch
// user id so the bot and broadcaster tokens coexist.

import { readFile, writeFile, rename, mkdir, chmod } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export class TokenStore {
  /** @param {string} dir  directory for token files (TOKEN_STORE_DIR / /data) */
  constructor(dir) {
    this.dir = dir;
  }

  /** @param {string} userId */
  _fileFor(userId) {
    const safe = String(userId).replace(/[^a-zA-Z0-9_-]/g, '_');
    return join(this.dir, `token-${safe}.json`);
  }

  /**
   * Load persisted token data for a user, or null if none stored yet.
   * @param {string} userId
   * @returns {Promise<import('@twurple/auth').AccessTokenWithUserId | null>}
   */
  async load(userId) {
    try {
      const raw = await readFile(this._fileFor(userId), 'utf8');
      return JSON.parse(raw);
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }

  /**
   * Atomically persist token data for a user (0600). Call from onRefresh.
   * @param {string} userId
   * @param {object} tokenData
   */
  async save(userId, tokenData) {
    const file = this._fileFor(userId);
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    await writeFile(tmp, JSON.stringify(tokenData, null, 2), { mode: 0o600 });
    await rename(tmp, file);
    try {
      await chmod(file, 0o600);
    } catch {
      // best effort on platforms without POSIX perms
    }
  }
}
