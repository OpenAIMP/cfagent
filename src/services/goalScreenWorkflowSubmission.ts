/**
 * Issue #1996 (#1972 slice 1) — goal-screen submission onto
 * the existing ScreenerScreenWorkflow machinery, shared by
 * the manual route and the scheduled service so both entries
 * build the identical command (no divergent second shape).
 *
 * Best-effort rule (mirrors the route-side
 * tryStartScreenerWorkflow): any failure — unbound workflow,
 * unbound projection store, invalid command, start error —
 * returns null and the caller falls back to the synchronous
 * direct path. An opt-in workflow submission must never 500
 * (route) or fail (schedule tick) a screen the direct path
 * can serve. Failures are console.warned so operators see a
 * degraded workflow path in logs.
 */
import {
  createWorkflowPorts,
  type WorkflowEnv,
} from "../workflows/createWorkflowPorts";
import type {
  WorkflowHandle,
  WorkflowJobCommand,
} from "../workflows/workflowPorts";
import type { ScenarioDefinition } from "./goalScenarioEngine";

/** Inputs to a goal-screen workflow submission (both entries build the same shape). */
export interface GoalScreenSubmissionInput {
  /** Idempotency key: the run's key (manual timestamp key, scheduled minute-slot key). */
  jobId: string;
  /** Trigger source for audit (never branched on): "manual" or "scheduled-tasks". */
  source: string;
  trigger: "manual" | "scheduled";
  /** Owner login. Required — fail closed without an identity (#1185). */
  userLogin: string;
  /** Tenant id resolved by the starter (absent → projection best-effort skipped). */
  tenantId?: string;
  /** Resolved scenario (built from goalKind/direction, or restored from a stored record). */
  scenario: ScenarioDefinition;
  scenarioSource: "built" | "stored";
  assetClasses?: ("stocks" | "options")[];
  symbols?: string[];
  /** Delivery channels for the completed run (absent = no delivery step). */
  deliverChannels?: ("slack" | "email" | "webhook" | "voice")[];
  emailTo?: string;
  environment?: "TEST" | "PROD";
  /** Issue #1571: "yahoo" runs the stock leg on the Yahoo engine (scheduled fallback runs). */
  provider?: "yahoo";
  providerFallback?: {
    from: "etrade";
    reason: string;
  };
}

/**
 * Build the goal-screen parent command. A goal run is a
 * single shard ("goal"): the goal engine screens its own
 * thesis legs internally, so there is nothing to fan out —
 * the parent machinery (poll, collate, project) runs
 * unchanged over one child.
 */
export function buildGoalScreenCommand(
  input: GoalScreenSubmissionInput,
): WorkflowJobCommand {
  return {
    jobId: input.jobId,
    type: "run-screen",
    source: input.source,
    trigger: input.trigger,
    userLogin: input.userLogin,
    role: "parent",
    ...(input.tenantId ? { tenantId: input.tenantId } : {}),
    shards: [{ shardId: "goal" }],
    ...(input.deliverChannels && input.deliverChannels.length > 0 ? { deliver: true } : {}),
    ...(input.environment ? { environment: input.environment } : {}),
    goalScreen: {
      scenario: input.scenario,
      scenarioSource: input.scenarioSource,
      ...(input.assetClasses ? { assetClasses: input.assetClasses } : {}),
      ...(input.symbols ? { symbols: input.symbols } : {}),
      ...(input.deliverChannels && input.deliverChannels.length > 0
        ? { deliver: input.deliverChannels }
        : {}),
      ...(input.emailTo ? { emailTo: input.emailTo } : {}),
      ...(input.provider ? { provider: input.provider } : {}),
      ...(input.providerFallback ? { providerFallback: input.providerFallback } : {}),
    },
  };
}

/** Start a goal-screen workflow when the port is available; null → caller falls back to direct. */
export async function tryStartGoalScreenWorkflow(
  env: WorkflowEnv,
  command: WorkflowJobCommand,
): Promise<WorkflowHandle | null> {
  try {
    const ports = createWorkflowPorts(env);
    if (!ports) return null;
    return await ports.start(command);
  } catch (err) {
    console.warn(
      "[goal-screen-workflow] Async start failed, falling back to direct:",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}
