// AIRCRAFT OVERHEAD — the offline suite. No network: every HTTP call goes through
// the `initAircraftWith` seam, and the orbit/cluster geometry is synthesised so the
// arithmetic is exact rather than probabilistic.
//
// What these cases are really defending is the CORROBORATION-ONLY contract. The
// measured background rate of a cluster of orbiting aircraft over the LA basin is
// zero, which is what makes this a usable signal — but "zero on three samples of a
// quiet afternoon" is not "zero precision for police pursuits specifically": a fire,
// a manhunt or a motorcade also converge aircraft. So the weight has to sit below the
// threshold and it has to STAY there, and that is the first assertion in this file.
//
// NOTE ON PRIVACY (CLAUDE.md): there is nothing to redact here. This source has no
// roster — it is a bounding box and a public ADS-B feed — and the icao24 addresses
// below are invented hex strings, not real registrations belonging to anyone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  aircraftReady, clusterOrbits, detectOrbits, haversineKm,
  initAircraftWith, parseStates, sampleAircraft,
} from '../../src/integrations/aircraft.js';
import { evaluateChase } from '../../src/rules/chase.js';
import { config } from '../../src/config.js';

const MIN = 60_000;
const NOW = Date.parse('2026-10-06T21:00:00Z');
const AC = config.chase.aircraft;

// Three points in the basin, each verified >= 15 km from all 18 excluded airports,
// so an orbit over any of them is excluded for its SHAPE and never for its location.
const DOWNTOWN = { lat: 34.05, lon: -118.25 };
const NEARBY = { lat: 34.0771, lon: -118.25 }; // 3.01 km from DOWNTOWN — inside clusterKm
const FAR = { lat: 33.688, lon: -118.25 }; // 40.25 km from DOWNTOWN — nowhere near it
const LAX = { lat: 33.9416, lon: -118.4085 }; // an excluded airport, for the pattern case

const KM_PER_DEG_LAT = 110.574;
const kmPerDegLon = (lat) => 111.320 * Math.cos((lat * Math.PI) / 180);

/** A point `radiusKm` from `centre` at compass angle `deg` (0 = north). */
function offset(centre, radiusKm, deg) {
  const rad = (deg * Math.PI) / 180;
  return {
    lat: centre.lat + (radiusKm * Math.cos(rad)) / KM_PER_DEG_LAT,
    lon: centre.lon + (radiusKm * Math.sin(rad)) / kmPerDegLon(centre.lat),
  };
}

/**
 * One aircraft's track as the orbit detector wants it: a fix per pass, going round a
 * circle. 0 -> 170 -> 340 degrees is 340 degrees of turn and brings it back nearly to
 * where it started, which is what circling looks like in three 70-second samples.
 */
function orbit(icao24, centre, over = {}) {
  const { angles = [0, 170, 340], radiusKm = 1.2, ...fix } = over;
  return angles.map((deg) => ({
    icao24,
    callsign: '',
    ...offset(centre, radiusKm, deg),
    altM: 400,
    spdMs: 40,
    trackDeg: (deg + 90) % 360, // tangential: it is flying around the circle
    at: NOW,
    ...fix,
  }));
}

/** The same aircraft going somewhere: a straight line, constant heading. */
function transit(icao24, centre, over = {}) {
  return [0, 1, 2].map((i) => ({
    icao24,
    callsign: '',
    ...offset(centre, i * 2, 90),
    altM: 400,
    spdMs: 50,
    trackDeg: 90,
    at: NOW,
    ...over,
  }));
}

/** Per-aircraft tracks -> the per-PASS arrays `detectOrbits` takes. */
function passes(...tracks) {
  const depth = Math.max(...tracks.map((t) => t.length));
  return Array.from({ length: depth }, (_, i) => tracks.map((t) => t[i]).filter(Boolean));
}

// ── the structural guarantee ─────────────────────────────────────────────────

