// Minimal obs-websocket v5 client — just enough to trigger a replay-buffer save
// on the streamer's machine over the tailnet.
//
// No dependency: Node 22 ships a global WebSocket, and the auth is two SHA-256
// rounds. Adding obs-websocket-js for ~80 lines of protocol would widen the
// supply-chain surface of an otherwise 4-dependency bot for no gain.
//
// We connect PER TRIGGER rather than holding a socket open. A clip is rare, the
// handshake is ~100ms, and a short-lived connection means no reconnect/backoff
// state machine and nothing to go stale while the streamer's PC sleeps. Every
// step is deadline-bounded so an unreachable PC can never hang a chat command.
//
// Protocol (docs/generated/protocol.md): server says Hello(0) with an optional
// {challenge, salt}; we reply Identify(1) with the derived auth; server confirms
// Identified(2); then Request(6) / RequestResponse(7) correlated by requestId.

import { createHash } from 'node:crypto';

const OP = { HELLO: 0, IDENTIFY: 1, IDENTIFIED: 2, REQUEST: 6, REQUEST_RESPONSE: 7 };

/**
 * obs-websocket v5 auth string:
 *   secret = base64(sha256(password + salt))
 *   auth   = base64(sha256(secret + challenge))
 */
export function deriveAuth(password, salt, challenge) {
  const sha256b64 = (s) => createHash('sha256').update(s).digest('base64');
  return sha256b64(sha256b64(password + salt) + challenge);
}

/** True when this runtime can open a WebSocket at all (Node 22+ / 20 with a flag). */
export function websocketAvailable() {
  return typeof WebSocket === 'function';
}

/**
 * Open a session, run `fn(request)`, and always close. `request(type, data)`
 * resolves with responseData or rejects with the OBS failure comment.
 *
 * @param {{ url: string, password?: string, timeoutMs?: number }} opts
 * @param {(request: (type: string, data?: object) => Promise<any>) => Promise<any>} fn
 */
export async function withObs({ url, password = '', timeoutMs = 8000 }, fn) {
  if (!websocketAvailable()) throw new Error('this Node build has no WebSocket support (needs Node 22+)');

  const ws = new WebSocket(url);
  const pending = new Map(); // requestId -> {resolve, reject}
  let seq = 0;
  let settleReady;
  let failAll;
  const ready = new Promise((resolve, reject) => {
    settleReady = resolve;
    failAll = reject;
  });

  // One deadline for the whole exchange — connect, identify, and every request.
  const timer = setTimeout(() => {
    const err = new Error(`OBS did not respond within ${timeoutMs}ms`);
    failAll(err);
    for (const p of pending.values()) p.reject(err);
    pending.clear();
    try { ws.close(); } catch { /* already closing */ }
  }, timeoutMs);

  ws.addEventListener('message', (ev) => {
    let msg;
    try {
      msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
    } catch {
      return; // ignore anything unparseable
    }
    if (msg.op === OP.HELLO) {
      const d = { rpcVersion: msg.d?.rpcVersion ?? 1 };
      const chal = msg.d?.authentication;
      if (chal) {
        if (!password) {
          failAll(new Error('OBS requires a websocket password but none is configured'));
          try { ws.close(); } catch { /* noop */ }
          return;
        }
        d.authentication = deriveAuth(password, chal.salt, chal.challenge);
      }
      ws.send(JSON.stringify({ op: OP.IDENTIFY, d }));
    } else if (msg.op === OP.IDENTIFIED) {
      settleReady();
    } else if (msg.op === OP.REQUEST_RESPONSE) {
      const p = pending.get(msg.d?.requestId);
      if (!p) return;
      pending.delete(msg.d.requestId);
      const st = msg.d.requestStatus || {};
      if (st.result) p.resolve(msg.d.responseData || {});
      else p.reject(new Error(st.comment || `OBS rejected ${msg.d.requestType} (code ${st.code})`));
    }
  });

  ws.addEventListener('error', () => {
    const err = new Error(`could not reach OBS at ${url}`);
    failAll(err);
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  });
  ws.addEventListener('close', () => {
    const err = new Error('OBS closed the connection');
    failAll(err);
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  });

  function request(requestType, requestData) {
    const requestId = `kb-${++seq}`;
    return new Promise((resolve, reject) => {
      pending.set(requestId, { resolve, reject });
      ws.send(JSON.stringify({ op: OP.REQUEST, d: { requestType, requestId, requestData } }));
    });
  }

  try {
    await ready;
    return await fn(request);
  } finally {
    clearTimeout(timer);
    try { ws.close(); } catch { /* already closed */ }
  }
}

/**
 * Save the last N seconds from OBS's replay buffer.
 *
 * If the buffer isn't running we START it — a streamer who forgot to enable it
 * shouldn't silently get nothing from every future `!clip`. But we do NOT then
 * pretend to save: OBS brings outputs up ASYNCHRONOUSLY, so an immediate save
 * fails with 501 OutputNotRunning (found the hard way against a real OBS), and
 * even once it is up the buffer holds ~nothing. So we wait for it to actually go
 * active, report `started: true, path: null`, and let the NEXT clip have content.
 *
 * @returns {Promise<{ path: string|null, started: boolean }>}
 */
