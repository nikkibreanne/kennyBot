// AIRCRAFT OVERHEAD — the one genuinely independent evidence source in this design.
//
// "Birds in the air" is scanner slang for aircraft overhead, and it is the thing a
// pursuit physically does to the sky: news helicopters and police aircraft converge
// on one moving location and ORBIT it. Every other source this monitor has is a
// newsroom — a title, a viewer count, an article, a going-live — which means every
// other source is ultimately one editorial decision observed from several angles
// (docs/chase-monitor-design.md §2.1). This one is not editorial at all. It is ADS-B
// transponder data: aircraft reporting their own position, with no newsroom in the
// loop.
//
// WHY A CLUSTER AND NOT A COUNT. Measured against the live OpenSky API over the LA
// basin with nothing happening (three 70s-spaced samples):
//
//     ~98 airborne aircraft in the box
//     ~38 low (<1500 m) and slow (3-60 m/s)
//     ~22 after excluding 8 km around the 18 basin airports
//     4-7 ORBITING by the test below
//     0   PAIRS of orbiting aircraft within 15 km of each other
//
// The background rate of a CLUSTER is zero. That is the entire reason this works as
// a signal: a lone orbiting aircraft over LA is unremarkable (traffic reporters,
// sightseeing, police patrol, a photo flight), while two aircraft circling the same
// patch of ground is not a thing that happens for no reason. The count of orbiters
// is not the signal; their mutual PROXIMITY is.
//
// CORROBORATION ONLY, structurally. `chase.aircraft.weight` (3) sits below
// `chase.threshold` (8), so a cluster can never fire an announcement by itself — and
// it cannot even nominate one, because an announcement needs a stream to link to and
// this source has none. It scores in its OWN pseudo-org group (`aircraft` in
// src/rules/chase.js), which is both conceptually right — aircraft overhead are not
// a property of any newsroom — and keeps the one-signal-per-channel-per-org rule
// intact rather than smuggling a second score into some station's group.
//
// COST. The endpoint is free and needs no key and no account. Anonymous access is
// rate limited at roughly 400 calls/day, reported in `x-rate-limit-remaining`, which
// is logged on every run. One reading costs `samples` calls (3), so the scheduler
// spends it only ON SUSPICION, behind a cooldown and a daily cap — see
// src/events/chaseMonitor.js.
//
// NOTHING here throws, same contract as chaseSources.js: a dead API degrades the
// score by one channel. A reading that could not be taken is reported as `samples: 0`
// and the evaluator scores it 0 rather than guessing.
//
// PRIVACY (CLAUDE.md): aircraft registrations and callsigns are public FAA/ADS-B data
// and are read straight off the wire here, but NO tail number or callsign is
// hardcoded anywhere in this file — a list of news-helicopter registrations would
// identify the outlets and belongs in the private roster, not in a public repo. The
// callsign is carried on a reading because the on-disk chase log is operator data and
// calibration needs to know whether an orbiter was a news ship or a police one; it is
// never put in a chat reply and never in a repo file.
import { setTimeout as delay } from 'node:timers/promises';

const STATES_URL = 'https://opensky-network.org/api/states/all';
const HTTP_TIMEOUT_MS = 15_000;

/**
 * The 18 basin airports whose traffic patterns are the main false-positive source:
 * an aircraft in the pattern is low, slow, and turning — which is exactly the orbit
 * test below. Public idents and published coordinates; nothing here identifies any
 * news organization. Verified 2026-10-06 to cover the box in `chase.aircraft.bbox`.
 * @type {Array<[string, number, number]>} ident, lat, lon
 */
