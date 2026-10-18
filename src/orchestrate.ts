/**
 * PR #1 — True Orchestrator: operation catalog + plan validation.
 *
 * Ported from cfpay's src/orchestrate.ts (battle-tested).
 * The catalog is the single source of truth for plannable operations.
 * The planner prompt is generated FROM it, so the model can only
 * propose steps that exist.
 */

export interface CatalogEntry {
  agent: string;
  /** Durable Object binding name on the Worker Env. */
  binding: string;
  operations: string[];
  blurb: string;
}

export const OPERATION_CATALOG: CatalogEntry[] = [
  {
    agent: "search",
    binding: "SEARCH_AGENT",
    operations: ["search.query"],
    blurb: "Web and data search.",
  },
  {
    agent: "payments",
    binding: "PAYMENTS_AGENT",
    operations: ["payments.draft"],
    blurb: "Draft a payment request (requires approval before execution).",
  },
  {
    agent: "tasks",
    binding: "TASKS_AGENT",
    operations: ["tasks.create"],
    blurb: "Create a tracked task with owner and due date.",
  },
  {
    agent: "memory",
    binding: "MEMORY_AGENT",
    operations: ["memory.remember"],
    blurb: "Store an outcome in long-term vector memory.",
  },
  {
    agent: "nlq",
    binding: "NLQ_AGENT",
    operations: ["nlq.execute"],
    blurb: "Execute a natural-language query against the data layer.",
  },
  {
    agent: "qa",
    binding: "SEARCH_AGENT",
    operations: ["qa.supervised_fix"],
    blurb: "Investigate a QA failure and propose a supervised fix (issue #162).",
  },
];

export function catalogAgent(agent: string): CatalogEntry | undefined {
  return OPERATION_CATALOG.find((e) => e.agent === agent);
}

export interface PlanStep {
  id: string;
  agent: string;
  operation: string;
  args?: Record<string, unknown>;
  dependsOn?: string[];
}

/** Supervisor bounds: revisions per job, total steps across plan + revisions. */
export const MAX_REVISIONS = 3;
export const MAX_TOTAL_STEPS = 12;
export const MAX_PLAN_STEPS = 8;

export type SupervisorVerdict = "continue" | "stop" | "revise";

/** The planner prompt, generated from the catalog. */
export function plannerPrompt(goal: string, brief?: string): string {
  const lines = OPERATION_CATALOG.map(
    (e) => `- ${e.agent}: ${e.operations.join(", ")} - ${e.blurb}`
  );
  return [
    "You plan work for a multi-agent system. Break the goal into steps, each executed by ONE agent operation from this catalog:",
    ...lines,
    "",
    "Rules:",
    "- Reply with ONLY a JSON array of steps, no prose.",
    '- Each step: {"id": "s1", "agent": "search", "operation": "search.query", "args": {}, "dependsOn": []}.',
    "- Use dependsOn only when a step truly needs an earlier step's result; independent steps run in parallel.",
    `- At most ${MAX_PLAN_STEPS} steps. Prefer the fewest steps that achieve the goal.`,
    ...(brief ? ["", brief] : []),
    "",
    `Goal: ${goal}`,
  ].join("\n");
}

/**
 * Validate raw step objects against the catalog.
 * Returns the validated steps, or null if unusable.
 */
export function validateSteps(
  parsed: unknown,
  externalIds: Set<string> = new Set()
): PlanStep[] | null {
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > MAX_PLAN_STEPS) {
    return null;
  }
  const steps: PlanStep[] = [];
  const ids = new Set<string>(externalIds);
  for (const item of parsed) {
    const s = item as Partial<PlanStep>;
    if (!s || typeof s.id !== "string" || typeof s.agent !== "string" || typeof s.operation !== "string") {
      return null;
    }
    const entry = catalogAgent(s.agent);
    if (!entry || !entry.operations.includes(s.operation)) return null;
    if (ids.has(s.id)) return null;
    ids.add(s.id);
    steps.push({
      id: s.id,
      agent: s.agent,
      operation: s.operation,
      args: s.args && typeof s.args === "object" ? (s.args as Record<string, unknown>) : {},
      dependsOn: Array.isArray(s.dependsOn) ? s.dependsOn.map(String) : [],
    });
  }
  // All dependencies must resolve
  for (const s of steps) {
    for (const dep of s.dependsOn ?? []) {
      if (!ids.has(dep)) return null;
    }
  }
  // No cycles (topological check)
  const done = new Set<string>(externalIds);
  let progress = true;
  while (progress && done.size < ids.size) {
    progress = false;
    for (const s of steps) {
      if (!done.has(s.id) && (s.dependsOn ?? []).every((d) => done.has(d))) {
        done.add(s.id);
        progress = true;
      }
    }
  }
  if (done.size < ids.size) return null; // cycle
  return steps;
}

/**
 * Topological wave sort: groups steps into parallel-executable waves.
 */
export function topoWaves(steps: PlanStep[]): PlanStep[][] {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const done = new Set<string>();
  const waves: PlanStep[][] = [];
  const remaining = new Set(steps.map((s) => s.id));

  while (remaining.size > 0) {
    const wave: PlanStep[] = [];
    for (const id of remaining) {
      const step = byId.get(id)!;
      if ((step.dependsOn ?? []).every((d) => done.has(d))) {
        wave.push(step);
      }
    }
    if (wave.length === 0) break;
    for (const s of wave) {
      remaining.delete(s.id);
      done.add(s.id);
    }
    waves.push(wave);
  }
  return waves;
}

/** Supervisor prompt: review wave results, verdict continue/stop/revise. */
export function supervisorPrompt(
  goal: string,
  completedSteps: { id: string; operation: string; result: string }[],
  revisionCount: number
): string {
  return [
    "You supervise a multi-agent plan. Review the completed steps below.",
    `Goal: ${goal}`,
    "",
    "Completed steps:",
    ...completedSteps.map((s) => `- ${s.id} (${s.operation}): ${s.result.slice(0, 500)}`),
    "",
    `Revisions used: ${revisionCount}/${MAX_REVISIONS}`,
    "",
    "Reply with ONLY one JSON object:",
    '{"verdict": "continue" | "stop" | "revise", "reason": "...", "newSteps": [...]}',
    '"continue": plan is on track, execute remaining steps.',
    '"stop": goal achieved or unachievable; no further steps needed.',
    '"revise": plan needs adjustment; provide newSteps (validated like the original plan).',
  ].join("\n");
}

/**
 * Create an orchestrator job for a scheduled goal.
 * Called by ScheduledAgent.onCron() — validates the goal's operation
 * against the catalog and returns a job descriptor.
 * Full plan execution happens via the worker's orchestration endpoint.
 */
export interface OrchestratorJob {
  jobId: string;
  goalId: string;
  goalName: string;
  operation: string;
  budgetCents: number;
  createdAt: string;
  status: "pending";
}

export async function createJob(
  env: unknown,
  req: {
    goalId: string;
    goalName: string;
    operation: string;
    budgetCents: number;
  }
): Promise<OrchestratorJob> {
  // Validate the operation exists in the catalog
  const entry = OPERATION_CATALOG.find((e) => e.operations.includes(req.operation));
  if (!entry) {
    throw new Error(`Unknown operation: ${req.operation}`);
  }
  return {
    jobId: `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    goalId: req.goalId,
    goalName: req.goalName,
    operation: req.operation,
    budgetCents: req.budgetCents,
    createdAt: new Date().toISOString(),
    status: "pending",
  };
}
