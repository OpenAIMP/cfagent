/**
 * Issue #1466 ([AGENTIC] Phase 5, sub-issue of #1362) — MCP exposure
 * of the Phase 1–4 definitions.
 *
 * Exactly three tools, registered in McpToolFactory alongside (never
 * instead of, never duplicating) the ~30 single-capability tools:
 *   - `goal.compile`  — Phase 2 compile over the Phase 1 registry,
 *     with Phase 4 prior-plan reuse + provenance when the MCP
 *     context carries the AI + Vectorize bindings.
 *   - `goal.schedule` — Phase 3 synthesis; returns a PENDING record
 *     only. The synthesized record type carries NO `enabled` field
 *     and `approveSynthesizedRecord` is the only path to live, so
 *     there is no MCP path that can enable a schedule.
 *   - `chain.run`     — re-validates the chain (registry, stages,
 *     order, budget) BEFORE reporting any leg, creates no scheduled
 *     job, no synthesized record, and no async job, and performs no
 *     paid action.
 *
 * One definition, two consumers: these tools call the SAME
 * `compileGoal` / `compileChain` / `synthesizeSchedule` /
 * `compileGoalWithMemory` the planner uses — no second compiler,
 * no second validator, no second synthesis record shape.
 *
 * HONESTY RULE for `chain.run`: the existing stage executors (the
 * #1355 shard executors, the async-job followup jobs) need DO/SQL
 * runtime deps the MCP command context does not carry, and invoking
 * them from MCP would create jobs — which this phase forbids. So
 * the MCP command supplies NO leg executor, and every production
 * leg reports as `unimplemented` with the reason, rather than
 * inventing execution. `runChain` itself is executor-agnostic: a
 * caller that DOES supply an executor (tests, a future wiring that
 * goes through the existing execution paths) gets real per-leg
 * dispatch, a failed leg skips later legs, and a paid leg is gated
 * on the existing PaymentsAgent budget-check path — see
 * `RunChainOptions.budgetCheck`. Wiring a real executor into the
 * MCP command is a follow-up decision, not smuggled in here.
 *
 * Auth: none of these tools authenticates anything. The server
 * route (`/mcp`, src/server.ts, #180) rejects callers without an
 * app session or a valid per-user `cfk_` API key before any DO
 * access; these commands ride that path exactly like every other
 * tool in the factory.
 */

import { z } from "zod";
import type { IMcpToolCommand, McpToolContext } from "../patterns/interfaces";
import {
  compileChain,
  compileGoal,
  type CompiledChain,
  type CompiledChainStep,
} from "../orchestrate";
import {
  compileGoalWithMemory,
  describeReuse,
  type PlanReuse,
} from "../agentic/compositionMemory";
import {
  shouldFireSynthesized,
  synthesizeSchedule,
  type SynthesizedSchedule,
} from "../agentic/jobSynthesis";
import { VectorMemory } from "../memory/vector-memory";

function validBudgetCents(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= 0
  );
}

function asBudgetCap(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (!validBudgetCents(value)) {
    throw new Error("budgetCapCents must be a non-negative integer or null.");
  }
  return value;
}

/* ------------------------------------------------------------------ */
/* goal.compile                                                        */
/* ------------------------------------------------------------------ */

export interface GoalCompileResult {
  recognized: boolean;
  chain: CompiledChain | null;
  reuse: PlanReuse | null;
  reuseDescription: string | null;
}

/**
 * Compile a goal for MCP. With a memory instance this is Phase 4's
 * `compileGoalWithMemory` (recall failure falls back to a fresh
 * compile inside that function); without one it is exactly the
 * Phase 2 compiler. Never throws for an unrecognized goal — that
 * is a null chain, not an error, because the compiler never
 * hallucinates a chain for free text it does not recognize.
 */
export async function compileGoalForMcp(
  goal: string,
  budgetCents: number,
  budgetCapCents: number | null,
  memory?: VectorMemory | null,
): Promise<GoalCompileResult> {
  if (typeof goal !== "string" || goal.trim().length === 0) {
    throw new Error("goal.compile: goal is required.");
  }
  if (!validBudgetCents(budgetCents)) {
    throw new Error("goal.compile: budgetCents must be a non-negative integer.");
  }
  const { chain, reuse } = memory
    ? await compileGoalWithMemory(goal, { budgetCents, budgetCapCents, memory })
    : {
        chain: compileGoal(goal, { budgetCents, budgetCapCents }),
        reuse: null as PlanReuse | null,
      };
  return {
    recognized: chain !== null,
    chain,
    reuse,
    reuseDescription: reuse ? describeReuse(reuse) : null,
  };
}

