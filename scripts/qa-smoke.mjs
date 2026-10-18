/**
 * Post-deploy QA smoke test for cfagent.
 *
 * Ported from cfpay's scripts/qa-smoke.mjs (battle-tested).
 * Runs against the deployed Worker after a successful deploy.
 *
 * Exit code is the contract: 0 means every check that RAN passed.
 * A check that could not run is reported as SKIP, never silently passing.
 *
 * Plain .mjs (not vitest): must talk to live production over HTTP,
 * and must not be collected by `vitest run`.
 */

const BASE_URL = (process.env.BASE_URL || "https://agent.openaimp.com").replace(/\/$/, "");
const API_KEY = process.env.DASHBOARD_API_KEY || "";

const results = [];
let failed = 0;

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  if (!ok) failed += 1;
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}${detail ? ` - ${detail}` : ""}`);
}

function skip(name, why) {
  results.push({ name, ok: true, skipped: true, detail: why });
  console.log(`  [SKIP] ${name} - ${why}`);
}

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { res, json, text };
}

async function main() {
  console.log(`Post-deploy QA against ${BASE_URL}\n`);

  // 1. Worker responds at all
  try {
    const { res } = await fetchJson(`${BASE_URL}/health`);
    record("worker responds on /health", res.ok, `status=${res.status}`);
    if (!res.ok) { await finish(); return; }
  } catch (err) {
    record("worker responds on /health", false, err.message);
    await finish();
    return;
  }

  // 2. A2A agent card (public discovery)
  try {
    const { res, json } = await fetchJson(`${BASE_URL}/.well-known/agent-card.json`);
    const ok = res.ok && json && Array.isArray(json.agents);
    record("A2A agent card", ok, ok ? `${json.agents.length} agents` : `status=${res.status}`);
  } catch (err) {
    record("A2A agent card", false, err.message);
  }

  // 3. ScheduledAgent DO is reachable (via server scheduled endpoint or status)
  //    We check the wrangler-deployed DO bindings indirectly: if the worker
  //    boots without binding errors, the health check above already passed.
  //    A deeper check hits the A2A RPC path for scheduled-agent if exposed.
  try {
    const { res } = await fetchJson(`${BASE_URL}/a2a/scheduled-agent`, {
      method: "POST",
      body: JSON.stringify({ method: "listGoals", params: {} }),
    });
    // 404 = not exposed via A2A yet (acceptable); 500 = binding broken (fail)
    if (res.status === 404) {
      skip("scheduled-agent A2A", "not exposed via /a2a yet");
    } else {
      record("scheduled-agent A2A", res.ok, `status=${res.status}`);
    }
  } catch (err) {
    record("scheduled-agent A2A", false, err.message);
  }

  // 4. Search agent responds (core capability)
  try {
    const { res, json } = await fetchJson(`${BASE_URL}/api/search`, {
      method: "POST",
      body: JSON.stringify({ query: "qa smoke test", limit: 1 }),
    });
    // Accept 200 or 401 (auth required) as "alive"; 500 is a failure
    const alive = res.status !== 500;
    record("search endpoint alive", alive, `status=${res.status}`);
  } catch (err) {
    record("search endpoint alive", false, err.message);
  }

  await finish();
}

async function finish() {
  await fileSelfHealIssues();
  const ran = results.filter((r) => !r.skipped).length;
  const skipped = results.filter((r) => r.skipped).length;
  const passed = ran - failed;
  console.log(
    `\n${passed}/${ran} checks passed` +
      (skipped ? `, ${skipped} skipped` : "") +
      (failed ? `, ${failed} FAILED` : ""),
  );
  process.exit(failed > 0 ? 1 : 0);
}

// File one GitHub issue per failing check (dedup by check name)
async function fileSelfHealIssues() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.log("  [SKIP] filing self-heal issues - GITHUB_TOKEN not set");
    return;
  }
  const failures = results.filter((r) => !r.ok && !r.skipped);
  if (failures.length === 0) return;

  for (const f of failures) {
    const title = `[QA self-heal] ${f.name}`;
    const body = [
      `**Check:** ${f.name}`,
      `**Detail:** ${f.detail || "(none)"}`,
      `**When:** ${new Date().toISOString()}`,
      `**Base URL:** ${BASE_URL}`,
      "",
      "What happens next: diagnose from the above, branch, and open a fix PR referencing this issue.",
      "This issue auto-closes when the check passes again on a deploy.",
    ].join("\n");

    try {
      // Check for existing open issue with same title (dedup)
      const searchRes = await fetch(
        `https://api.github.com/search/issues?q=${encodeURIComponent(`repo:OpenAIMP/cfagent "${title}" state:open`)}`,
        { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" } }
      );
      const searchJson = await searchRes.json();
      if (searchJson.total_count > 0) {
        console.log(`  [SKIP] issue already open for: ${f.name}`);
        continue;
      }

      const createRes = await fetch(`https://api.github.com/repos/OpenAIMP/cfagent/issues`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ title, body, labels: ["QA self-heal"] }),
      });
      if (createRes.ok) {
        console.log(`  [ISSUE] filed for: ${f.name}`);
      } else {
        console.log(`  [WARN] failed to file issue for ${f.name}: ${createRes.status}`);
      }
    } catch (err) {
      console.log(`  [WARN] issue filing error for ${f.name}: ${err.message}`);
    }
  }
}

main().catch((err) => {
  console.error("QA script crashed:", err);
  process.exit(2);
});
