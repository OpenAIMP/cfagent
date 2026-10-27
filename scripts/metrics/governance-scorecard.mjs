// Governance scorecard collector — issue #1893 (epic #1872, G1/G2/G3).
// Output format: the COBIT balanced scorecard (G3 #1875, definition in
// docs/operations/cobit-balanced-scorecard.md) — four perspectives
// (Financial, Customer, Internal process, Learning & growth), every
// number traced to a repo source, gaps stated not filled.
//
// No dependencies; Node 20+ global fetch. Reads the GitHub API, prints a
// markdown scorecard, optionally posts it as a comment on the epic, and
// optionally writes versioned HTML history (--html-dir) for GitHub Pages
// (HTML alongside comments, never instead of them — the #1872 comment
// stays the record).
//
// Failure policy: on ANY API error (including rate limits) the run fails
// WITHOUT posting and WITHOUT writing HTML. A partial scorecard is worse
// than no scorecard. HTML is written only after a successful collect
// (and after a successful post, when --post is set).
//
// Caps (GITHUB_TOKEN allows 1000 API calls/hour; a monthly run must stay
// far below that): at most 60 merged PRs, at most 5 commits examined per
// PR (the first decisive head is usually commit #1), at most 60 main
// commits examined for the post-merge rate, at most 5 pages of 100 items
// per list. Truncation is reported in the scorecard, never hidden.
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
import * as path from "node:path";

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
const MAX_MAIN_COMMITS = 60;
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

// v2 PR template shape: the Agent field and the Linked issue field both
// present. Used for template adoption (Learning & growth).
export function usesTemplate(body) {
  if (typeof body !== "string") return false;
  return body.includes("## Agent") && body.includes("## Linked issue");
}

// A non-empty User journey section (issue template field). Used for
// journey coverage (Customer).
export function hasJourney(body) {
  if (typeof body !== "string") return false;
  return /##\s*user journey\s*\n\s*\S/i.test(body);
}

export function medianHours(values) {
  const nums = (values || []).filter((v) => typeof v === "number" && Number.isFinite(v));
  if (!nums.length) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return Math.round(median * 10) / 10;
}

export function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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

// Structured scorecard data: one source of truth for the markdown and
// HTML renderers. Optional inputs (ciMinutes, postMerge, adrCommits,
// templateAdoption, journeyCoverage) render as "not collected" when
// absent, so older callers still produce a valid scorecard.
export function buildScorecardData(input) {
  const {
    windowStart,
    windowEnd,
    prs,
    issues,
    openIssues,
    truncated,
    ciMinutes = null,
    postMerge = null,
    adrCommits = null,
    templateAdoption = null,
    journeyCoverage = null,
  } = input;
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
  const mergeHours = prs
    .filter((p) => p.created_at && p.merged_at)
    .map((p) => (Date.parse(p.merged_at) - Date.parse(p.created_at)) / 3600000);
  return {
    windowStart,
    windowEnd,
    prs,
    issues,
    openIssues,
    truncated: truncated || [],
    pass,
    fail,
    unknown,
    decisive,
    ledgerCount,
    closedCounts,
    openCounts,
    failedPrs,
    unknownPrs,
    noLedger,
    noLedgerExtra,
    timeToMergeMedianHours: medianHours(mergeHours),
    ciMinutes,
    postMerge,
    adrCommits,
    templateAdoption,
    journeyCoverage,
  };
}

