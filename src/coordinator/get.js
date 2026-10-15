import { REPLICAS, R } from "../config.js";
import { sendToReplica, readFromReplica } from "./replicaClient.js";

// The get path:
//   1. ask ALL replicas in parallel
//   2. as soon as R replicas have answered (a 404 counts as an answer), reply with the newest
//      value among them; if R answers become impossible, reply with a failure
//   3. once ALL replicas have answered or timed out, repair the stale ones (in the background)
export function get(key) {
  return new Promise((resolve) => {
    const answers = []; // { replica, entry } - entry is { value, version } or null
    let failures = 0;
    let finished = 0;
    const maxFailures = REPLICAS.length - R; // more failures than this = quorum impossible

    for (const replica of REPLICAS) {
      readFromReplica(replica, key).then((reply) => {
        finished++;
        if (reply.ok) {
          answers.push({ replica, entry: reply.entry });
        } else {
          failures++;
        }

        // Same trick as put(): only the first resolve() counts.
        if (answers.length === R) resolve({ ok: true, entry: newest(answers) });
        if (failures === maxFailures + 1) resolve({ ok: false });

        // The last replica has answered (or timed out): now we know everything we will know.
        if (finished === REPLICAS.length) readRepair(key, answers);
      });
    }
  });
}

// Returns the entry with the highest version, or null if nobody has the key.
function newest(answers) {
  let best = null;
  for (const { entry } of answers) {
    if (entry && (!best || entry.version > best.version)) best = entry;
  }
  return best;
}

// Push the newest value to every replica that answered with an older version or nothing.
// Fire-and-forget: we don't wait, and a failed repair is fine - the next read or
// anti-entropy will fix it. Replicas that timed out are skipped (we don't know their state).
function readRepair(key, answers) {
  const latest = newest(answers);
  if (!latest) return; // nobody has the key, nothing to repair

  for (const { replica, entry } of answers) {
    const isStale = !entry || entry.version < latest.version;
    if (!isStale) continue;

    console.log(`read-repair: ${replica} has ${entry ? "v" + entry.version : "nothing"}, sending ${key} v${latest.version}`);
    sendToReplica(replica, key, latest.value, latest.version).then((ok) => {
      if (!ok) console.log(`read-repair to ${replica} failed (will be fixed later)`);
    });
  }
}
