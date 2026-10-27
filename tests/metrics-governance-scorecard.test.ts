import { describe, expect, it } from "vitest";
import {
  REQUIRED_CHECKS,
  buildScorecard,
  classifyCheckRuns,
  firstPassForCommits,
  parseLedger,
} from "../scripts/metrics/governance-scorecard.mjs";

const run = (name: string, conclusion: string, status = "completed") => ({
  name,
  conclusion,
  status,
  created_at: "2026-10-27T00:00:00Z",
  updated_at: "2026-10-27T00:00:00Z",
});

const allSuccess = () => REQUIRED_CHECKS.map((n) => run(n, "success"));

describe("classifyCheckRuns", () => {
  it("passes when every required check succeeded", () => {
    expect(classifyCheckRuns(allSuccess())).toBe("pass");
  });

  it("fails when any required check failed", () => {
    const runs = allSuccess();
    runs[1] = run(runs[1].name, "failure");
    expect(classifyCheckRuns(runs)).toBe("fail");
  });

  it("treats timed_out as a failure", () => {
    const runs = allSuccess();
    runs[0] = run(runs[0].name, "timed_out");
    expect(classifyCheckRuns(runs)).toBe("fail");
  });

  it("treats all-cancelled as cancelled-only, never a failure", () => {
    expect(classifyCheckRuns(REQUIRED_CHECKS.map((n) => run(n, "cancelled")))).toBe("cancelled-only");
  });

  it("treats a success/cancelled mix with no failure as cancelled-only (superseded attempt)", () => {
    const runs = allSuccess();
    runs[2] = run(runs[2].name, "cancelled");
    expect(classifyCheckRuns(runs)).toBe("cancelled-only");
  });

  it("is incomplete when a required check is missing or still running", () => {
    expect(classifyCheckRuns(allSuccess().slice(0, 3))).toBe("incomplete");
    const runs = allSuccess();
    runs[0] = run(runs[0].name, "success", "in_progress");
    expect(classifyCheckRuns(runs)).toBe("incomplete");
  });

  it("deduplicates by check name, latest run wins (re-run leaves cancelled + success)", () => {
    const runs = allSuccess();
    runs.push({ ...run("Policy Gate", "cancelled"), created_at: "2026-10-27T00:00:00Z", updated_at: "2026-10-27T00:00:00Z" });
    const older = { ...run("Policy Gate", "success"), created_at: "2026-10-26T00:00:00Z", updated_at: "2026-10-26T00:00:00Z" };
    expect(classifyCheckRuns([older, ...runs])).toBe("cancelled-only");
  });
});

describe("firstPassForCommits", () => {
  it("skips cancelled-only heads and takes the first decisive verdict", () => {
    expect(
      firstPassForCommits([
        { sha: "a", runs: REQUIRED_CHECKS.map((n) => run(n, "cancelled")) },
        { sha: "b", runs: allSuccess() },
      ]),
    ).toBe("pass");
    expect(
      firstPassForCommits([
        { sha: "a", runs: allSuccess() },
        { sha: "b", runs: REQUIRED_CHECKS.map((n) => run(n, "failure")) },
      ]),
    ).toBe("pass");
  });

  it("is unknown when no commit is decisive", () => {
    expect(
      firstPassForCommits([
        { sha: "a", runs: REQUIRED_CHECKS.map((n) => run(n, "cancelled")) },
        { sha: "b", runs: allSuccess().slice(0, 2) },
      ]),
    ).toBe("unknown");
  });
});

describe("parseLedger", () => {
  it("matches the Follow-ups ledger marker case-insensitively and handles empty bodies", () => {
    expect(parseLedger("## Follow-ups ledger\n- item")).toBe(true);
    expect(parseLedger("follow-ups LEDGER: none")).toBe(true);
    expect(parseLedger("nothing here")).toBe(false);
    expect(parseLedger(null)).toBe(false);
  });
});

describe("buildScorecard", () => {
  it("reports counts, both rates, and lists failures and unledgered issues", () => {
    const md = buildScorecard({
      windowStart: "2026-09-27",
      windowEnd: "2026-10-27",
      prs: [
        { number: 1, title: "good", url: "https://example.test/1", firstPass: "pass" },
        { number: 2, title: "bad", url: "https://example.test/2", firstPass: "fail" },
        { number: 3, title: "mystery", url: "https://example.test/3", firstPass: "unknown" },
      ],
      issues: [
        { number: 10, title: "with ledger", url: "https://example.test/10", ledger: true, labels: ["bug"] },
        { number: 11, title: "no ledger", url: "https://example.test/11", ledger: false, labels: ["ent-arch"] },
      ],
      openIssues: [{ number: 20, labels: ["bug"] }],
      truncated: [],
    });
    expect(md).toContain("<!-- governance-scorecard -->");
    expect(md).toContain("Merged PRs: 3 (first-pass pass 1, fail 1, unknown 1)");
    expect(md).toContain("33.3% of all PRs; 50.0% of decisive PRs");
    expect(md).toContain("https://example.test/2");
    expect(md).toContain("https://example.test/3");
    expect(md).toContain("with a Follow-ups ledger: 1 (50.0%)");
    expect(md).toContain("https://example.test/11");
    expect(md).toContain("bug 1");
    expect(md).toContain("ent-arch 1");
  });
});
