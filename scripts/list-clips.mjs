// scripts/list-clips.mjs — read-only demo of the "get timestamps from Twitch"
// step for the 4K-vertical pipeline. Pulls the channel's recent clips and prints
// the ONLY fields that step needs: which VOD (videoId) + in/out offsets
// (vodOffset .. vodOffset+duration). No OBS, no recording, no upload — just the
// public Clips API via an app token (no user login needed).
//
//   node scripts/list-clips.mjs [--days 14]
//   TWITCH_CHANNEL=someoneelse node scripts/list-clips.mjs --days 60
//
import 'dotenv/config';
import { ApiClient } from '@twurple/api';
import { AppTokenAuthProvider } from '@twurple/auth';

const { TWITCH_CLIENT_ID: clientId, TWITCH_CLIENT_SECRET: clientSecret, TWITCH_CHANNEL: channel } = process.env;
if (!clientId || !clientSecret || !channel) {
  console.error('Need TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET, TWITCH_CHANNEL in .env');
  process.exit(1);
}

const dIdx = process.argv.indexOf('--days');
const days = dIdx >= 0 && process.argv[dIdx + 1] ? Number(process.argv[dIdx + 1]) : 14;

const api = new ApiClient({ authProvider: new AppTokenAuthProvider(clientId, clientSecret) });

const user = await api.users.getUserByName(channel);
if (!user) { console.error(`channel not found: ${channel}`); process.exit(1); }

const startDate = new Date(Date.now() - days * 86_400_000).toISOString();
const { data: clips } = await api.clips.getClipsForBroadcaster(user.id, { startDate, limit: 100 });

const short = clips.filter((c) => c.duration <= 60);
console.log(`\n${channel}: ${clips.length} clips in the last ${days}d — ${short.length} are ≤60s (Shorts-eligible)\n`);

let mappable = 0;
for (const c of short) {
  const has = c.vodOffset != null;
  if (has) mappable += 1;
  const inOut = has
    ? `in=${c.vodOffset}s out=${c.vodOffset + Math.round(c.duration)}s`
    : 'in/out=PENDING (vod_offset null — VOD not processed yet, or VODs off)';
  console.log(
    [
      c.creationDate.toISOString().slice(0, 19).replace('T', ' '),
      `${Math.round(c.duration)}s`.padStart(4),
      `vod=${c.videoId || '—'}`.padEnd(14),
      inOut.padEnd(58),
      c.title.slice(0, 40),
    ].join('  '),
  );
}
console.log(
  `\n${mappable}/${short.length} clips are mappable now (vod_offset present).\n` +
    `Pipeline per clip: cut [in−pad, out+pad] from the LOCAL 4K recording of vod=<videoId>, then crop+stack to 9:16.\n`,
);
process.exit(0);