const AIRPORTS = [
  ['LAX', 33.9416, -118.4085], ['BUR', 34.2007, -118.3587], ['VNY', 34.2098, -118.4898],
  ['LGB', 33.8177, -118.1516], ['SNA', 33.6757, -117.8682], ['ONT', 34.0560, -117.6012],
  ['HHR', 33.9228, -118.3351], ['SMO', 34.0158, -118.4513], ['WHP', 34.2593, -118.4134],
  ['EMT', 34.0860, -118.0350], ['FUL', 33.8720, -117.9798], ['TOA', 33.8034, -118.3396],
  ['CNO', 33.9747, -117.6366], ['POC', 34.0916, -117.7817], ['AJO', 33.8977, -117.6025],
  ['CCB', 34.1116, -117.6879], ['RAL', 33.9519, -117.4450], ['SBD', 34.0954, -117.2350],
  // Catalina. Only inside the box since `bbox.lamin` moved south to cover Orange
  // County, and the island runs a steady helicopter shuttle — without this, that
  // traffic is low, at road speed and travelling in a line, which is exactly the
  // pursuit signature.
  ['AVX', 33.4049, -118.4157],
];

/** `states/all` column indices. The API returns bare positional arrays. */
const I = {
  icao24: 0, callsign: 1, lon: 5, lat: 6, baroAlt: 7,
  onGround: 8, velocity: 9, track: 10, geoAlt: 13,
};

const num = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
const numOrNull = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const round = (n, places) => { const p = 10 ** places; return Math.round(n * p) / p; };

/** Test seam: `fn(url, init)` replaces fetch. */
let fakeFetch = null;
const http = (url, init) => (fakeFetch ? fakeFetch(url, init) : fetch(url, init));

/**
 * Test seam, mirroring `initChaseSourcesWith`. Pass a `fetch`-shaped function to
 * intercept every request, or `null` to go back to the real one.
 * @param {((url: string, init?: object) => Promise<any>)|null} fn
 */
export function initAircraftWith(fn) {
  fakeFetch = fn || null;
}

/**
 * Whether this source can be polled at all. There is no credential — the endpoint is
 * anonymous — so this really asks "is there a usable fetch in this runtime".
 */
export function aircraftReady() {
  return Boolean(fakeFetch) || typeof fetch === 'function';
}

/**
 * Great-circle distance in km. Four scalars rather than two points, because every
 * caller here already has the components loose and packing them into objects to
 * unpack them again is noise.
 * @param {number} lat1 @param {number} lon1 @param {number} lat2 @param {number} lon2
 * @returns {number} km, or NaN if any argument is not a finite number
 */
export function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = Math.PI / 180;
  const [a, b, c, d] = [lat1, lon1, lat2, lon2].map(Number);
  if (![a, b, c, d].every(Number.isFinite)) return NaN;
  const dLat = (c - a) * toRad;
  const dLon = (d - b) * toRad;
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(a * toRad) * Math.cos(c * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * One aircraft at one instant.
 * @typedef {object} AircraftFix
 * @property {string} icao24     - the transponder's permanent 24-bit address (the tracking key)
 * @property {string} callsign   - as broadcast; often blank
 * @property {number} lat
 * @property {number} lon
 * @property {number|null} altM  - geo_altitude, falling back to baro_altitude
 * @property {number|null} spdMs - velocity, m/s
 * @property {number|null} trackDeg - true_track, degrees
 * @property {number} at         - ms epoch
 */

/**
 * One aircraft judged to be orbiting, over the whole sample window.
 * @typedef {object} Orbit
 * @property {string} icao24
 * @property {string} callsign
 * @property {number} lat        - the ORBIT CENTROID, not the last fix (see detectOrbits)
 * @property {number} lon
 * @property {number} altM       - mean altitude over the window
 * @property {number} spdMs      - mean speed over the window
 * @property {number} netKm      - great-circle first fix -> last fix
 * @property {number} pathKm     - summed leg distances
 * @property {number} turnDeg    - summed absolute heading change
 * @property {number} loiter     - netKm / pathKm; 0 is a perfect hold, 1 is a straight line
 * @property {number} fixes      - how many samples this aircraft appeared in
 */

/**
 * A `states/all` response -> AircraftFix[]. PURE.
 *
 * Positional arrays, so the indices in `I` are the schema. An aircraft `on_ground` is
 * dropped (a taxiing jet is low, slow and turning — the orbit test's worst enemy), as
 * is anything without a usable position. A missing altitude or velocity stays NULL
 * rather than becoming 0: 0 m is sea level and 0 m/s is a hover, and both would be
 * read as facts by the test below.
 *
 * @param {any} json
 * @param {number} [now] - stamped onto every fix; injectable for tests
 * @returns {AircraftFix[]}
 */
export function parseStates(json, now = Date.now()) {
  const rows = Array.isArray(json?.states) ? json.states : [];
  const out = [];
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    if (row[I.onGround] === true) continue;
    const icao24 = String(row[I.icao24] ?? '').trim().toLowerCase();
    const lat = numOrNull(row[I.lat]);
    const lon = numOrNull(row[I.lon]);
    if (!icao24 || lat == null || lon == null) continue;
    out.push({
      icao24,
      callsign: String(row[I.callsign] ?? '').trim(),
      lat,
      lon,
      altM: numOrNull(row[I.geoAlt]) ?? numOrNull(row[I.baroAlt]),
      spdMs: numOrNull(row[I.velocity]),
      trackDeg: numOrNull(row[I.track]),
      at: num(now, Date.now()),
    });
  }
  return out;
}

