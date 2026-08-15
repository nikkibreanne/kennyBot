// OBS scene / source / filter / audio control — everything at the obs-websocket
// seam that ISN'T playing a media source (that's obsMedia.js).
//
// Same connection, same contract as capture.js and obsMedia.js: connect per
// call, deadline-bounded, and every failure RESOLVES with `{ ok:false, reason }`
// rather than throwing. OBS being closed must never break chat.
//
// This exists to LEARN what OBS can do from chat, so it is deliberately broad and
// deliberately thin: each operation is one or two requests with no policy on top.
// The only gate is that `!obs` is mod-only. If one of these turns out to be worth
// keeping, it can grow its own command and its own guard rails then.
//
// Connection state is resolved here rather than shared with obsMedia, which is a
// little duplication in exchange for the media path — the one that is verified
// against a real rig and already merged — being impossible to destabilise from
// here. Both read the same env, so they cannot disagree about where OBS is.

import { withObs, obsConnectionFromEnv, websocketAvailable } from './obsWebsocket.js';

/** Connection config, or `null` when this deployment has no OBS. */
let conn = null;
/** Test seam: when set, stands in for `request` — see initObsControlWith. */
let fakeRequest = null;

/** @param {{url?: string, password?: string, timeoutMs?: number}} [opts] */
export function initObsControl(opts = {}, logger = console) {
  fakeRequest = null;
  const env = obsConnectionFromEnv();
  const url = opts.url ?? env?.url ?? '';
  if (!url || !websocketAvailable()) {
    conn = null;
    logger.info?.('obs control disabled (no OBS_WEBSOCKET_URL)');
    return;
  }
  conn = {
    url,
    password: opts.password ?? env?.password ?? '',
    timeoutMs: opts.timeoutMs ?? env?.timeoutMs ?? 8000,
  };
  logger.info?.('obs control ready', { url });
}

/**
 * Test seam. `fn(requestType, requestData)` replaces the obs-websocket request
 * function itself — NOT each operation — so tests assert the actual protocol
 * calls rather than a mock of our own design. Pass null to disable.
 */
export function initObsControlWith(fn) {
  fakeRequest = fn || null;
  conn = fn ? { url: 'test://obs', password: '', timeoutMs: 0 } : null;
}

/** True when an OBS connection is configured. */
export function obsControlReady() {
  return conn !== null;
}

/**
 * Run `fn(request)` against OBS. Never throws — the caller gets a reason it can
 * put in chat, which for this feature is usually OBS's own error text and is
 * more useful than anything we would write.
 * @returns {Promise<{ok: true, data: any} | {ok: false, reason: string}>}
 */
async function run(fn) {
  if (!conn) return { ok: false, reason: 'no OBS is configured for this bot' };
  try {
    return { ok: true, data: fakeRequest ? await fn(fakeRequest) : await withObs(conn, fn) };
  } catch (err) {
    return { ok: false, reason: String(err?.message || err) };
  }
}

// ── scenes ───────────────────────────────────────────────────────────────────

/** Every scene, plus which one is live. */
export function listScenes() {
  return run(async (request) => {
    const { scenes = [], currentProgramSceneName } = await request('GetSceneList');
    // OBS returns scenes in REVERSE UI order (index 0 is the bottom of the list).
    // Reversing makes chat's list read like the panel the streamer is looking at.
    return {
      current: currentProgramSceneName,
      names: scenes.map((s) => s.sceneName).reverse(),
    };
  });
}

/** Cut to a scene by exact name. */
export function setScene(sceneName) {
  return run(async (request) => {
    await request('SetCurrentProgramScene', { sceneName });
    return { sceneName };
  });
}

// ── sources (scene items) ────────────────────────────────────────────────────

/** The current program scene's name — the default target for source commands. */
async function currentScene(request) {
  const { currentProgramSceneName } = await request('GetSceneList');
  return currentProgramSceneName;
}

/** Every source in a scene, with whether it is currently visible. */
export function listSources(sceneName = null) {
  return run(async (request) => {
    const scene = sceneName || (await currentScene(request));
    const { sceneItems = [] } = await request('GetSceneItemList', { sceneName: scene });
    return {
      scene,
      // Reversed for the same reason as scenes: OBS's list is bottom-up.
      items: sceneItems
        .map((i) => ({ name: i.sourceName, id: i.sceneItemId, visible: i.sceneItemEnabled }))
        .reverse(),
    };
  });
}

/**
 * Show, hide, or flip a source's visibility.
 * @param {'show'|'hide'|'toggle'} mode
 */
