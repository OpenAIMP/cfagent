/**
 * Issue #2460 (Agent Mesh S19, programme #2225 G13c) — the
 * production GitHub filer for the RSI proposal pipeline: the
 * MeshProposalFiler seam's real adapter, POSTing the §5 issue
 * to the GitHub REST API.
 *
 * UNWIRED in this slice, deliberately: no production caller
 * constructs the pipeline yet (the caller — an operator-invoked
 * route or a scheduled evaluation pass — is a named, owner-
 * sequenced follow-up on #2460). The adapter exists so the seam
 * is real rather than test-shaped; it stays inert until a
 * caller injects it with a token.
 *
 * Why new code (gitops §7, reuse justification): the repo's live
 * issue filer is scripts/qa-smoke.mjs (`fileSelfHealIssues`) —
 * a script, which service code cannot import; and the only
 * in-src predecessor (src/qa/self-healing.ts) was retired in
 * place by #2439 — superseded by scripts/qa-smoke.mjs (filing)
 * and src/qa/investigate.ts (diagnosis) — with a pin asserting
 * it has no caller, so building on it would resurrect a
 * dispositioned module. This adapter is the minimal REST shape
 * both of those already use, scoped to exactly one operation:
 * create an issue.
 */
import type { MeshProposalFiler } from "./meshProposalPipeline";

export interface GitHubProposalFilerDeps {
  /** A token with issues:write on the repo. Never logged, never stored. */
  token: string;
  /** "owner/name". */
  repo: string;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export function createGitHubProposalFiler(deps: GitHubProposalFilerDeps): MeshProposalFiler {
  const fetchImpl = deps.fetchImpl ?? fetch;
  return {
    async file(issue) {
      const res = await fetchImpl(`https://api.github.com/repos/${deps.repo}/issues`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${deps.token}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          title: issue.title,
          body: issue.body,
          labels: issue.labels,
        }),
      });
      if (!res.ok) {
        throw new Error(`GitHub issue filing failed: ${res.status}: ${await res.text()}`);
      }
      const created = (await res.json()) as { number: number; html_url: string };
      return { number: created.number, url: created.html_url };
    },
  };
}
