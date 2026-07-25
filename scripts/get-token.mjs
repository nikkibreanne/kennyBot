// One-off dev helper: obtain a bot (or broadcaster) refresh token carrying the
// scopes kennyBot needs. NOT part of the running bot — the bot is outbound-only;
// this briefly listens on localhost:3000 only to catch the OAuth redirect, then
// exits. Uses YOUR app's client id/secret so the resulting token refreshes
// cleanly under the same RefreshingAuthProvider.
//
// Prereqs:
//   1. TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET in .env (already there for the bot).
//   2. Register  http://localhost:3000  as an OAuth Redirect URL in the Twitch app
//      console (https://dev.twitch.tv/console/apps → your app → add + save).
//   3. Log into twitch.tv as the account you want the token FOR (the bot account
//      for the bot token) before opening the URL below.
//
// Run:
//   node scripts/get-token.mjs
//   # custom scopes (space-separated):
//   OAUTH_SCOPES="chat:read chat:edit" node scripts/get-token.mjs
//
// The printed TWITCH_BOT_REFRESH_TOKEN goes into .env. If a token is already
// stored (TOKEN_STORE_DIR, default ./.tokens), delete .tokens/bot* so the new
// token re-bootstraps instead of the stored (old-scope) one winning.
import 'dotenv/config';
import http from 'node:http';
import { exchangeCode } from '@twurple/auth';

const clientId = process.env.TWITCH_CLIENT_ID;
const clientSecret = process.env.TWITCH_CLIENT_SECRET;
const redirectUri = process.env.OAUTH_REDIRECT_URI || 'http://localhost:3000';
// Default = everything discussed: IRC read/send + badge (app-token send) + !clip.
const scopes = (process.env.OAUTH_SCOPES || 'chat:read chat:edit user:bot user:write:chat clips:edit')
  .split(/\s+/)
  .filter(Boolean);

if (!clientId || !clientSecret) {
  console.error('Missing TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET (set them in .env).');
  process.exit(1);
}

const authUrl =
  'https://id.twitch.tv/oauth2/authorize?' +
  new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: scopes.join(' '),
    force_verify: 'true', // always re-prompt, so switching account / re-consenting works
  });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, redirectUri);
  if (!url.pathname.startsWith('/') || url.searchParams.get('error')) {
    res.writeHead(400, { 'content-type': 'text/plain' });
    res.end('OAuth error: ' + (url.searchParams.get('error_description') || 'no code'));
    return;
  }
  const code = url.searchParams.get('code');
  if (!code) {
    res.writeHead(204).end();
    return; // ignore favicon.ico etc.
  }
  try {
    const token = await exchangeCode(clientId, clientSecret, code, redirectUri);
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('Authorized. You can close this tab and return to the terminal.');
    console.log('\n✅ Token obtained.');
    console.log('   scopes:', token.scope.join(' '));
    console.log('\n   TWITCH_BOT_REFRESH_TOKEN=' + token.refreshToken + '\n');
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('Token exchange failed: ' + String(err));
    console.error('\n❌ exchange failed:', err);
  } finally {
    setTimeout(() => server.close(() => process.exit(0)), 250);
  }
});

server.listen(3000, () => {
  console.log('Requesting scopes:', scopes.join(' '));
  console.log('\n1) Log into twitch.tv as the target account (the BOT for the bot token).');
  console.log('2) Open this URL in a browser:\n');
  console.log('   ' + authUrl + '\n');
  console.log('Waiting for the redirect on ' + redirectUri + ' …  (Ctrl-C to abort)');
});
