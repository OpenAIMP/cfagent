/**
 * Issue #1737 — workflow port, flows, adapters, command
 * envelope. TDD: written against the port contract before
 * the routes land on it.
 *
 * The fake step executes do() immediately and advances a
 * virtual clock on sleep(), so poll loops and deadlines
 * behave deterministically without real waiting.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { InMemoryShardJobAdapter } from "../src/data/inMemoryShardJobAdapter";
import type { ShardJobStore } from "../src/data/shardJobPorts";
import { CfWorkflowAdapter, type WorkflowBindingLike } from "../src/workflows/cfWorkflowAdapter";
import { createWorkflowPorts } from "../src/workflows/createWorkflowPorts";
import { InMemoryWorkflowAdapter } from "../src/workflows/inMemoryWorkflowAdapter";
import {
  collateShards,
  runParentFlow,
  runShardFlow,
  shardSummaryFromResult,
  asShardScreenResult,
  stageTransitionsForShard,
  type ChildWorkflowOps,
  type ScreenerWorkflowDeps,
  type ScreenerWorkflowStep,
  type ShardScreenResult,
} from "../src/workflows/screenerWorkflowFlow";
import {
  fromWorkflowCommandEnvelope,
  toWorkflowCommandEnvelope,
} from "../src/workflows/workflowCommandEnvelope";
import {
  assertWorkflowJobCommand,
  workflowIdForJob,
  WorkflowError,
  type WorkflowInstanceStatus,
  type WorkflowJobCommand,
} from "../src/workflows/workflowPorts";

/* ------------------------------------------------------------------ */
/* Fakes                                                               */
/* ------------------------------------------------------------------ */

function makeClock(startMs = 1_000_000) {
  let now = startMs;
  const step: ScreenerWorkflowStep = {
    do: async (_name, fn) => fn(),
    sleep: async (_name, ms) => {
      now += ms;
    },
  };
  return { nowMs: () => now, step };
}

function parentCommand(overrides: Partial<WorkflowJobCommand> = {}): WorkflowJobCommand {
  return {
    jobId: "job-1",
    type: "run-screen",
    source: "manual",
    trigger: "manual",
    userLogin: "alice",
    role: "parent",
    tenantId: "tenant-1",
    shards: [
      { shardId: "TECH", universe: "TECH" },
      { shardId: "HEALTH", universe: "HEALTH" },
    ],
    deliver: true,
    ...overrides,
  };
}

function okResult(overrides: Partial<ShardScreenResult> = {}): ShardScreenResult {
  return {
    success: true,
    timestamp: "2026-10-26T12:00:00.000Z",
    totalScanned: 10,
    expectedCount: 10,
    matchedCount: 2,
    ...overrides,
  };
}

interface DepsBundle {
  store: InMemoryShardJobAdapter;
  /** Opaque payloads the child store/deliver steps received. */
  stored: unknown[];
  delivered: unknown[];
  clock: ReturnType<typeof makeClock>;
  deps: ScreenerWorkflowDeps;
}

function makeDeps(runScreen?: ScreenerWorkflowDeps["screenRunner"]["runScreen"]): DepsBundle {
  const store = new InMemoryShardJobAdapter();
  const stored: unknown[] = [];
  const delivered: unknown[] = [];
  const clock = makeClock();
  const deps: ScreenerWorkflowDeps = {
    screenRunner: {
      // Production runners attach `full` (the opaque full agent
      // result); the child's store/deliver steps consume it.
      runScreen:
        runScreen ??
        (async (req) => ({
          ...okResult({ universe: req.universe }),
          full: { marker: "full-result", universe: req.universe },
        })),
    },
    shardStore: store,
    storeReport: async (payload) => {
      stored.push(payload);
    },
    deliverOutcome: async (payload) => {
      delivered.push(payload);
    },
    nowMs: clock.nowMs,
  };
  return { store, stored, delivered, clock, deps };
}

/** Child ops keyed by child workflow id, with canned statuses. */
function makeChildOps(
  statuses: Record<string, { status: WorkflowInstanceStatus; output?: unknown; error?: { message: string } }>,
  created: string[] = [],
): ChildWorkflowOps {
  return {
    createChild: async (cmd) => {
      created.push(cmd.shard?.shardId ?? "?");
      return { workflowId: workflowIdForJob(cmd.jobId) };
    },
    getChildStatus: async (workflowId) => {
      const s = statuses[workflowId];
      if (!s) return { status: "running" };
      return s;
    },
  };
}

