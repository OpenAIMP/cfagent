/**
 * CI/CD Optimization, Integrity, and Velocity Guards (#2497).
 *
 * Verifies:
 * 1. policy-gate.yml runs on both pull_request and merge_group so Merge Queue
 *    never hangs waiting for the required "Policy Gate" check.
 * 2. ci.yml computes the commit's git tree SHA (HEAD^{tree}) in load-environment,
 *    skips fast-gates and test-shard when the identical tree was already verified,
 *    and keeps test-and-verify on if: always() so the required check is always published.
 * 3. gitleaks.yml uses the open-source gitleaks CLI binary instead of the
 *    organization-license-gated gitleaks-action@v2.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const policyGateYml = readFileSync(
  new URL("../.github/workflows/policy-gate.yml", import.meta.url),
  "utf-8"
);
const ciYml = readFileSync(
  new URL("../.github/workflows/ci.yml", import.meta.url),
  "utf-8"
);
const gitleaksYml = readFileSync(
  new URL("../.github/workflows/gitleaks.yml", import.meta.url),
  "utf-8"
);

describe("CI/CD Merge Queue + Policy Gate + Tree-Hash Deduplication (#2497)", () => {
  it("triggers Policy Gate on merge_group as well as open pull_requests", () => {
    expect(policyGateYml).toMatch(/^\s*merge_group:\s*$/m);
    expect(policyGateYml).toContain(
      "if: github.event_name == 'merge_group' || github.event.pull_request.state == 'open'"
    );
  });

  it("deduplicates CI test execution by git tree SHA while always publishing the required check", () => {
    expect(ciYml).toContain("git rev-parse 'HEAD^{tree}'");
    expect(ciYml).toContain("tree_already_verified");
    expect(ciYml).toContain("if: needs.load-environment.outputs.tree_already_verified != 'true'");
    expect(ciYml).toContain("if: always()");
    expect(ciYml).toContain("Test & Build (Node 22) [${{ needs.load-environment.outputs.target_env }}]");
  });

  it("runs open-source gitleaks CLI without requiring a paid org license action", () => {
    expect(gitleaksYml).toContain("gitleaks git --log-opts=");
    expect(gitleaksYml).not.toContain("uses: gitleaks/gitleaks-action@v2");
  });
});