test('the aircraft weight sits BELOW the threshold — corroboration only, structurally', () => {
  assert.ok(AC.weight > 0, 'a weight of 0 would make the whole source dead code');
  assert.ok(
    AC.weight < config.chase.threshold,
    `a cluster must never be able to fire alone: weight ${AC.weight} must stay under threshold ${config.chase.threshold}`,
  );
  assert.ok(
    AC.suspicionFloor < config.chase.threshold,
    'the floor has to be reachable by the cheap sources alone, or a reading is never taken',
  );
  assert.ok(AC.minCluster >= 2, 'a lone orbiter is the measured background, not evidence');
});

// ── haversineKm ──────────────────────────────────────────────────────────────

test('haversineKm measures a known leg, and refuses to invent one', () => {
  // LAX -> BUR. Published great-circle distance is ~29 km.
  assert.ok(Math.abs(haversineKm(33.9416, -118.4085, 34.2007, -118.3587) - 29.2) < 0.5);
  assert.equal(haversineKm(34, -118, 34, -118), 0);
  assert.ok(Number.isNaN(haversineKm(34, -118, 'x', null)), 'garbage in must not come out as 0 km');
});

// ── parseStates ──────────────────────────────────────────────────────────────

/** A `states/all` row, which the API sends as a bare positional array. */
function row(over = {}) {
  const r = new Array(17).fill(null);
  r[0] = over.icao24 ?? 'a1b2c3';
  r[1] = over.callsign ?? 'TEST1   ';
  // `in`, not `??`: a row whose position is explicitly null is the case under test.
  r[5] = 'lon' in over ? over.lon : -118.25;
  r[6] = 'lat' in over ? over.lat : 34.05;
  r[7] = over.baroAlt ?? 450;
  r[8] = over.onGround ?? false;
  r[9] = 'velocity' in over ? over.velocity : 42;
  r[10] = over.track ?? 180;
  r[13] = 'geoAlt' in over ? over.geoAlt : 500;
  return r;
}

test('parseStates reads the positional array, drops the useless rows and never invents a zero', () => {
  const fixes = parseStates({
    time: 1,
    states: [
      row(),
      row({ icao24: 'onground', onGround: true }), // a taxiing jet is low, slow and turning
      row({ icao24: 'nopos', lat: null, lon: null }),
      row({ icao24: '' }),
      row({ icao24: 'barofall', geoAlt: null, baroAlt: 980 }),
      row({ icao24: 'nospeed', velocity: null }),
      'not an array',
    ],
  }, NOW);

  assert.deepEqual(fixes.map((f) => f.icao24), ['a1b2c3', 'barofall', 'nospeed']);
  assert.equal(fixes[0].callsign, 'TEST1', 'the API pads callsigns to 8 characters');
  assert.equal(fixes[0].altM, 500, 'geo_altitude wins');
  assert.equal(fixes[1].altM, 980, 'and baro_altitude is the fallback');
  assert.equal(fixes[2].spdMs, null, 'a missing velocity is NULL — 0 m/s would read as a hover');
  assert.equal(fixes[0].at, NOW);
});

test('parseStates survives a response that is not one', () => {
  for (const junk of [null, undefined, {}, { states: null }, { states: 'nope' }, 42]) {
    assert.deepEqual(parseStates(junk, NOW), []);
  }
});

// ── detectOrbits ─────────────────────────────────────────────────────────────

test('a circling aircraft is detected, with the measured loiter/turn arithmetic', () => {
  const found = detectOrbits(passes(orbit('aaa001', DOWNTOWN)), AC);
  assert.equal(found.length, 1);
  const [o] = found;
  assert.equal(o.icao24, 'aaa001');
  assert.equal(o.fixes, 3);
  assert.ok(o.turnDeg > AC.turnMinDeg, `turn ${o.turnDeg} must clear ${AC.turnMinDeg}`);
  assert.ok(o.loiter < AC.loiterMax, `loiter ${o.loiter} must clear ${AC.loiterMax}`);
  assert.ok(o.netKm < o.pathKm, 'it came back to where it started');
  // The CENTROID, not the last fix: for an aircraft holding over something, the mean
  // of its track is the point it is circling, and that is what a cluster is about.
  assert.ok(haversineKm(o.lat, o.lon, DOWNTOWN.lat, DOWNTOWN.lon) < 1, 'the centroid is near the orbit centre');
});

