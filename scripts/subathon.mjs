// SUBATHON OPERATOR CLI — the private back channel.
//
// Runs LOCALLY (your machine, not the container) and writes straight to the same
// RTDB the bot reads. The running bot picks changes up through the config mirror
// it already keeps, so nothing has to be attached to, exec'd into, or restarted.
//
//   node scripts/subathon.mjs owed        # what to tell her to add or subtract
//   node scripts/subathon.mjs status
//   node scripts/subathon.mjs dono 25 "off-platform"
//   node scripts/subathon.mjs align 6h22m "restarted, lost events"
//
// WHY NOT THE CONTAINER CONSOLE: `docker run -d` closes stdin, so the bot's own
// process has no readable console — `docker logs` is one-way and `docker exec`
// starts a NEW process that shares no memory with the bot. There is nothing to
// type into. This sidesteps that by writing to the state both processes share.
//
// CREDENTIALS: needs FIREBASE_DATABASE_URL and GOOGLE_APPLICATION_CREDENTIALS
// (the service-account JSON) — both from .env, neither in the repo. Cloning the
// repo gets you this script and no way to point it at anything.
//
// RATES ARE NOT IN THIS REPO. `start` reads the card from a gitignored file
// (SUBATHON_RATES_FILE, default .workspace/subathon-rates.json) and stores it on
// the event record. Monetary figures are hidden from output unless you pass
// --money, so a screenshot of this terminal leaks nothing.

import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { initFirebase, closeFirebase } from '../src/db/firebase.js';
import {
  readSubathon, startSubathon, stopSubathon, clearSubathon, pauseSubathon,
  resumeSubathon, adjustSubathon, undoLedgerEntry, creditSubathon, subathonStatus,
  recordCorrection, alignSubathon,
} from '../src/db/subathon.js';
import {
  parseSeconds, formatDuration, ledgerSeconds, bandTimeline, ledgerBreakdown,
  describeSe, ratesFrom, seMatchesOpeningBand,
} from '../src/rules/subathon.js';

const [, , cmd, ...rest] = process.argv;
const emulator = process.env.FIREBASE_DATABASE_EMULATOR_HOST;
const target = emulator ? `EMULATOR ${emulator}` : process.env.FIREBASE_DATABASE_URL;
const RATES_FILE = process.env.SUBATHON_RATES_FILE || '.workspace/subathon-rates.json';
const SHOW_MONEY = rest.includes('--money');

const hhmm = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19) + 'Z';
const sign = (n) => (n >= 0 ? `+${n}` : String(n));
// formatDuration floors at zero — right for a clock, wrong for a ledger delta,
// where a −5m correction must not render as "0s".
const delta = (seconds) => (seconds < 0 ? `-${formatDuration(-seconds * 1000)}` : formatDuration(seconds * 1000));

function flag(name, fallback = null) {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 && rest[i + 1] != null && !rest[i + 1].startsWith('--') ? rest[i + 1] : fallback;
}
/** Positional args, with `--flag [value]` pairs stripped out. */
function positional() {
  const out = [];
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i].startsWith('--')) {
      if (rest[i + 1] != null && !rest[i + 1].startsWith('--')) i += 1;
      continue;
    }
    out.push(rest[i]);
  }
  return out;
}

function usage() {
  console.log(`
subathon — operator CLI  (target: ${target || 'UNSET'})

  owed                       ➜ the one to run: how much to tell her to add or
                             subtract externally, since that timer never changes band
  corrected <dur>|--all      record that you applied that correction
  align <dur>                force kennyBot's clock to this remaining time
                             (after a restart that lost events, or a bug)
  status                     the clock, the band, the outstanding correction
  reconcile                  full cross-check + the wall-clock band marks
  ledger [n]                 last n ledger entries (default 20)
  add <dur> [note]           add/remove raw time — 5m, 90s, 1h30m, -10m
  dono <amount> [note]       credit a donation, priced at the CURRENT band
  bits <n> [note]            credit bits the bot missed
  sub <t1|t2|t3> [n] [note]  credit sub(s) the bot missed
  undo <entryId>             reverse one entry (appends a compensating entry)
  pause | resume             freeze/unfreeze the clock AND the band
  start --base <dur>         begin; rates come from ${RATES_FILE}
  end                        stop the clock, keep the ledger
  wipe --yes                 delete the record entirely (test runs only)

  --money                    include monetary figures in the output (off by
                             default so a screenshot leaks nothing)
  --off-platform             (dono/bits/sub) the external timer never saw this
  --only-here                (add) went into kennyBot alone, still owed externally
`.trimStart());
}

