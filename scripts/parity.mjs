#!/usr/bin/env node
/**
 * scripts/parity.mjs — test-parity harness (issue #1746, program #1736 item 10).
 *
 * The discipline items 1–9 enforced manually, made runnable: a refactor PR
 * captures a baseline suite snapshot, compares old vs new behavior, and
 * carries a parity checklist into its §15. Nothing here changes production
 * behavior and nothing here redefines what passes — it measures the
 * repo's own gates (typecheck, vitest suite, build) and fails loudly on
 * silent weakening.
 *
 * Subcommands:
 *   capture --label <label> --out <file>
 *     Run typecheck + the vitest suite (JSON reporter) + build on the
 *     current checkout and write a snapshot. Capture always exits 0 when
 *     the snapshot is written, even when the suite is red: measurement
 *     is not enforcement. A red snapshot is warned about on stderr and
 *     refused as a compare baseline (parity is undefined against red).
 *   compare --baseline <file> [--current <file>] [--removals <file>] [--out <file>]
 *     Compare a baseline snapshot against the current checkout (or a
 *     --current snapshot). Exit 0 = parity holds, 1 = parity failure,
 *     2 = harness failure (unreadable input, unparseable output — never
 *     silently skipped). Unlisted test-file removals fail; removals
 *     listed in --removals ({ "<path>": "<reason>" }) pass as accepted
 *     and are reported as such, never hidden.
 *   checklist
 *     Print the canonical per-PR parity checklist (markdown) for pasting
 *     into a PR body or §15.
 *   check --checklist <file>
 *     Validate a filled checklist: every required group must appear as a
 *     checked `- [x]` line. Exit 0 = complete, 1 = gaps listed.
 *   report --comparison <file> --baseline <file> --current <file>
 *     Render the migration parity report (markdown) for a §15.
 *
 * Parity surface, deliberately: typecheck + suite + build. The design
 * token check stays in `npm run check` (it guards token drift, not
 * behavior), and the policy gate stays in scripts/verify-before-merge.sh
 * (it guards PR policy, not behavior). This harness composes with both
 * and replaces neither.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");

export const SNAPSHOT_VERSION = 1;

/** Required checklist groups. Each group passes when any alternative appears checked. */
export const CHECKLIST_GROUPS = [
  { key: "baseline", alternatives: ["Baseline snapshot captured"] },
  { key: "comparison", alternatives: ["Behavior comparison run"] },
  {
    key: "verify",
    alternatives: ["verify-before-merge.sh run on the rebased head"],
  },
  {
    key: "pins",
    alternatives: [
      "Pin updates in the same PR",
      "No pin updates in this PR",
    ],
  },
  {
    key: "gate",
    alternatives: ["Gate green", "Red checks diagnosed and classified"],
  },
  { key: "section15", alternatives: ["Parity section in §15 written"] },
];

export const CHECKLIST_TEMPLATE = `# Parity checklist (program #1736, issue #1746)

Paste into the PR body and tick each box with evidence. The harness
validates this file with \`node scripts/parity.mjs check --checklist <file>\`.

- [ ] Baseline snapshot captured (snapshot file / commit: ___)
- [ ] Behavior comparison run (compare output: ___)
- [ ] verify-before-merge.sh run on the rebased head (head: ___)
- [ ] Pin updates in the same PR (list them, or tick the next line instead)
- [ ] No pin updates in this PR
- [ ] Gate green (link: ___)
- [ ] Red checks diagnosed and classified (only when the gate is not green)
- [ ] Parity section in §15 written (comment id: ___)
`;

/**
 * Parse vitest `--reporter=json` output into a per-file test summary.
 * File paths are relativized against `root`. Throws on unparseable input
 * or a missing testResults array — a half-snapshot must never be written.
 */
export function parseVitestJson(raw, root = REPO_ROOT) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("parity: vitest JSON output is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.testResults)) {
    throw new Error("parity: vitest JSON output has no testResults array");
  }
  const byFile = {};
  const failedTests = [];
  for (const suite of parsed.testResults) {
    const rel =
      typeof suite.name === "string" && suite.name.startsWith(root + path.sep)
        ? suite.name.slice(root.length + 1)
        : String(suite.name ?? "unknown");
    const counts = { passed: 0, failed: 0, skipped: 0, total: 0 };
    if (Array.isArray(suite.assertionResults)) {
      for (const t of suite.assertionResults) {
        counts.total += 1;
        if (t.status === "passed") counts.passed += 1;
        else if (t.status === "failed") {
          counts.failed += 1;
          failedTests.push(`${rel} > ${t.fullName || t.title || "unnamed"}`);
        } else counts.skipped += 1; // pending, skipped, todo
      }
    } else if (suite.status === "failed") {
      // Degenerate suite with no per-test results: one observed failure.
      counts.failed = 1;
      counts.total = 1;
    }
    byFile[rel] = counts;
  }
  const totals = Object.values(byFile).reduce(
    (acc, c) => ({
      passed: acc.passed + c.passed,
      failed: acc.failed + c.failed,
      skipped: acc.skipped + c.skipped,
      total: acc.total + c.total,
    }),
    { passed: 0, failed: 0, skipped: 0, total: 0 },
  );
  return {
    files: Object.keys(byFile).length,
    ...totals,
    byFile,
    failedTests,
  };
}