export function setSourceVisible(sourceName, mode, sceneName = null) {
  return run(async (request) => {
    const scene = sceneName || (await currentScene(request));
    // SetSceneItemEnabled takes a numeric id; there is no name-based form.
    const { sceneItemId } = await request('GetSceneItemId', { sceneName: scene, sourceName });
    let enabled;
    if (mode === 'toggle') {
      const cur = await request('GetSceneItemEnabled', { sceneName: scene, sceneItemId });
      enabled = !cur.sceneItemEnabled;
    } else {
      enabled = mode === 'show';
    }
    await request('SetSceneItemEnabled', { sceneName: scene, sceneItemId, sceneItemEnabled: enabled });
    return { scene, sourceName, visible: enabled };
  });
}

// ── filters ──────────────────────────────────────────────────────────────────

/** Every filter on a source, in OBS's own order, with enabled state. */
export function listFilters(sourceName) {
  return run(async (request) => {
    const { filters = [] } = await request('GetSourceFilterList', { sourceName });
    return {
      sourceName,
      filters: filters.map((f) => ({ name: f.filterName, kind: f.filterKind, enabled: f.filterEnabled })),
    };
  });
}

/**
 * Turn one or more filters on a source on or off, over a SINGLE connection.
 *
 * Two things this deliberately does not do. It does not open a connection per
 * filter — `run()` wraps one, and flipping three filters should not mean three
 * handshakes. And it does not abort the batch on the first bad name: a typo in
 * the second of three filters would otherwise leave the first applied, the third
 * untouched, and the mod guessing which. Each filter reports its own outcome and
 * the caller says exactly what happened.
 *
 * @param {string[]} filterNames
 * @returns {Promise<{ok:true,data:{sourceName:string,enabled:boolean,results:Array<{filterName:string,ok:boolean,reason?:string}>}}|{ok:false,reason:string}>}
 */
export function setFilters(sourceName, filterNames, enabled) {
  return run(async (request) => {
    const results = [];
    for (const filterName of filterNames) {
      try {
        await request('SetSourceFilterEnabled', { sourceName, filterName, filterEnabled: enabled });
        results.push({ filterName, ok: true });
      } catch (err) {
        // OBS's own message names the thing it couldn't find, which beats
        // anything we would write here.
        results.push({ filterName, ok: false, reason: String(err?.message || err) });
      }
    }
    return { sourceName, enabled, results };
  });
}

/** Turn one filter on or off. Thin wrapper — the batch form is the real one. */
export function setFilter(sourceName, filterName, enabled) {
  return setFilters(sourceName, [filterName], enabled);
}

// ── audio ────────────────────────────────────────────────────────────────────

/**
 * Inputs that actually have audio, with mute state and level.
 *
 * OBS has no "list audio inputs" request, so this asks every input for its mute
 * state and keeps the ones that answer — a source with no audio track errors,
 * and that error IS the filter. Costs one round trip per input, on a single
 * connection, which is fine for a command a mod types occasionally.
 */
export function listAudio() {
  return run(async (request) => {
    const { inputs = [] } = await request('GetInputList');
    const out = [];
    for (const { inputName } of inputs) {
      try {
        const { inputMuted } = await request('GetInputMute', { inputName });
        const { inputVolumeDb } = await request('GetInputVolume', { inputName });
        out.push({ name: inputName, muted: inputMuted, db: inputVolumeDb });
      } catch {
        /* no audio track on this input — not an error, just not audio */
      }
    }
    return { inputs: out };
  });
}

/**
 * Mute, unmute, or flip an audio input.
 * @param {'mute'|'unmute'|'toggle'} mode
 */
export function setMute(inputName, mode) {
  return run(async (request) => {
    let muted;
    if (mode === 'toggle') {
      const { inputMuted } = await request('GetInputMute', { inputName });
      muted = !inputMuted;
    } else {
      muted = mode === 'mute';
    }
    await request('SetInputMute', { inputName, inputMuted: muted });
    return { inputName, muted };
  });
}

// ── health ───────────────────────────────────────────────────────────────────

/**
 * The numbers that say whether the STREAM is healthy, not whether OBS is up.
 * Dropped frames and encoder lag are what a mod needs when chat says "it's
 * buffering" and the streamer can't see it.
 */
export function getStats() {
  return run(async (request) => {
    const s = await request('GetStats');
    const out = await request('GetStreamStatus').catch(() => null);
    return {
      cpu: s.cpuUsage,
      fps: s.activeFps,
      renderSkipped: s.renderSkippedFrames,
      renderTotal: s.renderTotalFrames,
      outputSkipped: s.outputSkippedFrames,
      outputTotal: s.outputTotalFrames,
      diskGb: s.availableDiskSpace / 1024,
      streaming: out?.outputActive ?? null,
      streamSkipped: out?.outputSkippedFrames ?? null,
      streamTotal: out?.outputTotalFrames ?? null,
    };
  });
}
