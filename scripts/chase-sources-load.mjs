// Load the PRIVATE chase-monitor source roster into RTDB.
//
// The roster — which outlets are watched, their channel ids, their stream classes —
// is deliberately absent from this repo (CLAUDE.md: it must never appear in config,
// a comment, a test fixture or a doc). `config.chase.orgs` ships EMPTY, so a fresh
// clone runs an inert monitor until someone loads sources here.
//
//   npx firebase emulators:exec --only database --project okrafans \
//     "node scripts/chase-sources-load.mjs"          # local
//   node scripts/chase-sources-load.mjs              # against the real project
//   node scripts/chase-sources-load.mjs --file <p>   # a different roster file
//   node scripts/chase-sources-load.mjs --show       # print what is loaded, no write
//
// The file is `.workspace/chase-sources.json` (that directory is gitignored). Shape,
// with PLACEHOLDER values only — never commit real ones:
//
//   [
//   (placeholders are deliberately SHORT — a stand-in long enough to look like a real
//    channel id would trip the `UC[A-Za-z0-9_-]{22}` leak check on every use)
//     { "id": "org1", "name": "Org One", "channelId": "UC-org1",
//       "streamClass": "chopper" },
//     { "id": "org2", "name": "Org Two", "channelId": "UC-org2",
//       "streamClass": "episodic" },
//     { "id": "org3", "name": "Org Three", "channelId": "UC-org3",
//       "streamClass": "newscast",
//       "articleFeed": "https://example.test/chases?rss=y",
//       "groupCap": 7 }
//   ]
//
// `streamClass` is the only field the scoring branches on:
//   chopper  — always live under a generic title; the audience channel is its detector
//   newscast — always live, title tracks the current show
//   episodic — dark until something happens, so GOING LIVE is itself the signal
// `groupCap` below the threshold makes a source a corroborator that can never fire alone.
import { readFileSync } from 'node:fs';
import { initFirebase, closeFirebase } from '../src/db/firebase.js';
import { setChaseSources, getChaseSettings } from '../src/db/chaseMonitor.js';

const DEFAULT_FILE = '.workspace/chase-sources.json';
const argv = process.argv.slice(2);
const fileArg = argv.indexOf('--file');
const file = fileArg >= 0 ? argv[fileArg + 1] : DEFAULT_FILE;
const showOnly = argv.includes('--show');

/** Never print a channel id or a feed url — this output can end up in a scrollback. */
const redact = (o) => `${o.id} (${o.streamClass}${o.groupCap ? `, cap ${o.groupCap}` : ''}${o.articleFeed ? ', +feed' : ''})`;

async function main() {
  await initFirebase(console);

  if (showOnly) {
    const { orgs } = await getChaseSettings();
    console.log(orgs.length ? `\n  ${orgs.length} source(s) loaded:` : '\n  no sources loaded — the monitor is inert');
    for (const o of orgs) console.log(`    · ${redact(o)}`);
    console.log();
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    console.error(`\n  cannot read ${file}\n  ${err.message}`);
    console.error('\n  That file is gitignored and is NOT in the repo — create it from the');
    console.error('  shape documented at the top of this script.\n');
    process.exitCode = 1;
    return;
  }

  // setChaseSources is all-or-nothing: a bad entry throws and nothing is written,
  // so a typo can never leave a half-loaded roster that looks configured.
  const n = await setChaseSources(parsed);
  const { orgs } = await getChaseSettings();
  console.log(`\n  loaded ${n} source(s) into config/chaseMonitor/orgs:`);
  for (const o of orgs) console.log(`    · ${redact(o)}`);
  console.log('\n  the monitor is still OFF and in shadow mode — !chasemon on / !chasemon live\n');
}

main()
  .catch((err) => { console.error('\n  load failed:', err.message, '\n'); process.exitCode = 1; })
  .finally(() => closeFirebase?.());
