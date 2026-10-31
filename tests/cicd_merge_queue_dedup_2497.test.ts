/**
 * CI/CD Optimization, Integrity, and Velocity Guards (#2497, #2499).
 *
 * Verifies:
 * 1. policy-gate.yml runs on both pull_request and merge_group and passes GH_TOKEN
 *    so scripts/ci/policy_gate.py evaluates each queued PR individually + aggregate.
 * 2. ci.yml enforces a 24h non-transitive tree-dedup anchor (verifying Fast gates +
 *    all 4 Tests shards concluded success), supports a docs-only fast path inside
 *    load-environment, writes to $GITHUB_STEP_SUMMARY, and keeps test-and-verify on if: always().
 * 3. gitleaks.yml verifies the SHA-256 checksum of the OSS gitleaks binary, scans
 *    merge-base..HEAD on PR/merge_group, and includes a nightly full-history schedule backstop.
 * 4. auto-update-prs-app.yml is disabled in place (if: false) so Merge Queue is the sole updater.
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
const autoUpdateYml = readFileSync(
  new URL("../.github/workflows/auto-update-prs-app.yml", import.meta.url),
  "utf-8"
);

describe("CI/CD Merge Queue + Policy Gate + Tree-Hash Deduplication (#2497, #2499)", () => {
  it("triggers Policy Gate on merge_group with GH_TOKEN for per-PR evaluation", () => {
    expect(policyGateYml).toMatch(/^\s*merge_group:\s*$/m);
    expect(policyGateYml).toContain(
      "if: github.event_name == 'merge_group' || github.event.pull_request.state == 'open'"
    );
    expect(policyGateYml).toContain("GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}");
  });

  it("enforces non-transitive 24h tree-dedup anchor, docs-only fast path, and step summary audit trail", () => {
    expect(ciYml).toContain("git rev-parse 'HEAD^{tree}'");
    expect(ciYml).toContain("verify_anchor_jobs()");
    expect(ciYml).toContain("24 hours ago");
    expect(ciYml).toContain("docs_only");
    expect(ciYml).toContain("GITHUB_STEP_SUMMARY");
    expect(ciYml).toContain("if: needs.load-environment.outputs.tree_already_verified != 'true'");
    expect(ciYml).toContain("if: always()");
    expect(ciYml).toContain("Test & Build (Node 22) [${{ needs.load-environment.outputs.target_env }}]");
  });

  it("pins OSS gitleaks SHA-256 checksum, scans merge-base..HEAD, and runs a nightly full-history backstop", () => {
    expect(gitleaksYml).toContain("fa0500f6b7e41d28791ebc680f5dd9899cd42b58629218a5f041efa899151a8e");
    expect(gitleaksYml).toContain("sha256sum --check --strict");
    expect(gitleaksYml).toContain('gitleaks git --log-opts="${BASE_MERGE}..HEAD"');
    expect(gitleaksYml).toMatch(/^\s*schedule:\s*$/m);
    expect(gitleaksYml).not.toContain("uses: gitleaks/gitleaks-action@v2");
  });

  it("retires auto-update-prs-app.yml in place with if: false so Merge Queue is the sole updater", () => {
    expect(autoUpdateYml).toMatch(/^\s*if:\s*false\s*$/m);
  });
});
