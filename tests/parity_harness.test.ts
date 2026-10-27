/**
 * tests/parity_harness.test.ts
 *
 * The test-parity harness (issue #1746) is the program-wide discipline
 * that items 1–9 enforced manually: a refactor PR captures a baseline
 * suite snapshot, compares old vs new behavior, and carries a parity
 * checklist into its §15. These tests pin the harness contract:
 * - vitest JSON output parses into per-file aggregates + failed names;
 * - comparison fails on exactly the silent-weakening shapes (new
 *   failures, typecheck/build regressions, unlisted removals, a red
 *   baseline) and passes on growth;
 * - removals are never silent: an accepted removal needs a reason and
 *   is reported as accepted, not hidden;
 * - the per-PR checklist validates only when every required group is
 *   checked, with the pin group accepting either "updates listed" or
 *   "none declared";
 * - the rendered §15 report carries verdict, failures, accepted
 *   removals with reasons, and counts.
 */
import { describe, it, expect } from "vitest";
import {
  parseVitestJson,
  compareSnapshots,
  validateChecklist,
  renderReport,
  CHECKLIST_GROUPS,
} from "../scripts/parity.mjs";

const ROOT = "/repo";

function vitestJson(files: Array<{
  name: string;
  status: string;
  tests: Array<{ title: string; status: string }>;
}>) {
  return JSON.stringify({
    numTotalTestSuites: files.length,
    numPassedTestSuites: files.filter((f) => f.status === "passed").length,
    numFailedTestSuites: files.filter((f) => f.status === "failed").length,
    numTotalTests: files.reduce((n, f) => n + f.tests.length, 0),
    numPassedTests: files.reduce(
      (n, f) => n + f.tests.filter((t) => t.status === "passed").length,
      0,
    ),
    numFailedTests: files.reduce(
      (n, f) => n + f.tests.filter((t) => t.status === "failed").length,
      0,
    ),
    numPendingTests: files.reduce(
      (n, f) => n + f.tests.filter((t) => t.status === "pending").length,
      0,
    ),
    testResults: files.map((f) => ({
      name: `${ROOT}/${f.name}`,
      status: f.status,
      assertionResults: f.tests.map((t) => ({
        title: t.title,
        fullName: `group > ${t.title}`,
        status: t.status,
      })),
    })),
  });
}

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    kind: "parity-baseline",
    label: "test",
    commit: "abc1234",
    branch: "main",
    createdAt: "2026-10-27T00:00:00.000Z",
    typecheck: "pass",
    build: "pass",
    tests: {
      files: 2,
      passed: 3,
      failed: 0,
      skipped: 0,
      total: 3,
      byFile: {
        "tests/a.test.ts": { passed: 2, failed: 0, skipped: 0, total: 2 },
        "tests/b.test.ts": { passed: 1, failed: 0, skipped: 0, total: 1 },
      },
      failedTests: [],
    },
    ...overrides,
  };
}

describe("parseVitestJson", () => {
  it("aggregates per-file results and relativizes paths", () => {
    const raw = vitestJson([
      {
        name: "tests/a.test.ts",
        status: "passed",
        tests: [
          { title: "one", status: "passed" },
          { title: "two", status: "passed" },
        ],
      },
      {
        name: "tests/b.test.ts",
        status: "failed",
        tests: [
          { title: "three", status: "passed" },
          { title: "four", status: "failed" },
        ],
      },
    ]);
    const summary = parseVitestJson(raw, ROOT);
    expect(summary.files).toBe(2);
    expect(summary.passed).toBe(3);
    expect(summary.failed).toBe(1);
    expect(summary.total).toBe(4);
    expect(summary.byFile["tests/a.test.ts"]).toEqual({
      passed: 2,
      failed: 0,
      skipped: 0,
      total: 2,
    });
    expect(summary.byFile["tests/b.test.ts"].failed).toBe(1);
    expect(summary.failedTests).toEqual(["tests/b.test.ts > group > four"]);
  });

  it("counts pending as skipped", () => {
    const raw = vitestJson([
      {
        name: "tests/a.test.ts",
        status: "passed",
        tests: [{ title: "one", status: "pending" }],
      },
    ]);
    const summary = parseVitestJson(raw, ROOT);
    expect(summary.skipped).toBe(1);
    expect(summary.total).toBe(1);
  });

  it("falls back to suite status when assertionResults are absent", () => {
    const raw = JSON.stringify({
      testResults: [{ name: `${ROOT}/tests/a.test.ts`, status: "failed" }],
    });
    const summary = parseVitestJson(raw, ROOT);
    expect(summary.byFile["tests/a.test.ts"].failed).toBe(1);
    expect(summary.failed).toBe(1);
  });

  it("throws on unparseable output instead of publishing a half-snapshot", () => {
    expect(() => parseVitestJson("not json", ROOT)).toThrow();
    expect(() => parseVitestJson(JSON.stringify({}), ROOT)).toThrow();
  });
});