export class GoalCompileCommand implements IMcpToolCommand<{
  goal: string;
  budgetCents: number;
  budgetCapCents?: number | null;
}> {
  readonly name = "goal.compile";
  readonly description =
    "Compile a plain-text goal into a validated capability chain over the Phase 1 registry (feed → generate → store → serve → deliver, budget-capped), with any prior-plan reuse from composition memory reported with provenance. Compile output is data, not execution: it runs nothing, sends nothing, and creates no schedule.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      goal: {
        type: "string",
        description:
          "Plain-text goal, e.g. 'Create a NASDAQ100 screen and send it to Slack' or \"Send yesterday's report by email\".",
      },
      budgetCents: {
        type: "integer",
        description: "Declared budget in cents; the compiled budget must not exceed its cap.",
      },
      budgetCapCents: {
        type: "integer",
        description: "Optional budget cap in cents; null when uncapped.",
      },
    },
    required: ["goal", "budgetCents"],
  };
  readonly zodSchema = z.object({
    goal: z.string().min(1).describe("Plain-text goal to compile"),
    budgetCents: z.number().int().nonnegative().describe("Declared budget in cents"),
    budgetCapCents: z
      .number()
      .int()
      .nonnegative()
      .nullable()
      .optional()
      .describe("Optional budget cap in cents"),
  });

  async execute(
    input: { goal: string; budgetCents: number; budgetCapCents?: number | null },
    context: McpToolContext,
  ): Promise<GoalCompileResult> {
    const cap = asBudgetCap(input.budgetCapCents);
    // Phase 4 reuse only when the MCP context actually carries the
    // bindings VectorMemory needs; otherwise this is exactly the
    // Phase 2 compiler. A missing binding is not an error.
    const env = (context.env ?? {}) as unknown as Record<string, unknown>;
    const memory =
      env.AI !== undefined &&
      env.AI !== null &&
      env.VECTOR_MEMORY !== undefined &&
      env.VECTOR_MEMORY !== null
        ? new VectorMemory(env.AI, env.VECTOR_MEMORY, undefined)
        : null;
    const result = await compileGoalForMcp(
      input.goal,
      input.budgetCents,
      cap,
      memory,
    );
    context.audit("goal.compile", "mcp", {
      goal: input.goal,
      recognized: result.recognized,
      steps: result.chain?.steps.length ?? 0,
      reused: result.reuse !== null,
    });
    return result;
  }
}

/* ------------------------------------------------------------------ */
/* goal.schedule                                                       */
/* ------------------------------------------------------------------ */

export interface GoalScheduleResult {
  record: SynthesizedSchedule;
  /** Always "pending" — synthesis has no path to any other status. */
  status: "pending";
  /** Always false for a pending record, even when its cron is due. */
  fires: false;
}

/**
 * Synthesize a PENDING record from a compiled chain. Defense in
 * depth: if synthesis ever returned anything but pending, this
 * throws rather than handing a live record to an MCP caller.
 */
export function synthesizePendingForMcp(
  chain: CompiledChain,
  opts: { cron?: string | null; id?: string; timeZone?: string } = {},
): GoalScheduleResult {
  const record = synthesizeSchedule(chain, opts);
  if (record.status !== "pending") {
    throw new Error("goal.schedule refused: synthesis returned a non-pending record.");
  }
  return {
    record,
    status: "pending",
    fires: shouldFireSynthesized(record, new Date()) as false,
  };
}