export function buildScorecard(input) {
  const d = buildScorecardData(input);
  const lines = [];
  lines.push("<!-- governance-scorecard -->");
  lines.push("# Governance scorecard (COBIT balanced scorecard)");
  lines.push("");
  lines.push(`Window: ${d.windowStart} to ${d.windowEnd} (merged/closed in window, base main).`);
  lines.push("Mapping: docs/operations/cobit-balanced-scorecard.md. Every number traces to a link; gaps are stated, not filled.");
  lines.push("");
  lines.push("## Financial — value for governance effort (EDM02, EDM04, APO)");
  lines.push("");
  lines.push(`- Delivery volume: ${d.prs.length} merged PRs in window.`);
  lines.push(`- Closed in window: ${TYPE_LABELS.map((l) => `${l} ${d.closedCounts[l]}`).join(", ")}.`);
  lines.push(`- Open backlog: ${TYPE_LABELS.map((l) => `${l} ${d.openCounts[l]}`).join(", ")} (open issues: ${d.openIssues.length}).`);
  lines.push(
    d.ciMinutes === null
      ? "- CI minutes in window: not collected."
      : `- CI minutes in window: ${d.ciMinutes} (approx wall-clock across completed workflow runs).`,
  );
  lines.push("- Paid-service costs: not recorded (costs live outside the repo).");
  lines.push("");
  lines.push("## Customer — delivery serving users (DSS, EDM05)");
  lines.push("");
  lines.push("- Merged value: see Financial delivery volume.");
  lines.push(
    d.journeyCoverage === null
      ? "- User-journey coverage: not collected."
      : `- User-journey coverage: ${d.journeyCoverage.withJourney} of ${d.journeyCoverage.total} closed issues carry a non-empty User journey section (${pct(d.journeyCoverage.withJourney, d.journeyCoverage.total)}).`,
  );
  lines.push("");
  lines.push("## Internal process — how well the machine runs (BAI, MEA01)");
  lines.push("");
  lines.push(`- Merged PRs: ${d.prs.length} (first-pass pass ${d.pass}, fail ${d.fail}, unknown ${d.unknown}).`);
  lines.push(`- First-pass rate: ${pct(d.pass, d.prs.length)} of all PRs; ${pct(d.pass, d.decisive)} of decisive PRs (pass + fail).`);
  lines.push("- Classification: a cancelled-only or incomplete first head is skipped, never counted as a failure; unknown PRs are listed below, not hidden in either rate.");
  if (d.failedPrs.length) {
    lines.push("- First-pass failures:");
    for (const p of d.failedPrs) lines.push(`  - [#${p.number}](${p.url}) ${p.title}`);
  }
  if (d.unknownPrs.length) {
    lines.push("- First-pass unknown (no decisive head found within the examined commits):");
    for (const p of d.unknownPrs) lines.push(`  - [#${p.number}](${p.url}) ${p.title}`);
  }
  lines.push(`- Closed issues in window: ${d.issues.length}; with a Follow-ups ledger: ${d.ledgerCount} (${pct(d.ledgerCount, d.issues.length)}).`);
  if (d.noLedger.length) {
    lines.push("- Closed without a ledger:");
    for (const i of d.noLedger) lines.push(`  - [#${i.number}](${i.url}) ${i.title}`);
    if (d.noLedgerExtra > 0) lines.push(`  - ...and ${d.noLedgerExtra} more.`);
  }
  lines.push(
    d.postMerge === null
      ? "- Post-merge red rate: not collected."
      : `- Post-merge red rate: ${d.postMerge.red} of ${d.postMerge.total} decisive main heads red (${pct(d.postMerge.red, d.postMerge.total)}).`,
  );
  lines.push(
    d.timeToMergeMedianHours === null
      ? "- Time-to-merge: not collected."
      : `- Time-to-merge: median ${d.timeToMergeMedianHours} hours (issue open to merge).`,
  );
  lines.push("");
  lines.push("## Learning & growth — is the system improving (MEA, BAI08, EDM01)");
  lines.push("");
  lines.push(
    d.adrCommits === null
      ? "- ADRs added in window: not collected."
      : `- ADRs added in window: ${d.adrCommits} commits touched docs/architecture/adr/.`,
  );
  lines.push(
    d.templateAdoption === null
      ? "- Template adoption: not collected."
      : `- Template adoption: ${d.templateAdoption.adopted} of ${d.templateAdoption.total} merged PRs use the v2 template shape (${pct(d.templateAdoption.adopted, d.templateAdoption.total)}).`,
  );
  lines.push("- Audit closure: ledger compliance above; backfill count reported when the manual audit runs (not estimated).");
  lines.push("");
  lines.push("## Limits");
  lines.push("");
  lines.push("- Metrics do not prove causation; PR mix is not classified here, so read the failed/unknown lists alongside the rates.");
  lines.push("- Numbers are small; counts always accompany percentages.");
  if (d.truncated.length) {
    lines.push(`- Truncated collections (counts are lower bounds): ${d.truncated.join(", ")}.`);
  }
  return lines.join("\n") + "\n";
}

