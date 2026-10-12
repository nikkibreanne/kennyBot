#!/usr/bin/env node
// Is the ADS-B side of the chase monitor actually seeing anything?
//
// Written because answering that took a hand-rolled probe. The aircraft channel's
// first real miss (2026-10-09, a televised CHP pursuit) logged `orbiting: 0`, and
// there was no way to tell a dead fetch from a live sky the detector had rejected —
// opposite fixes, identical evidence. This prints the whole chain in one shot:
// what the API returned, what survived tracking, and what each shape test made of
// it. One pass costs 1 call against the ~400/day anonymous budget; `--passes N`
// takes N and actually runs the detectors, which needs at least 2.
//
// It talks to a public API and reads src/config.js. No credentials, no RTDB, no
// roster — so it is safe to run from anywhere, including a host with no .env.
import 'dotenv/config'; // every operator script here needs this — see chase-sources-load.mjs
import { config } from '../src/config.js';
import { parseStates, detectOrbits, detectPursuits, clusterOrbits, clusterPursuits } from '../src/integrations/aircraft.js';

const AC = config.chase.aircraft;
const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : fallback;
};
const passesWanted = Math.max(1, Math.round(Number(arg('passes', 1)) || 1));
const gapMs = Math.max(0, Number(arg('gap', AC.sampleGapMs)) || 0);
const b = AC.bbox;
const url = `https://opensky-network.org/api/states/all?lamin=${b.lamin}&lomin=${b.lomin}&lamax=${b.lamax}&lomax=${b.lomax}`;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (s = '') => console.log(s);

say('');
say('  CHASE MONITOR — ADS-B PROBE');
say(`  bbox      ${JSON.stringify(b)}`);
say(`  passes    ${passesWanted}${passesWanted > 1 ? ` · ${Math.round(gapMs / 1000)}s apart` : '  (--passes=3 to run the detectors)'}`);
say('');

const collected = [];
let rateRemaining = null;
for (let i = 0; i < passesWanted; i += 1) {
  if (i > 0 && gapMs > 0) await delay(gapMs);
  try {
    const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
    const left = res.headers?.get?.('x-rate-limit-remaining');
    if (left != null) rateRemaining = left;
    if (!res.ok) { say(`  pass ${i + 1}  HTTP ${res.status} — ${res.status === 429 ? 'daily budget gone' : 'API having a day'}`); continue; }
    const fixes = parseStates(await res.json(), Date.now());
    collected.push(fixes);
    say(`  pass ${i + 1}  ${String(fixes.length).padStart(3)} usable fixes · rate-remaining ${left ?? '—'}`);
  } catch (err) {
    say(`  pass ${i + 1}  unreachable: ${err?.message || err}`);
  }
}

if (!collected.length) {
  say('');
  say('  NOTHING CAME BACK. That is a fetch problem, not a detector one — check');
  say('  network reachability and whether the anonymous daily budget is spent.');
  say('');
  process.exitCode = 1;
} else {
  const union = new Set();
  for (const p of collected) for (const f of p) union.add(f.icao24);
  const low = collected[collected.length - 1].filter((f) => f.altM != null && f.altM < AC.altMaxM);
  say('');
  say(`  distinct aircraft   ${union.size}`);
  say(`  low (<${AC.altMaxM}m) in the last pass  ${low.length}`);

  if (collected.length < 2) {
    say('');
    say('  Only one pass, so no shape can be measured — an orbit and a pursuit are both');
    say('  defined by movement over time. Re-run with --passes=3 to exercise the detectors.');
  } else {
    const orbiting = detectOrbits(collected, AC);
    const pursuing = detectPursuits(collected, AC);
    const oc = clusterOrbits(orbiting, AC);
    const pc = clusterPursuits(pursuing, AC);
    let tracked = 0;
    const counts = new Map();
    for (const p of collected) for (const f of p) counts.set(f.icao24, (counts.get(f.icao24) || 0) + 1);
    for (const n of counts.values()) if (n === collected.length) tracked += 1;

    say(`  tracked in EVERY pass  ${tracked}   <- the candidate pool both detectors judge`);
    say('');
    say(`  orbiting  ${orbiting.length}  -> ${oc.length} cluster(s) ${oc.map((c) => `size ${c.size}`).join(', ')}`);
    say(`  pursuing  ${pursuing.length}  -> ${pc.length} cluster(s) ${pc.map((c) => `size ${c.size}`).join(', ')}`);
    for (const p of pursuing.slice(0, 6)) {
      say(`      ${p.icao24} ${String(p.callsign).padEnd(9)} ${String(p.altM).padStart(5)}m ${String(p.spdMs).padStart(5)}m/s`
        + ` loiter ${p.loiter} path ${p.pathKm}km hdg ${p.headingDeg}`);
    }
    say('');
    if (!orbiting.length && !pursuing.length && tracked > 0) {
      say(`  A sky of ${union.size} with ${tracked} trackable and NOTHING matching either shape is`);
      say('  the normal, quiet result — but it is also what "the thresholds are too strict"');
      say('  looks like. The difference is only visible across many readings; that is what');
      say('  the calibration section of `npm run chase:report` accumulates.');
    } else if (tracked === 0) {
      say('  NOTHING was trackable across passes, so neither detector could judge anything.');
      say(`  With a ${Math.round(gapMs / 1000)}s gap, aircraft are leaving the box between passes — try a shorter --gap.`);
    }
  }
  say('');
  say(`  budget remaining ${rateRemaining ?? '—'} of ~400/day anonymous · this run cost ${collected.length}`);
  say('');
}
