/**
 * Issue #1996 (#1972 slice 1) — goal-screen commands on the
 * existing ScreenerScreenWorkflow machinery. TDD: written
 * against the slice-1 contract before the implementation.
 *
 * Covers: port validation for goal-screen commands, the
 * shard flow's goal branch (including the fail-closed rule:
 * a goal command NEVER falls back to a market screen), the
 * goal result → shard result mapping, and parent collation
 * for a single-goal-shard run.
 */
import { describe, expect, it, vi } from "vitest";
import { InMemoryShardJobAdapter } from "../src/data/inMemoryShardJobAdapter";
import {
  goalResultToShardResult,
  goalShardRequest,
  runParentFlow,
  runShardFlow,
  type ChildWorkflowOps,
  type ScreenerWorkflowDeps,
  type ScreenerWorkflowStep,
  type ShardScreenResult,
} from "../src/workflows/screenerWorkflowFlow";
import {
  assertWorkflowJobCommand,
  WorkflowError,
  workflowIdForJob,
  type WorkflowJobCommand,
} from "../src/workflows/workflowPorts";
import { buildScenario } from "../src/services/goalScenarioEngine";
import type { GoalDrivenScreenResult } from "../src/services/goalDrivenScreen";
import { STOCK_SCREENING_PROVIDER_ID } from "../src/trading/screeningProvider";

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

function fakeGoalResult(overrides: Partial<GoalDrivenScreenResult> = {}): GoalDrivenScreenResult {
  return {
    goalKind: "income",
    outlook: "bullish",
    plan: {
      goalKind: "income",
      outlook: "bullish",
      structures: ["cash_secured_put"],
      stockFilter: {},
      optionsFilter: {},
    },
    status: "complete",
    hits: [
      { assetClass: "stocks", providerId: STOCK_SCREENING_PROVIDER_ID, symbol: "AAPL" },
    ],
    counts: {
      stocksScanned: 100,
      stocksMatched: 1,
      optionsUnderlyingsScanned: 50,
      optionsContractsMatched: 0,
      hits: 1,
    },
    completedAt: "2026-10-27T12:00:00.000Z",
    ...overrides,
  };
}

function goalParentCommand(overrides: Partial<WorkflowJobCommand> = {}): WorkflowJobCommand {
  return {
    jobId: "goal-screen:manual:alice:income:2026-10-27T12:00:00.000Z",
    type: "run-screen",
    source: "manual",
    trigger: "manual",
    userLogin: "alice",
    role: "parent",
    tenantId: "tenant-1",
    shards: [{ shardId: "goal" }],
    goalScreen: {
      scenario: buildScenario({
        goalKind: "income",
        portfolioRef: { kind: "hypothetical" },
      }),
      scenarioSource: "built",
    },
    ...overrides,
  };
}

function goalShardCommand(parent: WorkflowJobCommand): WorkflowJobCommand {
  return {
    ...parent,
    role: "shard",
    parentJobId: parent.jobId,
    shard: { shardId: "goal" },
    shards: [{ shardId: "goal" }],
    jobId: `${parent.jobId}:shard:goal`,
  };
}

function okGoalShardResult(result: GoalDrivenScreenResult): ShardScreenResult {
  return goalResultToShardResult({
    taskId: "task-1",
    scenarioSource: "built",
    trigger: "manual",
    result,
  });
}

interface GoalDepsBundle {
  stored: unknown[];
  delivered: unknown[];
  clock: ReturnType<typeof makeClock>;
  deps: ScreenerWorkflowDeps;
  runScreen: ReturnType<typeof vi.fn>;
  runGoalScreen: ReturnType<typeof vi.fn>;
}

function makeGoalDeps(opts: { withGoalRunner: boolean; deliver?: boolean }): GoalDepsBundle {
  const store = new InMemoryShardJobAdapter();
  const stored: unknown[] = [];
  const delivered: unknown[] = [];
  const clock = makeClock();
  const runScreen = vi.fn(async () => {
    throw new Error("market runner must never run for a goal command");
  });
  const runGoalScreen = vi.fn(async (req: Parameters<NonNullable<ScreenerWorkflowDeps["screenRunner"]["runGoalScreen"]>>[0]) => {
    const result = fakeGoalResult();
    return okGoalShardResult(result);
  });
  const deps: ScreenerWorkflowDeps = {
    screenRunner: opts.withGoalRunner
      ? { runScreen, runGoalScreen }
      : { runScreen },
    shardStore: store,
    storeReport: async (payload) => {
      stored.push(payload);
    },
    deliverOutcome: async (payload) => {
      delivered.push(payload);
    },
    nowMs: clock.nowMs,
  };
  return { stored, delivered, clock, deps, runScreen, runGoalScreen };
}

