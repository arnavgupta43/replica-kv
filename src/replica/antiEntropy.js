import { PEERS, BUCKETS, ANTI_ENTROPY_MS } from "../config.js";
import { apply } from "./store.js";
import { bucketHashes, bucketEntries } from "./merkle.js";
import { sendToReplica, fetchJson } from "../shared/replicaClient.js";

// Anti-entropy: every ANTI_ENTROPY_MS, sync with one randomly picked peer.
// If that peer is down the sync just fails, and we try again next round -
// so with one replica down, the other two still keep syncing with each other.
export function startAntiEntropy() {
  if (PEERS.length === 0) return;

  async function loop() {
    const peer = PEERS[Math.floor(Math.random() * PEERS.length)];
    await syncWith(peer);
    setTimeout(loop, ANTI_ENTROPY_MS);
  }
  setTimeout(loop, ANTI_ENTROPY_MS);
}

// One sync session with a peer. Fixes BOTH sides:
//   peer has a newer version (or we lack the key)  → apply it locally   (pull)
//   we have a newer version (or the peer lacks it) → send it to the peer (push)
async function syncWith(peer) {
  // 1. Get the peer's bucket hashes and compare them with ours.
  const theirHashes = await fetchJson(`${peer}/merkle`);
  if (!theirHashes) {
    console.log(`anti-entropy: ${peer} unreachable, skipping this round`);
    return;
  }
  const myHashes = bucketHashes();

  let differingBuckets = 0;
  let pulled = 0;
  let pushed = 0;

  for (let bucket = 0; bucket < BUCKETS; bucket++) {
    if (myHashes[bucket] === theirHashes[bucket]) continue; // identical - skip

    // 2. This bucket differs: fetch the peer's entries for it.
    differingBuckets++;
    const theirEntries = await fetchJson(`${peer}/bucket/${bucket}`);
    if (!theirEntries) return; // peer went away mid-sync; next round will retry

    const mine = toMap(bucketEntries(bucket));
    const theirs = toMap(theirEntries);

    // 3. Compare key by key, looking at keys from BOTH sides.
    const allKeys = new Set([...mine.keys(), ...theirs.keys()]);
    for (const key of allKeys) {
      const my = mine.get(key);
      const their = theirs.get(key);

      if (their && (!my || their.version > my.version)) {
        apply(key, their.value, their.version);
        pulled++;
      } else if (my && (!their || my.version > their.version)) {
        await sendToReplica(peer, key, my.value, my.version);
        pushed++;
      }
    }
  }

  if (differingBuckets > 0) {
    console.log(`anti-entropy with ${peer}: ${differingBuckets} buckets differed, pulled ${pulled}, pushed ${pushed}`);
  }
}

// [{ key, value, version }] → Map(key → { value, version })
function toMap(entries) {
  return new Map(entries.map(({ key, value, version }) => [key, { value, version }]));
}
