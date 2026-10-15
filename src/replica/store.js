import fs from "node:fs";
import path from "node:path";

// The replica's data lives in two places:
//   1. data   - an in-memory Map for fast lookups: key -> { value, version }
//   2. a log  - an append-only file on disk, one JSON record per line.
// The log is the source of truth. On startup we replay it to rebuild the Map.

const data = new Map();
let logFile;

export function openStore(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  logFile = path.join(dataDir, "data.log");

  if (!fs.existsSync(logFile)) return;

  const lines = fs.readFileSync(logFile, "utf8").split("\n");
  for (const line of lines) {
    if (!line) continue;
    try {
      const { key, value, version } = JSON.parse(line);
      applyInMemory(key, value, version);
    } catch {
      // A crash in the middle of a write can leave a half-written last line. Skip it.
      console.warn("skipping corrupt log line:", line);
    }
  }
  console.log(`restored ${data.size} keys from ${logFile}`);
}

// The one rule: only accept a write if its version is higher than what we have.
// Returns true if the write was applied, false if we already had this version or newer.
export function apply(key, value, version) {
  const current = data.get(key);
  if (current && current.version >= version) return false;

  // Write to disk FIRST (flush: true forces it onto the disk), then update memory.
  // If we crash after this line, the write is safe and will be replayed on restart.
  const record = JSON.stringify({ key, value, version }) + "\n";
  fs.appendFileSync(logFile, record, { flush: true });

  data.set(key, { value, version });
  return true;
}

export function get(key) {
  return data.get(key);
}

// Every key this replica holds, as [{ key, value, version }]. Used by anti-entropy.
export function allEntries() {
  const result = [];
  for (const [key, { value, version }] of data) {
    result.push({ key, value, version });
  }
  return result;
}

// Used while replaying the log: same rule as apply(), but no disk write.
function applyInMemory(key, value, version) {
  const current = data.get(key);
  if (current && current.version >= version) return;
  data.set(key, { value, version });
}