describe("compareSnapshots", () => {
  it("passes on identical snapshots", () => {
    const result = compareSnapshots(snapshot(), snapshot());
    expect(result.pass).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it("passes when the current run only adds passing files", () => {
    const current = snapshot();
    current.tests.byFile["tests/c.test.ts"] = {
      passed: 5,
      failed: 0,
      skipped: 0,
      total: 5,
    };
    current.tests.files = 3;
    current.tests.passed = 8;
    current.tests.total = 8;
    const result = compareSnapshots(snapshot(), current);
    expect(result.pass).toBe(true);
    expect(result.added).toEqual(["tests/c.test.ts"]);
  });

  it("fails when a previously passing file gains failures, naming the test", () => {
    const current = snapshot();
    current.tests.byFile["tests/b.test.ts"] = {
      passed: 0,
      failed: 1,
      skipped: 0,
      total: 1,
    };
    current.tests.failed = 1;
    current.tests.failedTests = ["tests/b.test.ts > breaks now"];
    const result = compareSnapshots(snapshot(), current);
    expect(result.pass).toBe(false);
    expect(result.failures.join(" ")).toContain("tests/b.test.ts");
    expect(result.failures.join(" ")).toContain("tests/b.test.ts > breaks now");
  });

  it("fails on typecheck and build regressions", () => {
    expect(
      compareSnapshots(snapshot(), snapshot({ typecheck: "fail" })).failures
        .join(" "),
    ).toContain("typecheck");
    expect(
      compareSnapshots(snapshot(), snapshot({ build: "fail" })).failures.join(
        " ",
      ),
    ).toContain("build");
  });

  it("refuses a red baseline: parity is undefined against red", () => {
    const red = snapshot();
    red.tests.failed = 1;
    red.tests.failedTests = ["tests/a.test.ts > already broken"];
    const result = compareSnapshots(red, snapshot());
    expect(result.pass).toBe(false);
    expect(result.failures.join(" ")).toContain("baseline is not green");
  });

  it("fails on unlisted removals and passes on removals accepted with a reason", () => {
    const current = snapshot();
    delete current.tests.byFile["tests/b.test.ts"];
    current.tests.files = 1;
    current.tests.passed = 2;
    current.tests.total = 2;
    const unlisted = compareSnapshots(snapshot(), current);
    expect(unlisted.pass).toBe(false);
    expect(unlisted.removed).toEqual(["tests/b.test.ts"]);

    const accepted = compareSnapshots(snapshot(), current, {
      acceptedRemovals: { "tests/b.test.ts": "folded into tests/a.test.ts" },
    });
    expect(accepted.pass).toBe(true);
    expect(accepted.accepted).toEqual([
      { file: "tests/b.test.ts", reason: "folded into tests/a.test.ts" },
    ]);
  });
});

describe("validateChecklist", () => {
  const full = CHECKLIST_GROUPS.map((g) => `- [x] ${g.alternatives[0]}`).join(
    "\n",
  );

  it("passes when every required group is checked", () => {
    expect(validateChecklist(full).pass).toBe(true);
  });

  it("fails listing the missing group when a box is unchecked or absent", () => {
    const unchecked = full.replace(
      "- [x] Baseline snapshot captured",
      "- [ ] Baseline snapshot captured",
    );
    const result = validateChecklist(unchecked);
    expect(result.pass).toBe(false);
    expect(result.missing).toContain("baseline");
  });

  it("accepts the no-pin-updates declaration for the pin group", () => {
    const noPins = full.replace(
      "- [x] Pin updates in the same PR",
      "- [x] No pin updates in this PR",
    );
    expect(validateChecklist(noPins).pass).toBe(true);
  });

  it("ignores unchecked lines and non-checklist prose", () => {
    const result = validateChecklist(
      `# Parity checklist\n\nSome prose mentioning Gate green in passing.\n\n${full}`,
    );
    expect(result.pass).toBe(true);
  });
});

describe("renderReport", () => {
  it("carries verdict, failures, accepted removals with reasons, and counts", () => {
    const current = snapshot();
    delete current.tests.byFile["tests/b.test.ts"];
    current.tests.files = 1;
    const comparison = compareSnapshots(snapshot(), current, {
      acceptedRemovals: { "tests/b.test.ts": "folded into tests/a.test.ts" },
    });
    const report = renderReport(comparison, snapshot(), current);
    expect(report).toContain("PASS");
    expect(report).toContain("folded into tests/a.test.ts");
    expect(report).toContain("tests/b.test.ts");
    expect(report).toContain("2");
  });

  it("marks a failing comparison FAIL with the failure lines", () => {
    const current = snapshot();
    current.tests.byFile["tests/b.test.ts"] = {
      passed: 0,
      failed: 1,
      skipped: 0,
      total: 1,
    };
    current.tests.failed = 1;
    current.tests.failedTests = ["tests/b.test.ts > breaks now"];
    const comparison = compareSnapshots(snapshot(), current);
    const report = renderReport(comparison, snapshot(), current);
    expect(report).toContain("FAIL");
    expect(report).toContain("tests/b.test.ts > breaks now");
  });
});