/* ------------------------------------------------------------------ */
/* Port: goal-screen command validation                                */
/* ------------------------------------------------------------------ */

describe("goal-screen command validation (#1996)", () => {
  it("accepts a well-formed goal parent command", () => {
    expect(assertWorkflowJobCommand(goalParentCommand())).toBeDefined();
  });

  it("rejects a goal command without a scenario", () => {
    const cmd = goalParentCommand();
    delete (cmd.goalScreen as Partial<NonNullable<WorkflowJobCommand["goalScreen"]>>).scenario;
    expect(() => assertWorkflowJobCommand(cmd)).toThrow(WorkflowError);
  });

  it("rejects a goal command with an unknown asset class", () => {
    const cmd = goalParentCommand({
      goalScreen: {
        scenario: buildScenario({ goalKind: "income", portfolioRef: { kind: "hypothetical" } }),
        scenarioSource: "built",
        assetClasses: ["crypto"] as never,
      },
    });
    expect(() => assertWorkflowJobCommand(cmd)).toThrow(WorkflowError);
  });

  it("rejects a goal command with symbols over the claim-check cap", () => {
    const cmd = goalParentCommand({
      goalScreen: {
        scenario: buildScenario({ goalKind: "income", portfolioRef: { kind: "hypothetical" } }),
        scenarioSource: "built",
        symbols: Array.from({ length: 201 }, (_, i) => `SYM${i}`),
      },
    });
    expect(() => assertWorkflowJobCommand(cmd)).toThrow(WorkflowError);
  });

  it("rejects a goal command with an unknown deliver channel", () => {
    const cmd = goalParentCommand({
      goalScreen: {
        scenario: buildScenario({ goalKind: "income", portfolioRef: { kind: "hypothetical" } }),
        scenarioSource: "built",
        deliver: ["smoke-signal"] as never,
      },
    });
    expect(() => assertWorkflowJobCommand(cmd)).toThrow(WorkflowError);
  });

  it("leaves market commands unaffected", () => {
    const cmd = goalParentCommand();
    delete cmd.goalScreen;
    cmd.shards = [{ shardId: "TECH", universe: "TECH" }];
    expect(assertWorkflowJobCommand(cmd)).toBeDefined();
  });
});

/* ------------------------------------------------------------------ */
/* Mapping: goal result -> shard result                                */
/* ------------------------------------------------------------------ */