/** Signed heading change, wrapped into (-180, 180]. 350 -> 010 is +20, not -340. */
function headingDelta(from, to) {
  let d = (Number(to) - Number(from)) % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

/** Is this position inside the exclusion radius of a basin airport? */
function nearAirport(lat, lon, km) {
  if (!(km > 0)) return false;
  return AIRPORTS.some(([, alat, alon]) => haversineKm(lat, lon, alat, alon) <= km);
}

/**
 * `icao24 -> one fix per pass, in order`, keeping only aircraft seen in EVERY pass.
 *
 * Shared by both detectors because "the same aircraft across time" is the
 * measurement, and the two differ only in what shape they then look for.
 * @param {AircraftFix[][]} passes
 * @returns {Map<string, AircraftFix[]>}
 */
function buildTracks(passes) {
  /** @type {Map<string, AircraftFix[]>} */
  const tracks = new Map();
  for (const [i, pass] of passes.entries()) {
    const seen = new Set();
    for (const fix of pass) {
      const id = String(fix?.icao24 ?? '');
      if (!id || seen.has(id)) continue; // one fix per aircraft per pass
      // Present in ALL passes means present in every pass SO FAR, so an aircraft
      // first seen in pass 2 can never catch up and is dropped without bookkeeping.
      seen.add(id);
      if (i === 0) tracks.set(id, [fix]);
      else if (tracks.get(id)?.length === i) tracks.get(id).push(fix);
    }
  }
  return tracks;
}

/**
 * The geometry of one track, or null if it cannot be judged.
 *
 * `loiter` is net displacement over path length and is the whole discriminator
 * between the two shapes this module looks for: near 0 the aircraft went nowhere
 * (it is circling something), near 1 it travelled in a line (it is going
 * somewhere, or following something that is).
 * @param {AircraftFix[]} track
 */
function trackGeometry(track) {
  const alts = track.map((f) => numOrNull(f.altM)).filter((v) => v != null);
  const spds = track.map((f) => numOrNull(f.spdMs)).filter((v) => v != null);
  // An aircraft that reported neither cannot be judged, so it is not judged.
  if (!alts.length || !spds.length) return null;

  let pathKm = 0;
  let turnDeg = 0;
  for (let i = 1; i < track.length; i += 1) {
    const a = track[i - 1];
    const b = track[i];
    const leg = haversineKm(a.lat, a.lon, b.lat, b.lon);
    if (Number.isFinite(leg)) pathKm += leg;
    if (a.trackDeg != null && b.trackDeg != null) turnDeg += Math.abs(headingDelta(a.trackDeg, b.trackDeg));
  }
  if (!(pathKm > 0)) return null;
  const last = track[track.length - 1];
  const netKm = haversineKm(track[0].lat, track[0].lon, last.lat, last.lon);
  if (!Number.isFinite(netKm)) return null;

  return {
    avgAlt: alts.reduce((a, b) => a + b, 0) / alts.length,
    avgSpd: spds.reduce((a, b) => a + b, 0) / spds.length,
    pathKm,
    turnDeg,
    netKm,
    loiter: netKm / pathKm,
    lat: track.reduce((a, f) => a + f.lat, 0) / track.length,
    lon: track.reduce((a, f) => a + f.lon, 0) / track.length,
  };
}

/**
 * Which aircraft were ORBITING across these samples. PURE.
 *
 * Takes N passes (each an AircraftFix[]), tracks by `icao24`, and keeps only aircraft
 * present in EVERY pass — an aircraft that drifted in or out of the box, or that the
 * network lost, cannot be measured and is not guessed at. Then, over that aircraft's
 * track:
 *
 *   net   = great-circle distance from the first fix to the last
 *   path  = sum of the leg distances
 *   turn  = sum of |heading change| between consecutive fixes
 *
 *   orbiting  <=>  avgAlt < altMaxM  AND  avgSpd < spdMaxMs  AND  path > 0
 *                  AND net/path < loiterMax  AND  turn > turnMinDeg
 *
 * `net/path` is the loiter ratio: a straight transit has net == path and scores 1, a
 * closed circle returns to where it started and scores ~0. The turn floor is what
 * separates a circle from a slow aircraft that simply did not get far — a holding
 * pattern turns through hundreds of degrees. `path > 0` is also the lower speed bound:
 * the measured funnel pre-filtered 3-60 m/s, and an aircraft that did not move at all
 * is a stale or garbled position report, not a hover.
 *
 * Measured: 82 tracked aircraft -> 4-7 orbiting.
 *
 * The AIRPORT EXCLUSION is applied here, to the orbit CENTROID, because the pattern
 * at a busy airport produces textbook orbits by the test above and is by far the
 * largest false-positive source (~38 candidates -> ~22 with it).
 *
 * The centroid — not the last fix — is also what a cluster is measured on: for an
 * aircraft holding over something, the mean of its track is the point it is circling,
 * and "two aircraft circling the same spot" is the actual claim being made.
 *
 * @param {AircraftFix[][]} samples - one array per pass, in time order
 * @param {object} [cfg] - config.chase.aircraft
 * @returns {Orbit[]}
 */
export function detectOrbits(samples, cfg = {}) {
  const passes = (Array.isArray(samples) ? samples : []).filter((p) => Array.isArray(p));
  // Two fixes are the arithmetic minimum: one leg, one heading change, one net.
  if (passes.length < 2) return [];

  const altMaxM = num(cfg?.altMaxM, 1200);
  const spdMaxMs = num(cfg?.spdMaxMs, 60);
  const loiterMax = num(cfg?.loiterMax, 0.4);
  const turnMinDeg = num(cfg?.turnMinDeg, 60);
  const airportKm = num(cfg?.airportExclusionKm, 8);

  const tracks = buildTracks(passes);

  const out = [];
  for (const [icao24, track] of tracks) {
    if (track.length !== passes.length) continue;
    const g = trackGeometry(track);
    if (!g) continue;
    if (!(g.avgAlt < altMaxM) || !(g.avgSpd < spdMaxMs)) continue;
    if (!(g.loiter < loiterMax) || !(g.turnDeg > turnMinDeg)) continue;
    if (nearAirport(g.lat, g.lon, airportKm)) continue;

    out.push({
      icao24,
      callsign: track[track.length - 1].callsign || '',
      lat: round(g.lat, 4),
      lon: round(g.lon, 4),
      altM: Math.round(g.avgAlt),
      spdMs: round(g.avgSpd, 1),
      netKm: round(g.netKm, 2),
      pathKm: round(g.pathKm, 2),
      turnDeg: Math.round(g.turnDeg),
      loiter: round(g.loiter, 3),
      fixes: track.length,
    });
  }
  // Tightest hold first, and icao24 to make the order deterministic for a test.
  out.sort((a, b) => a.loiter - b.loiter || a.icao24.localeCompare(b.icao24));
  return out;
}

/**
 * Group orbiting aircraft that are circling the same place. PURE.
 *
 * Single-linkage within `clusterKm` of the orbit centroids: A joins B's cluster if it
 * is within the radius of ANY member, because three helicopters strung out along a
 * freeway are all on the same incident even when the two ends are further apart than
 * the radius. Only clusters of at least `minCluster` are returned — a lone orbiter is
 * the measured background (4-7 of them, all the time) and is not evidence of
 * anything.
 *
 * @param {Orbit[]} orbiting
 * @param {object} [cfg] - config.chase.aircraft
 * @returns {Array<{size: number, lat: number, lon: number, spreadKm: number, aircraft: string[]}>}
 */
export function clusterOrbits(orbiting, cfg = {}, linkable = null) {
  const birds = (Array.isArray(orbiting) ? orbiting : [])
    .filter((o) => o && Number.isFinite(Number(o.lat)) && Number.isFinite(Number(o.lon)));
  const clusterKm = num(cfg?.clusterKm, 5);
  const minCluster = Math.max(2, Math.round(num(cfg?.minCluster, 2)));
  if (birds.length < minCluster) return [];

  // Union-find, which is what single linkage is.
  const parent = birds.map((_, i) => i);
  const find = (i) => { let r = i; while (parent[r] !== r) r = parent[r]; parent[i] = r; return r; };
  for (let i = 0; i < birds.length; i += 1) {
    for (let j = i + 1; j < birds.length; j += 1) {
      const d = haversineKm(birds[i].lat, birds[i].lon, birds[j].lat, birds[j].lon);
      if (!Number.isFinite(d) || d > clusterKm) continue;
      if (linkable && !linkable(birds[i], birds[j])) continue;
      parent[find(i)] = find(j);
    }
  }

  /** @type {Map<number, number[]>} */
  const groups = new Map();
  for (let i = 0; i < birds.length; i += 1) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(i);
  }

  const out = [];
  for (const members of groups.values()) {
    if (members.length < minCluster) continue;
    const pts = members.map((i) => birds[i]);
    const lat = pts.reduce((a, p) => a + Number(p.lat), 0) / pts.length;
    const lon = pts.reduce((a, p) => a + Number(p.lon), 0) / pts.length;
    let spreadKm = 0;
    for (let i = 0; i < pts.length; i += 1) {
      for (let j = i + 1; j < pts.length; j += 1) {
        const d = haversineKm(pts[i].lat, pts[i].lon, pts[j].lat, pts[j].lon);
        if (Number.isFinite(d)) spreadKm = Math.max(spreadKm, d);
      }
    }
    out.push({
      size: pts.length,
      lat: round(lat, 4),
      lon: round(lon, 4),
      spreadKm: round(spreadKm, 2),
      aircraft: pts.map((p) => String(p.icao24)),
    });
  }
  out.sort((a, b) => b.size - a.size || a.spreadKm - b.spreadKm);
  return out;
}

