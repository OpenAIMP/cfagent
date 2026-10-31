import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

const ciYml = readFileSync(
  new URL("../.github/workflows/ci.yml", import.meta.url),
  "utf8"
);
const policyGateYml = readFileSync(
  new URL("../.github/workflows/policy-gate.yml", import.meta.url),
  "utf8"
);
const autoMergeYml = readFileSync(
  new URL("../.github/workflows/auto-merge-trusted.yml", import.meta.url),
  "utf8"
);
const autoUpdateYml = readFileSync(
  new URL("../.github/workflows/auto-update-prs-app.yml", import.meta.url),
  "utf8"
);

describe("CI/CD deduplication & Merge Queue alignment (#2497, #2499, #2546)", () => {
  it("triggers Policy Gate on both pull_request and merge_group", () => {
    expect(policyGateYml).toMatch(/^\s*merge_group:\s*$/m);
    expect(policyGateYml).toMatch(/^\s*pull_request:\s*$/m);
  });

  it("omits strategy flags (--rebase/--squash/--merge) in auto-merge-trusted.yml (#2519)", () => {
    // When a merge queue is configured, passing any merge strategy flag to
    // `gh pr merge --auto` causes the CLI to emit an error and exit without
    // enqueuing the PR. The workflow must invoke `gh pr merge --auto` with
    // no merge method flag, letting the queue enforce the strategy (REBASE).
    expect(autoMergeYml).toContain("gh pr merge --auto");
    expect(autoMergeYml).not.toMatch(/gh pr merge --auto --(rebase|squash|merge)/);
  });

  it("runs shards in parallel on PR events and runs shards sequentially on merge_group", () => {
    // PR path: 4 shards in matrix, no cross-shard dependencies
    expect(ciYml).toContain("test-shard-pr:");
    expect(ciYml).toContain("shard: [1, 2, 3, 4]");
    expect(ciYml).toContain("if: github.event_name != 'merge_group'");

    // MQ path: single job, 4 iterations in bash loop
    expect(ciYml).toContain("test-shard-mq:");
    expect(ciYml).toContain("if: github.event_name == 'merge_group'");
    expect(ciYml).toContain("for SHARD in 1 2 3 4; do");
  });

  it("preserves required check names and tree deduplication anchor across PR and MQ paths", () => {
    // Both PR shards and MQ job report the exact check-run name the ruleset requires
    expect(ciYml).toContain('name: "Tests PR (shard ${{ matrix.shard }}/4)"');
    expect(ciYml).toContain('name: "Tests MQ (shard ${{ matrix.shard }}/4)"');
    // test-and-verify still reports the required name and accepts all three paths
    expect(ciYml).toContain("needs: [load-environment, fast-gates, test-shard-pr, test-shard-mq]");
    expect(ciYml).toContain("needs.test-shard-pr.result");
    expect(ciYml).toContain("needs.test-shard-mq.result");
    expect(ciYml).toContain("PR event: fast-gates and test-shard-pr passed");
    expect(ciYml).toContain("merge_group event: fast-gates and test-shard-mq passed");
    // Dedup anchor must still recognise the renamed shard jobs (otherwise
    // every merge_group run would re-run the full suite instead of deduping)
    expect(ciYml).toContain('Tests (PR|MQ)');
  });

  it("keeps auto-update-prs-app.yml scoped to unqueued auto-merge PRs so Merge Queue is the sole updater for queued PRs (#2546)", () => {
    expect(autoUpdateYml).toContain("isInMergeQueue");
    expect(autoUpdateYml).toContain("hasAutoMerge");
  });
});
