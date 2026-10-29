/**
 * Issue #2341 (Agent Mesh S5, programme #2225 G1 batch A) — the
 * chat-turn commands over the mesh doors.
 *
 * Four thin commands, registered in McpToolFactory alongside (never
 * instead of) the existing catalog, each declaring exactly one
 * scope in MCP_TOOL_SCOPES (#1744):
 *   - `list_scheduled_goals`  (mcp:read)     — list/inspect the
 *     scheduled-goal catalogue through the ScheduledAgent door.
 *   - `trigger_scheduled_goal` (mcp:write)   — trigger one goal;
 *     the returned tick is the agent's real outcome.
 *   - `check_payment_budget`  (mcp:payments) — PaymentsAgent budget
 *     verdict for a proposed spend, against the orchestrator bucket.
 *   - `get_payments_overview` (mcp:payments) — today's spend +
 *     recent payments, read through PaymentsAgent.
 *
 * The commands are thin by design (doors-and-layers §11.1): resolve
 * identity -> gate -> dispatch. Identity comes ONLY from the tool
 * context's actingLogin carrier — populated server-side by the
 * chat-turn context owner and threaded through the async-job path —
 * never from tool arguments (a caller-supplied login argument would
 * be a forgery surface, and the schemas deliberately carry none).
 * Without an identified chat turn the door refuses (fail-closed);
 * external MCP callers reach these agents through the A2A doors
 * (#2223) instead. All behavior lives in the door module
 * (src/agents/orchestrator/meshDoors.ts); these classes validate
 * input shape, dispatch, and audit.
 */

import { z } from "zod";
import type { IMcpToolCommand, McpToolContext } from "../patterns/interfaces";
import {
  listScheduledGoalsViaDoor,
  triggerScheduledGoalViaDoor,
  checkPaymentBudgetViaDoor,
  getPaymentsOverviewViaDoor,
  type ScheduledGoalsDoorResult,
  type ScheduledGoalTriggerDoorResult,
  type PaymentBudgetDoorResult,
  type PaymentsOverviewDoorResult,
} from "../agents/orchestrator/meshDoors";

/* ------------------------------------------------------------------ */
/* list_scheduled_goals                                                */
/* ------------------------------------------------------------------ */

export class ListScheduledGoalsCommand implements IMcpToolCommand<{
  goalId?: string;
}> {
  readonly name = "list_scheduled_goals";
  readonly description =
    "List the scheduled-goal catalogue through the ScheduledAgent door, or inspect one goal when goalId is given. Read-only. Requires the chat turn's acting identity; the catalogue is the shared operator catalogue the schedule routes expose to any signed-in user.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      goalId: {
        type: "string",
        description: "Optional: return only the goal with this id (an unknown id is an error, not an empty list).",
      },
    },
  };
  readonly zodSchema = z.object({
    goalId: z.string().min(1).optional().describe("Optional goal id to inspect"),
  });

  async execute(
    input: { goalId?: string },
    context: McpToolContext,
  ): Promise<ScheduledGoalsDoorResult> {
    const actingLogin = context.actingLogin?.();
    const result = await listScheduledGoalsViaDoor(context.env, actingLogin, input.goalId);
    context.audit("list_scheduled_goals", "mcp", {
      actingLogin: actingLogin ?? null,
      goalId: input.goalId ?? null,
      count: result.goals.length,
    });
    return result;
  }
}

/* ------------------------------------------------------------------ */
/* trigger_scheduled_goal                                              */
/* ------------------------------------------------------------------ */

export class TriggerScheduledGoalCommand implements IMcpToolCommand<{
  goalId: string;
}> {
  readonly name = "trigger_scheduled_goal";
  readonly description =
    "Trigger one scheduled goal now through the ScheduledAgent door. Returns the agent's real tick outcome (jobs created/skipped, errors) — a budget-denied firing is reported in the tick, never as success. Requires the chat turn's acting identity.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      goalId: {
        type: "string",
        description: "The id of the scheduled goal to trigger.",
      },
    },
    required: ["goalId"],
  };
  readonly zodSchema = z.object({
    goalId: z.string().min(1).describe("The scheduled goal id"),
  });

  async execute(
    input: { goalId: string },
    context: McpToolContext,
  ): Promise<ScheduledGoalTriggerDoorResult> {
    const actingLogin = context.actingLogin?.();
    const result = await triggerScheduledGoalViaDoor(context.env, actingLogin, input.goalId);
    context.audit("trigger_scheduled_goal", "mcp", {
      actingLogin: actingLogin ?? null,
      goalId: input.goalId,
      jobsCreated: result.tick.jobsCreated,
      jobsSkipped: result.tick.jobsSkipped,
      errors: result.tick.errors.length,
    });
    return result;
  }
}

/* ------------------------------------------------------------------ */
/* check_payment_budget                                                */
/* ------------------------------------------------------------------ */

export class CheckPaymentBudgetCommand implements IMcpToolCommand<{
  operation: string;
  amountCents: number;
}> {
  readonly name = "check_payment_budget";
  readonly description =
    "Ask PaymentsAgent whether a proposed spend is within budget: evaluates the BudgetGuard against the orchestrator spend bucket (the bucket chat-executed spend is attributed to in the ledger). A check records nothing. The verdict, including a denial's reason, is the guard's own. Requires the chat turn's acting identity.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      operation: {
        type: "string",
        description: "The budget-guarded operation name (must be on the guard allowlist, e.g. search.query, nlq.execute).",
      },
      amountCents: {
        type: "number",
        description: "The proposed spend, in cents (positive integer).",
      },
    },
    required: ["operation", "amountCents"],
  };
  readonly zodSchema = z.object({
    operation: z.string().min(1).describe("The budget-guarded operation name"),
    amountCents: z.number().int().positive().describe("The proposed spend, in cents"),
  });

  async execute(
    input: { operation: string; amountCents: number },
    context: McpToolContext,
  ): Promise<PaymentBudgetDoorResult> {
    const actingLogin = context.actingLogin?.();
    const result = await checkPaymentBudgetViaDoor(context.env, actingLogin, input);
    context.audit("check_payment_budget", "mcp", {
      actingLogin: actingLogin ?? null,
      operation: input.operation,
      amountCents: input.amountCents,
      agentId: result.agentId,
      allowed: result.allowed,
    });
    return result;
  }
}

/* ------------------------------------------------------------------ */
/* get_payments_overview                                               */
/* ------------------------------------------------------------------ */

export class GetPaymentsOverviewCommand implements IMcpToolCommand<{
  limit?: number;
}> {
  readonly name = "get_payments_overview";
  readonly description =
    "Read the payments overview through PaymentsAgent: total spent today (cents) and the most recent payments from the ledger of record. Read-only. Requires the chat turn's acting identity.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      limit: {
        type: "number",
        description: "How many recent payments to include (default 10).",
      },
    },
  };
  readonly zodSchema = z.object({
    limit: z.number().int().positive().max(50).optional().describe("Recent payments to include (default 10)"),
  });

  async execute(
    input: { limit?: number },
    context: McpToolContext,
  ): Promise<PaymentsOverviewDoorResult> {
    const actingLogin = context.actingLogin?.();
    const result = await getPaymentsOverviewViaDoor(context.env, actingLogin, input.limit);
    context.audit("get_payments_overview", "mcp", {
      actingLogin: actingLogin ?? null,
      todaySpentCents: result.todaySpentCents,
      count: result.recentPayments.length,
    });
    return result;
  }
}