test('a straight transit is not an orbit — net == path, no turn', () => {
  assert.deepEqual(detectOrbits(passes(transit('bbb001', DOWNTOWN)), AC), []);
});

test('an airliner overhead is not an orbit, however it turns', () => {
  assert.deepEqual(detectOrbits(passes(orbit('ccc001', DOWNTOWN, { altM: 9500 })), AC), []);
});

test('a fast aircraft is not an orbit, however tightly it turns', () => {
  assert.deepEqual(detectOrbits(passes(orbit('ddd001', DOWNTOWN, { spdMs: 140 })), AC), []);
});

test('an aircraft the network lost is dropped, not extrapolated', () => {
  const partial = orbit('eee001', DOWNTOWN).slice(0, 2); // present in passes 1-2, gone by 3
  const steady = orbit('eee002', NEARBY);
  const found = detectOrbits(passes(steady, partial), AC);
  assert.deepEqual(found.map((o) => o.icao24), ['eee002'], 'only aircraft present in ALL passes are measured');
});

test('an aircraft first seen in a later pass can never catch up', () => {
  const late = [null, ...orbit('fff001', DOWNTOWN).slice(0, 2)];
  const pass = passes(orbit('fff002', NEARBY), late);
  assert.deepEqual(detectOrbits(pass, AC).map((o) => o.icao24), ['fff002']);
});

test('a textbook orbit over an excluded airport is thrown away — the pattern is the main false positive', () => {
  const shape = detectOrbits(passes(orbit('ggg001', LAX)), { ...AC, airportExclusionKm: 0 });
  assert.equal(shape.length, 1, 'it IS an orbit by shape — the exclusion is what removes it');
  assert.deepEqual(detectOrbits(passes(orbit('ggg001', LAX)), AC), []);
});

test('one pass is not a measurement', () => {
  assert.deepEqual(detectOrbits([orbit('hhh001', DOWNTOWN)[0] ? [orbit('hhh001', DOWNTOWN)[0]] : []], AC), []);
  assert.deepEqual(detectOrbits([], AC), []);
  assert.deepEqual(detectOrbits(null, AC), []);
});

test('an aircraft that reported neither altitude nor speed is not judged', () => {
  assert.deepEqual(detectOrbits(passes(orbit('iii001', DOWNTOWN, { altM: null, spdMs: null })), AC), []);
});

// ── clusterOrbits ────────────────────────────────────────────────────────────

/** Orbit records as `detectOrbits` returns them, placed by hand. */
const at = (icao24, p) => ({ icao24, callsign: '', lat: p.lat, lon: p.lon, altM: 400, spdMs: 40, fixes: 3 });

test('two aircraft circling 3 km apart are ONE cluster — the measured background for this is zero', () => {
  const clusters = clusterOrbits([at('a', DOWNTOWN), at('b', NEARBY)], AC);
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].size, 2);
  assert.deepEqual(clusters[0].aircraft.sort(), ['a', 'b']);
  assert.ok(clusters[0].spreadKm > 2.9 && clusters[0].spreadKm < 3.2);
});

test('two aircraft circling 40 km apart are not a cluster — proximity IS the signal', () => {
  assert.deepEqual(clusterOrbits([at('a', DOWNTOWN), at('b', FAR)], AC), []);
});

test('a lone orbiter is never a cluster — 4-7 of them is the measured quiet-afternoon baseline', () => {
  assert.deepEqual(clusterOrbits([at('a', DOWNTOWN)], AC), []);
  assert.deepEqual(clusterOrbits([], AC), []);
  assert.deepEqual(clusterOrbits(null, AC), []);
});

test('single linkage chains along a freeway — three ships strung out are one incident', () => {
  const mid = offset(DOWNTOWN, 4, 0);
  const end = offset(DOWNTOWN, 8, 0);
  const clusters = clusterOrbits([at('a', DOWNTOWN), at('b', mid), at('c', end)], AC);
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].size, 3);
  assert.ok(clusters[0].spreadKm > AC.clusterKm, 'the ends are further apart than the radius, and still one cluster');
});

test('minCluster is honoured — raising it rejects a pair', () => {
  assert.deepEqual(clusterOrbits([at('a', DOWNTOWN), at('b', NEARBY)], { ...AC, minCluster: 3 }), []);
});

