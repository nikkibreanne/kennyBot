#!/usr/bin/env node
// Emit the item catalog as an ordered JSON array to stdout — the build-time
// FALLBACK the website's /items/ Compendium renders when Firebase `items/` is
// empty or unreachable (mirrors _data/facts.yml's role for the facts page).
// The live page prefers Firebase (seeded by seedCatalog() on boot); this static
// copy is only the offline safety net, so regenerate it after catalog edits:
//
//   node scripts/export-catalog.mjs > ../nikkibreanne.github.io/_data/items.json
//
// Pure read of src/content/items.js via catalogRows() — never touches Firebase.
import { catalogRows } from '../src/db/catalog.js';

process.stdout.write(`${JSON.stringify(catalogRows(), null, 2)}\n`);
