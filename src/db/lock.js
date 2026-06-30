// Single-instance lease (IMPLEMENTATION §E/§J). Two bot instances = double EXP,
// double loot, races on the level-up roll — a correctness invariant, not tidiness.
// The spec relies on operational discipline; this ENFORCES it: a second instance
// transactionally fails to claim the lease and refuses to start. A crashed
// instance's lease goes stale and can be taken over.

import { database, PATHS } from './firebase.js';
import { config } from '../config.js';
import { hostname } from 'node:os';

/** Default, reasonably-unique instance id. Overridable via env for clarity. */
export function defaultInstanceId() {
  return process.env.INSTANCE_ID || `${hostname()}:${process.pid}`;
}

/**
 * Attempt to claim the lease. Succeeds if free, stale (abandoned), or already
 * ours. Fails (without writing) if another live instance holds it.
 * @param {{ instanceId?: string, staleMs?: number }} [opts]
 * @returns {Promise<{ acquired: boolean, holder: object|null }>}
 */
export async function acquireLock({ instanceId = defaultInstanceId(), staleMs = config.lock.staleMs } = {}) {
  const ref = database().ref(PATHS.configLock());
  const now = Date.now();

  const res = await ref.transaction((curr) => {
    const isFree = curr == null;
    const isOurs = curr?.owner === instanceId;
    const isStale = curr && typeof curr.heartbeat === 'number' && now - curr.heartbeat > staleMs;
    if (isFree || isOurs || isStale) {
      return { owner: instanceId, heartbeat: now, since: curr?.owner === instanceId ? curr.since : now };
    }
    return undefined; // someone else holds a live lease → abort, don't overwrite
  });

  return { acquired: res.committed, holder: res.snapshot.val() };
}

/**
 * Begin heartbeating the lease so it doesn't go stale under us. Returns a stop
 * function. If a heartbeat ever finds the lease owned by someone ELSE, it invokes
 * `onLost` (the caller should shut down — we lost the single-instance race).
 * @param {{ instanceId?: string, intervalMs?: number, onLost?: (holder:any)=>void }} [opts]
 */
export function startHeartbeat({
  instanceId = defaultInstanceId(),
  intervalMs = config.lock.heartbeatMs,
  onLost = () => {},
} = {}) {
  const ref = database().ref(PATHS.configLock());
  const timer = setInterval(async () => {
    try {
      const res = await ref.transaction((curr) => {
        if (curr == null || curr.owner === instanceId) {
          return { owner: instanceId, heartbeat: Date.now(), since: curr?.since ?? Date.now() };
        }
        return undefined; // lost the lease
      });
      if (!res.committed) onLost(res.snapshot.val());
    } catch {
      // transient RTDB error — next tick retries; do not crash the heartbeat
    }
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** Release the lease if (and only if) we still own it. */
export async function releaseLock({ instanceId = defaultInstanceId() } = {}) {
  const ref = database().ref(PATHS.configLock());
  await ref.transaction((curr) => {
    if (curr == null || curr.owner === instanceId) return null;
    return undefined; // not ours — leave it
  });
}
