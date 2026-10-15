import { REPLICAS, W } from "../config.js";
import { nextVersion } from "./version.js";
import { addHint } from "./hints.js";
import { sendToReplica } from "../shared/replicaClient.js";

// The put path:
//   1. assign a version
//   2. send to ALL replicas in parallel (no health check - the write itself is the check)
//   3. reply as soon as W replicas say OK, or as soon as W OKs become impossible
//   4. every replica that fails or times out gets a hint
export function put(key, value) {
  const version = nextVersion();

  return new Promise((resolve) => {
    let oks = 0;
    let failures = 0;
    const maxFailures = REPLICAS.length - W; // more failures than this = quorum impossible

    for (const replica of REPLICAS) {
      sendToReplica(replica, key, value, version).then((ok) => {
        if (ok) {
          oks++;
        } else {
          failures++;
          addHint(replica, key, value, version);
        }

        // A Promise can only resolve once, so later calls to resolve() are simply ignored.
        // That is what lets us reply early without waiting for the slowest replica.
        if (oks === W) resolve({ ok: true, version });
        if (failures === maxFailures + 1) resolve({ ok: false, version });
      });
    }
  });
}
