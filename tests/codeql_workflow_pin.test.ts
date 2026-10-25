/**
 * Pin CodeQL workflow runner to ubuntu-24.04 and action version to v4 (issue #1312).
 *
 * Prevents regressions back to unpinned ubuntu-latest (which drifts to Ubuntu 26,
 * causing segfaults per incident #596) and ensures CodeQL actions are bumped to v4
 * before v3 deprecation.
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

  it("includes workflow_dispatch event trigger for manual and bot dispatch", () => {
    expect(workflow).toMatch(/^\s*workflow_dispatch:\s*$/m);
  });
});
