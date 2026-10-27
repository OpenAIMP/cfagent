// Governance scorecard collector — issue #1893 (epic #1872, G1/G2/G3).
//
// No dependencies; Node 20+ global fetch. Reads the GitHub API, prints a
// markdown scorecard, and optionally posts it as a comment on the epic.
//
// Failure policy: on ANY API error (including rate limits) the run fails
// WITHOUT posting. A partial scorecard is worse than no scorecard.
//
// Caps (GITHUB_TOKEN allows 1000 API calls/hour; a monthly run must stay
// far below that): at most 60 merged PRs, at most 5 commits examined per
// PR (the first decisive head is usually commit #1), at most 5 pages of
// 100 items per list. Truncation is reported in the scorecard, never
// hidden.
//
// Classification (§18.2: never report a bare total, and never count a
// superseded attempt as a failure):
// - A commit's check-runs are deduplicated by check name (latest wins —
//   a re-run leaves both a cancelled and a success run behind).
// - pass: every required check completed with conclusion success.
// - fail: any required check concluded failure or timed_out.
// - cancelled-only: no failure, and every required check is cancelled,
//   skipped, or a success/cancelled mix (a superseded attempt — the
//   #1865 aggregator-cancel pattern). Skipped, never counted as fail.
// - incomplete: a required check is missing or still running.
// - firstPassForCommits walks commits in order and returns the first
//   decisive (pass/fail) verdict; cancelled-only and incomplete commits
//   are skipped. No decisive commit means "unknown", reported separately
//   from both pass and fail.

import { pathToFileURL } from "node:url";
import * as fs from "node:fs";

export const REQUIRED_CHECKS = [
  "Load Active Environment",
  "Gitleaks secret scan",
  "Test & Build (Node 22) [PROD]",
  "Policy Gate",
];

export const TYPE_LABELS = [
  "ent-arch",
  "bug",
  "enhancement",
  "fix",
  "hotfix",
  "incident",
  "problem",
  "known-error",
];

const MAX_PRS = 60;
const MAX_COMMITS_PER_PR = 5;
const MAX_PAGES = 5;
const API_BASE = "https://api.github.com";

const FAILURE_CONCLUSIONS = new Set(["failure", "timed_out"]);
const CANCELLED_CONCLUSIONS = new Set(["cancelled", "skipped"]);

export function classifyCheckRuns(runs, required = REQUIRED_CHECKS) {
  const latestByName = new Map();
  for (const run of runs || []) {
    if (!required.includes(run.name)) continue;
    const prev = latestByName.get(run.name);
    const stamp = run.updated_at || run.created_at || "";
    const prevStamp = prev ? prev.updated_at || prev.created_at || "" : "";
    if (!prev || stamp >= prevStamp) latestByName.set(run.name, run);
  }
  for (const name of required) {
    if (!latestByName.has(name)) return "incomplete";
  }
  const states = [...latestByName.values()];
  if (states.some((r) => r.status !== "completed")) return "incomplete";
  if (states.some((r) => FAILURE_CONCLUSIONS.has(r.conclusion))) return "fail";
  if (states.every((r) => r.conclusion === "success")) return "pass";
  if (states.every((r) => CANCELLED_CONCLUSIONS.has(r.conclusion) || r.conclusion === "success")) {
    return "cancelled-only";
  }
  return "incomplete";
}

export function firstPassForCommits(commitRuns) {
  for (const entry of commitRuns || []) {
    const verdict = classifyCheckRuns(entry.runs);
    if (verdict === "pass" || verdict === "fail") return verdict;
  }
  return "unknown";
}

export function parseLedger(body) {
  return /follow-ups ledger/i.test(body || "");
}

function countByLabel(items, labels) {
  const counts = {};
  for (const label of labels) counts[label] = 0;
  for (const item of items || []) {
    for (const label of item.labels || []) {
      if (label in counts) counts[label] += 1;
    }
  }
  return counts;
}

function pct(n, d) {
  if (!d) return "n/a";
  return `${((100 * n) / d).toFixed(1)}%`;
}