function childId(parentJobId: string, shardId: string): string {
  return workflowIdForJob(`${parentJobId}:shard:${shardId}`);
}

async function latestParentRow(store: ShardJobStore, jobId: string) {
  return store.latestJob("tenant-1", jobId, jobId);
}

/* ------------------------------------------------------------------ */
/* Port: command validation + instance ids                             */
/* ------------------------------------------------------------------ */

describe("workflow command validation", () => {
  it("accepts a well-formed parent command", () => {
    expect(assertWorkflowJobCommand(parentCommand())).toBeDefined();
  });

  it("rejects a missing jobId", () => {
    const cmd = parentCommand();
    delete (cmd as Partial<WorkflowJobCommand>).jobId;
    expect(() => assertWorkflowJobCommand(cmd)).toThrow(WorkflowError);
  });

  it("rejects a missing userLogin (fail closed, #1185)", () => {
    const cmd = parentCommand();
    delete (cmd as Partial<WorkflowJobCommand>).userLogin;
    expect(() => assertWorkflowJobCommand(cmd)).toThrow(WorkflowError);
  });

  it("rejects an unknown command type", () => {
    const cmd = { ...parentCommand(), type: "explode" } as unknown as WorkflowJobCommand;
    expect(() => assertWorkflowJobCommand(cmd)).toThrow(WorkflowError);
  });

  it("rejects an empty shard list", () => {
    expect(() => assertWorkflowJobCommand(parentCommand({ shards: [] }))).toThrow(WorkflowError);
  });

  it("rejects a symbol list over the claim-check cap", () => {
    const symbols = Array.from({ length: 201 }, (_, i) => `SYM${i}`);
    expect(() =>
      assertWorkflowJobCommand(
        parentCommand({ shards: [{ shardId: "symbols", symbols }] }),
      ),
    ).toThrow(WorkflowError);
  });

  it("rejects a shard command without parentJobId/shard", () => {
    const cmd = parentCommand({ role: "shard" });
    expect(() => assertWorkflowJobCommand(cmd)).toThrow(WorkflowError);
  });
});

describe("workflowIdForJob", () => {
  it("is deterministic and sanitizes ':'", () => {
    expect(workflowIdForJob("screener:scheduled:TECH:ALL:2026-10-26T12:00")).toBe(
      "screen-screener-scheduled-TECH-ALL-2026-10-26T12-00",
    );
    expect(workflowIdForJob("job-1")).toBe(workflowIdForJob("job-1"));
  });

  it("refuses ids over 100 chars rather than truncating into a collision", () => {
    expect(() => workflowIdForJob("x".repeat(200))).toThrow(WorkflowError);
  });
});

/* ------------------------------------------------------------------ */
/* Collation (pure)                                                    */
/* ------------------------------------------------------------------ */

describe("collateShards", () => {
  it("all completed → Completed, unqualified, full coverage", () => {
    const c = collateShards("job-1", "screen-job-1", [
      { shardId: "A", status: "completed", totalScanned: 10, expectedCount: 10, matchedCount: 1 },
      { shardId: "B", status: "completed", totalScanned: 5, expectedCount: 5, matchedCount: 0 },
    ], [], []);
    expect(c.lifecycle).toBe("Completed");
    expect(c.qualified).toBe(false);
    expect(c.coverage).toEqual({ evaluated: 15, considered: 15, ratio: 1 });
  });

  it("one failed → Completed but qualified (partial, not failure)", () => {
    const c = collateShards("job-1", "screen-job-1", [
      { shardId: "A", status: "completed", totalScanned: 10, expectedCount: 10 },
      { shardId: "B", status: "failed", error: "boom", expectedCount: 10 },
    ], [], []);
    expect(c.lifecycle).toBe("Completed");
    expect(c.qualified).toBe(true);
    expect(c.coverage.ratio).toBe(10 / 20);
  });

  it("all failed → Failed with an error", () => {
    const c = collateShards("job-1", "screen-job-1", [
      { shardId: "A", status: "failed", error: "boom" },
    ], [], []);
    expect(c.lifecycle).toBe("Failed");
    expect(c.error).toBe("boom");
  });

  it("zero considered → null ratio (never NaN)", () => {
    const c = collateShards("job-1", "screen-job-1", [
      { shardId: "A", status: "completed", totalScanned: 0, expectedCount: 0 },
    ], [], []);
    expect(c.coverage.ratio).toBeNull();
  });

  it("all completed + all stored → ReportGenerated (flags come from children)", () => {
    const c = collateShards("job-1", "screen-job-1", [
      { shardId: "A", status: "completed", totalScanned: 10, expectedCount: 10, stored: true, delivered: true },
      { shardId: "B", status: "completed", totalScanned: 5, expectedCount: 5, stored: true, delivered: true },
    ], [], []);
    expect(c.lifecycle).toBe("ReportGenerated");
    expect(c.storedShards).toEqual(["A", "B"]);
    expect(c.deliveredShards).toEqual(["A", "B"]);
  });

  it("one completed-but-unstored shard → Completed + storeErrors map", () => {
    const c = collateShards("job-1", "screen-job-1", [
      { shardId: "A", status: "completed", totalScanned: 10, expectedCount: 10, stored: false, storeError: "R2 down" },
      { shardId: "B", status: "completed", totalScanned: 5, expectedCount: 5, stored: true },
    ], [], []);
    expect(c.lifecycle).toBe("Completed");
    expect(c.storeErrors).toEqual({ A: "R2 down" });
  });
});

