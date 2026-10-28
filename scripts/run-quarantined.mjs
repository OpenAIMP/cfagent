#!/usr/bin/env node
/**
 * Run the quarantined suites listed in tests/flaky-quarantine.json
 * (#2070, gitops §18.3) for signal, outside the required check.
 * With an empty registry there is nothing to run — that is the
 * healthy state, not an error.
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const registry = JSON.parse(
  readFileSync(join(root, "tests/flaky-quarantine.json"), "utf8"),
);
if (!Array.isArray(registry)) {
  console.error("tests/flaky-quarantine.json must be an array of entries.");
  process.exit(1);
}
if (registry.length === 0) {
  console.log("No quarantined suites (tests/flaky-quarantine.json is empty).");
  process.exit(0);
}
const files = registry.map((entry) => entry.file);
console.log(`Running ${files.length} quarantined suite(s): ${files.join(", ")}`);
const result = spawnSync("npx", ["vitest", "run", ...files], {
  stdio: "inherit",
  cwd: root,
});
process.exit(result.status ?? 1);