export function buildScorecard(input) {
  const { windowStart, windowEnd, prs, issues, openIssues, truncated } = input;
  const pass = prs.filter((p) => p.firstPass === "pass").length;
  const fail = prs.filter((p) => p.firstPass === "fail").length;
  const unknown = prs.filter((p) => p.firstPass === "unknown").length;
  const decisive = pass + fail;
  const ledgerCount = issues.filter((i) => i.ledger).length;
  const closedCounts = countByLabel(issues, TYPE_LABELS);
  const openCounts = countByLabel(openIssues, TYPE_LABELS);
  const failedPrs = prs.filter((p) => p.firstPass === "fail");
  const unknownPrs = prs.filter((p) => p.firstPass === "unknown");
  const noLedger = issues.filter((i) => !i.ledger).slice(0, 20);
  const noLedgerExtra = issues.filter((i) => !i.ledger).length - noLedger.length;

  const lines = [];
  lines.push("<!-- governance-scorecard -->");
  lines.push("# Governance scorecard");
  lines.push("");
  lines.push(`Window: ${windowStart} to ${windowEnd} (merged/closed in window, base main).`);
  lines.push("");
  lines.push("## First-pass gate rate (G1)");
  lines.push("");
  lines.push(`- Merged PRs: ${prs.length} (first-pass pass ${pass}, fail ${fail}, unknown ${unknown}).`);
  lines.push(`- First-pass rate: ${pct(pass, prs.length)} of all PRs; ${pct(pass, decisive)} of decisive PRs (pass + fail).`);
  lines.push("- Classification: a cancelled-only or incomplete first head is skipped, never counted as a failure; unknown PRs are listed below, not hidden in either rate.");
  if (failedPrs.length) {
    lines.push("- First-pass failures:");
    for (const p of failedPrs) lines.push(`  - [#${p.number}](${p.url}) ${p.title}`);
  }
  if (unknownPrs.length) {
    lines.push("- First-pass unknown (no decisive head found within the examined commits):");
    for (const p of unknownPrs) lines.push(`  - [#${p.number}](${p.url}) ${p.title}`);
  }
  lines.push("");
  lines.push("## Ledger compliance (G2)");
  lines.push("");
  lines.push(`- Closed issues in window: ${issues.length}; with a Follow-ups ledger: ${ledgerCount} (${pct(ledgerCount, issues.length)}).`);
  if (noLedger.length) {
    lines.push("- Closed without a ledger:");
    for (const i of noLedger) lines.push(`  - [#${i.number}](${i.url}) ${i.title}`);
    if (noLedgerExtra > 0) lines.push(`  - ...and ${noLedgerExtra} more.`);
  }
  lines.push("");
  lines.push("## Label counts (G3)");
  lines.push("");
  lines.push(`- Closed in window: ${TYPE_LABELS.map((l) => `${l} ${closedCounts[l]}`).join(", ")}.`);
  lines.push(`- Open backlog: ${TYPE_LABELS.map((l) => `${l} ${openCounts[l]}`).join(", ")} (open issues: ${openIssues.length}).`);
  lines.push("");
  lines.push("## Limits");
  lines.push("");
  lines.push("- Metrics do not prove causation; PR mix is not classified here, so read the failed/unknown lists alongside the rates.");
  lines.push("- Numbers are small; counts always accompany percentages.");
  if (truncated && truncated.length) {
    lines.push(`- Truncated collections (counts are lower bounds): ${truncated.join(", ")}.`);
  }
  return lines.join("\n") + "\n";
}

async function api(urlOrPath, token, options = {}) {
  const url = urlOrPath.startsWith("http") ? urlOrPath : API_BASE + urlOrPath;
  const res = await fetch(url, {
    method: options.method || "GET",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "cfagent-governance-scorecard",
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    if (res.status === 403 && /rate limit/i.test(text)) {
      throw new Error(`GitHub API rate limit exceeded for ${urlOrPath}; scorecard not posted.`);
    }
    throw new Error(`GitHub API ${res.status} for ${urlOrPath}: ${text.slice(0, 300)}`);
  }
  const data = text ? JSON.parse(text) : {};
  return { data, link: res.headers.get("link") || "" };
}

function nextPageUrl(linkHeader) {
  if (!linkHeader) return null;
  const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
  return match ? match[1] : null;
}

async function listAll(path, token) {
  const items = [];
  let url = path;
  let truncated = false;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const { data, link } = await api(url, token);
    if (Array.isArray(data)) items.push(...data);
    const next = nextPageUrl(link);
    if (!next) return { items, truncated };
    url = next;
  }
  return { items, truncated: true };
}