async function requireActive() {
  const state = await readSubathon();
  if (!state?.active) {
    console.error('No active subathon. Start one with:  node scripts/subathon.mjs start --base <dur>');
    process.exit(1);
  }
  return state;
}

function printStatus(state, now = Date.now()) {
  const s = subathonStatus(state, now);
  if (!s.active) { console.log('subathon: inactive'); return; }
  console.log(`
  clock       ${formatDuration(s.remainingMs)} remaining${s.paused ? '   ⏸  PAUSED' : ''}
  ends        ${hhmm(s.endsAt)}
  uptime      ${formatDuration(s.elapsedMs)}   (band: ${String(s.band).toUpperCase()})
  correction  ${delta(s.owedSeconds)} outstanding
  granted     ${formatDuration(s.grantedSeconds * 1000)} earned  +  ${formatDuration(s.baseSeconds * 1000)} base
  ledger      ${s.entries} entries
  soft cap    ${s.softCapHours ?? '—'}h   (not enforced — she calls the end)
`.trimStart());
  if (SHOW_MONEY) console.log(`  external timer: ${describeSe(ratesFrom(state).se)}\n`);
}

async function loadRates() {
  try {
    const rates = JSON.parse(await readFile(RATES_FILE, 'utf8'));
    if (!ratesFrom({ rates }).configured) throw new Error('file has no usable values/bands');
    return rates;
  } catch (err) {
    console.error(`Could not read a rate card from ${RATES_FILE}: ${err.message}`);
    console.error('No rates ship in this repository — see the private runbook in .workspace/.');
    process.exit(1);
  }
}