export class GoalScheduleCommand implements IMcpToolCommand<{
  goal?: string;
  chain?: CompiledChain;
  budgetCents?: number;
  budgetCapCents?: number | null;
  cron?: string | null;
}> {
  readonly name = "goal.schedule";
  readonly description =
    "Synthesize a schedule/job record from a compiled chain (or from a goal compiled first). ALWAYS returns a PENDING record only: it never goes live without human confirmation, and the approval step is the only path to live. A pending record never fires, even when its cron is due. This tool creates no scheduled job, no goal-list entry, and no async job.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      goal: {
        type: "string",
        description:
          "Plain-text goal to compile first (used when chain is not supplied).",
      },
      chain: {
        type: "object",
        description:
          "A compiled chain (goal.compile output) to synthesize. When supplied, goal/budgetCents are ignored.",
      },
      budgetCents: {
        type: "integer",
        description: "Declared budget in cents, used when compiling from a goal.",
      },
      budgetCapCents: {
        type: "integer",
        description: "Optional budget cap in cents.",
      },
      cron: {
        type: "string",
        description:
          "Cron expression for recurring chains (required); must be absent for one-shot chains.",
      },
    },
  };
  readonly zodSchema = z.object({
    goal: z.string().min(1).optional().describe("Plain-text goal to compile first"),
    chain: z.any().optional().describe("A compiled chain to synthesize"),
    budgetCents: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe("Declared budget in cents"),
    budgetCapCents: z
      .number()
      .int()
      .nonnegative()
      .nullable()
      .optional()
      .describe("Optional budget cap in cents"),
    cron: z.string().nullable().optional().describe("Cron for recurring chains"),
  });

  async execute(
    input: {
      goal?: string;
      chain?: CompiledChain;
      budgetCents?: number;
      budgetCapCents?: number | null;
      cron?: string | null;
    },
    context: McpToolContext,
  ): Promise<GoalScheduleResult> {
    let chain = input.chain ?? null;
    if (!chain) {
      if (typeof input.goal !== "string" || input.goal.trim().length === 0) {
        throw new Error("goal.schedule: supply a compiled chain or a goal to compile.");
      }
      if (!validBudgetCents(input.budgetCents)) {
        throw new Error(
          "goal.schedule: budgetCents must be a non-negative integer when compiling from a goal.",
        );
      }
      chain = compileGoal(input.goal, {
        budgetCents: input.budgetCents as number,
        budgetCapCents: asBudgetCap(input.budgetCapCents),
      });
      if (!chain) {
        throw new Error(
          "goal.schedule: goal was not recognized as a compilable chain; nothing was synthesized.",
        );
      }
    }
    const result = synthesizePendingForMcp(chain, {
      ...(input.cron !== undefined ? { cron: input.cron } : {}),
    });
    context.audit("goal.schedule", "mcp", {
      goal: chain.goal,
      kind: result.record.kind,
      status: result.record.status,
    });
    return result;
  }
}

/* ------------------------------------------------------------------ */
/* chain.run                                                           */
/* ------------------------------------------------------------------ */

export type ChainLegStatus =
  | "completed"
  | "failed"
  | "blocked"
  | "unimplemented"
  | "skipped";

export interface ChainLegResult {
  stepId: string;
  capabilityId: string;
  stage: string;
  status: ChainLegStatus;
  detail: string;
  result?: unknown;
}

export interface ChainRunResult {
  validated: true;
  goal: string;
  budgetCents: number;
  budgetCapCents: number | null;
  legs: ChainLegResult[];
  /** True only when at least one leg actually executed. */
  ranAnything: boolean;
  /** Always false: chain.run never creates a scheduled job. */
  scheduledJobCreated: false;
  /** Always false from the MCP command (no executor supplied). */
  paidActionPerformed: false;
  ok: boolean;
}

export interface RunChainOptions {
  /**
   * Executor for one validated leg, supplied ONLY by a caller that
   * routes through an existing execution path. The MCP command
   * never supplies one. When absent, every leg reports
   * `unimplemented` — honest, and no execution is invented.
   */
  executeLeg?: (step: CompiledChainStep) => Promise<unknown>;
  /**
   * Existing PaymentsAgent budget-check path: when a leg executor
   * is supplied and the chain carries a positive budget, a false
   * verdict blocks the leg (and skips later legs) instead of
   * performing a paid action. With no executor this gate is moot
   * — no paid action can occur — but the parameter documents the
   * contract any future wiring must satisfy.
   */
  budgetCheck?: (budgetCents: number) => Promise<boolean> | boolean;
}

/**
 * Run a compiled chain: re-validate FIRST through the Phase 2
 * `compileChain` (registry ids, registry-derived stages, stage
 * order, budget vs cap), then report one result per leg in chain
 * order. A failed or budget-blocked leg skips every later leg —
 * later legs are never reported as run after an earlier leg did
 * not complete. This function never synthesizes, schedules, or
 * submits anything: no `synthesizeSchedule`, no goal-list write,
 * no async-job submission anywhere in this module.
 *
 * Throws (running nothing) when the chain fails re-validation.
 */
