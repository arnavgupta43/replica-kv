import express from "express";
import { NODE_ID, PORT, DATA_DIR } from "../config.js";
import { openStore, apply, get } from "./store.js";

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

app.listen(PORT, () => {
  console.log(`replica ${NODE_ID} listening on port ${PORT}`);
});