/** Build a snapshot object from measured gate results. */
export function buildSnapshot({ label, commit, branch, typecheck, build, tests }) {
  return {
    version: SNAPSHOT_VERSION,
    kind: "parity-baseline",
    label,
    commit,
    branch,
    createdAt: new Date().toISOString(),
    typecheck,
    build,
    tests,
  };
}

function isGreen(snapshot) {
  return (
    snapshot.typecheck === "pass" &&
    snapshot.build === "pass" &&
    snapshot.tests.failed === 0
  );
}

/**
 * Compare a baseline snapshot against a current snapshot.
 * Blocking failures: a red baseline, typecheck/build regressions, a
 * previously passing file gaining failures, and unlisted test-file
 * removals. Added files and growth are informational, never failures.
 * acceptedRemovals maps a removed path to its reason; accepted removals
 * are reported, never hidden.
 */
export function compareSnapshots(baseline, current, options = {}) {
  const acceptedRemovals = options.acceptedRemovals ?? {};
  const failures = [];
  const added = [];
  const removed = [];
  const accepted = [];
  if (!isGreen(baseline)) {
    return {
      pass: false,
      failures: [
        "baseline is not green (typecheck/build must pass, suite failures must be 0); parity is undefined against red",
      ],
      added,
      removed,
      accepted,
    };
  }
  if (baseline.typecheck === "pass" && current.typecheck !== "pass") {
    failures.push(`typecheck regressed (baseline pass → current ${current.typecheck})`);
  }
  if (baseline.build === "pass" && current.build !== "pass") {
    failures.push(`build regressed (baseline pass → current ${current.build})`);
  }
  const baselineFiles = baseline.tests.byFile ?? {};
  const currentFiles = current.tests.byFile ?? {};
  for (const [file, counts] of Object.entries(baselineFiles)) {
    if (!(counts.failed === 0 && counts.passed > 0)) continue;
    if (!(file in currentFiles)) {
      if (file in acceptedRemovals) {
        accepted.push({ file, reason: acceptedRemovals[file] });
      } else {
        removed.push(file);
        failures.push(
          `test file removed without an accepted reason: ${file} (list it in --removals with a reason, or restore it)`,
        );
      }
      continue;
    }
    const now = currentFiles[file];
    if (now.failed > 0) {
      const names = (current.tests.failedTests ?? []).filter((t) =>
        t.startsWith(`${file} > `),
      );
      failures.push(
        `test file ${file} now has ${now.failed} failure(s)` +
          (names.length ? `: ${names.join(", ")}` : ""),
      );
    }
  }
  for (const file of Object.keys(currentFiles)) {
    if (!(file in baselineFiles)) added.push(file);
  }
  return { pass: failures.length === 0, failures, added, removed, accepted };
}

/** Validate a filled checklist file. Returns { pass, missing: [group keys] }. */
export function validateChecklist(text) {
  const checked = [];
  for (const line of String(text).split("\n")) {
    const m = /^\s*-\s*\[[xX]\]\s+(.*)$/.exec(line);
    if (m) checked.push(m[1]);
  }
  const missing = CHECKLIST_GROUPS.filter(
    (g) => !g.alternatives.some((alt) => checked.some((line) => line.includes(alt))),
  ).map((g) => g.key);
  return { pass: missing.length === 0, missing };
}

/** Render the migration parity report (markdown) for a §15. */
export function renderReport(comparison, baseline, current) {
  const lines = [];
  lines.push("# Parity report");
  lines.push("");
  lines.push(`Verdict: **${comparison.pass ? "PASS" : "FAIL"}**`);
  lines.push("");
  lines.push(`Baseline: ${baseline.commit} (${baseline.branch})`);
  lines.push(`Current: ${current.commit} (${current.branch})`);
  lines.push("");
  lines.push(
    `Tests: baseline ${baseline.tests.passed} passed / ${baseline.tests.failed} failed / ${baseline.tests.skipped} skipped / ${baseline.tests.total} total` +
      ` → current ${current.tests.passed} passed / ${current.tests.failed} failed / ${current.tests.skipped} skipped / ${current.tests.total} total`,
  );
  lines.push(`Typecheck: baseline ${baseline.typecheck} → current ${current.typecheck}`);
  lines.push(`Build: baseline ${baseline.build} → current ${current.build}`);
  lines.push("");
  if (comparison.failures.length) {
    lines.push("## Failures");
    lines.push("");
    for (const f of comparison.failures) lines.push(`- ${f}`);
    lines.push("");
  }
  if (comparison.added.length) {
    lines.push("## Added test files (informational)");
    lines.push("");
    for (const f of comparison.added) lines.push(`- ${f}`);
    lines.push("");
  }
  if (comparison.removed.length) {
    lines.push("## Removed test files without an accepted reason");
    lines.push("");
    for (const f of comparison.removed) lines.push(`- ${f}`);
    lines.push("");
  }
  if (comparison.accepted.length) {
    lines.push("## Accepted removals (with reasons, never silent)");
    lines.push("");
    for (const a of comparison.accepted) lines.push(`- ${a.file}: ${a.reason}`);
    lines.push("");
  }
  return lines.join("\n");
}

