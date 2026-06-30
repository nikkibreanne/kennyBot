// Wipe the raid-game state from Firebase WITHOUT touching the OKRAMARKET poll.
// Targets whatever DB the env points at (emulator if FIREBASE_DATABASE_EMULATOR_HOST
// is set, else the real project via GOOGLE_APPLICATION_CREDENTIALS).
//
// Dry-run by default; pass --yes to actually delete:
//   node scripts/db-cleanup.js          # shows what it would remove
//   node scripts/db-cleanup.js --yes    # removes it
//
// NEVER removes: polls/ (the website poll) or config/secrets (persisted tokens).
import 'dotenv/config';
import { initFirebase, database, closeFirebase, emulatorNamespace } from '../src/db/firebase.js';

// Every game path the bot writes. Explicitly NOT 'polls' and NOT 'config/secrets'.
const GAME_PATHS = [
  'players',
  'usernames',
  'raids',
  'bosses',
  'drops',
  'leaderboard',
  'config/season',
  'config/raid',
  'config/live',
  'config/expMode',
  'config/lock',
  'config/dropScheduler',
];

const confirmed = process.argv.includes('--yes');
const onEmulator = Boolean(process.env.FIREBASE_DATABASE_EMULATOR_HOST);

async function main() {
  console.log(`Target: ${onEmulator ? 'EMULATOR' : 'PRODUCTION'} (ns ${emulatorNamespace()})`);
  console.log('Will remove these game paths (KEEPS polls/ and config/secrets):');
  for (const p of GAME_PATHS) console.log(`  - ${p}`);

  if (!confirmed) {
    console.log('\nDry run — nothing deleted. Re-run with --yes to delete.');
    return;
  }
  if (!onEmulator) {
    console.log('\n⚠️  Deleting from PRODUCTION in 3s… (Ctrl+C to abort)');
    await new Promise((r) => setTimeout(r, 3000));
  }

  initFirebase();
  for (const p of GAME_PATHS) {
    await database().ref(p).remove();
    console.log(`  removed ${p}`);
  }
  await closeFirebase();
  console.log('\nDone. polls/ and config/secrets were left untouched. ✅');
}

main().catch(async (err) => {
  console.error('cleanup failed:', err);
  await closeFirebase().catch(() => {});
  process.exit(1);
});
