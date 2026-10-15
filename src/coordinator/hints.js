import { HINT_REPLAY_MS, HINT_TTL_MS } from "../config.js";
import { sendToReplica } from "../shared/replicaClient.js";

// Hint store: writes that a replica missed, kept so they can be redelivered later.
// Each hint is { replica, key, value, version, createdAt }.
//
// Hints live in memory only - if the coordinator restarts they are lost,
// and anti-entropy is left to fix the replica.

let hints = [];

export function addHint(replica, key, value, version) {
  hints.push({ replica, key, value, version, createdAt: Date.now() });
  console.log(`hint stored for ${replica}: ${key} v${version}`);
}

export function listHints() {
  return hints;
}

// Run replayHints() every HINT_REPLAY_MS.
// The next round is scheduled only after the current one finishes, so rounds never overlap.
export function startHintReplay() {
  async function loop() {
    await replayHints();
    setTimeout(loop, HINT_REPLAY_MS);
  }
  setTimeout(loop, HINT_REPLAY_MS);
}

// One round of hinted handoff (push model):
//   - hint older than the TTL      → drop it
//   - replica says OK               → delete it (OK = "I have this version or newer")
//   - replica fails                 → keep it, and skip that replica's other hints this round
async function replayHints() {
  if (hints.length === 0) return;

  const done = new Set();        // hints to remove: delivered or expired
  const unreachable = new Set(); // replicas that failed this round

  // Loop over a copy: put() may add new hints while we are awaiting below.
  for (const hint of [...hints]) {
    if (Date.now() - hint.createdAt > HINT_TTL_MS) {
      console.log(`hint expired for ${hint.replica}: ${hint.key} v${hint.version} (anti-entropy will fix it)`);
      done.add(hint);
      continue;
    }

    // Already failed once this round - don't wait for another timeout.
    if (unreachable.has(hint.replica)) continue;

    const ok = await sendToReplica(hint.replica, hint.key, hint.value, hint.version);
    if (ok) {
      console.log(`hint delivered to ${hint.replica}: ${hint.key} v${hint.version}`);
      done.add(hint);
    } else {
      unreachable.add(hint.replica);
    }
  }

  // Remove finished hints. Hints added during this round are not in `done`, so they stay.
  hints = hints.filter((hint) => !done.has(hint));
}
