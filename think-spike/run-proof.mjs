/**
 * Issue #1935 (O3 spike) — workerd proof runner. Spawns
 * `wrangler dev` on think-spike/wrangler.jsonc (which bundles the
 * proof worker with Cloudflare's own esbuild config — the route
 * that works), waits for ready, fetches /proof, and asserts each
 * case. Assertions mirror the node conformance suite where the
 * suite has an equivalent, plus the Think-session claims the node
 * suite cannot make.
 *
 * Why wrangler, not miniflare: miniflare v5 (installed) serves a
 * scriptPath entry raw instead of bundling its TypeScript, and a
 * hand-rolled esbuild bundle of Think's graph dies on workerd's
 * dynamic-require rules for node builtins (via @vercel/oidc).
 * Wrangler's bundler handles both. The miniflare attempt is
 * recorded here so the next spike doesn't re-try it blind.
 *
 * Usage (from the repo root): node think-spike/run-proof.mjs
 * Exit 0 = all cases pass; exit 1 = any case fails (evidence is
 * printed for every failing case).
 */
import { spawn } from "node:child_process";
import { once } from "node:events";

// Random port per run: wrangler dev orphans workerd on SIGTERM,
// so a fixed port collides with the previous run's leftover.
const PORT = 8800 + Math.floor(Math.random() * 100);

function eq(actual, expected, label, failures) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) failures.push(`${label}: expected ${e}, got ${a}`);
}

function check(c, failures) {
  if (c.error) {
    failures.push(`worker error: ${c.error}`);
    return;
  }
  switch (c.case) {
    case "state":
      eq(c.putGet, "v1", "state put/get", failures);
      eq(c.afterDelete, null, "state delete", failures);
      if (!Array.isArray(c.sqlRows) || c.sqlRows.length !== 1) {
        failures.push(`state sql rows: expected 1 row, got ${JSON.stringify(c.sqlRows)}`);
      }
      break;
    case "schedule":
      eq(c.cancelOwn, true, "schedule cancel own", failures);
      if (
        Array.isArray(c.listAfterCancel) &&
        Array.isArray(c.scheduledIds) &&
        c.listAfterCancel.includes(c.scheduledIds[0])
      ) {
        failures.push("schedule list still contains cancelled id");
      }
      // missingCancel is evidence only (shared cf/think production
      // behavior, not a Think-specific semantic): print, don't fail.
      console.log(`  [evidence] schedule missingCancel = ${JSON.stringify(c.missingCancel)}`);
      break;
    case "session":
      eq(
        c.ordered.map((m) => m.text),
        ["one", "two"],
        "session append order",
        failures
      );
      eq(c.afterUpsert.length, 2, "session upsert keeps length", failures);
      eq(c.afterUpsert[0]?.text, "one-updated", "session upsert updates text", failures);
      eq(
        c.afterDelete.map((m) => m.text),
        ["two"],
        "session delete keeps order",
        failures
      );
      eq(c.afterClear, [], "session clear empties", failures);
      eq(c.legacy?.[0]?.id, "msg-1", "legacy row 1 id", failures);
      eq(c.legacy?.[0]?.createdAt, "2026-10-01T12:00:00.000Z", "legacy row 1 createdAt", failures);
      eq(c.legacy?.[1]?.metadata, { agent: "search" }, "legacy row 2 metadata", failures);
      break;
    case "turn-string": {
      // Delta assertions: the string input has a fresh random id,
      // so Think history must grow by exactly 2, ending in the
      // new user + assistant pair. (Absolute histories would
      // break under wrangler dev's persisted storage.)
      eq(c.status, "completed", "turn-string status", failures);
      eq(c.messageRole, "assistant", "turn-string message role", failures);
      eq(c.messageText, "Stub Think reply.", "turn-string message text", failures);
      eq(c.beforeTurn, 1, "turn-string beforeTurn", failures);
      eq(c.responses, 1, "turn-string responses", failures);
      eq(
        c.portMessages.map((m) => m.role),
        ["user", "assistant"],
        "turn-string port session roles",
        failures
      );
      eq(
        c.thinkHistory.length,
        c.thinkBeforeLength + 2,
        "turn-string think history delta",
        failures
      );
      eq(
        c.thinkHistory.slice(-2).map((m) => m.role),
        ["user", "assistant"],
        "turn-string think session tail",
        failures
      );
      eq(
        c.thinkHistory.slice(-2).map((m) => m.text),
        ["hello", "Stub Think reply."],
        "turn-string think session tail texts",
        failures
      );
      console.log(`  [evidence] turn-string thinkResponseFired = ${c.thinkResponseFired}`);
      break;
    }
    case "turn-factory": {
      // u1 is a FIXED id: it may already exist in Think history
      // from a prior run, so the upsert proof is "exactly one u1"
      // (not a length delta), plus a trailing assistant proving
      // the model ran on the no-op factory.
      eq(c.portUserCount, 1, "turn-factory port user count", failures);
      eq(
        c.thinkHistory.filter((m) => m.id === "u1").length,
        1,
        "turn-factory think u1 count (upsert-by-id)",
        failures
      );
      eq(
        c.thinkHistory[c.thinkHistory.length - 1]?.role,
        "assistant",
        "turn-factory think tail (model ran)",
        failures
      );
      eq(c.beforeTurn, 1, "turn-factory beforeTurn", failures);
      eq(c.responses, 1, "turn-factory responses", failures);
      break;
    }
    case "turn-configOverride":
      // Empty history: Think's empty-list input returns "skipped",
      // mapped to completed with no message (no model run exists
      // to report). beforeTurn stays skipped, responses still 1,
      // and Think history is untouched.
      eq(c.status, "completed", "turn-configOverride status", failures);
      eq(c.beforeTurn, 0, "turn-configOverride beforeTurn skipped", failures);
      eq(c.responses, 1, "turn-configOverride responses", failures);
      eq(c.portMessages, [], "turn-configOverride port session (no message)", failures);
      eq(
        c.thinkHistory.length,
        c.thinkBeforeLength,
        "turn-configOverride think history untouched",
        failures
      );
      break;
    case "turn-configOverride-nonempty": {
      eq(c.status, "completed", "turn-configOverride-nonempty status", failures);
      eq(c.beforeTurn, 0, "turn-configOverride-nonempty beforeTurn skipped", failures);
      eq(c.responses, 1, "turn-configOverride-nonempty responses", failures);
      eq(
        c.thinkHistory.filter((m) => m.id === "u1").length,
        1,
        "turn-configOverride-nonempty think u1 count (upsert-by-id)",
        failures
      );
      eq(
        c.thinkHistory[c.thinkHistory.length - 1]?.role,
        "assistant",
        "turn-configOverride-nonempty think tail (model ran)",
        failures
      );
      eq(
        c.portMessages.map((m) => m.role),
        ["user", "assistant"],
        "turn-configOverride-nonempty port session roles",
        failures
      );
      break;
    }
    case "turn-failure": {
      eq(c.threw, true, "turn-failure threw", failures);
      eq(c.thrownMessage, "provider down", "turn-failure message (no wrap)", failures);
      eq(c.errors.length, 1, "turn-failure onChatError exactly once", failures);
      eq(c.responses, 0, "turn-failure no onChatResponse", failures);
      // The failed turn persists its user input, then fails: the
      // tail must be that user message (prior runs end the same
      // way, so this holds across runs too).
      const tail = c.thinkHistory[c.thinkHistory.length - 1];
      eq(tail?.role, "user", "turn-failure think tail role", failures);
      eq(tail?.text, "hello", "turn-failure think tail text", failures);
      console.log(`  [evidence] turn-failure adapterErrorReported = ${c.adapterErrorReported}`);
      break;
    }
    default:
      failures.push(`unknown case ${c.case}`);
  }
}

