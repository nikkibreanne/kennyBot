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
 * Save the last N seconds from OBS's replay buffer. Starts the buffer first if
 * it isn't running, so a streamer who forgot to enable it still gets the clip
 * (that save will be short — the buffer only just began filling).
 *
 * @returns {Promise<{ path: string|null, started: boolean }>}
 */
export async function saveReplayBuffer({ url, password, timeoutMs }) {
  return withObs({ url, password, timeoutMs }, async (request) => {
    let started = false;
    const status = await request('GetReplayBufferStatus');
    if (!status.outputActive) {
      await request('StartReplayBuffer');
      started = true;
    }
    await request('SaveReplayBuffer');
    // OBS writes the file asynchronously; the path may lag a beat, so a miss
    // here is not an error — the save still happened.
    let path = null;
    try {
      const last = await request('GetLastReplayBufferReplay');
      path = last?.savedReplayPath ?? null;
    } catch {
      /* path unavailable — the save itself already succeeded */
    }
    return { path, started };
  });
}
