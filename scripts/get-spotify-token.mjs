// One-off helper: obtain the Spotify refresh token `!song` needs.
//
// NOT part of the running bot — kennyBot is outbound-only. This briefly listens on
// 127.0.0.1 purely to catch the OAuth redirect, then exits. Exactly the same shape
// as scripts/get-token.mjs does for Twitch.
//
// Prereqs:
//   1. SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET in .env (from
//      https://developer.spotify.com/dashboard → your app → Settings).
//   2. Add the redirect URI to that app and SAVE it. It must be the loopback IP
//      literal — Spotify explicitly rejects `localhost`:
//        http://127.0.0.1:8888/callback
//   3. Be logged into Spotify as the account whose music should be shown.
//
// Run:
//   node scripts/get-spotify-token.mjs
//
// The token is written straight into the token store (TOKEN_STORE_DIR, default
// ./.tokens) as token-spotify.json, so nothing needs pasting into .env. It is
// also printed, for a deployment that prefers SPOTIFY_REFRESH_TOKEN.
import 'dotenv/config';
import http from 'node:http';
import { TokenStore } from '../src/db/tokenStore.js';

const clientId = process.env.SPOTIFY_CLIENT_ID;
const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
// Spotify permits http ONLY for a loopback address given as an IP literal.
const redirectUri = process.env.SPOTIFY_REDIRECT_URI || 'http://127.0.0.1:8888/callback';
// Everything !song needs and nothing more. Podcasts additionally need
// user-read-playback-state; add it here if you want episodes named.
const scopes = (process.env.SPOTIFY_SCOPES || 'user-read-currently-playing').split(/\s+/).filter(Boolean);

if (!clientId || !clientSecret) {
  console.error('Missing SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET (set them in .env).');
  process.exit(1);
}

const url = new URL(redirectUri);
const state = Math.random().toString(36).slice(2);

const authUrl =
  'https://accounts.spotify.com/authorize?' +
  new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: scopes.join(' '),
    state,
    // Force the consent screen so re-running this after a scope change actually
    // re-prompts instead of silently handing back the old grant.
    show_dialog: 'true',
  });

console.log('\n1. Open this in a browser signed in as the Spotify account to show:\n');
console.log(`   ${authUrl}\n`);
console.log(`2. Approve. Waiting for the redirect on ${redirectUri} …\n`);

const server = http.createServer(async (req, res) => {
  const got = new URL(req.url, `http://${req.headers.host}`);
  if (got.pathname !== url.pathname) {
    res.writeHead(404).end('not the redirect path');
    return;
  }
  const code = got.searchParams.get('code');
  const err = got.searchParams.get('error');
  if (err || !code) {
    res.writeHead(400).end(`Spotify returned: ${err || 'no code'}`);
    console.error(`\n✗ ${err || 'no code in redirect'}`);
    server.close();
    process.exitCode = 1;
    return;
  }
  if (got.searchParams.get('state') !== state) {
    res.writeHead(400).end('state mismatch');
    console.error('\n✗ state mismatch — start over');
    server.close();
    process.exitCode = 1;
    return;
  }

  try {
    const r = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
      },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri }),
    });
    const json = await r.json();
    if (!r.ok) throw new Error(`${r.status} ${JSON.stringify(json)}`);

    const store = new TokenStore(process.env.TOKEN_STORE_DIR || './.tokens');
    await store.save('spotify', {
      refreshToken: json.refresh_token,
      scope: (json.scope || '').split(' ').filter(Boolean),
      obtainmentTimestamp: Date.now(),
    });

    res.writeHead(200, { 'content-type': 'text/html' })
      .end('<h2>kennyBot: Spotify connected.</h2><p>You can close this tab.</p>');
    console.log('✓ stored in the token store as token-spotify.json');
    console.log('  scopes:', json.scope);
    console.log('\n  (optional, for a deployment without the token file:)');
    console.log(`  SPOTIFY_REFRESH_TOKEN=${json.refresh_token}\n`);
  } catch (e) {
    res.writeHead(500).end('token exchange failed');
    console.error(`\n✗ token exchange failed: ${e.message}`);
    process.exitCode = 1;
  } finally {
    server.close();
  }
});

server.listen(Number(url.port || 80), url.hostname);
