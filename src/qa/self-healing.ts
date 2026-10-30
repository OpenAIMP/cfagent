/**
 * DEPRECATED — superseded by scripts/qa-smoke.mjs (issue filing,
 * `fileSelfHealIssues`) and src/qa/investigate.ts (the supervised
 * diagnosis served by POST /api/qa/investigate). Disposition
 * recorded by issue #2439 (Agent Mesh S18), on this evidence:
 * this module landed alone in PR #7 and was never wired — it has
 * no production caller; its supervise half calls
 * `orchestrator.createJob(...)`, a method that does not exist on
 * OrchestratorAgent (today's createJob, src/orchestrate.ts, is
 * descriptor-only and executes nothing); and its dedup signature
 * (`operation :: errorClass`) never matched qa-smoke's own
 * check-name dedup, so the two filers would have double-filed.
 * The live loop is: qa-smoke files the issue, the investigate
 * route produces the diagnosis, a human reviews and merges the
 * fix. Kept in place per the repo's deprecate-don't-delete rule;
 * tests/mesh_golden_tasks_s18_2439.test.ts pins the no-caller
 * state, so wiring a caller must update this disposition first.
 *
 * Original header (PR #7 — Self-healing QA loop):
 *
 * Reuses the qa-smoke pattern: on QA failure,
 * handleQAFailure() creates a GitHub issue (deduplicated by
 * failure signature) and triggers an Orchestrator supervise job
 * to produce the fix.
 */

export interface QAFailure {
  operation: string;
  errorClass: "timeout" | "api_error" | "validation" | "unknown";
  detail: string;
  runLink?: string;
}

export interface SelfHealIssue {
  number: number;
  url: string;
  deduped: boolean;
}

export function failureSignature(f: QAFailure): string {
  return `[QA self-heal] ${f.operation} :: ${f.errorClass}`;
}

interface Deps {
  githubToken: string;
  repo: string; // "owner/name"
  orchestrator: any; // OrchestratorAgent DO stub
}

async function gh(
  deps: Deps,
  path: string,
  method: string = "GET",
  body?: unknown
): Promise<any> {
  const res = await fetch(`https://api.github.com/repos/${deps.repo}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${deps.githubToken}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${await res.text()}`);
  return res.json();
}

/**
 * Handle a QA failure: dedup → issue → supervised fix job.
 * The fix PR must reference "Fixes #<issue>" for auto-close.
 */
export async function handleQAFailure(
  deps: Deps,
  failure: QAFailure
): Promise<SelfHealIssue> {
  const signature = failureSignature(failure);

  // Dedup: reuse an open issue with the same signature from the last 24h
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const open = await gh(deps, `/issues?state=open&per_page=50&since=${since}`);
  const dup = open.find((i: any) => i.title === signature && !i.pull_request);
  if (dup) {
    return { number: dup.number, url: dup.html_url, deduped: true };
  }

  // File the issue
  const issue = await gh(deps, `/issues`, "POST", {
    title: signature,
    body: [
      `## QA failure`,
      ``,
      `**Operation:** ${failure.operation}`,
      `**Error class:** ${failure.errorClass}`,
      ``,
      `### Detail`,
      failure.detail,
      failure.runLink ? `\n**Run:** ${failure.runLink}` : ``,
      ``,
      `---`,
      `Filed by the self-healing QA loop.`,
    ].join("\n"),
    labels: ["self-heal", "qa-failure"],
  });

  // Trigger Orchestrator supervise job for the fix
  await deps.orchestrator.createJob({
    goalId: `self-heal-${issue.number}`,
    goalName: `Fix QA failure #${issue.number}`,
    operation: "qa.supervised_fix",
    mode: "supervise",
    context: {
      issueNumber: issue.number,
      issueUrl: issue.html_url,
      prBodySuffix: `Fixes #${issue.number}`,
    },
  });

  return { number: issue.number, url: issue.html_url, deduped: false };
}