// ---- runners (CLI only; unit tests cover the pure functions above) ----

function runQuiet(command, args) {
  try {
    execFileSync(command, args, { cwd: REPO_ROOT, stdio: "ignore" });
    return "pass";
  } catch {
    return "fail";
  }
}

function gitField(args, fallback = "unknown") {
  try {
    return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  } catch {
    return fallback;
  }
}

function captureCurrent(label) {
  const typecheck = runQuiet("npm", ["run", "typecheck", "--silent"]);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "parity-"));
  const vitestOut = path.join(tmpDir, "vitest.json");
  let tests;
  try {
    // A failing suite exits non-zero; the JSON file is still written and
    // is the measurement. Only a missing/unparseable file is a harness error.
    execFileSync(
      "npx",
      ["vitest", "run", "--reporter=json", `--outputFile=${vitestOut}`],
      { cwd: REPO_ROOT, stdio: "ignore" },
    );
  } catch {
    // Non-zero vitest exit = suite failures, not a harness failure.
  }
  if (!fs.existsSync(vitestOut)) {
    throw new Error("parity: vitest produced no JSON output file");
  }
  tests = parseVitestJson(fs.readFileSync(vitestOut, "utf8"), REPO_ROOT);
  const build = runQuiet("npm", ["run", "build", "--silent"]);
  return buildSnapshot({
    label,
    commit: gitField(["rev-parse", "--short", "HEAD"]),
    branch: gitField(["rev-parse", "--abbrev-ref", "HEAD"]),
    typecheck,
    build,
    tests,
  });
}

function loadJson(file, what) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new Error(`parity: cannot read ${what} JSON from ${file}`);
  }
}

function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith("--")) {
      flags[argv[i].slice(2)] = argv[i + 1];
      i += 1;
    }
  }
  return flags;
}

function usage() {
  return [
    "Usage: node scripts/parity.mjs <capture|compare|checklist|check|report> [flags]",
    "  capture --label <label> --out <file>",
    "  compare --baseline <file> [--current <file>] [--removals <file>] [--out <file>]",
    "  checklist",
    "  check --checklist <file>",
    "  report --comparison <file> --baseline <file> --current <file>",
  ].join("\n");
}

function main(argv) {
  const [subcommand, ...rest] = argv;
  const flags = parseFlags(rest);
  try {
    if (subcommand === "capture") {
      if (!flags.label || !flags.out) {
        console.error(usage());
        return 2;
      }
      const snapshot = captureCurrent(flags.label);
      fs.writeFileSync(flags.out, `${JSON.stringify(snapshot, null, 2)}\n`);
      if (!isGreen(snapshot)) {
        console.error(
          "parity: warning: captured snapshot is not green (typecheck/build/test failures recorded); it cannot serve as a compare baseline",
        );
      }
      console.log(`parity: snapshot written to ${flags.out}`);
      return 0;
    }
    if (subcommand === "compare") {
      if (!flags.baseline) {
        console.error(usage());
        return 2;
      }
      const baseline = loadJson(flags.baseline, "baseline");
      const current = flags.current
        ? loadJson(flags.current, "current")
        : captureCurrent("current");
      const acceptedRemovals = flags.removals
        ? loadJson(flags.removals, "accepted removals")
        : {};
      const comparison = compareSnapshots(baseline, current, { acceptedRemovals });
      if (flags.out) {
        fs.writeFileSync(flags.out, `${JSON.stringify(comparison, null, 2)}\n`);
      }
      console.log(renderReport(comparison, baseline, current));
      return comparison.pass ? 0 : 1;
    }
    if (subcommand === "checklist") {
      console.log(CHECKLIST_TEMPLATE);
      return 0;
    }
    if (subcommand === "check") {
      if (!flags.checklist) {
        console.error(usage());
        return 2;
      }
      const result = validateChecklist(fs.readFileSync(flags.checklist, "utf8"));
      if (result.pass) {
        console.log("parity: checklist complete");
        return 0;
      }
      console.error(`parity: checklist incomplete, missing groups: ${result.missing.join(", ")}`);
      return 1;
    }
    if (subcommand === "report") {
      if (!flags.comparison || !flags.baseline || !flags.current) {
        console.error(usage());
        return 2;
      }
      console.log(
        renderReport(
          loadJson(flags.comparison, "comparison"),
          loadJson(flags.baseline, "baseline"),
          loadJson(flags.current, "current"),
        ),
      );
      return 0;
    }
    console.error(usage());
    return 2;
  } catch (err) {
    // Harness failure: reported, never skipped, never masked as a pass.
    console.error(`parity: harness failure: ${err.message}`);
    return 2;
  }
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH;
if (isMain) {
  process.exit(main(process.argv.slice(2)));
}
