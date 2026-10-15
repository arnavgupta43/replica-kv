// All settings come from environment variables, so the same code
// runs as a local process or inside a Docker container.

export const NODE_ID = process.env.NODE_ID;
export const PORT = Number(process.env.PORT);
export const DATA_DIR = process.env.DATA_DIR;

// Coordinator only: the replica URLs, e.g. "http://localhost:4001,http://localhost:4002"
export const REPLICAS = (process.env.REPLICAS || "").split(",").filter(Boolean);

// Quorum: a write succeeds when W replicas confirm it.
export const W = 2;

// Quorum: a read succeeds when R replicas answer. W + R > number of replicas,
// so every read overlaps at least one replica that has the latest successful write.
export const R = 2;

// How long the coordinator waits for a replica before treating it as failed.
export const TIMEOUT_MS = 1000;