/**
 * A PURSUIT, which is the shape an orbit test cannot see.
 *
 * This exists because the orbit detector missed a real, televised, 44-minute CHP
 * pursuit on 2026-10-09 — and not by a narrow margin. While a chase is actually
 * running, the helicopter covering it is not circling anything: it is following a
 * car down a freeway. Measured against that event's route (the 405 through
 * Huntington Beach, then the 5 at Irvine), a tracking aircraft's `loiter` sits
 * near 0.9 against the orbit test's `< 0.4`, and a freeway is straight so its
 * cumulative `turnDeg` stays near 0 against a required `> 60`. It fails both
 * shape tests by design, not by tuning.
 *
 * Orbiting is what happens when a chase ENDS — the suspect bails, or stops, and
 * the aircraft holds over one spot. That is a real and useful signal, and
 * `detectOrbits` keeps it. But it is the tail of the event, and the useful moment
 * is the pursuit itself.
 *
 * So this looks for the opposite geometry: low, moving at road speed, and
 * actually covering ground in a line.
 *
 *   altitude  < `altMaxM`             — shared with orbits; airliners are excluded
 *   speed     `pursuitSpdMinMs`..Max  — road speed. Below is loitering, above is transit
 *   loiter    > `pursuitLoiterMin`    — went somewhere, rather than nowhere
 *   path      >= `pursuitMinPathKm`   — and covered real ground doing it
 *
 * One aircraft matching that is unremarkable — it is also what a news helicopter
 * flying home looks like. The discriminator is the CLUSTER (`clusterPursuits`):
 * two or more of them low, at road speed, close together and not heading in
 * opposing directions. That is a convoy, and media aircraft form one over a
 * pursuit. Its background rate is UNMEASURED, which is why the aircraft weight
 * stays below the threshold and gated — this widens what the channel can see, it
 * does not promote it to a detector.
 *
 * Airport vicinity is excluded at BOTH endpoints rather than the midpoint: an
 * aircraft on approach is low, at moderate speed and travelling in a line, which
 * is this exact signature, and its midpoint can sit well outside the exclusion
 * radius while both ends are inside it.
 *
 * @param {AircraftFix[][]} samples one array of fixes per pass, in order
 * @param {object} [cfg] `config.chase.aircraft`
 * @returns {object[]} one entry per aircraft that is tracking something
 */