function inWindow(iso, startIso, endIso) {
  return iso && iso >= startIso && iso <= endIso;
}

async function collect({ repo, token, windowDays }) {
  const end = new Date();
  const start = new Date(end.getTime() - windowDays * 86400000);
  const startIso = start.toISOString();
  const endIso = end.toISOString();
  const windowStart = startIso.slice(0, 10);
  const windowEnd = endIso.slice(0, 10);
  const truncated = [];

  const prList = await listAll(`/repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=100`, token);
  if (prList.truncated) truncated.push("merged PR list");
  const mergedPrs = prList.items.filter(
    (pr) => pr.merged_at && inWindow(pr.merged_at, startIso, endIso) && pr.base && pr.base.ref === "main",
  );
  const prsCapped = mergedPrs.length > MAX_PRS;
  if (prsCapped) truncated.push(`merged PRs (capped at ${MAX_PRS})`);
  const prs = [];
  for (const pr of mergedPrs.slice(0, MAX_PRS)) {
    const commitList = await listAll(`/repos/${repo}/pulls/${pr.number}/commits?per_page=100`, token);
    const commitRuns = [];
    for (const commit of commitList.items.slice(0, MAX_COMMITS_PER_PR)) {
      const { data } = await api(`/repos/${repo}/commits/${commit.sha}/check-runs?per_page=100`, token);
      commitRuns.push({ sha: commit.sha, runs: data.check_runs || [] });
      if (classifyCheckRuns(commitRuns[commitRuns.length - 1].runs) === "pass" ||
          classifyCheckRuns(commitRuns[commitRuns.length - 1].runs) === "fail") {
        break;
      }
    }
    prs.push({
      number: pr.number,
      title: pr.title || "",
      url: pr.html_url,
      firstPass: firstPassForCommits(commitRuns),
    });
  }

  const closedList = await listAll(`/repos/${repo}/issues?state=closed&per_page=100`, token);
  if (closedList.truncated) truncated.push("closed issue list");
  const issues = closedList.items
    .filter((i) => !i.pull_request && inWindow(i.closed_at, startIso, endIso))
    .map((i) => ({
      number: i.number,
      title: i.title || "",
      url: i.html_url,
      ledger: parseLedger(i.body),
      labels: (i.labels || []).map((l) => l.name),
    }));

  const openList = await listAll(`/repos/${repo}/issues?state=open&per_page=100`, token);
  if (openList.truncated) truncated.push("open issue list");
  const openIssues = openList.items
    .filter((i) => !i.pull_request)
    .map((i) => ({ number: i.number, labels: (i.labels || []).map((l) => l.name) }));

  return buildScorecard({ windowStart, windowEnd, prs, issues, openIssues, truncated });
}

function parseArgs(argv) {
  const out = { windowDays: 30, post: false, repo: null, epic: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--post") out.post = true;
    else if (arg.startsWith("--window-days=")) out.windowDays = Number(arg.split("=")[1]);
    else if (arg === "--window-days") out.windowDays = Number(argv[i + 1]);
    else if (arg.startsWith("--repo=")) out.repo = arg.split("=")[1];
    else if (arg === "--repo") out.repo = argv[i + 1];
    else if (arg.startsWith("--epic=")) out.epic = arg.split("=")[1];
    else if (arg === "--epic") out.epic = argv[i + 1];
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) {
    console.error("GH_TOKEN (or GITHUB_TOKEN) is required; scorecard not posted.");
    process.exit(1);
  }
  const repo = args.repo || process.env.REPO || "OpenAIMP/cfagent";
  const epic = args.epic || process.env.EPIC || "1872";
  const post = args.post || process.env.POST === "true";
  const markdown = await collect({ repo, token, windowDays: args.windowDays });
  process.stdout.write(markdown);
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
  }
  if (post) {
    await api(`/repos/${repo}/issues/${epic}/comments`, token, {
      method: "POST",
      body: { body: markdown },
    });
    console.error(`Posted scorecard comment on ${repo}#${epic}.`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`governance-scorecard failed: ${err.message}`);
    process.exit(1);
  });
}