test('clusters are returned largest first', () => {
  const far2 = offset(FAR, 2, 0);
  const far3 = offset(FAR, 4, 0);
  const clusters = clusterOrbits(
    [at('a', DOWNTOWN), at('b', NEARBY), at('c', FAR), at('d', far2), at('e', far3)],
    AC,
  );
  assert.deepEqual(clusters.map((c) => c.size), [3, 2]);
});

// ── the evidence channel ─────────────────────────────────────────────────────

/** The roster is PRIVATE (CLAUDE.md), so these orgs are invented. */
const ORGS = [
  { id: 'org1', name: 'Org One', channelId: 'UC-org1', streamClass: 'chopper' },
  { id: 'org2', name: 'Org Two', channelId: 'UC-org2', streamClass: 'newscast' },
];
const cfg = { ...config.chase, orgs: ORGS };
const VIDEO = { org1: 'eeee3333fff', org2: 'cccc2222ddd' };
const CHOPPER_CAM = '🔴LIVE: Chopper Camera';
const restingTitle = (org) => `LIVE: ${ORGS.find((o) => o.id === org).name} News`;

function sample(org, over = {}) {
  return {
    org,
    videoId: VIDEO[org],
    streamClass: ORGS.find((o) => o.id === org).streamClass,
    live: true,
    title: restingTitle(org),
    viewers: null,
    at: NOW,
    ...over,
  };
}

/** A state that already knows the stream (so a retitle is measurable) with a baseline. */
function baselined(org, { title = restingTitle(org), viewers = 200, count = 20 } = {}) {
  return {
    streams: { [VIDEO[org]]: { title, live: true, wentLiveAt: NOW - 6 * 3600_000, seenAt: NOW - MIN } },
    baselines: { [VIDEO[org]]: Array.from({ length: count }, (_, i) => [NOW - (count - i) * MIN, viewers]) },
  };
}

/** A reading with one qualifying cluster, taken `ageMs` before the tick. */
function reading(over = {}) {
  return {
    orbiting: [at('a', DOWNTOWN), at('b', NEARBY)],
    clusters: [{ size: 2, lat: DOWNTOWN.lat, lon: DOWNTOWN.lon, spreadKm: 3.01, aircraft: ['a', 'b'] }],
    samples: 3,
    rateRemaining: 371,
    at: NOW,
    ...over,
  };
}

test('a qualifying cluster scores in its OWN pseudo-org group, and in nobody else\'s', () => {
  const r = evaluateChase({
    samples: [sample('org2', { title: 'LIVE: Police pursuit downtown' })],
    aircraft: reading(),
    state: baselined('org2'),
    now: NOW,
    cfg,
  });
  assert.deepEqual(r.groups.aircraft, { score: AC.weight, channels: { aircraft: AC.weight }, vetoed: false });
  assert.deepEqual(r.groups.org2.channels, { title: 5 }, 'no aircraft channel inside a newsroom group');
  assert.equal(r.score, 5 + AC.weight, 'across groups there is no discount — 5 + 3');
});

test('aircraft alone scores NOTHING — a busy sky is not a chase', () => {
  // Two guarantees at once. The weight (3) is below the threshold (8) so it could not
  // open an incident even if it scored; and with nothing having NAMED a chase it does
  // not score at all. Aircraft orbiting one spot says "an event is happening there",
  // never which kind.
  let state = baselined('org2');
  for (let i = 0; i < 8; i += 1) {
    const now = NOW + i * MIN;
    const r = evaluateChase({ samples: [], aircraft: reading({ at: now }), state, now, cfg });
    assert.equal(r.score, 0, 'nothing named a chase, so the sky is irrelevant');
    assert.equal(r.groups.aircraft, undefined, 'no phantom group');
    assert.equal(r.opened, false);
    assert.equal(r.announce, null);
    state = r.state;
  }
  assert.ok(AC.weight < cfg.threshold, `weight ${AC.weight} must stay under threshold ${cfg.threshold}`);
});