const child = spawn("npx", ["wrangler", "dev", "--port", String(PORT), "--config", "wrangler.jsonc"], {
  cwd: "think-spike",
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
child.stdout.on("data", (d) => {
  output += d.toString();
});
child.stderr.on("data", (d) => {
  output += d.toString();
});

async function waitReady(timeoutMs = 120000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (output.includes(`Ready on http://localhost:${PORT}`)) return;
    if (child.exitCode !== null) {
      throw new Error(`wrangler dev exited early (${child.exitCode}):\n${output}`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`wrangler dev not ready after ${timeoutMs}ms:\n${output}`);
}

let exitCode = 0;
try {
  await waitReady();
  const res = await fetch(`http://localhost:${PORT}/proof`, { signal: AbortSignal.timeout(120000) });
  const data = await res.json();
  for (const c of data.cases) {
    const failures = [];
    check(c, failures);
    if (failures.length === 0) {
      console.log(`PASS ${c.case}`);
    } else {
      exitCode = 1;
      console.log(`FAIL ${c.case}`);
      for (const f of failures) console.log(`  - ${f}`);
      console.log(`  evidence: ${JSON.stringify(c)}`);
    }
  }

  // Cold-turn probe: a brand-new DO instance whose FIRST rpc is
  // a turn (no schedule case first). Must pass now that the
  // adapter boots the lifecycle explicitly: before the boot, this
  // case threw "reading 'appendMessage'" with this.session
  // undefined forever (native RPC bypasses lifecycle startup).
  // Warm turns are 8/8 above — this probe isolates the cold path.
  const coldRes = await fetch(`http://localhost:${PORT}/proof-cold`, {
    signal: AbortSignal.timeout(120000),
  });
  const cold = await coldRes.json();
  const coldFailures = [];
  if (cold.error) coldFailures.push(`worker error: ${cold.error}`);
  console.log(
    `  [evidence] turn-cold lcPresent = ${cold.lcPresent}, startType = ${cold.startType}, startOutcome = ${cold.startOutcome}, sessionAfterStart = ${cold.sessionAfterStart}, sessionAfterTurn = ${cold.sessionAfterTurn}`
  );
  if (cold.threw) coldFailures.push(`turn-cold threw: ${cold.thrownMessage}`);
  eq(cold.status, "completed", "turn-cold status", coldFailures);
  eq(cold.messageText, "Stub Think reply.", "turn-cold text", coldFailures);
  eq(cold.beforeTurn, 1, "turn-cold beforeTurn", coldFailures);
  eq(cold.responses, 1, "turn-cold responses", coldFailures);
  eq(
    (cold.portMessages || []).map((m) => m.role),
    ["user", "assistant"],
    "turn-cold port roles",
    coldFailures
  );
  if (coldFailures.length === 0) {
    console.log("PASS turn-cold");
  } else {
    exitCode = 1;
    console.log("FAIL turn-cold");
    for (const f of coldFailures) console.log(`  - ${f}`);
    console.log(`  evidence: ${JSON.stringify(cold)}`);
  }
} catch (e) {
  exitCode = 1;
  console.log(`RUNNER ERROR: ${e instanceof Error ? e.message : String(e)}`);
  console.log(output.slice(-3000));
} finally {
  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), new Promise((r) => setTimeout(r, 5000))]);
  if (child.exitCode === null) child.kill("SIGKILL");
  // Wrangler orphans workerd holding the port (and the stdio
  // pipes); reap it best-effort so the next run's port is free.
  try {
    const { spawnSync } = await import("node:child_process");
    spawnSync("fuser", ["-k", `${PORT}/tcp`], { stdio: "ignore" });
  } catch {}
}
process.exit(exitCode);
