// Create the now-playing text source in OBS and add it to every scene.
//
// Separate from the bot on purpose: creating and positioning sources is SETUP, and
// a bot that invents sources in your scene collection at boot is a bot you stop
// trusting. Run this once; after that kennyBot only ever writes the source's text.
//
//   node scripts/obs-overlay-setup.mjs                    create + add to all scenes
//   node scripts/obs-overlay-setup.mjs --name "Now Playing"
//   node scripts/obs-overlay-setup.mjs --scenes "Scene,BRB"   only these
//   node scripts/obs-overlay-setup.mjs --remove           undo it everywhere
//
// ONE source shown in several scenes, not a copy per scene: in OBS a source can
// appear in many scenes as separate scene items, and they all render the same
// underlying text. So kennyBot writes once and every scene updates. Copies would
// need a write each and would drift.
import 'dotenv/config';
import { withObs, obsConnectionFromEnv } from '../src/integrations/obsWebsocket.js';

const conn = obsConnectionFromEnv();
if (!conn) {
  console.error('Need OBS_WEBSOCKET_URL (and usually OBS_WEBSOCKET_PASSWORD) in .env');
  process.exit(1);
}

const arg = (f) => {
  const i = process.argv.indexOf(f);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const NAME = arg('--name') || process.env.SPOTIFY_OVERLAY_SOURCE || 'Now Playing';
const REMOVE = process.argv.includes('--remove');
const ONLY = arg('--scenes')?.split(',').map((s) => s.trim()).filter(Boolean);

await withObs(conn, async (rq) => {
  const { scenes } = await rq('GetSceneList');
  const names = scenes.map((s) => s.sceneName).reverse();
  const targets = ONLY ? names.filter((n) => ONLY.includes(n)) : names;
  if (!targets.length) {
    console.error(`No matching scenes. OBS has: ${names.join(', ')}`);
    process.exitCode = 1;
    return;
  }

  if (REMOVE) {
    // Removing the INPUT removes every scene item referencing it, in one call.
    await rq('RemoveInput', { inputName: NAME });
    console.log(`removed "${NAME}" from all scenes`);
    return;
  }

  // Which text kind this OBS build has: GDI+ on Windows, FreeType elsewhere. Ask
  // rather than assume — the wrong kind fails with an unhelpful error.
  const { inputKinds } = await rq('GetInputKindList');
  const kind = ['text_gdiplus_v3', 'text_gdiplus_v2', 'text_ft2_source_v2']
    .find((k) => inputKinds.includes(k));
  if (!kind) {
    console.error(`No text source kind available. OBS offers: ${inputKinds.join(', ')}`);
    process.exitCode = 1;
    return;
  }

  const exists = (await rq('GetInputList')).inputs.some((i) => i.inputName === NAME);
  const [first, ...rest] = targets;

  if (!exists) {
    await rq('CreateInput', {
      sceneName: first,
      inputName: NAME,
      inputKind: kind,
      inputSettings: {
        text: '',
        // A readable default; restyle it in OBS afterwards, this only has to be
        // visible enough to find and drag.
        font: { face: 'Segoe UI', size: 36, style: 'Bold' },
        color: 0xffffffff,
        outline: true,
      },
    });
    console.log(`created "${NAME}" [${kind}] in "${first}"`);
  } else {
    console.log(`"${NAME}" already exists — adding it to any scene that lacks it`);
    rest.unshift(first);
  }

  for (const sceneName of rest) {
    const { sceneItems } = await rq('GetSceneItemList', { sceneName });
    if (sceneItems.some((i) => i.sourceName === NAME)) {
      console.log(`  "${sceneName}": already there`);
      continue;
    }
    await rq('CreateSceneItem', { sceneName, sourceName: NAME, sceneItemEnabled: true });
    console.log(`  "${sceneName}": added`);
  }

  console.log(`\nNow set this in .env so kennyBot writes to it:\n  SPOTIFY_OVERLAY_SOURCE=${NAME}`);
  console.log('Then position and restyle it in OBS — it is one source, so every scene follows.');
});