export async function saveReplayBuffer({ url, password, timeoutMs, verticalOutput = '' }) {
  return withObs({ url, password, timeoutMs }, async (request) => {
    const horizontal = await replayBufferSequence(request);
    if (!verticalOutput) return horizontal;
    // Vertical rides the SAME connection — one handshake, one deadline. It is
    // strictly best-effort: a missing plugin or a misconfigured output must not
    // cost us the horizontal capture we already have.
    const vertical = await verticalBacktrackSequence(request, verticalOutput)
      .catch((err) => ({ ok: false, reason: String(err?.message || err) }));
    return { ...horizontal, vertical };
  });
}

/** obs-websocket vendor name registered by the Aitum Stream Suite plugin. */
export const AITUM_VENDOR = 'aitum-stream-suite';

/**
 * Save the vertical canvas's "Backtrack" — Aitum's replay buffer for its second
 * (9:16) canvas, which carries the natively-framed portrait layout rather than a
 * crop of the landscape one.
 *
 * IMPORTANT: `save_backtrack` answers `{success: true}` as soon as it ACCEPTS the
 * request. Verified against a real Stream Suite 1.2.1: with a full buffer it
 * returns success and writes NO FILE when the output has no recording path
 * configured. The vendor API exposes no way to read that path back, so we cannot
 * confirm a write. This returns `requested`, never `saved`, precisely so callers
 * can't mistake acceptance for a file on disk.
 *
 * @param {(type: string, data?: object) => Promise<any>} request
 * @param {string} outputName e.g. "Vertical Backtrack" (see the `get_outputs` vendor request)
 * @param {(ms: number) => Promise<void>} [sleep] injectable for tests
 * @returns {Promise<{ ok: boolean, requested: boolean, started: boolean, reason?: string }>}
 */
export async function verticalBacktrackSequence(request, outputName, sleep = (ms) => new Promise((r) => setTimeout(r, ms))) {
  const vendor = (requestType, requestData = {}) =>
    request('CallVendorRequest', { vendorName: AITUM_VENDOR, requestType, requestData })
      .then((r) => r?.responseData ?? r);

  const find = async () => {
    const { outputs = [] } = (await vendor('get_outputs')) || {};
    return outputs.find((o) => o.name === outputName) || null;
  };

  const output = await find();
  if (!output) throw new Error(`no Aitum output named "${outputName}"`);

  if (!output.active) {
    // Same lesson as the main replay buffer: outputs come up asynchronously, and
    // a buffer that just started holds nothing worth saving. Start it and let the
    // NEXT clip have content.
    await vendor('start_output', { output: outputName });
    for (const wait of [150, 250, 500, 1000]) {
      await sleep(wait);
      const s = await find();
      if (s?.active) break;
    }
    return { ok: true, requested: false, started: true };
  }

  const res = await vendor('save_backtrack', { output: outputName });
  if (res && res.success === false) throw new Error(res.error || `save_backtrack refused for "${outputName}"`);
  return { ok: true, requested: true, started: false };
}

/**
 * The request sequence itself, split out from the socket so it can be unit-tested
 * with a fake `request`. Both bugs found against a real OBS lived here: saving
 * before the output was actually up, and reporting the PREVIOUS file's path.
 *
 * @param {(type: string, data?: object) => Promise<any>} request
 * @param {(ms: number) => Promise<void>} [sleep] injectable for tests
 */
export async function replayBufferSequence(request, sleep = (ms) => new Promise((r) => setTimeout(r, ms))) {
  {
    const status = await request('GetReplayBufferStatus');
    if (!status.outputActive) {
      await request('StartReplayBuffer');
      // Poll until the output is genuinely up, so the buffer is filling from now on.
      for (const wait of [150, 250, 500, 1000]) {
        await sleep(wait);
        const s = await request('GetReplayBufferStatus');
        if (s.outputActive) break;
      }
      return { path: null, started: true };
    }
    // Remember which file was last written BEFORE saving. OBS finalizes the new
    // one asynchronously, so GetLastReplayBufferReplay keeps returning the
    // PREVIOUS path for a moment — reporting that would name the wrong file
    // (observed against a real OBS). Poll until it actually changes.
    const previous = await request('GetLastReplayBufferReplay')
      .then((r) => r?.savedReplayPath ?? null)
      .catch(() => null);

    await request('SaveReplayBuffer');

    let path = null;
    for (const wait of [200, 300, 500, 1000]) {
      await sleep(wait);
      const current = await request('GetLastReplayBufferReplay')
        .then((r) => r?.savedReplayPath ?? null)
        .catch(() => null);
      if (current && current !== previous) {
        path = current;
        break;
      }
    }
    // A null path just means the write hadn't landed yet — the save still happened.
    return { path, started: false };
  }
}
