/**
 * Tests for .github/workflows/auto-update-prs.yml and workflow runner standardization.
 *
 * Ensures auto-update-prs workflow triggers on push to main, uses actions/github-script@v7,
 * handles pagination, and that all repo workflows use pinned ubuntu-24.04 runners.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const workflowPath = new URL("../.github/workflows/auto-update-prs.yml", import.meta.url);
const workflowContent = readFileSync(workflowPath, "utf-8");

describe("auto-update-prs.yml workflow configuration", () => {
  it("triggers on push to main branch", () => {
    expect(workflowContent).toMatch(/^\s*push:\s*$/m);
    expect(workflowContent).toMatch(/^\s*branches:\s*$/m);
    expect(workflowContent).toMatch(/-\s*main/);
  });

  it("pins runner to ubuntu-24.04", () => {
    expect(workflowContent).toMatch(/runs-on:\s*ubuntu-24\.04/);
  });

  it("sets required write permissions for pull-requests, contents, and actions", () => {
    expect(workflowContent).toMatch(/pull-requests:\s*write/);
    expect(workflowContent).toMatch(/contents:\s*write/);
    expect(workflowContent).toMatch(/actions:\s*write/);
  });

  it("uses actions/github-script@v7 with pagination, updateBranch API call, and workflow dispatches", () => {
    expect(workflowContent).toContain("uses: actions/github-script@v7");
    expect(workflowContent).toContain("github.paginate(github.rest.pulls.list");
    expect(workflowContent).toContain("github.rest.pulls.updateBranch");
    expect(workflowContent).toContain("github.rest.actions.createWorkflowDispatch");
    expect(workflowContent).toContain("'ci.yml'");
    expect(workflowContent).toContain("'gitleaks.yml'");
    expect(workflowContent).toContain("'codeql.yml'");
    expect(workflowContent).toContain("if (pr.draft) continue;");
  });

  it("skips Dependabot PRs to prevent exponential CI workflow thrash on reference-only PRs", () => {
    expect(workflowContent).toContain("pr.user?.login === 'dependabot[bot]'");
    expect(workflowContent).toContain("isDependabot");
    expect(workflowContent).toContain("Skipping Dependabot PR");
  });
});

describe("workflow runner standardization", () => {
  it("ensures no workflow in .github/workflows uses unpinned ubuntu-latest", () => {
    const workflowsDir = new URL("../.github/workflows", import.meta.url).pathname;
    const files = readdirSync(workflowsDir).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));

    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const content = readFileSync(join(workflowsDir, file), "utf-8");
      expect(content, `${file} should not use ubuntu-latest`).not.toMatch(/runs-on:\s*ubuntu-latest/);
    }
  });
});