test('corroboration PROMOTES the design\'s strictest near miss — 6.2 + 3 fires after dwell', () => {
  // Design §2.4 row 5: a newsroom writes "pursuit" but the audience only moves 3x.
  // 5 + 0.6*2 = 6.2, deliberately below threshold, because titles get reused and
  // mistyped. Independent aircraft evidence is exactly what that row was waiting for.
  let state = baselined('org2');
  const results = [];
  for (let i = 0; i < cfg.dwell; i += 1) {
    const now = NOW + i * MIN;
    const r = evaluateChase({
      samples: [sample('org2', { title: 'LIVE: Police pursuit on surface streets', viewers: 600, at: now })],
      aircraft: reading({ at: NOW }), // one reading, reused by later ticks — it is ~140s old by design
      state,
      now,
      cfg,
    });
    state = r.state;
    results.push(r);
  }
  const last = results[results.length - 1];
  assert.deepEqual(last.groups.org2.channels, { title: 5, audience: 2 });
  assert.equal(last.score, 9.2, '6.2 from the newsroom plus 3 from the sky');
  assert.ok(last.opened, 'it clears the threshold on the dwell-th poll');
  // And the announcement is still about a NEWSROOM — the aircraft group has no stream
  // and must never be the thing chat is pointed at.
  assert.equal(last.announce.incident.org, 'org2');
  assert.match(last.announce.text, /org two/i);
  assert.doesNotMatch(last.announce.text, /aircraft|orbit|helicopter/i);
});

test('without the aircraft reading that same tick stays below threshold', () => {
  let state = baselined('org2');
  for (let i = 0; i < cfg.dwell + 2; i += 1) {
    const now = NOW + i * MIN;
    const r = evaluateChase({
      samples: [sample('org2', { title: 'LIVE: Police pursuit on surface streets', viewers: 600, at: now })],
      state,
      now,
      cfg,
    });
    assert.equal(r.score, 6.2);
    assert.equal(r.opened, false);
    assert.equal(r.groups.aircraft, undefined, 'no reading means no group at all');
    state = r.state;
  }
});

test('a bare viewer spike plus aircraft does NOT fire — that shape is a brush fire', () => {
  // This was asserted the other way round, on the reasoning that "a spike alone is a
  // fire, a protest or a chase, and two aircraft circling one spot tells those apart."
  // It does not. News helicopters converge on a fire exactly as they do on a pursuit,
  // and a fire spikes an audience exactly as a pursuit does. Summing the two as if they
  // discriminated reached 8 and announced a police chase over a wildfire — and the live
  // logs contain that audience shape, from a named brush fire on 2026-10-03.
  //
  // Both observations are real. Neither is chase-SPECIFIC, which is what the threshold
  // is supposed to represent.
  let state = baselined('org1', { title: CHOPPER_CAM });
  let last = null;
  for (let i = 0; i < cfg.dwell + 2; i += 1) {
    const now = NOW + i * MIN;
    last = evaluateChase({
      samples: [sample('org1', { title: 'LIVE: Bouquet Fire near Santa Clarita', viewers: 12_000, at: now })],
      aircraft: reading({ at: now }),
      state,
      now,
      cfg,
    });
    state = last.state;
  }
  assert.deepEqual(last.groups.org1.channels, { audience: 5 }, 'the spike is real and still scores');
  assert.equal(last.groups.aircraft, undefined, 'but nothing named a chase, so aircraft adds nothing');
  assert.equal(last.score, 5);
  assert.equal(last.opened, false);
  assert.equal(last.announce, null);
});

test('the same spike DOES fire once something names a chase', () => {
  // The gate costs no recall: every genuine-chase path names one, and those are exactly
  // the cases aircraft still reinforces.
  let state = baselined('org1', { title: CHOPPER_CAM });
  let last = null;
  for (let i = 0; i < cfg.dwell + 2; i += 1) {
    const now = NOW + i * MIN;
    last = evaluateChase({
      samples: [sample('org1', { title: 'LIVE: Police pursuit on the freeway', viewers: 12_000, at: now })],
      aircraft: reading({ at: now }),
      state,
      now,
      cfg,
    });
    state = last.state;
  }
  assert.equal(last.groups.aircraft.score, AC.weight, 'now it corroborates');
  assert.ok(last.score >= cfg.threshold);
  assert.ok(last.opened || last.state.incident, 'and it fires');
});

