import { TIMEOUT_MS } from "../config.js";

// The only two ways the coordinator talks to a replica.
// Neither function ever throws - errors and timeouts become plain return values.

// Send a versioned value. Used by writes, read-repair, and (later) hint replay.
// Returns true if the replica confirmed, false on error or timeout.
export async function sendToReplica(replica, key, value, version) {
  try {
    const res = await fetch(`${replica}/kv/${encodeURIComponent(key)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value, version }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false; // replica down, unreachable, or too slow
  }
}

// Read a replica's copy of a key. Returns one of:
//   { ok: true, entry: { value, version } }   replica has the key
//   { ok: true, entry: null }                  replica is alive but has nothing (404)
//   { ok: false }                              replica down, unreachable, or too slow
export async function readFromReplica(replica, key) {
  try {
    const res = await fetch(`${replica}/kv/${encodeURIComponent(key)}`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 404) return { ok: true, entry: null };
    if (!res.ok) return { ok: false };
    return { ok: true, entry: await res.json() };
  } catch {
    return { ok: false };
  }
}