async function main() {
  if (!cmd || cmd === 'help' || cmd === '--help') { usage(); return; }
  if (!emulator && !process.env.FIREBASE_DATABASE_URL) {
    console.error('FIREBASE_DATABASE_URL is unset and no emulator host — refusing to guess a target.');
    process.exit(1);
  }
  initFirebase();
  if (!emulator) console.error(`→ ${target}\n`); // stderr so piping stays clean

  const args = positional();
  const now = Date.now();

  switch (cmd) {
    case 'status': {
      printStatus(await readSubathon(), now);
      break;
    }

    case 'owed': {
      const s = subathonStatus(await requireActive(), now);
      const owed = s.owedSeconds;
      console.log(`  kennyBot clock  ${formatDuration(s.remainingMs)}   (band ${String(s.band).toUpperCase()}, uptime ${formatDuration(s.elapsedMs)})`);
      if (Math.abs(owed) < 30) {
        console.log(`  correction      none worth calling out (${delta(owed)})`);
      } else if (owed < 0) {
        console.log(`\n  ➜  TELL HER: SUBTRACT ${formatDuration(-owed * 1000)}`);
        console.log('     (the external timer never leaves its opening band, so it has over-granted)');
      } else {
        console.log(`\n  ➜  TELL HER: ADD ${formatDuration(owed * 1000)}`);
      }
      console.log('\n  once applied:  node scripts/subathon.mjs corrected --all\n');
      break;
    }

    case 'corrected': {
      const state = await requireActive();
      const all = rest.includes('--all');
      const seconds = all ? subathonStatus(state, now).owedSeconds : parseSeconds(args[0]);
      if (seconds == null) { console.error('Usage: corrected <dur> [note]   |   corrected --all'); process.exit(1); }
      const entry = await recordCorrection(seconds, { note: args.slice(all ? 0 : 1).join(' ') || null }, now);
      const after = subathonStatus({ ...state, ledger: { ...(state.ledger || {}), [entry.id]: entry } }, now);
      console.log(`recorded: external timer moved by ${delta(seconds)}  (${entry.id})`);
      console.log(`outstanding now ${delta(after.owedSeconds)}`);
      break;
    }

    case 'align': {
      const state = await requireActive();
      const targetSeconds = parseSeconds(args[0]);
      if (targetSeconds == null) { console.error('Usage: align <dur>   e.g. align 6h22m'); process.exit(1); }
      const before = subathonStatus(state, now);
      const entry = await alignSubathon(state, targetSeconds * 1000, { note: args.slice(1).join(' ') || null }, now);
      console.log(`aligned: ${formatDuration(before.remainingMs)} → ${formatDuration(targetSeconds * 1000)}  (${delta(entry.seconds)})`);
      console.log('the outstanding correction is unchanged — realigning does not invent one.');
      break;
    }

    case 'reconcile': {
      const state = await readSubathon();
      const s = subathonStatus(state, now);
      if (!s.active) { console.log('subathon: inactive'); break; }
      console.log(`  kennyBot says   ${formatDuration(s.remainingMs)} left   (ends ${hhmm(s.endsAt)})`);
      console.log(`  uptime          ${formatDuration(s.elapsedMs)}   band ${String(s.band).toUpperCase()}`);
      console.log(`  correction      ${delta(s.owedSeconds)} outstanding\n`);

      console.log('  where the time came from');
      for (const r of ledgerBreakdown(state.ledger)) {
        const money = SHOW_MONEY && r.worth ? `   worth ${r.worth}` : '';
        console.log(`    ${String(r.kind).padEnd(9)} ${String(r.count).padStart(4)} ×  ${delta(r.seconds).padStart(12)}${money}`);
      }
      console.log(`    ${'BASE'.padEnd(9)}       ${formatDuration(s.baseSeconds * 1000).padStart(12)}`);
      console.log(`    ${'TOTAL'.padEnd(9)}       ${formatDuration((s.baseSeconds + s.grantedSeconds) * 1000).padStart(12)}\n`);

      console.log('  band marks   (kennyBot switches automatically at these times)');
      for (const b of bandTimeline(state, now)) {
        const span = b.untilHours == null ? `${b.fromHours}h+` : `${b.fromHours}–${b.untilHours}h`;
        const when = b.projected ? `~${hhmm(b.at)} (projected)` : hhmm(b.at);
        const mark = b.active ? ' ← ACTIVE' : b.past ? ' done' : '';
        console.log(`    ${b.band.toUpperCase().padEnd(8)} ${span.padEnd(9)} ${when}${mark}`);
      }
      console.log('');
      break;
    }

    case 'ledger': {
      const state = await readSubathon();
      const limit = Number(args[0]) || 20;
      const rows = Object.entries(state?.ledger || {})
        .map(([id, e]) => ({ id, ...e }))
        .sort((a, b) => a.at - b.at)
        .slice(-limit);
      if (!rows.length) { console.log('(ledger empty)'); break; }
      for (const r of rows) {
        const who = r.who ? ` ${r.who}` : '';
        const band = r.band ? ` @${r.band}` : '';
        const note = r.note ? `  — ${r.note}` : '';
        console.log(`${hhmm(r.at)}  ${r.id}  ${sign(r.seconds).padStart(7)}s  ${String(r.kind).padEnd(10)}${band}${who}${note}`);
      }
      console.log(`\n  total granted: ${formatDuration(ledgerSeconds(state.ledger) * 1000)}`);
      break;
    }

    case 'add': {
      const state = await requireActive();
      const seconds = parseSeconds(args[0]);
      if (seconds == null) { console.error(`Not a duration: "${args[0] ?? ''}"  (try 5m, 90s, 1h30m, -10m)`); process.exit(1); }
      const entry = await adjustSubathon(seconds, {
        note: args.slice(1).join(' ') || null, source: 'cli', seenBySe: !rest.includes('--only-here'),
      }, now);
      console.log(`${sign(seconds)}s  (${entry.id})`);
      printStatus({ ...state, ledger: { ...(state.ledger || {}), [entry.id]: entry } }, now);
      break;
    }

    case 'dono':
    case 'bits':
    case 'sub': {
      const state = await requireActive();
      let contribution;
      let noteFrom = 1;
      if (cmd === 'dono') {
        const amount = Number(args[0]);
        if (!Number.isFinite(amount) || amount <= 0) { console.error('Usage: dono <amount> [note]'); process.exit(1); }
        contribution = { product: 'dollars', dollars: amount };
      } else if (cmd === 'bits') {
        const bits = Number(args[0]);
        if (!Number.isFinite(bits) || bits <= 0) { console.error('Usage: bits <n> [note]'); process.exit(1); }
        contribution = { product: 'bits', bits };
      } else {
        const tier = String(args[0] || '').toLowerCase();
        if (!['t1', 't2', 't3'].includes(tier)) { console.error('Usage: sub <t1|t2|t3> [count] [note]'); process.exit(1); }
        const count = Number(args[1]) > 0 ? Number(args[1]) : 1;
        contribution = { product: tier, count };
        noteFrom = Number(args[1]) > 0 ? 2 : 1;
      }
      const entry = await creditSubathon(state, contribution, {
        note: args.slice(noteFrom).join(' ') || null,
        source: 'cli',
        kind: cmd,
        // Off-platform money the external timer never saw is owed in full.
        seenBySe: !rest.includes('--off-platform'),
      }, now);
      console.log(`+${entry.seconds}s @ ${entry.band}  (${entry.id})`);
      printStatus({ ...state, ledger: { ...(state.ledger || {}), [entry.id]: entry } }, now);
      break;
    }

    case 'undo': {
      const state = await requireActive();
      const id = args[0];
      if (!id) { console.error('Usage: undo <entryId>   (get ids from `ledger`)'); process.exit(1); }
      const entry = await undoLedgerEntry(state, id, {}, now);
      if (!entry) { console.error(`Nothing to undo for "${id}" — unknown id, or already reversed.`); process.exit(1); }
      console.log(`reversed ${id}: ${sign(entry.seconds)}s`);
      printStatus({ ...state, ledger: { ...(state.ledger || {}), [entry.id]: entry } }, now);
      break;
    }

    case 'pause': {
      printStatus(await pauseSubathon(await requireActive(), now), now);
      break;
    }

    case 'resume': {
      printStatus(await resumeSubathon(await requireActive(), now), now);
      break;
    }

    case 'start': {
      const existing = await readSubathon();
      if (existing?.active) { console.error('A subathon is already active. `end` it first, or `wipe --yes` a test run.'); process.exit(1); }
      const baseSeconds = parseSeconds(flag('base'));
      if (baseSeconds == null || baseSeconds <= 0) { console.error('--base is required, e.g. --base 3h'); process.exit(1); }
      const rates = await loadRates();
      const state = await startSubathon({
        baseHours: baseSeconds / 3600, rates, softCapHours: Number(flag('soft-cap')) || null, now,
      });
      console.log('started.');
      printStatus(state, now);
      // A mismatch here means one of the two systems is not set up the way we
      // think, and every correction from now on would be wrong. Say so loudly
      // while there is still time to check.
      const matches = seMatchesOpeningBand(ratesFrom(state));
      if (matches === false) {
        console.log('  ⚠  the external timer is NOT on the opening band — expect a correction from');
        console.log('     the very first contribution. Verify its settings before going live.\n');
      } else if (matches === true) {
        console.log('  ✓ external timer matches the opening band — the correction should stay at');
        console.log('    zero until the first band change. Watch for that as a setup check.\n');
      }
      break;
    }

    case 'end': {
      await stopSubathon();
      console.log('ended — clock stopped, ledger kept for reconciliation.');
      break;
    }

    case 'wipe': {
      if (!emulator && !rest.includes('--yes')) {
        console.error('Refusing to wipe production state without --yes (this deletes the ledger).');
        process.exit(1);
      }
      await clearSubathon();
      console.log('wiped.');
      break;
    }

    default:
      console.error(`Unknown command: ${cmd}\n`);
      usage();
      process.exit(1);
  }
}

main()
  .catch((err) => { console.error('failed:', err?.message || err); process.exitCode = 1; })
  // The RTDB SDK keeps a socket open; without this the CLI hangs after a write.
  .finally(async () => { try { await closeFirebase(); } catch { /* already closed */ } });
