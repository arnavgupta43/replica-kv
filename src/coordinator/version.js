import fs from "node:fs";
import path from "node:path";

// Every write gets a version number that is higher than all previous ones.
// The counter is saved to disk on every increment. Otherwise a coordinator restart
// would reset it to 0, and replicas would reject every new write as "older".

let counter = 0;
let counterFile;

export function loadVersion(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  counterFile = path.join(dataDir, "version.txt");

  if (fs.existsSync(counterFile)) {
    counter = Number(fs.readFileSync(counterFile, "utf8"));
  }
  console.log(`version counter starts at ${counter}`);
}

// Node runs our JavaScript on a single thread and these file calls are synchronous,
// so two requests can never get the same version.
export function nextVersion() {
  counter++;
  fs.writeFileSync(counterFile, String(counter), { flush: true });
  return counter;
}
