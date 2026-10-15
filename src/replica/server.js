import express from "express";
import { NODE_ID, PORT, DATA_DIR, PEERS, BUCKETS } from "../config.js";
import { openStore, apply, get } from "./store.js";
import { bucketHashes, bucketEntries } from "./merkle.js";
import { startAntiEntropy } from "./antiEntropy.js";

openStore(DATA_DIR);

const app = express();
app.use(express.json());

// Store a versioned value.
// Replies OK both when the write is applied AND when we already hold this version
// or newer - an OK means "I have this version or a newer one", not "I just wrote it".
// Only a real problem (e.g. disk error) is a failure.
app.put("/kv/:key", (req, res) => {
  const { value, version } = req.body;
  if (value === undefined || !Number.isInteger(version)) {
    return res.status(400).json({ error: "body must be { value, version }" });
  }

  try {
    const applied = apply(req.params.key, value, version);
    console.log(`PUT ${req.params.key} v${version} -> ${applied ? "applied" : "ignored (have newer)"}`);
    res.json({ ok: true, applied });
  } catch (err) {
    console.error("write failed:", err);
    res.status(500).json({ ok: false, error: "write failed" });
  }
});

// Read this replica's own copy (handy for checking each replica directly).
app.get("/kv/:key", (req, res) => {
  const entry = get(req.params.key);
  if (!entry) return res.status(404).json({ error: "not found" });
  res.json(entry);
});

// Anti-entropy: the fingerprint of every bucket (an array of BUCKETS hashes).
app.get("/merkle", (req, res) => {
  res.json(bucketHashes());
});

// Anti-entropy: every entry in one bucket, so a peer can compare key by key.
app.get("/bucket/:i", (req, res) => {
  const bucket = Number(req.params.i);
  if (!Number.isInteger(bucket) || bucket < 0 || bucket >= BUCKETS) {
    return res.status(400).json({ error: `bucket must be 0..${BUCKETS - 1}` });
  }
  res.json(bucketEntries(bucket));
});

app.listen(PORT, () => {
  console.log(`replica ${NODE_ID} listening on port ${PORT} (peers: ${PEERS.join(", ") || "none"})`);
});

startAntiEntropy();
