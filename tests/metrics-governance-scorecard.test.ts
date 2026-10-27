import { describe, expect, it } from "vitest";
import {
  REQUIRED_CHECKS,
  buildScorecard,
  buildScorecardHtml,
  buildScorecardIndex,
  classifyCheckRuns,
  escapeHtml,
  firstPassForCommits,
  hasJourney,
  medianHours,
  parseLedger,
  usesTemplate,
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

  it("renders the four COBIT perspectives and reports uncollected metrics as gaps, not zeros", () => {
    const md = buildScorecard({
      windowStart: "2026-09-27",
      windowEnd: "2026-10-27",
      prs: [{ number: 1, title: "good", url: "https://example.test/1", firstPass: "pass" }],
      issues: [],
      openIssues: [],
      truncated: [],
    });
    expect(md).toContain("## Financial");
    expect(md).toContain("## Customer");
    expect(md).toContain("## Internal process");
    expect(md).toContain("## Learning");
    expect(md).toContain("CI minutes in window: not collected.");
    expect(md).toContain("Post-merge red rate: not collected.");
    expect(md).toContain("ADRs added in window: not collected.");
    expect(md).toContain("Template adoption: not collected.");
    expect(md).toContain("User-journey coverage: not collected.");
    expect(md).toContain("Paid-service costs: not recorded");
  });

  it("renders provided balanced metrics and the median time-to-merge", () => {
    const md = buildScorecard({
      windowStart: "2026-09-27",
      windowEnd: "2026-10-27",
      prs: [
        { number: 1, title: "a", url: "https://example.test/1", firstPass: "pass", created_at: "2026-10-01T00:00:00Z", merged_at: "2026-10-01T10:00:00Z" },
        { number: 2, title: "b", url: "https://example.test/2", firstPass: "pass", created_at: "2026-10-02T00:00:00Z", merged_at: "2026-10-03T00:00:00Z" },
      ],
      issues: [],
      openIssues: [],
      truncated: [],
      ciMinutes: 1234,
      postMerge: { total: 20, red: 1 },
      adrCommits: 2,
      templateAdoption: { adopted: 1, total: 2 },
      journeyCoverage: { withJourney: 0, total: 0 },
    });
    expect(md).toContain("CI minutes in window: 1234");
    expect(md).toContain("Post-merge red rate: 1 of 20 decisive main heads red (5.0%)");
    expect(md).toContain("ADRs added in window: 2 commits");
    expect(md).toContain("Template adoption: 1 of 2 merged PRs use the v2 template shape (50.0%)");
    expect(md).toContain("Time-to-merge: median 17 hours");
  });
});

describe("balanced helpers", () => {
  it("medianHours handles odd, even, and empty inputs", () => {
    expect(medianHours([10, 20, 30])).toBe(20);
    expect(medianHours([10, 20])).toBe(15);
    expect(medianHours([])).toBe(null);
    expect(medianHours([5])).toBe(5);
  });

  it("usesTemplate requires both the Agent and Linked issue markers", () => {
    expect(usesTemplate("## Agent\n#x\n## Linked issue\nOpenAIMP/cfagent#1")).toBe(true);
    expect(usesTemplate("## Agent\n#x")).toBe(false);
    expect(usesTemplate(null)).toBe(false);
  });

  it("hasJourney requires a non-empty User journey section", () => {
    expect(hasJourney("## User journey\nAs a user I want X")).toBe(true);
    expect(hasJourney("## User journey\n")).toBe(false);
    expect(hasJourney("no journey here")).toBe(false);
  });

  it("escapeHtml escapes markup in titles and urls", () => {
    expect(escapeHtml('<script>"x"</script>')).toBe("&lt;script&gt;&quot;x&quot;&lt;/script&gt;");
  });
});

describe("buildScorecardHtml", () => {
  it("renders perspectives as HTML and escapes malicious titles", () => {
    const html = buildScorecardHtml({
      windowStart: "2026-09-27",
      windowEnd: "2026-10-27",
      prs: [
        { number: 1, title: "<script>alert(1)</script>", url: "https://example.test/1", firstPass: "fail" },
      ],
      issues: [],
      openIssues: [],
      truncated: [],
    });
    expect(html).toContain("<h2>Financial");
    expect(html).toContain("<h2>Customer");
    expect(html).toContain("<h2>Internal process");
    expect(html).toContain("Learning");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("https://example.test/1");
    expect(html).not.toContain("<script src");
  });
});

describe("buildScorecardIndex", () => {
  it("lists dated scorecards newest-first and links the latest", () => {
    const html = buildScorecardIndex([
      "scorecard-2026-09-01.html",
      "scorecard.html",
      "scorecard-2026-10-01.html",
      "notes.txt",
    ]);
    expect(html).toContain('<a href="scorecard.html">Latest scorecard</a>');
    expect(html.indexOf("2026-10-01")).toBeLessThan(html.indexOf("2026-09-01"));
    expect(html).not.toContain("notes.txt");
  });
});
