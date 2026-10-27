/**
 * Policy Gate Guards Tests (#1684)
 *
 * Verifies that scripts/ci/policy_gate.py reliably enforces:
 * - (a) linked issue presence
 * - (b) lane label (lane:*)
 * - (c) agent hashtag (#<agent>-<id>)
 * - (d) CHANGELOG entry under ## [Unreleased]
 * - (e) docs scope guard (docs PR cannot touch code/tests)
 * - (f) stale base reversion guard (cannot delete recently merged main additions)
 * - (g) test deletion guard (cannot delete tests without allow-test-deletion)
 * - (h) process documentation line (gitops §23: PR body must carry the
 *   §9 "Process documentation impact:" checklist line, presence only)
 *
 * Uses an isolated, temporary git repository to ensure deterministic test
 * execution across all environments and shallow CI clones.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";

const PYTHON_BIN = process.platform === "win32" ? "python" : "python3";
const SCRIPT_PATH = path.resolve(__dirname, "../scripts/ci/policy_gate.py");

let tempRepoDir = "";

function runGit(repoDir: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: repoDir,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function runPolicyGate(
  env: Record<string, string>,
  args: string[] = ["--base", "main", "--head", "HEAD"],
  cwd: string = tempRepoDir
): { stdout: string; status: number } {
  try {
    const stdout = execFileSync(PYTHON_BIN, [SCRIPT_PATH, ...args], {
      env: { ...process.env, ...env },
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { stdout, status: 0 };
  } catch (err: any) {
    const stdout = (err.stdout || "") + "\n" + (err.stderr || "");
    return { stdout, status: err.status ?? 1 };
  }
}

describe("Policy Gate Guards (#1684)", () => {
  beforeAll(() => {
    tempRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), "cfagent-policy-test-"));
    runGit(tempRepoDir, ["init", "-b", "main"]);
    runGit(tempRepoDir, ["config", "user.email", "test@example.com"]);
    runGit(tempRepoDir, ["config", "user.name", "Test Runner"]);

    // Initial structure: CHANGELOG, src file, test file
    fs.mkdirSync(path.join(tempRepoDir, "src"), { recursive: true });
    fs.mkdirSync(path.join(tempRepoDir, "tests"), { recursive: true });

    fs.writeFileSync(
      path.join(tempRepoDir, "CHANGELOG.md"),
      "# Changelog\n\n## [Unreleased]\n\n- Base initial unreleased change\n"
    );
    fs.writeFileSync(path.join(tempRepoDir, "src", "index.ts"), "export const a = 1;\n");
    fs.writeFileSync(
      path.join(tempRepoDir, "tests", "unit.test.ts"),
      "test('truthy', () => {});\n"
    );

    runGit(tempRepoDir, ["add", "-A"]);
    runGit(tempRepoDir, ["commit", "-m", "chore: initial commit"]);

    // Branch 1: docs PR that improperly touches a src file
    runGit(tempRepoDir, ["checkout", "-b", "branch-docs-scope-violation"]);
    fs.appendFileSync(path.join(tempRepoDir, "src", "index.ts"), "export const b = 2;\n");
    runGit(tempRepoDir, ["commit", "-am", "docs: update docs but touch src"]);

    // Branch 2: branch deleting a test file
    runGit(tempRepoDir, ["checkout", "main"]);
    runGit(tempRepoDir, ["checkout", "-b", "branch-test-deletion"]);
    fs.unlinkSync(path.join(tempRepoDir, "tests", "unit.test.ts"));
    runGit(tempRepoDir, ["commit", "-am", "refactor: delete test file"]);

    // Branch 3: stale base branch that reverts a file added to main
    runGit(tempRepoDir, ["checkout", "main"]);
    runGit(tempRepoDir, ["checkout", "-b", "branch-stale-reversion"]);
    // Advance main with a newly added file
    runGit(tempRepoDir, ["checkout", "main"]);
    fs.writeFileSync(path.join(tempRepoDir, "src", "new_feature.ts"), "export const newF = true;\n");
    runGit(tempRepoDir, ["add", "-A"]);
    runGit(tempRepoDir, ["commit", "-m", "feat: new feature on main"]);

    // Branch 4: fully valid compliant feature branch
    runGit(tempRepoDir, ["checkout", "main"]);
    runGit(tempRepoDir, ["checkout", "-b", "branch-compliant"]);
    fs.writeFileSync(
      path.join(tempRepoDir, "CHANGELOG.md"),
      "# Changelog\n\n## [Unreleased]\n\n- **Awesome feature (#1684):** compliant change #CTO-mbshr\n- Base initial unreleased change\n"
    );
    fs.writeFileSync(path.join(tempRepoDir, "src", "feature.ts"), "export const feat = 1;\n");
    runGit(tempRepoDir, ["add", "-A"]);
    runGit(tempRepoDir, ["commit", "-m", "feat: valid feature"]);

    // Branch 5: fragment-only PR (issue #1801) — no CHANGELOG change.
    runGit(tempRepoDir, ["checkout", "main"]);
    runGit(tempRepoDir, ["checkout", "-b", "branch-fragment"]);
    fs.mkdirSync(path.join(tempRepoDir, "changelog.d"), { recursive: true });
    fs.writeFileSync(
      path.join(tempRepoDir, "changelog.d", "1684-feature.md"),
      "### Added\n\n- **Fragment feature (#1684):** changelog.d entry\n"
    );
    runGit(tempRepoDir, ["add", "-A"]);
    runGit(tempRepoDir, ["commit", "-m", "feat: fragment-only change"]);

    // Branch 6: header-only fragment — passes no gate: no entry line.
    runGit(tempRepoDir, ["checkout", "main"]);
    runGit(tempRepoDir, ["checkout", "-b", "branch-fragment-empty"]);
    fs.mkdirSync(path.join(tempRepoDir, "changelog.d"), { recursive: true });
    fs.writeFileSync(path.join(tempRepoDir, "changelog.d", "1684-empty.md"), "### Added\n");
    runGit(tempRepoDir, ["add", "-A"]);
    runGit(tempRepoDir, ["commit", "-m", "feat: header-only fragment"]);

    // Branch 7: neither a CHANGELOG entry nor a fragment.
    runGit(tempRepoDir, ["checkout", "main"]);
    runGit(tempRepoDir, ["checkout", "-b", "branch-no-changelog"]);
    fs.writeFileSync(path.join(tempRepoDir, "src", "nochange.ts"), "export const n = 1;\n");
    runGit(tempRepoDir, ["add", "-A"]);
    runGit(tempRepoDir, ["commit", "-m", "feat: no changelog at all"]);
  });

  afterAll(() => {
    if (tempRepoDir && fs.existsSync(tempRepoDir)) {
      try {
        fs.rmSync(tempRepoDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup error on Windows
      }
    }
  });

  it("rejects PR missing linked issue", () => {
    const res = runPolicyGate({
      PR_TITLE: "feat: add awesome feature",
      PR_BODY: "## Agent\n#CTO-mbshr",
      PR_LABELS: "lane:cto-mbshr",
    });
    expect(res.status).toBe(1);
    expect(res.stdout).toContain("(a) linked issue");
  });

  it("rejects PR missing lane label or agent hashtag in body", () => {
    const res = runPolicyGate({
      PR_TITLE: "feat: add awesome feature (#100)",
      PR_BODY: "Fixes #100\nNo agent hashtag here",
      PR_LABELS: "unrelated-label",
    });
    expect(res.status).toBe(1);
    expect(res.stdout).toContain("(b) lane label");
  });

  it("rejects PR missing agent hashtag", () => {
    const res = runPolicyGate({
      PR_TITLE: "feat: add awesome feature (#100)",
      PR_BODY: "Fixes #100",
      PR_LABELS: "lane:cto-mbshr",
    });
    expect(res.status).toBe(1);
    expect(res.stdout).toContain("(c) agent hashtag");
  });

  it("catches docs-scoped PRs touching code files", () => {
    const res = runPolicyGate(
      {
        PR_TITLE: "docs(architecture): update architecture docs (#1684) #CTO-mbshr",
        PR_BODY: "Fixes #1684\n## Agent\n#CTO-mbshr",
        PR_LABELS: "lane:cto-mbshr",
      },
      ["--base", "main", "--head", "branch-docs-scope-violation"]
    );
    expect(res.status).toBe(1);
    expect(res.stdout).toContain("(e) docs scope");
  });

  it("rejects test deletion without allow-test-deletion label", () => {
    const resWithoutLabel = runPolicyGate(
      {
        PR_TITLE: "refactor: cleanup tests (#1684) #CTO-mbshr",
        PR_BODY: "Fixes #1684\n## Agent\n#CTO-mbshr",
        PR_LABELS: "lane:cto-mbshr",
      },
      ["--base", "main", "--head", "branch-test-deletion"]
    );
    expect(resWithoutLabel.status).toBe(1);
    expect(resWithoutLabel.stdout).toContain("(g) test deletion");
  });

  it("allows test deletion when explicitly authorized with allow-test-deletion label", () => {
    const resWithLabel = runPolicyGate(
      {
        PR_TITLE: "refactor: retirement cleanup (#1684) #CTO-mbshr",
        PR_BODY: "Fixes #1684\n## Agent\n#CTO-mbshr",
        PR_LABELS: "lane:cto-mbshr allow-test-deletion",
      },
      ["--base", "main", "--head", "branch-test-deletion"]
    );
    expect(resWithLabel.stdout).not.toContain("(g) test deletion");
  });

  it("rejects PR cut from stale base that reverts newly added main files", () => {
    const resStale = runPolicyGate(
      {
        PR_TITLE: "feat: stale branch work (#1684) #CTO-mbshr",
        PR_BODY: "Fixes #1684\n## Agent\n#CTO-mbshr",
        PR_LABELS: "lane:cto-mbshr",
      },
      ["--base", "main", "--head", "branch-stale-reversion"]
    );
    expect(resStale.status).toBe(1);
    expect(resStale.stdout).toContain("(f) stale base reversion");
  });

  it("validates that a compliant PR format passes all policy gate checks", () => {
    runGit(tempRepoDir, ["checkout", "branch-compliant"]);
    const res = runPolicyGate(
      {
        PR_TITLE: "feat: add awesome feature (#1684) #CTO-mbshr",
        PR_BODY: "Fixes #1684\n\n## Agent\n#CTO-mbshr\n\n- [ ] Process documentation impact: none",
        PR_LABELS: "lane:cto-mbshr",
      },
      ["--base", "main", "--head", "branch-compliant"]
    );
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("Policy gate passed");
  });

  it("passes Policy Gate (d) with only a changelog.d fragment (issue #1801)", () => {
    runGit(tempRepoDir, ["checkout", "branch-fragment"]);
    const res = runPolicyGate(
      {
        PR_TITLE: "feat: fragment-only change (#1684) #CTO-mbshr",
        PR_BODY: "Fixes #1684\n\n## Agent\n#CTO-mbshr\n\n- [ ] Process documentation impact: none",
        PR_LABELS: "lane:cto-mbshr",
      },
      ["--base", "main", "--head", "branch-fragment"]
    );
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("Policy gate passed");
  });

  it("rejects a header-only changelog.d fragment with no entry line", () => {
    runGit(tempRepoDir, ["checkout", "branch-fragment-empty"]);
    const res = runPolicyGate(
      {
        PR_TITLE: "feat: header-only fragment (#1684) #CTO-mbshr",
        PR_BODY: "Fixes #1684\n\n## Agent\n#CTO-mbshr",
        PR_LABELS: "lane:cto-mbshr",
      },
      ["--base", "main", "--head", "branch-fragment-empty"]
    );
    expect(res.status).toBe(1);
    expect(res.stdout).toContain("(d) CHANGELOG");
  });

  it("rejects a PR missing the process documentation checklist line (gitops §23)", () => {
    runGit(tempRepoDir, ["checkout", "branch-compliant"]);
    const res = runPolicyGate(
      {
        PR_TITLE: "feat: add awesome feature (#1684) #CTO-mbshr",
        PR_BODY: "Fixes #1684\n\n## Agent\n#CTO-mbshr",
        PR_LABELS: "lane:cto-mbshr",
      },
      ["--base", "main", "--head", "branch-compliant"]
    );
    expect(res.status).toBe(1);
    expect(res.stdout).toContain("(h) process documentation");
  });

  it("passes Policy Gate (h) when the process documentation line is present", () => {
    runGit(tempRepoDir, ["checkout", "branch-compliant"]);
    const res = runPolicyGate(
      {
        PR_TITLE: "feat: add awesome feature (#1684) #CTO-mbshr",
        PR_BODY:
          "Fixes #1684\n\n## Agent\n#CTO-mbshr\n\n- [ ] Process documentation impact: none",
        PR_LABELS: "lane:cto-mbshr",
      },
      ["--base", "main", "--head", "branch-compliant"]
    );
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("Policy gate passed");
  });

  it("rejects a PR with neither a CHANGELOG entry nor a fragment", () => {
    runGit(tempRepoDir, ["checkout", "branch-no-changelog"]);
    const res = runPolicyGate(
      {
        PR_TITLE: "feat: no changelog at all (#1684) #CTO-mbshr",
        PR_BODY: "Fixes #1684\n\n## Agent\n#CTO-mbshr",
        PR_LABELS: "lane:cto-mbshr",
      },
      ["--base", "main", "--head", "branch-no-changelog"]
    );
    expect(res.status).toBe(1);
    expect(res.stdout).toContain("(d) CHANGELOG");
  });
});