test('a stale reading scores 0 — the sky it measured is gone', () => {
  const now = NOW + AC.maxAgeMs + MIN;
  const r = evaluateChase({ samples: [], aircraft: reading({ at: NOW }), state: null, now, cfg });
  assert.equal(r.score, 0);
  assert.equal(r.groups.aircraft, undefined);
});

test('a reading dated into the future scores 0 rather than scoring forever', () => {
  const r = evaluateChase({ samples: [], aircraft: reading({ at: NOW + 10 * MIN }), state: null, now: NOW, cfg });
  assert.equal(r.score, 0);
});

test('an absent, unmeasurable or clusterless reading all score 0 — nothing is guessed', () => {
  const cases = {
    'no reading at all': null,
    'not an object': 'nope',
    'one surviving pass': reading({ samples: 1 }),
    'no passes at all': reading({ samples: 0, clusters: [], orbiting: [] }),
    'no timestamp': reading({ at: null }),
    'lone orbiters, no cluster': reading({ clusters: [] }),
    'a cluster below minCluster': reading({ clusters: [{ size: 1 }] }),
    'a garbled cluster': reading({ clusters: [{ size: 'two' }] }),
  };
  for (const [name, aircraft] of Object.entries(cases)) {
    const r = evaluateChase({ samples: [], aircraft, state: null, now: NOW, cfg });
    assert.equal(r.score, 0, name);
    assert.equal(r.groups.aircraft, undefined, name);
  }
});

test('the channel can be switched off without touching the evaluator', () => {
  const r = evaluateChase({
    samples: [],
    aircraft: reading(),
    state: null,
    now: NOW,
    cfg: { ...cfg, aircraft: { ...AC, enabled: false } },
  });
  assert.equal(r.score, 0);
});

test('evaluateChase stays PURE over the reading — it is cached and reused by later ticks', () => {
  const input = reading();
  const snapshot = JSON.parse(JSON.stringify(input));
  const state = baselined('org2');
  const stateSnapshot = JSON.parse(JSON.stringify(state));
  evaluateChase({ samples: [sample('org2')], aircraft: input, state, now: NOW, cfg });
  assert.deepEqual(input, snapshot, 'the cached reading must survive being scored');
  assert.deepEqual(state, stateSnapshot);
});

// ── sampleAircraft, through the fetch seam ───────────────────────────────────

/** A fetch-shaped response carrying `states` and the rate-limit header. */
function respond(states, { status = 200, rateRemaining = '371' } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (h) => (String(h).toLowerCase() === 'x-rate-limit-remaining' ? rateRemaining : null) },
    json: async () => ({ time: Math.floor(NOW / 1000), states }),
  };
}

/** The same two orbiting aircraft, as the API would send them, pass by pass. */
function wirePasses() {
  const a = orbit('aaa001', DOWNTOWN);
  const b = orbit('aaa002', NEARBY);
  const straight = transit('aaa003', FAR);
  return passes(a, b, straight).map((pass) => pass.map((f) => {
    const r = new Array(17).fill(null);
    [r[0], r[1], r[5], r[6], r[8], r[9], r[10], r[13]] = [f.icao24, 'N123AB', f.lon, f.lat, false, f.spdMs, f.trackDeg, f.altM];
    return r;
  }));
}

test('aircraftReady is true in a runtime with fetch, and whenever the seam is installed', () => {
  assert.equal(aircraftReady(), true);
});

test('sampleAircraft takes N passes, finds the cluster, and reports the rate limit', async (t) => {
  const wire = wirePasses();
  const urls = [];
  initAircraftWith(async (url) => { urls.push(url); return respond(wire[urls.length - 1] || []); });
  t.after(() => initAircraftWith(null));

  const r = await sampleAircraft({ ...AC, sampleGapMs: 0 }, { warn() {}, info() {} });
  assert.equal(urls.length, AC.samples, 'one call per sample — this is what the daily cap counts');
  assert.match(urls[0], /^https:\/\/opensky-network\.org\/api\/states\/all\?/);
  assert.match(urls[0], /lamin=33\.6&lomin=-118\.8&lamax=34\.4&lomax=-117\.4/);
  assert.equal(r.samples, AC.samples);
  assert.equal(r.rateRemaining, 371, 'logged on every pass — it is the only view of the ~400/day budget');
  assert.deepEqual(r.orbiting.map((o) => o.icao24).sort(), ['aaa001', 'aaa002'], 'the transit is not an orbit');
  assert.equal(r.clusters.length, 1);
  assert.equal(r.clusters[0].size, 2);
  assert.ok(Number.isFinite(r.at) && Number.isFinite(r.tookMs));
});