export function detectPursuits(samples, cfg = {}) {
  const passes = (Array.isArray(samples) ? samples : []).filter((p) => Array.isArray(p));
  if (passes.length < 2) return [];

  const altMaxM = num(cfg?.altMaxM, 1200);
  const spdMinMs = num(cfg?.pursuitSpdMinMs, 18);
  const spdMaxMs = num(cfg?.pursuitSpdMaxMs, 75);
  const loiterMin = num(cfg?.pursuitLoiterMin, 0.6);
  const minPathKm = num(cfg?.pursuitMinPathKm, 2);
  const airportKm = num(cfg?.airportExclusionKm, 8);

  const tracks = buildTracks(passes);
  const out = [];
  for (const [icao24, track] of tracks) {
    if (track.length !== passes.length) continue;
    const g = trackGeometry(track);
    if (!g) continue;
    if (!(g.avgAlt < altMaxM)) continue;
    if (!(g.avgSpd >= spdMinMs) || !(g.avgSpd <= spdMaxMs)) continue;
    if (!(g.loiter > loiterMin)) continue;
    if (!(g.pathKm >= minPathKm)) continue;

    const first = track[0];
    const last = track[track.length - 1];
    if (nearAirport(first.lat, first.lon, airportKm)) continue;
    if (nearAirport(last.lat, last.lon, airportKm)) continue;

    out.push({
      icao24,
      callsign: last.callsign || '',
      // Where it is NOW, not the track mean: a moving aircraft's midpoint is
      // behind it, and the cluster is about where the event currently is.
      lat: round(last.lat, 4),
      lon: round(last.lon, 4),
      // ...and where it STARTED, which is what makes co-movement testable:
      // two aircraft following the same car stay close for the whole window,
      // while two crossing paths are close for one sample only.
      lat0: round(first.lat, 4),
      lon0: round(first.lon, 4),
      altM: Math.round(g.avgAlt),
      spdMs: round(g.avgSpd, 1),
      netKm: round(g.netKm, 2),
      pathKm: round(g.pathKm, 2),
      turnDeg: Math.round(g.turnDeg),
      loiter: round(g.loiter, 3),
      headingDeg: last.trackDeg == null ? null : Math.round(last.trackDeg),
      fixes: track.length,
    });
  }
  // Furthest travelled first — the strongest instance of "this is going somewhere".
  out.sort((a, b) => b.pathKm - a.pathKm || a.icao24.localeCompare(b.icao24));
  return out;
}