// Standalone HTML rendering of the same data (no external resources, no
// scripts — safe to serve statically from GitHub Pages). All dynamic
// text is escaped; links come from API data and are escaped as well.
export function buildScorecardHtml(input) {
  const d = buildScorecardData(input);
  const li = (items) => items.map((x) => `      <li>${x}</li>`).join("\n");
  const linkList = (items) =>
    items.map((i) => `      <li><a href="${escapeHtml(i.url)}">#${i.number}</a> ${escapeHtml(i.title)}</li>`).join("\n");
  const sections = [];
  sections.push(`    <h2>Financial — value for governance effort (EDM02, EDM04, APO)</h2>
    <ul>
${li([
  `Delivery volume: ${d.prs.length} merged PRs in window.`,
  `Closed in window: ${escapeHtml(TYPE_LABELS.map((l) => `${l} ${d.closedCounts[l]}`).join(", "))}.`,
  `Open backlog: ${escapeHtml(TYPE_LABELS.map((l) => `${l} ${d.openCounts[l]}`).join(", "))} (open issues: ${d.openIssues.length}).`,
  d.ciMinutes === null
    ? "CI minutes in window: not collected."
    : `CI minutes in window: ${d.ciMinutes} (approx wall-clock across completed workflow runs).`,
  "Paid-service costs: not recorded (costs live outside the repo).",
])}
    </ul>`);
  sections.push(`    <h2>Customer — delivery serving users (DSS, EDM05)</h2>
    <ul>
${li([
  "Merged value: see Financial delivery volume.",
  d.journeyCoverage === null
    ? "User-journey coverage: not collected."
    : `User-journey coverage: ${d.journeyCoverage.withJourney} of ${d.journeyCoverage.total} closed issues carry a non-empty User journey section (${pct(d.journeyCoverage.withJourney, d.journeyCoverage.total)}).`,
])}
    </ul>`);
  const internal = [
    `Merged PRs: ${d.prs.length} (first-pass pass ${d.pass}, fail ${d.fail}, unknown ${d.unknown}).`,
    `First-pass rate: ${pct(d.pass, d.prs.length)} of all PRs; ${pct(d.pass, d.decisive)} of decisive PRs (pass + fail).`,
    "Classification: a cancelled-only or incomplete first head is skipped, never counted as a failure; unknown PRs are listed below, not hidden in either rate.",
    `Closed issues in window: ${d.issues.length}; with a Follow-ups ledger: ${d.ledgerCount} (${pct(d.ledgerCount, d.issues.length)}).`,
    d.postMerge === null
      ? "Post-merge red rate: not collected."
      : `Post-merge red rate: ${d.postMerge.red} of ${d.postMerge.total} decisive main heads red (${pct(d.postMerge.red, d.postMerge.total)}).`,
    d.timeToMergeMedianHours === null
      ? "Time-to-merge: not collected."
      : `Time-to-merge: median ${d.timeToMergeMedianHours} hours (issue open to merge).`,
  ];
  let internalHtml = `    <h2>Internal process — how well the machine runs (BAI, MEA01)</h2>
    <ul>
${li(internal)}
    </ul>`;
  if (d.failedPrs.length) internalHtml += `
    <h3>First-pass failures</h3>
    <ul>
${linkList(d.failedPrs)}
    </ul>`;
  if (d.unknownPrs.length) internalHtml += `
    <h3>First-pass unknown</h3>
    <ul>
${linkList(d.unknownPrs)}
    </ul>`;
  if (d.noLedger.length) {
    internalHtml += `
    <h3>Closed without a ledger</h3>
    <ul>
${linkList(d.noLedger)}
    </ul>`;
    if (d.noLedgerExtra > 0) internalHtml += `
    <p>…and ${d.noLedgerExtra} more.</p>`;
  }
  sections.push(internalHtml);
  sections.push(`    <h2>Learning &amp; growth — is the system improving (MEA, BAI08, EDM01)</h2>
    <ul>
${li([
  d.adrCommits === null
    ? "ADRs added in window: not collected."
    : `ADRs added in window: ${d.adrCommits} commits touched docs/architecture/adr/.`,
  d.templateAdoption === null
    ? "Template adoption: not collected."
    : `Template adoption: ${d.templateAdoption.adopted} of ${d.templateAdoption.total} merged PRs use the v2 template shape (${pct(d.templateAdoption.adopted, d.templateAdoption.total)}).`,
  "Audit closure: ledger compliance above; backfill count reported when the manual audit runs (not estimated).",
])}
    </ul>`);
  const limits = [
    "Metrics do not prove causation; PR mix is not classified here, so read the failed/unknown lists alongside the rates.",
    "Numbers are small; counts always accompany percentages.",
  ];
  if (d.truncated.length) limits.push(`Truncated collections (counts are lower bounds): ${d.truncated.join(", ")}.`);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Governance scorecard ${escapeHtml(d.windowStart)} to ${escapeHtml(d.windowEnd)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:72ch;margin:2rem auto;padding:0 1rem;line-height:1.5}h1{font-size:1.5rem}h2{font-size:1.2rem;margin-top:2rem}code{background:#f0f0f0;padding:0 .2rem}</style>
</head>
<body>
<h1>Governance scorecard (COBIT balanced scorecard)</h1>
<p>Window: ${escapeHtml(d.windowStart)} to ${escapeHtml(d.windowEnd)} (merged/closed in window, base main).<br>
Mapping: docs/operations/cobit-balanced-scorecard.md. Every number traces to a link; gaps are stated, not filled.</p>
${sections.join("\n")}
<h2>Limits</h2>
<ul>
${li(limits)}
</ul>
</body>
</html>
`;
}

// History index for the gh-pages branch: filenames are
// scorecard-YYYY-MM-DD.html (lexicographic order is chronological).
// The latest run is always scorecard.html.
export function buildScorecardIndex(filenames) {
  const dated = [...new Set(filenames || [])]
    .filter((f) => /^scorecard-\d{4}-\d{2}-\d{2}\.html$/.test(f))
    .sort()
    .reverse();
  const items = dated.map((f) => `      <li><a href="${escapeHtml(f)}">${escapeHtml(f.replace(/^scorecard-/, "").replace(/\.html$/, ""))}</a></li>`).join("\n");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Governance scorecard history</title>
<style>body{font-family:system-ui,sans-serif;max-width:72ch;margin:2rem auto;padding:0 1rem;line-height:1.5}</style>
</head>
<body>
<h1>Governance scorecard history</h1>
<p><a href="scorecard.html">Latest scorecard</a> — monthly COBIT balanced scorecard (see docs/operations/cobit-balanced-scorecard.md for the mapping).</p>
<ul>
${items}
</ul>
</body>
</html>
`;
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
      created_at: pr.created_at,
      merged_at: pr.merged_at,
      body: pr.body || "",
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
      body: i.body || "",
    }));

  const openList = await listAll(`/repos/${repo}/issues?state=open&per_page=100`, token);
  if (openList.truncated) truncated.push("open issue list");
  const openIssues = openList.items
    .filter((i) => !i.pull_request)
    .map((i) => ({ number: i.number, labels: (i.labels || []).map((l) => l.name) }));

  // Financial: CI minutes (approx wall-clock across completed workflow
  // runs in window). New API group, pages capped like the others.
  let ciMinutes = null;
  const runList = await listAll(
    `/repos/${repo}/actions/runs?created=%3E${encodeURIComponent(startIso)}&per_page=100`,
    token,
  );
  if (runList.truncated) truncated.push("workflow run list");
  let minutes = 0;
  for (const run of runList.items) {
    if (run.status === "completed" && run.run_started_at && run.updated_at) {
      minutes += (Date.parse(run.updated_at) - Date.parse(run.run_started_at)) / 60000;
    }
  }
  ciMinutes = Math.round(minutes);

  // Internal process: post-merge red rate from main heads in window.
  let postMerge = null;
  const mainList = await listAll(
    `/repos/${repo}/commits?sha=main&since=${encodeURIComponent(startIso)}&until=${encodeURIComponent(endIso)}&per_page=100`,
    token,
  );
  if (mainList.truncated) truncated.push("main commit list");
  let mainPass = 0;
  let mainFail = 0;
  for (const commit of mainList.items.slice(0, MAX_MAIN_COMMITS)) {
    const { data } = await api(`/repos/${repo}/commits/${commit.sha}/check-runs?per_page=100`, token);
    const verdict = classifyCheckRuns(data.check_runs || []);
    if (verdict === "pass") mainPass += 1;
    else if (verdict === "fail") mainFail += 1;
  }
  if (mainPass + mainFail > 0) postMerge = { total: mainPass + mainFail, red: mainFail };

  // Learning & growth: ADR commits in window.
  let adrCommits = null;
  const adrList = await listAll(
    `/repos/${repo}/commits?path=docs/architecture/adr/&since=${encodeURIComponent(startIso)}&until=${encodeURIComponent(endIso)}&per_page=100`,
    token,
  );
  if (adrList.truncated) truncated.push("ADR commit list");
  adrCommits = adrList.items.length;

  // Customer / Learning: derived from already-fetched bodies, no new calls.
  const templateAdoption = {
    adopted: prs.filter((p) => usesTemplate(p.body)).length,
    total: prs.length,
  };
  const journeyCoverage = {
    withJourney: issues.filter((i) => hasJourney(i.body)).length,
    total: issues.length,
  };

  const input = {
    windowStart,
    windowEnd,
    prs,
    issues,
    openIssues,
    truncated,
    ciMinutes,
    postMerge,
    adrCommits,
    templateAdoption,
    journeyCoverage,
  };
  return { markdown: buildScorecard(input), html: buildScorecardHtml(input), windowEnd };
}

