/**
 * Tests for .github/dependabot.yml configuration.
 *
 * Ensures Dependabot configuration enforces limits, disabled rebase strategy,
 * and grouping to keep Dependabot PR volume predictable and minimize CI runs.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const dependabotPath = new URL("../.github/dependabot.yml", import.meta.url);
const dependabotContent = readFileSync(dependabotPath, "utf-8");

describe("dependabot.yml configuration", () => {
  it("uses version 2", () => {
    expect(dependabotContent).toMatch(/^version:\s*2/m);
  });

  it("configures npm ecosystem with open-pull-requests-limit, disabled rebase-strategy, and grouping", () => {
    expect(dependabotContent).toContain('package-ecosystem: "npm"');
    expect(dependabotContent).toContain("open-pull-requests-limit: 1");
    expect(dependabotContent).toContain('rebase-strategy: "disabled"');
    expect(dependabotContent).toContain("npm-dependencies:");
  });

  it("configures github-actions ecosystem with open-pull-requests-limit, disabled rebase-strategy, and grouping", () => {
    expect(dependabotContent).toContain('package-ecosystem: "github-actions"');
    expect(dependabotContent).toContain("actions-dependencies:");
  });
});