describe("stageTransitionsForShard", () => {
  it("completed shard records feed+gather+analysis completed", () => {
    expect(stageTransitionsForShard({ shardId: "A", status: "completed" }, 5)).toEqual([
      { stage: "feed", outcome: "completed", atMs: 5 },
      { stage: "gather", outcome: "completed", atMs: 5 },
      { stage: "analysis", outcome: "completed", atMs: 5 },
    ]);
  });

  it("failed shard records only analysis.failed (feed/gather unobserved, not claimed)", () => {
    expect(stageTransitionsForShard({ shardId: "A", status: "failed" }, 5)).toEqual([
      { stage: "analysis", outcome: "failed", atMs: 5 },
    ]);
  });
});

describe("shard result helpers", () => {
  it("shardSummaryFromResult mirrors success", () => {
    expect(shardSummaryFromResult("A", okResult())).toMatchObject({
      shardId: "A",
      status: "completed",
      totalScanned: 10,
    });
    expect(shardSummaryFromResult("A", okResult({ success: false, error: "x" }))).toMatchObject({
      status: "failed",
      error: "x",
    });
  });

  it("asShardScreenResult rejects garbage (never crashes collation)", () => {
    expect(asShardScreenResult(null)).toBeNull();
    expect(asShardScreenResult({ success: true })).toBeNull();
    expect(asShardScreenResult(okResult())).toMatchObject({ success: true });
  });

  it("asShardScreenResult strips full but keeps child store/deliver flags", () => {
    const out = asShardScreenResult({
      ...okResult(),
      full: { bulk: "must not cross" },
      stored: true,
      delivered: false,
      deliverError: "x",
    });
    expect(out).not.toBeNull();
    expect("full" in (out ?? {})).toBe(false);
    expect(out).toMatchObject({ stored: true, delivered: false, deliverError: "x" });
  });
});

/* ------------------------------------------------------------------ */
/* Shard flow                                                          */
/* ------------------------------------------------------------------ */

function shardCommand(overrides: Partial<WorkflowJobCommand> = {}): WorkflowJobCommand {
  return {
    ...parentCommand(),
    role: "shard",
    parentJobId: "job-1",
    shard: { shardId: "TECH", universe: "TECH" },
    shards: [{ shardId: "TECH", universe: "TECH" }],
    jobId: "job-1:shard:TECH",
    ...overrides,
  };
}