test('the bounding box is configurable and goes on the wire verbatim', async (t) => {
  let seen = '';
  initAircraftWith(async (url) => { seen = url; return respond([]); });
  t.after(() => initAircraftWith(null));
  await sampleAircraft({ ...AC, samples: 2, sampleGapMs: 0, bbox: { lamin: 1, lomin: 2, lamax: 3, lomax: 4 } }, { warn() {} });
  assert.match(seen, /lamin=1&lomin=2&lamax=3&lomax=4/);
});

test('a network that is on fire never throws, and reports a reading of nothing', async (t) => {
  const warnings = [];
  initAircraftWith(async () => { throw new Error('ECONNRESET ...states/all'); });
  t.after(() => initAircraftWith(null));

  const r = await sampleAircraft({ ...AC, sampleGapMs: 0 }, { warn: (m) => warnings.push(m) });
  assert.deepEqual({ orbiting: r.orbiting, clusters: r.clusters, samples: r.samples }, { orbiting: [], clusters: [], samples: 0 });
  assert.equal(warnings.length, AC.samples, 'each failed pass is logged on its own');
  // And that reading scores nothing, rather than reading as "the sky is empty".
  assert.equal(evaluateChase({ samples: [], aircraft: r, state: null, now: r.at, cfg }).score, 0);
});

test('a rejected call is logged with its status and costs the tick nothing', async (t) => {
  const warnings = [];
  initAircraftWith(async () => respond([], { status: 429, rateRemaining: '0' }));
  t.after(() => initAircraftWith(null));

  const r = await sampleAircraft({ ...AC, samples: 2, sampleGapMs: 0 }, { warn: (m, d) => warnings.push(d) });
  assert.equal(r.samples, 0);
  assert.equal(r.rateRemaining, 0, 'the budget being gone is exactly what we want in the log');
  assert.deepEqual(warnings.map((w) => w.status), [429, 429]);
});

test('one usable pass out of three is still not a measurement', async (t) => {
  const wire = wirePasses();
  let n = 0;
  initAircraftWith(async () => { n += 1; return n === 1 ? respond(wire[0]) : respond([], { status: 503 }); });
  t.after(() => initAircraftWith(null));

  const r = await sampleAircraft({ ...AC, sampleGapMs: 0 }, { warn() {} });
  assert.equal(r.samples, 1);
  assert.deepEqual(r.orbiting, [], 'an orbit cannot be seen in one snapshot');
});

test('a garbled response body is a failed pass, not a crash', async (t) => {
  initAircraftWith(async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => { throw new Error('invalid json'); },
  }));
  t.after(() => initAircraftWith(null));
  const r = await sampleAircraft({ ...AC, samples: 2, sampleGapMs: 0 }, { warn() {} });
  assert.equal(r.samples, 0);
  assert.equal(r.rateRemaining, null);
});

test('sampleAircraft tolerates a logger that is not one, and a missing config', async (t) => {
  initAircraftWith(async () => respond([]));
  t.after(() => initAircraftWith(null));
  const r = await sampleAircraft({ samples: 2, sampleGapMs: 0 }, null);
  assert.equal(r.samples, 0);
  assert.deepEqual(r.clusters, []);
});

// ── what counts as "naming a chase" ─────────────────────────────────────────
// The gate is the whole reason this source is safe to add, so the set of things
// that satisfy it is itself worth pinning down.