export async function runChain(
  chain: CompiledChain,
  opts: RunChainOptions = {},
): Promise<ChainRunResult> {
  const validated = compileChain({
    goal: chain?.goal,
    steps: Array.isArray(chain?.steps)
      ? chain.steps.map((s) => ({ capabilityId: s.capabilityId, args: s.args }))
      : [],
    budgetCents: chain?.budgetCents,
    budgetCapCents: chain?.budgetCapCents ?? null,
    recurrence: chain?.recurrence ?? "one-shot",
    reusesStoredReport: chain?.reusesStoredReport ?? false,
  });
  if (!validated) {
    throw new Error(
      "chain.run refused: chain failed re-validation (unknown or planned capability, out-of-order stage, duplicate step, or budget over cap); nothing was run.",
    );
  }
  const legs: ChainLegResult[] = [];
  let stopped = false;
  let ranAnything = false;
  let ok = true;
  for (const step of validated.steps) {
    if (stopped) {
      legs.push({
        stepId: step.id,
        capabilityId: step.capabilityId,
        stage: step.stage,
        status: "skipped",
        detail: "Skipped: an earlier leg did not complete.",
      });
      continue;
    }
    if (!opts.executeLeg) {
      legs.push({
        stepId: step.id,
        capabilityId: step.capabilityId,
        stage: step.stage,
        status: "unimplemented",
        detail:
          `No executor callable from the MCP command context for ${step.capabilityId}; ` +
          "existing execution rides the #1355 sharded chain / async-job path, which chain.run does not invoke.",
      });
      continue;
    }
    if (validated.budgetCents > 0 && opts.budgetCheck) {
      const allowed = await opts.budgetCheck(validated.budgetCents);
      if (!allowed) {
        ok = false;
        stopped = true;
        legs.push({
          stepId: step.id,
          capabilityId: step.capabilityId,
          stage: step.stage,
          status: "blocked",
          detail:
            "Blocked: the existing PaymentsAgent budget check did not allow this chain's budget; no paid action was performed.",
        });
        continue;
      }
    }
    try {
      const result = await opts.executeLeg(step);
      ranAnything = true;
      legs.push({
        stepId: step.id,
        capabilityId: step.capabilityId,
        stage: step.stage,
        status: "completed",
        detail: "Completed via the caller-supplied existing execution path.",
        result,
      });
    } catch (err) {
      ok = false;
      stopped = true;
      legs.push({
        stepId: step.id,
        capabilityId: step.capabilityId,
        stage: step.stage,
        status: "failed",
        detail: `Failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
  // A run whose legs are all unimplemented did not fail — it
  // reported honestly. `ok` is false only on failed/blocked legs.
  return {
    validated: true,
    goal: validated.goal,
    budgetCents: validated.budgetCents,
    budgetCapCents: validated.budgetCapCents,
    legs,
    ranAnything,
    scheduledJobCreated: false,
    paidActionPerformed: false,
    ok,
  };
}

export class ChainRunCommand implements IMcpToolCommand<{ chain: CompiledChain }> {
  readonly name = "chain.run";
  readonly description =
    "Run a compiled chain: re-validates it first (registry, stages, order, budget), then reports one result per leg in order. Creates no scheduled job and performs no paid action; legs with no executor callable from the MCP context are reported as unimplemented rather than invented. A failed leg skips later legs.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      chain: {
        type: "object",
        description:
          "A compiled chain (goal.compile output): goal, validated steps, budgetCents, budgetCapCents, recurrence, reusesStoredReport.",
      },
    },
    required: ["chain"],
  };
  readonly zodSchema = z.object({
    chain: z.any().describe("A compiled chain to run"),
  });

  async execute(
    input: { chain: CompiledChain },
    context: McpToolContext,
  ): Promise<ChainRunResult> {
    if (!input.chain || typeof input.chain !== "object") {
      throw new Error("chain.run: a compiled chain is required.");
    }
    // Deliberately no executor: the MCP command context carries no
    // DO/SQL runtime for the existing stage executors, and invoking
    // them would create jobs. Legs report honestly as unimplemented.
    const result = await runChain(input.chain);
    context.audit("chain.run", "mcp", {
      goal: result.goal,
      legs: result.legs.length,
      ranAnything: result.ranAnything,
      scheduledJobCreated: false,
    });
    return result;
  }
}