describe("goalResultToShardResult (#1996)", () => {
  it("maps counts, keeps the pdf key, and envelopes the full result for the child store step", () => {
    const result = fakeGoalResult({ pdfKey: "pdf-1" } as Partial<GoalDrivenScreenResult>);
    const shard = goalResultToShardResult({
      taskId: "task-1",
      scenarioSource: "stored",
      trigger: "scheduled",
      result,
    });
    expect(shard.success).toBe(true);
    expect(shard.totalScanned).toBe(150);
    expect(shard.expectedCount).toBe(150);
    expect(shard.matchedCount).toBe(1);
    expect(shard.pdfKey).toBe("pdf-1");
    expect(shard.timestamp).toBe("2026-10-27T12:00:00.000Z");
    const full = shard.full as { taskId: string; scenarioSource: string; trigger: string; result: unknown };
    expect(full.taskId).toBe("task-1");
    expect(full.scenarioSource).toBe("stored");
    expect(full.trigger).toBe("scheduled");
    expect(full.result).toBe(result);
  });

  it("marks a failed goal run failed with a loud error, never a fake success", () => {
    const result = fakeGoalResult({
      status: "failed",
      hits: [],
      counts: {
        stocksScanned: 0,
        stocksMatched: 0,
        optionsUnderlyingsScanned: 0,
        optionsContractsMatched: 0,
        hits: 0,
      },
    });
    const shard = goalResultToShardResult({
      taskId: "task-1",
      scenarioSource: "built",
      trigger: "manual",
      result,
    });
    expect(shard.success).toBe(false);
    expect(shard.error).toMatch(/failed/);
  });

  it("counts a partial goal run as success with qualification (the #462 vocabulary)", () => {
    const result = fakeGoalResult({ status: "partial" });
    const shard = goalResultToShardResult({
      taskId: "task-1",
      scenarioSource: "built",
      trigger: "manual",
      result,
    });
    expect(shard.success).toBe(true);
    expect(shard.error).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* Flow: goal shard                                                    */
/* ------------------------------------------------------------------ */

describe("runShardFlow for goal commands (#1996)", () => {
  it("executes the goal runner, stores the envelope, and never touches the market runner", async () => {
    const parent = goalParentCommand();
    const { stored, delivered, clock, deps, runScreen, runGoalScreen } = makeGoalDeps({
      withGoalRunner: true,
    });
    const out = await runShardFlow(goalShardCommand(parent), clock.step, deps);
    expect(runScreen).not.toHaveBeenCalled();
    expect(runGoalScreen).toHaveBeenCalledTimes(1);
    const req = runGoalScreen.mock.calls[0][0];
    expect(req.scenario.goalKind).toBe("income");
    expect(req.idempotencyKey).toBe(parent.jobId);
    expect(req.userLogin).toBe("alice");
    expect(out.success).toBe(true);
    expect(out.stored).toBe(true);
    expect(out.delivered).toBe(false);
    expect((out as Record<string, unknown>).full).toBeUndefined();
    expect(stored).toHaveLength(1);
    const envelope = stored[0] as { taskId: string; scenarioSource: string; result: GoalDrivenScreenResult };
    expect(envelope.taskId).toBe("task-1");
    expect(envelope.scenarioSource).toBe("built");
    expect(envelope.result.goalKind).toBe("income");
    expect(delivered).toHaveLength(0);
  });

  it("runs the deliver step for goal commands that carry deliver channels", async () => {
    const parent = goalParentCommand({ deliver: true });
    const { stored, delivered, clock, deps } = makeGoalDeps({ withGoalRunner: true });
    const out = await runShardFlow(goalShardCommand(parent), clock.step, deps);
    expect(out.delivered).toBe(true);
    expect(delivered).toHaveLength(1);
    expect(stored).toHaveLength(1);
  });

  it("fails closed when the runner has no goal support — never a market-screen fallback", async () => {
    const parent = goalParentCommand();
    const { clock, deps, runScreen } = makeGoalDeps({ withGoalRunner: false });
    await expect(runShardFlow(goalShardCommand(parent), clock.step, deps)).rejects.toThrow(/goal/i);
    expect(runScreen).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ */
/* Flow: goal parent collation                                         */
/* ------------------------------------------------------------------ */

describe("runParentFlow for goal commands (#1996)", () => {
  it("collates a single stored goal shard to ReportGenerated", async () => {
    const parent = goalParentCommand({ deliver: true });
    const { stored, delivered, clock, deps } = makeGoalDeps({ withGoalRunner: true });
    const outputs = new Map<string, ShardScreenResult>();
    const ops: ChildWorkflowOps = {
      createChild: async (cmd) => {
        const out = await runShardFlow(cmd, clock.step, deps);
        outputs.set(workflowIdForJob(cmd.jobId), out);
        return { workflowId: workflowIdForJob(cmd.jobId) };
      },
      getChildStatus: async (workflowId) => {
        const out = outputs.get(workflowId);
        return out ? { status: "complete", output: out } : { status: "running" };
      },
    };
    const collation = await runParentFlow(parent, clock.step, deps, ops);
    expect(collation.lifecycle).toBe("ReportGenerated");
    expect(collation.qualified).toBe(false);
    expect(collation.shards).toHaveLength(1);
    expect(collation.shards[0].shardId).toBe("goal");
    expect(collation.shards[0].status).toBe("completed");
    expect(collation.shards[0].matchedCount).toBe(1);
    expect(collation.storedShards).toEqual(["goal"]);
    expect(collation.deliveredShards).toEqual(["goal"]);
    expect(stored).toHaveLength(1);
    expect(delivered).toHaveLength(1);
  });
});