test('an ARTICLE naming a pursuit satisfies the gate', () => {
  // The most explicit naming available anywhere in the design: a newsroom wrote
  // the word. The fetcher already admits only strong-vocabulary items, but the
  // evaluator re-checks, so this holds even if a caller hands over a raw feed.
  const r = evaluateChase({
    samples: [sample('org2', { viewers: 200 })], // resting title, no spike
    articles: [{ org: 'org2', title: 'Police pursuit underway in South LA', publishedAt: NOW - MIN }],
    aircraft: reading(),
    state: baselined('org2'),
    now: NOW,
    cfg,
  });
  assert.equal(r.groups.aircraft.score, AC.weight);
  assert.deepEqual(r.groups.org2.channels, { editorial: 2 });
  // 2 + 3 = 5, and still silent: a lagging article plus a busy sky is corroboration
  // of each other, not of an emergency. The gate opens the channel; it does not
  // lower the threshold.
  assert.equal(r.score, 5);
  assert.equal(r.opened, false);
});

test('an article + a real spike + aircraft fires where the article alone could not', () => {
  // The recall this wiring buys. Without the article satisfying the gate this is
  // 5 + 0.6·2 = 6.2 and silent; with it, 6.2 + 3 = 9.2 and it fires. A newsroom
  // writing "pursuit underway" WHILE its own stream takes an 8x spike is not an
  // ambiguous shape.
  let state = baselined('org2');
  let last = null;
  for (let i = 0; i < cfg.dwell + 2; i += 1) {
    const now = NOW + i * MIN;
    last = evaluateChase({
      samples: [sample('org2', { viewers: 1_600, at: now })], // 8x the 200 baseline
      articles: [{ org: 'org2', title: 'Police pursuit underway in South LA', publishedAt: now - MIN }],
      aircraft: reading({ at: now }),
      state,
      now,
      cfg,
    });
    state = last.state;
  }
  assert.deepEqual(last.groups.org2.channels, { audience: 5, editorial: 2 });
  assert.equal(last.groups.aircraft.score, AC.weight);
  assert.equal(last.score, 9.2);
  assert.ok(last.opened || last.state.incident, 'must fire');
});

test('a RECAP article does not satisfy the gate — negative markers win', () => {
  const r = evaluateChase({
    samples: [sample('org2', { viewers: 200 })],
    articles: [{ org: 'org2', title: 'RAW VIDEO: police pursuit ends in crash', publishedAt: NOW - MIN }],
    aircraft: reading(),
    state: baselined('org2'),
    now: NOW,
    cfg,
  });
  assert.equal(r.groups.aircraft, undefined, 'a recap names a PAST chase, which the sky cannot corroborate');
  assert.equal(r.score, 0);
});

test('a STANDING chase title names a chase even though it scores no title points', () => {
  // These are two different questions and the gate must not conflate them. The
  // `title` channel needs the title to have CHANGED (scoring a permanent one
  // forever is the §2.1 error). The gate only asks whether the words are there.
  // A chopper cam parked under a permanent "pursuit" title therefore scores 0
  // for `title` and still lets the sky corroborate it.
  const standing = 'LIVE: Police pursuit coverage';
  const r = evaluateChase({
    samples: [sample('org1', { title: standing, viewers: 200 })],
    aircraft: reading(),
    state: baselined('org1', { title: standing }), // already resting there — no change
    now: NOW,
    cfg,
  });
  assert.deepEqual(r.groups.org1.channels, {}, 'the title scores nothing: it did not change');
  assert.equal(r.groups.org1.score, 0);
  assert.equal(r.groups.aircraft.score, AC.weight, 'but it did NAME a chase');
  assert.equal(r.score, AC.weight);
  assert.equal(r.opened, false, 'and 3 is still under 8, so nothing fires on this alone');
});

test('an OFFLINE stream carrying chase vocabulary does not satisfy the gate', () => {
  // A dark stream's leftover title describes the last thing it covered, which is
  // the retrospective trap in a different costume.
  const r = evaluateChase({
    samples: [sample('org2', { title: 'LIVE: Police pursuit downtown', live: false, viewers: null })],
    aircraft: reading(),
    state: baselined('org2'),
    now: NOW,
    cfg,
  });
  assert.equal(r.groups.aircraft, undefined);
  assert.equal(r.score, 0);
});
