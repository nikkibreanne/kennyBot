// Twitch auth via twurple's RefreshingAuthProvider (IMPLEMENTATION §F). One auth
// provider serves chat + Helix + EventSub. A user access token dies in ~4h; the
// provider refreshes it automatically and fires onRefresh, which we persist
// durably (TokenStore) so a restart never re-uses a stale token — the single
// most common cause of a silently-bricked 24/7 bot.
//
// Tokens are stored per ROLE ('bot' / 'broadcaster') rather than per Twitch user
// id, so startup can load them before the user id is known.

import { RefreshingAuthProvider } from '@twurple/auth';

/**
 * @param {{ clientId: string, clientSecret: string, tokenStore: import('../db/tokenStore.js').TokenStore, logger?: any }} args
 */
export async function buildAuth({ clientId, clientSecret, tokenStore, logger = console }) {
  if (!clientId || !clientSecret) {
    throw new Error('TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET are required');
  }

  const authProvider = new RefreshingAuthProvider({ clientId, clientSecret });
  /** @type {Map<string,string>} userId → role */
  const userIdToRole = new Map();
  let pendingRole = null;

  authProvider.onRefresh(async (userId, tokenData) => {
    const role = userIdToRole.get(userId) ?? pendingRole ?? String(userId);
    try {
      await tokenStore.save(role, tokenData);
      logger.info?.('twitch token refreshed + persisted', { role });
    } catch (err) {
      logger.error?.('failed to persist refreshed token', { role, err: String(err) });
    }
  });

  /**
   * Add a Twitch user to the provider, loading its persisted token or
   * bootstrapping from a one-time refresh token. Returns the resolved user id,
   * or null if no token is available for the role.
   * @param {string} role  'bot' | 'broadcaster'
   * @param {string|undefined} bootstrapRefreshToken
   * @param {string[]} intents  e.g. ['chat'] for the chat account
   * @returns {Promise<string|null>}
   */
  async function addRole(role, bootstrapRefreshToken, intents = []) {
    let tokenData = await tokenStore.load(role);
    if (!tokenData) {
      if (!bootstrapRefreshToken) return null;
      // Minimal bootstrap: empty access token + expiry 0 forces an immediate
      // refresh, after which onRefresh persists the full token.
      tokenData = {
        accessToken: '',
        refreshToken: bootstrapRefreshToken,
        expiresIn: 0,
        obtainmentTimestamp: 0,
        scope: [],
      };
    }

    pendingRole = role;
    try {
      const userId = await authProvider.addUserForToken(tokenData, intents);
      userIdToRole.set(userId, role);
      // Ensure the role file reflects the (possibly just-refreshed) token even if
      // onRefresh didn't fire (e.g. a still-valid stored token).
      const current = await authProvider.getAccessTokenForUser(userId);
      if (current) await tokenStore.save(role, current);
      logger.info?.('twitch user added', { role, userId });
      return userId;
    } finally {
      pendingRole = null;
    }
  }

  return { authProvider, addRole };
}
