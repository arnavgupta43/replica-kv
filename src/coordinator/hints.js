// Hint store: writes that a replica missed, kept so they can be redelivered later.
// Each hint is { replica, key, value, version }.
//
// For now hints live in memory only (lost if the coordinator restarts - anti-entropy
// will cover that). Replaying them is a later phase (hinted handoff).

const hints = [];

export function addHint(replica, key, value, version) {
  hints.push({ replica, key, value, version });
  console.log(`hint stored for ${replica}: ${key} v${version}`);
}

export function listHints() {
  return hints;
}