/**
 * Group tracking aircraft that are travelling TOGETHER.
 *
 * Proximity alone is nowhere near enough here, and this is the part that decides
 * whether the whole pursuit source is usable. An orbit cluster could lean on
 * proximity because its measured background rate was ZERO — two aircraft circling
 * one spot essentially does not happen by chance. A pursuit cluster cannot: LA has
 * busy low-level helicopter corridors along the freeways and the coast, a live
 * sample holds roughly 15-20 aircraft that are low and at road speed, and "two of
 * them within 5 km heading roughly alike" is an ordinary Tuesday. Scored naively
 * that would hand a free +3 to any tick that merely named a chase.
 *
 * So a link requires co-movement, on three counts:
 *
 *   * close at the END of the window (where the event is now), AND
 *   * close at the START of it — two aircraft following the same vehicle stay
 *     together for the whole window, while two crossing paths are close for a
 *     single sample. This is the test that does the real work.
 *   * headings not opposed, within `pursuitHeadingTolDeg`.
 *
 * The heading tolerance stays loose (60 degrees) because aircraft over a pursuit
 * weave and cut corners while the group progresses; the both-ends proximity test
 * is what provides the precision, so this only has to reject oncoming traffic. An
 * aircraft reporting no heading is linked on proximity alone rather than dropped,
 * since the alternative is discarding a real convoy member over a missing field.
 *
 * Even so the background rate here is UNMEASURED, which is exactly why the
 * channel's weight stays below the threshold and behind the naming gate. The
 * calibration section of `chase:report` is what will settle it.
 * @param {object[]} pursuing output of `detectPursuits`
 * @param {object} [cfg]
 */