describe("runShardFlow (child owns store + deliver)", () => {
  it("executes, stores + delivers its full result, projects its row, returns a stripped summary", async () => {
    const b = makeDeps();
    const output = await runShardFlow(shardCommand(), b.clock.step, b.deps);
    expect(output.success).toBe(true);
    expect(output.stored).toBe(true);
    expect(output.delivered).toBe(true);
    // Claim-check: bulk data never leaves the child.
    expect("full" in output).toBe(false);
    expect(b.stored).toEqual([{ marker: "full-result", universe: "TECH" }]);
    expect(b.delivered).toEqual([{ marker: "full-result", universe: "TECH" }]);
    const rows = await b.store.listJobsForChain("tenant-1", "job-1");
    expect(rows.map((r) => r.jobKey)).toContain("shard:TECH");
    expect(rows.find((r) => r.jobKey === "shard:TECH")?.status).toBe("completed");
  });

  it("deliver=false skips the deliver step (market-data/premium shape)", async () => {
    const b = makeDeps();
    const output = await runShardFlow(shardCommand({ deliver: false }), b.clock.step, b.deps);
    expect(output.delivered).toBe(false);
    expect(b.delivered).toHaveLength(0);
    expect(b.stored).toHaveLength(1);
  });

  it("a store failure is recorded, never fatal to the screen", async () => {
    const b = makeDeps();
    b.deps.storeReport = async () => {
      throw new Error("R2 down");
    };
    const output = await runShardFlow(shardCommand(), b.clock.step, b.deps);
    expect(output.success).toBe(true);
    expect(output.stored).toBe(false);
    expect(output.storeError).toBe("R2 down");
  });

  it("a deliver failure is recorded, never fatal", async () => {
    const b = makeDeps();
    b.deps.deliverOutcome = async () => {
      throw new Error("pipeline down");
    };
    const output = await runShardFlow(shardCommand(), b.clock.step, b.deps);
    expect(output.delivered).toBe(false);
    expect(output.deliverError).toBe("pipeline down");
  });

  it("a failed screen is still stored + delivered (canonical attempt record, sync-path parity)", async () => {
    const b = makeDeps(async (req) => ({
      ...okResult({ success: false, error: "no quotes", universe: req.universe }),
      full: { marker: "full-failed" },
    }));
    const output = await runShardFlow(shardCommand(), b.clock.step, b.deps);
    expect(output.success).toBe(false);
    expect(output.stored).toBe(true);
    expect(output.delivered).toBe(true);
    const rows = await b.store.listJobsForChain("tenant-1", "job-1");
    // Slice-2 rule: a failed leg keys as leg:<stepId> (no job id).
    expect(rows.find((r) => r.jobKey === "leg:TECH")?.status).toBe("failed");
  });

  it("a throwing runner propagates (step retry is the runtime's job)", async () => {
    const b = makeDeps(async () => {
      throw new Error("provider down");
    });
    await expect(runShardFlow(shardCommand(), b.clock.step, b.deps)).rejects.toThrow("provider down");
  });
});

/* ------------------------------------------------------------------ */
/* Parent flow                                                         */
/* ------------------------------------------------------------------ */