function parseArgs(argv) {
  const out = { windowDays: 30, post: false, repo: null, epic: null, htmlDir: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--post") out.post = true;
    else if (arg.startsWith("--window-days=")) out.windowDays = Number(arg.split("=")[1]);
    else if (arg === "--window-days") out.windowDays = Number(argv[i + 1]);
    else if (arg.startsWith("--repo=")) out.repo = arg.split("=")[1];
    else if (arg === "--repo") out.repo = argv[i + 1];
    else if (arg.startsWith("--epic=")) out.epic = arg.split("=")[1];
    else if (arg === "--epic") out.epic = argv[i + 1];
    else if (arg.startsWith("--html-dir=")) out.htmlDir = arg.split("=")[1];
    else if (arg === "--html-dir") out.htmlDir = argv[i + 1];
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
  const { markdown, html, windowEnd } = await collect({ repo, token, windowDays: args.windowDays });
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
  // HTML history is written only after a successful collect (and after a
  // successful post, when --post is set), so a failed run writes nothing.
  if (args.htmlDir) {
    fs.mkdirSync(args.htmlDir, { recursive: true });
    const dated = `scorecard-${windowEnd}.html`;
    fs.writeFileSync(path.join(args.htmlDir, dated), html);
    fs.writeFileSync(path.join(args.htmlDir, "scorecard.html"), html);
    const existing = fs
      .readdirSync(args.htmlDir)
      .filter((f) => /^scorecard-\d{4}-\d{2}-\d{2}\.html$/.test(f));
    fs.writeFileSync(path.join(args.htmlDir, "index.html"), buildScorecardIndex(existing));
    console.error(`Wrote HTML history to ${args.htmlDir} (${dated}, scorecard.html, index.html).`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`governance-scorecard failed: ${err.message}`);
    process.exit(1);
  });
}
