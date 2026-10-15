import crypto from "node:crypto";
import { BUCKETS } from "../config.js";
import { allEntries } from "./store.js";

// Merkle v1: flat buckets.
// Every key goes into one of BUCKETS buckets. Each bucket gets a fingerprint (hash)
// of its "key:version" pairs. Two replicas with the same bucket hash hold the
// same keys at the same versions in that bucket - no need to look inside.

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

// Which bucket a key belongs to. Same formula on every replica,
// so a key always lands in the same bucket everywhere.
export function bucketOf(key) {
  const hash = sha256(key);
  return parseInt(hash.slice(0, 8), 16) % BUCKETS; // first 8 hex chars = a 32-bit number
}

// All entries in one bucket: [{ key, value, version }]
export function bucketEntries(bucket) {
  return allEntries().filter((entry) => bucketOf(entry.key) === bucket);
}

// The fingerprint of every bucket, as an array of BUCKETS hashes.
// Recomputed from scratch each time - simple, and fast enough at this scale.
export function bucketHashes() {
  // 1. Group "key:version" strings by bucket.
  const groups = Array.from({ length: BUCKETS }, () => []);
  for (const { key, version } of allEntries()) {
    groups[bucketOf(key)].push(`${key}:${version}`);
  }

  // 2. Sort each group (so insertion order doesn't matter), join, and hash.
  return groups.map((group) => sha256(group.sort().join("|")));
}