export function clusterPursuits(pursuing, cfg = {}) {
  const tol = num(cfg?.pursuitHeadingTolDeg, 60);
  const clusterKm = num(cfg?.pursuitClusterKm, num(cfg?.clusterKm, 5));
  const opts = { clusterKm, minCluster: num(cfg?.pursuitMinCluster, num(cfg?.minCluster, 2)) };
  return clusterOrbits(pursuing, opts, (a, b) => {
    const started = haversineKm(a.lat0, a.lon0, b.lat0, b.lon0);
    // A missing start position must not silently pass the test that provides the
    // precision — without it this is proximity-only, so refuse the link.
    if (!Number.isFinite(started) || started > clusterKm) return false;
    if (a.headingDeg == null || b.headingDeg == null) return true;
    return Math.abs(headingDelta(a.headingDeg, b.headingDeg)) <= tol;
  });
}

/** The bounding box query, with the configured basin box as the default. */
function statesUrl(cfg) {
  const box = cfg?.bbox && typeof cfg.bbox === 'object' ? cfg.bbox : {};
  const qs = new URLSearchParams({
    lamin: String(num(box.lamin, 33.6)),
    lomin: String(num(box.lomin, -118.8)),
    lamax: String(num(box.lamax, 34.4)),
    lomax: String(num(box.lomax, -117.4)),
  });
  return `${STATES_URL}?${qs}`;
}

/**
 * One aircraft READING: `samples` passes over the box, spaced `sampleGapMs`, reduced
 * to the orbiting aircraft and their clusters.
 *
 * NEVER THROWS. A pass that fails is skipped and the reading is taken from whatever
 * came back; if fewer than two passes survive there is no orbit arithmetic to do and
 * the reading is honestly empty with `samples` saying why. "We could not measure" is
 * reported as such, never as "nothing is happening".
 *
 * THIS IS SLOW ON PURPOSE — 3 passes x 70 s is ~140 s, which is longer than a monitor
 * tick. The caller must NOT await it inside a tick: start it, cache the resolved
 * reading, and let the NEXT tick score it (see src/events/chaseMonitor.js). The
 * reading carries `at` so the evaluator can reject one that has gone stale.
 *
 * @param {object} cfg - config.chase.aircraft
 * @param {any} [logger]
 * @returns {Promise<{orbiting: Orbit[], clusters: Array<object>, samples: number,
 *                    rateRemaining: number|null, at: number, tookMs: number}>}
 */
