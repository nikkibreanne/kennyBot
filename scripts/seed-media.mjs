// scripts/seed-media.mjs — load the `!media` slot map into a database.
//
//   npm run seed:media                    # → the emulator (needs it running)
//   npm run seed:media -- --prod          # → production, deliberately
//   npm run seed:media -- --list          # show what's mapped, write nothing
//
// The dev emulator DB is EPHEMERAL — a fresh, empty one every `dev:live` /
// `dev:all` — so the slots have to be re-seeded each session. Doing that by hand
// through `!media set` is a dozen chat messages with exact OBS source names in
// them, which is how a slot ends up looking mapped and playing nothing.
//
// THE MAPPING IS NOT IN THIS REPO. It's the streamer's own OBS setup, so it
// lives in a gitignored file (MEDIA_SLOTS_FILE, default
// .workspace/media-slots.json) shaped like:
//
//   [
//     { "slot": 1, "inputs": "some-gif | some-sound", "label": "optional" },
//     { "slot": 2, "inputs": "another-source", "scene": "Alerts", "action": "restart" }
//   ]
//
// `inputs` is one string, sources separated by `|` — the same syntax `!media set`
// takes, so what you put here is what a mod would type. Get the exact names from
// `node scripts/obs-media.mjs`; they must match OBS character for character.
//
// Writes go through the same mapSlot() the chat command uses, so validation
// (length, part count, action names) is identical — this cannot create a slot
// `!media` would have rejected.

import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { initFirebase, closeFirebase, database, PATHS } from '../src/db/firebase.js';
import { mapSlot } from '../src/db/media.js';
import { describeSlot, slotInputs } from '../src/rules/media.js';

const SLOTS_FILE = process.env.MEDIA_SLOTS_FILE || '.workspace/media-slots.json';
const emulator = process.env.FIREBASE_DATABASE_EMULATOR_HOST;
const argv = process.argv.slice(2);
const listOnly = argv.includes('--list');

if (!emulator && !argv.includes('--prod')) {
  console.error('Refusing to guess a target.');
  console.error('  emulator:    FIREBASE_DATABASE_EMULATOR_HOST=127.0.0.1:9000 npm run seed:media');
  console.error('  production:  npm run seed:media -- --prod');
  process.exit(1);
}

/** RTDB stores arrays as numeric-keyed objects; accept an object map too. */
function entriesFrom(parsed) {
  const list = Array.isArray(parsed) ? parsed : Object.entries(parsed).map(([slot, v]) => ({ slot, ...v }));
  return list.map((e) => ({
    slot: Number(e.slot),
    inputs: e.inputs ?? e.input,
    ...(e.scene ? { scene: e.scene } : {}),
    ...(e.action ? { action: e.action } : {}),
    ...(e.label ? { label: e.label } : {}),
  }));
}

async function loadSlots() {
  try {
    return entriesFrom(JSON.parse(await readFile(SLOTS_FILE, 'utf8')));
  } catch (err) {
    console.error(`Could not read ${SLOTS_FILE}: ${err.message}\n`);
    console.error('No slot map ships in this repository — it is the streamer\'s OBS setup.');
    console.error('Create it (the path is gitignored) as:\n');
    console.error('  [ { "slot": 1, "inputs": "some-gif | some-sound", "label": "optional" } ]\n');
    console.error('Exact source names: node scripts/obs-media.mjs');
    process.exit(1);
  }
}

async function main() {
  initFirebase();
  console.error(`→ ${emulator ? `EMULATOR ${emulator}` : process.env.FIREBASE_DATABASE_URL}\n`);

  if (listOnly) {
    // Read RTDB directly rather than db/media.js's listSlots(): that one serves
    // the bot's in-memory config mirror, which is empty in a standalone script.
    const snap = await database().ref(PATHS.mediaSlots()).get();
    const rows = Object.entries(snap.val() || {})
      .map(([n, slot]) => ({ ...slot, n: Number(n) }))
      .filter((slot) => slotInputs(slot).length)
      .sort((a, b) => a.n - b.n);
    if (!rows.length) { console.log('(no slots mapped)'); return; }
    for (const slot of rows) console.log(`  ${describeSlot(slot)}`);
    return;
  }

  const entries = await loadSlots();
  let failed = 0;
  for (const { slot, ...patch } of entries) {
    const res = await mapSlot(slot, patch);
    if (!res.ok) {
      console.error(`  ✗ slot ${slot}: ${res.reason}`);
      failed += 1;
      continue;
    }
    console.log(`  ✓ slot ${slot}  ${patch.inputs}`);
  }
  if (failed) {
    process.exitCode = 1;
    console.error(`\n${failed} slot(s) rejected — the same validation !media set applies.`);
    return;
  }
  console.log(`\n${entries.length} slot(s) mapped. Fire one with !media <n>.`);
}

main()
  .catch((err) => { console.error('failed:', err?.message || err); process.exitCode = 1; })
  .finally(async () => { try { await closeFirebase(); } catch { /* already closed */ } });