describe("runParentFlow (collates child flags; never stores or delivers)", () => {
  it("happy path: 2 stored shards → ReportGenerated, rows projected, parent deps untouched", async () => {
    const b = makeDeps();
    const ops = makeChildOps({
      [childId("job-1", "TECH")]: { status: "complete", output: { ...okResult({ universe: "TECH", pdfKey: "pdf-tech" }), stored: true, delivered: true } },
      [childId("job-1", "HEALTH")]: { status: "complete", output: { ...okResult({ universe: "HEALTH", pdfKey: "pdf-health" }), stored: true, delivered: true } },
    });
    const c = await runParentFlow(parentCommand(), b.clock.step, b.deps, ops);
    expect(c.lifecycle).toBe("ReportGenerated");
    expect(c.qualified).toBe(false);
    expect(c.reportKeys).toEqual(["pdf-tech", "pdf-health"]);
    expect(c.storedShards).toEqual(["TECH", "HEALTH"]);
    expect(c.deliveredShards).toEqual(["TECH", "HEALTH"]);
    // The parent never calls store/deliver itself: fake
    // children never touch the parent's deps.
    expect(b.stored).toHaveLength(0);
    expect(b.delivered).toHaveLength(0);
    const parentRow = await latestParentRow(b.store, "job-1");
    expect(parentRow?.status).toBe("completed");
    expect(JSON.parse(parentRow?.resultJson ?? "{}").lifecycle).toBe("ReportGenerated");
    const rows = await b.store.listJobsForChain("tenant-1", "job-1");
    expect(rows.map((r) => r.jobKey).sort()).toEqual(
      ["job-1", "shard:HEALTH", "shard:TECH"].sort(),
    );
  });

  it("a completed-but-unstored shard → Completed (not ReportGenerated) + storeErrors", async () => {
    const b = makeDeps();
    const ops = makeChildOps({
      [childId("job-1", "TECH")]: { status: "complete", output: { ...okResult({ universe: "TECH" }), stored: false, delivered: false, storeError: "R2 down" } },
      [childId("job-1", "HEALTH")]: { status: "complete", output: { ...okResult({ universe: "HEALTH" }), stored: true, delivered: true } },
    });
    const c = await runParentFlow(parentCommand(), b.clock.step, b.deps, ops);
    expect(c.lifecycle).toBe("Completed");
    expect(c.storeErrors).toEqual({ TECH: "R2 down" });
    expect(c.storedShards).toEqual(["HEALTH"]);
  });

  it("timeout: hanging shard → timed_out, qualified partial, BudgetConstrained", async () => {
    const b = makeDeps();
    const ops = makeChildOps({
      [childId("job-1", "TECH")]: { status: "complete", output: { ...okResult({ universe: "TECH" }), stored: true, delivered: true } },
      // HEALTH never completes: always running.
    });
    const c = await runParentFlow(
      parentCommand({ shardTimeoutMs: 1000, pollIntervalMs: 100 }),
      b.clock.step,
      b.deps,
      ops,
    );
    // ReportGenerated = every COMPLETED shard stored; a
    // qualified partial reaches it when its usable shards are
    // all stored. It is still qualified, not a full screen.
    expect(c.lifecycle).toBe("ReportGenerated");
    expect(c.qualified).toBe(true);
    expect(c.shards.find((s) => s.shardId === "HEALTH")?.status).toBe("timed_out");
    expect(c.lifecycleTransitions.map((t) => t.lifecycle)).toContain("BudgetConstrained");
  });

  it("all failed → Failed", async () => {
    const b = makeDeps();
    const ops = makeChildOps({
      [childId("job-1", "TECH")]: { status: "complete", output: okResult({ success: false, error: "no quotes" }) },
      [childId("job-1", "HEALTH")]: { status: "errored", error: { message: "child crashed" } },
    });
    const c = await runParentFlow(parentCommand(), b.clock.step, b.deps, ops);
    expect(c.lifecycle).toBe("Failed");
  });

  it("malformed child output → failed shard, never a collation crash", async () => {
    const b = makeDeps();
    const ops = makeChildOps({
      [childId("job-1", "TECH")]: { status: "complete", output: { nonsense: true } },
      [childId("job-1", "HEALTH")]: { status: "complete", output: { ...okResult({ universe: "HEALTH" }), stored: true, delivered: true } },
    });
    const c = await runParentFlow(parentCommand(), b.clock.step, b.deps, ops);
    expect(c.shards.find((s) => s.shardId === "TECH")?.status).toBe("failed");
    expect(c.lifecycle).toBe("ReportGenerated");
    expect(c.qualified).toBe(true);
  });

  it("maxParallelShards=1 creates shards in order, one batch at a time", async () => {
    const b = makeDeps();
    const created: string[] = [];
    const shards = ["A", "B", "C"].map((s) => ({ shardId: s, universe: s }));
    const statuses: Record<string, { status: WorkflowInstanceStatus; output?: unknown }> = {};
    for (const s of shards) {
      statuses[childId("job-1", s.shardId)] = { status: "complete", output: { ...okResult({ universe: s.shardId }), stored: true, delivered: true } };
    }
    const ops = makeChildOps(statuses, created);
    await runParentFlow(parentCommand({ shards, maxParallelShards: 1 }), b.clock.step, b.deps, ops);
    expect(created).toEqual(["A", "B", "C"]);
  });
});

/* ------------------------------------------------------------------ */
/* Adapters: conformance (same suite, both adapters)                   */
/* ------------------------------------------------------------------ */

function fakeBinding() {
  const instances = new Map<string, { status: WorkflowInstanceStatus; output?: unknown }>();
  let createCalls = 0;
  const binding: WorkflowBindingLike = {
    create: async ({ id }) => {
      createCalls += 1;
      if (instances.has(id)) throw new Error("already exists");
      instances.set(id, { status: "queued" });
      return { id };
    },
    get: async (id) => {
      const rec = instances.get(id);
      if (!rec) throw new Error("not found");
      return {
        id,
        status: async () => ({ status: rec.status, output: rec.output }),
      };
    },
  };
  return { binding, instances, getCreateCalls: () => createCalls };
}

