import express from "express";
import { PORT, DATA_DIR, REPLICAS, W, R } from "../config.js";
import { loadVersion } from "./version.js";
import { listHints, startHintReplay } from "./hints.js";
import { put } from "./put.js";
import { get } from "./get.js";

loadVersion(DATA_DIR);
startHintReplay();

const app = express();
app.use(express.json());

// Client write: body is { value }. The coordinator assigns the version.
app.put("/kv/:key", async (req, res) => {
  const { value } = req.body;
  if (value === undefined) {
    return res.status(400).json({ error: "body must be { value }" });
  }

  const result = await put(req.params.key, value);

  if (result.ok) {
    res.json({ ok: true, version: result.version });
  } else {
    // Failure means "unknown outcome": the write may still have reached a replica.
    // Retrying is safe - a retry simply gets a newer version.
    res.status(503).json({ ok: false, version: result.version, error: "quorum not reached, outcome unknown" });
  }
});

// Client read: returns the newest value among R replicas (and repairs stale ones).
app.get("/kv/:key", async (req, res) => {
  const result = await get(req.params.key);

  if (!result.ok) {
    return res.status(503).json({ error: "not enough replicas answered" });
  }
  if (!result.entry) {
    return res.status(404).json({ error: "not found" });
  }
  res.json(result.entry);
});

// Debug: see which writes are waiting to be redelivered.
app.get("/hints", (req, res) => {
  res.json(listHints());
});

app.listen(PORT, () => {
  console.log(`coordinator listening on port ${PORT} (W=${W}, R=${R}, replicas: ${REPLICAS.join(", ")})`);
});