export async function sampleAircraft(cfg = {}, logger = console) {
  const startedAt = Date.now();
  const empty = (rateRemaining = null, samples = 0) => ({
    orbiting: [], clusters: [], pursuing: [], pursuitClusters: [],
    aircraftSeen: 0, tracked: 0,
    samples, rateRemaining, at: Date.now(), tookMs: Date.now() - startedAt,
  });
  try {
    if (!aircraftReady()) return empty();
    const wanted = Math.max(2, Math.round(num(cfg?.samples, 3)));
    const gapMs = Math.max(0, num(cfg?.sampleGapMs, 70_000));
    const url = statesUrl(cfg);

    /** @type {AircraftFix[][]} */
    const passes = [];
    let rateRemaining = null;
    for (let i = 0; i < wanted; i += 1) {
      // Between passes, never after the last one: the gap is what makes two passes
      // a measurement, and a trailing sleep only delays the answer.
      //
      // A REF'D timer, deliberately. An unref'd one looks tidier — "a run in flight
      // can never hold the process open" — but its real effect is that a run is
      // silently ABANDONED whenever nothing else happens to be keeping the event loop
      // alive, which is any one-off script or probe that calls this (measured: node
      // exited mid-sleep with `unsettled top-level await`). Shutdown is not the reason
      // to take that risk: index.js's signal path ends in `process.exit`, which kills
      // a pending timer regardless, and the monitor already discards a reading that
      // lands after it stopped.
      if (i > 0 && gapMs > 0) await delay(gapMs);
      try {
        const res = await http(url, {
          headers: { accept: 'application/json' },
          signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
        });
        // Logged on every pass because it is the only view of the anonymous budget
        // (~400/day) there is, and a reading costs `samples` of it.
        const left = numOrNull(res?.headers?.get?.('x-rate-limit-remaining'));
        if (left != null) rateRemaining = left;
        if (!res?.ok) {
          // 429 is the budget gone, 503 is the API having a day. Both are normal and
          // both must leave chat untouched.
          logger?.warn?.('chase: aircraft states rejected', { status: res?.status ?? 0, pass: i + 1, rateRemaining });
          continue;
        }
        const fixes = parseStates(await res.json(), Date.now());
        if (fixes.length) passes.push(fixes);
      } catch (err) {
        logger?.warn?.('chase: aircraft states unreachable', { pass: i + 1, err: String(err?.message || err) });
      }
    }

    if (passes.length < 2) return empty(rateRemaining, passes.length);
    const orbiting = detectOrbits(passes, cfg);
    const clusters = clusterOrbits(orbiting, cfg);
    const pursuing = detectPursuits(passes, cfg);
    const pursuitClusters = clusterPursuits(pursuing, cfg);

    // RAW COUNTS, and they are not decoration. The first real miss produced
    // `orbiting: 0` and there was no way to tell from the log whether the API had
    // returned nothing or had returned a full sky that the detector rejected —
    // which have opposite fixes. `aircraftSeen` and `tracked` separate them:
    // seen 0 is a fetch or bbox problem, seen 70 with tracked 0 means the passes
    // share no aircraft, and tracked 30 with both detectors empty means the shape
    // tests are too strict.
    const union = new Set();
    for (const pass of passes) for (const f of pass) union.add(String(f?.icao24 ?? ''));
    union.delete('');
    let tracked = 0;
    for (const track of buildTracks(passes).values()) if (track.length === passes.length) tracked += 1;

    return {
      orbiting,
      clusters,
      pursuing,
      pursuitClusters,
      aircraftSeen: union.size,
      tracked,
      samples: passes.length,
      rateRemaining,
      at: Date.now(),
      tookMs: Date.now() - startedAt,
    };
  } catch (err) {
    // The outer net. Nothing in this module is allowed to reach the tick.
    logger?.warn?.('chase: aircraft sampling failed', { err: String(err?.message || err) });
    return empty();
  }
}