describe("adapter conformance: start/status/idempotency", () => {
  it("provider adapter over a fake binding: start, duplicate adopts, unknown status null", async () => {
    const { binding, getCreateCalls } = fakeBinding();
    const adapter = new CfWorkflowAdapter(binding);
    const cmd = parentCommand();
    const h1 = await adapter.start(cmd);
    expect(h1.existing).toBe(false);
    expect(h1.statusUrl).toBe("/api/jobs/history?chainId=job-1");
    const h2 = await adapter.start(cmd);
    expect(h2.existing).toBe(true);
    expect(h2.workflowId).toBe(h1.workflowId);
    expect(getCreateCalls()).toBe(2);
    expect(await adapter.status("nope")).toBeNull();
    await expect(adapter.start(parentCommand({ jobId: "" }))).rejects.toThrow(WorkflowError);
  });

  it("in-memory adapter: start runs the flow, duplicate start never re-executes", async () => {
    let runs = 0;
    const b = makeDeps(async (req) => {
      runs += 1;
      return {
        ...okResult({ universe: req.universe }),
        full: { marker: "full-result", universe: req.universe },
      };
    });
    const adapter = new InMemoryWorkflowAdapter(b.deps);
    const h1 = await adapter.start(parentCommand());
    expect(h1.existing).toBe(false);
    expect(h1.status).toBe("complete");
    expect(runs).toBe(2);
    // Real children ran: each stored + delivered its own full
    // result (the parent never touches store/deliver).
    expect(b.stored).toHaveLength(2);
    expect(b.delivered).toHaveLength(2);
    const h2 = await adapter.start(parentCommand());
    expect(h2.existing).toBe(true);
    expect(runs).toBe(2);
    const st = await adapter.status(h1.workflowId);
    expect(st?.jobId).toBe("job-1");
    expect(await adapter.status("missing")).toBeNull();
    const parentRow = await latestParentRow(b.store, "job-1");
    expect(JSON.parse(parentRow?.resultJson ?? "{}").lifecycle).toBe("ReportGenerated");
    // Real children ran: their rows exist (parent project-final
    // dedups against them via the replay rule, never duplicates).
    const rows = await b.store.listJobsForChain("tenant-1", "job-1");
    expect(rows.map((r) => r.jobKey).sort()).toEqual(
      ["job-1", "shard:HEALTH", "shard:TECH"].sort(),
    );
  });

  it("composition root returns null without bindings, adapter with both", () => {
    expect(createWorkflowPorts({})).toBeNull();
    expect(createWorkflowPorts({ SCREENER_WORKFLOW: {} })).toBeNull();
    const { binding } = fakeBinding();
    expect(createWorkflowPorts({ SCREENER_WORKFLOW: binding })).toBeNull();
    expect(createWorkflowPorts({ SCREENER_WORKFLOW: binding, AGENT_DB: {} })).not.toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* Command envelope                                                    */
/* ------------------------------------------------------------------ */

describe("workflow command envelope", () => {
  it("round-trips a command", () => {
    const cmd = parentCommand();
    const env = toWorkflowCommandEnvelope(cmd, "2026-10-26T12:00:00.000Z");
    expect(env.specversion).toBe("1.0");
    expect(env.type).toBe("run-screen");
    expect(env.id).toBe("workflow-command:run-screen:job-1");
    expect(fromWorkflowCommandEnvelope(env)).toEqual(cmd);
  });

  it("rejects non-run-screen envelopes and invalid commands", () => {
    const env = toWorkflowCommandEnvelope(parentCommand());
    expect(fromWorkflowCommandEnvelope({ ...env, type: "screener.completed" })).toBeNull();
    const bad = { ...parentCommand(), userLogin: "" };
    expect(fromWorkflowCommandEnvelope({ ...env, data: bad })).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* Port purity (provider-neutral domain surface)                       */
/* ------------------------------------------------------------------ */

describe("port purity (provider-neutral domain surface)", () => {
  const read = (rel: string) => readFileSync(resolve(__dirname, "..", rel), "utf8");
  const noProviderConcepts = (src: string) => {
    expect(src.toLowerCase()).not.toContain("cloudflare");
    expect(src).not.toContain("Queue<");
    expect(src).not.toContain(".ack(");
    expect(src).not.toContain(".retry(");
  };

  it("port, flow, envelope, in-memory adapter, and composition root carry no provider concepts", () => {
    for (const f of [
      "src/workflows/workflowPorts.ts",
      "src/workflows/screenerWorkflowFlow.ts",
      "src/workflows/workflowCommandEnvelope.ts",
      "src/workflows/inMemoryWorkflowAdapter.ts",
      "src/workflows/createWorkflowPorts.ts",
    ]) {
      noProviderConcepts(read(f));
    }
  });
});
