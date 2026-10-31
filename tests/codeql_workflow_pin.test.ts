/**
 * Pin CodeQL workflow runner to ubuntu-24.04 and action version to v4 (issue #1312, #2505, #2537).
 *
 * Prevents regressions back to unpinned ubuntu-latest (which drifts to Ubuntu 26,
 * causing segfaults per incident #596) and ensures CodeQL actions are bumped to v4
 * before v3 deprecation.
 *
 * CodeQL merge_group and pull_request gates (#2505, #2537):
 * the analyze job must run on merge_group and pull_request (to satisfy ruleset 25543527
 * required status checks on PR branch heads), and must keep the job name
 * "Analyze (javascript-typescript)" unchanged.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const workflow = readFileSync(
  new URL("../.github/workflows/codeql.yml", import.meta.url),
  "utf-8"
);

describe("codeql.yml — runner pin and v4 action bump (#1312)", () => {
  it("pins the runner to ubuntu-24.04 instead of ubuntu-latest", () => {
    expect(workflow).toMatch(/runs-on:\s*ubuntu-24\.04/);
    expect(workflow).not.toMatch(/runs-on:\s*ubuntu-latest/);
  });

  it("bumps CodeQL actions to v4 and contains no deprecated v3 references", () => {
    expect(workflow).toContain("uses: github/codeql-action/init@v4");
    expect(workflow).toContain("uses: github/codeql-action/autobuild@v4");
    expect(workflow).toContain("uses: github/codeql-action/analyze@v4");
    expect(workflow).not.toContain("github/codeql-action/init@v3");
    expect(workflow).not.toContain("github/codeql-action/autobuild@v3");
    expect(workflow).not.toContain("github/codeql-action/analyze@v3");
  });

  it("includes merge_group event trigger for queue validation", () => {
    expect(workflow).toMatch(/^\s*merge_group:\s*$/m);
  });

  it("includes pull_request event trigger for PR head ruleset 25543527 check satisfaction (#2537)", () => {
    expect(workflow).toMatch(/^\s*pull_request:\s*$/m);
  });

  it("includes workflow_dispatch event trigger for manual and bot dispatch", () => {
    expect(workflow).toMatch(/^\s*workflow_dispatch:\s*$/m);
  });

  it("runs the analyze job as a required gate (no merge_group skip)", () => {
    expect(workflow).not.toContain("if: github.event_name != 'merge_group'");
    expect(workflow).toContain("name: Analyze (javascript-typescript)");
  });

  it("has a docs-only early-exit before Initialize CodeQL", () => {
    expect(workflow).toContain("docs_only");
    expect(workflow).toContain("steps.docs.outputs.docs_only != 'true'");
  });
});
