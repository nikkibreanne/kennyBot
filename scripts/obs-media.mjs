// scripts/obs-media.mjs — set up `!media` slots without needing the bot running.
//
// Slot mapping only works if the OBS source names are EXACT, and typing them from
// memory is how you get a slot that looks mapped and plays nothing. This asks OBS
// what it actually has, and lets you fire one to confirm before mapping it.
//
//   node scripts/obs-media.mjs                          list Media Sources
//   node scripts/obs-media.mjs --all                    list every input, with kinds
//   node scripts/obs-media.mjs --scenes                 list scenes
//   node scripts/obs-media.mjs --play "Airhorn SFX"     fire one, right now
//   node scripts/obs-media.mjs --play "GIF | Sound"      fire a whole slot together
//   node scripts/obs-media.mjs --play "GIF" --scene "Alerts" --action restart
//
// Reads OBS_WEBSOCKET_URL / OBS_WEBSOCKET_PASSWORD from .env, the same two vars
// the bot uses — so if this works, `!media` will too, and if it doesn't, the
// problem is the connection rather than anything in the bot.
import 'dotenv/config';
import { withObs, obsConnectionFromEnv } from '../src/integrations/obsWebsocket.js';
import { mediaSequence } from '../src/integrations/obsMedia.js';
import { MEDIA_ACTIONS, DEFAULT_ACTION, parseInputList } from '../src/rules/media.js';

const conn = obsConnectionFromEnv();
if (!conn) {
  console.error('Need OBS_WEBSOCKET_URL (and usually OBS_WEBSOCKET_PASSWORD) in .env');
  console.error('e.g. OBS_WEBSOCKET_URL=ws://<obs-host>:4455');
  process.exit(1);
}

const arg = (flag) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const has = (flag) => process.argv.includes(flag);

const play = arg('--play');
const scene = arg('--scene') ?? null;
const action = arg('--action') ?? DEFAULT_ACTION;

if (play && !MEDIA_ACTIONS.includes(action)) {
  console.error(`--action must be one of: ${MEDIA_ACTIONS.join(', ')}`);
  process.exit(1);
}

try {
  await withObs(conn, async (request) => {
    if (play) {
      // Same `|` separator as `!media set`, so what you test here is what you map.
      const inputs = parseInputList(play);
      if (!inputs) {
        console.error('--play needs one or more non-empty source names separated by |');
        process.exitCode = 1;
        return;
      }
      const res = await mediaSequence(request, { inputs, scene, action });
      console.log(`▶ ${action} ${inputs.map((i) => `"${i}"`).join(' + ')}${scene ? ` (revealed in "${scene}")` : ''}`);
      console.log(res.shown ? `  ${res.shown} scene item(s) enabled first` : '  no scene handling — sources must already be visible');
      // OBS accepts a media action against a source whose FILE is missing without
      // complaint, so this says what was sent, not that anything was heard.
      console.log('  OBS accepted the request. If you heard nothing, check the source in OBS.');
      return;
    }

    if (has('--scenes')) {
      const { scenes = [] } = await request('GetSceneList');
      console.log(`${scenes.length} scene(s):`);
      for (const s of scenes) console.log(`  "${s.sceneName}"`);
      return;
    }

    // ffmpeg_source IS the OBS "Media Source" kind — the only kind that answers a
    // media action. --all exists for when a source is not where you expect it.
    const kind = has('--all') ? null : 'ffmpeg_source';
    const { inputs = [] } = await request('GetInputList', kind ? { inputKind: kind } : {});
    if (!inputs.length) {
      console.log(kind ? 'No Media Sources in OBS. Add one, or re-run with --all.' : 'OBS reports no inputs at all.');
      return;
    }
    console.log(`${inputs.length} ${kind ? 'Media Source' : 'input'}(s) — map with: !media set <n> <name>`);
    for (const i of inputs) {
      console.log(has('--all') ? `  "${i.inputName}"  [${i.inputKind}]` : `  "${i.inputName}"`);
    }
  });
} catch (err) {
  console.error(`OBS: ${err.message}`);
  process.exit(1);
}
