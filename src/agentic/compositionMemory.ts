/**
 * Issue #1461 ([AGENTIC] Phase 4, sub-issue of #1362) — memory/vector
 * reuse.
 *
 * Plan-level composition memory ON the existing Vectorize index /
 * VectorMemory path (src/memory/vector-memory.ts), and serve-leg
 * reuse through the existing reportSemanticIndex path (#337). No
 * second vector store, no new embedding provider, no new index.
 *
 * How reuse works:
 * 1. `recordPlanOutcome` stores a compiled chain's outcome keyed on
 *    goal text (VectorMemory.rememberPlan, `kind: "plan"` metadata).
 * 2. `compileGoalWithMemory` recalls prior plans before compiling
 *    fresh. A reusable prior plan is REBUILT through the Phase 2
 *    `compileChain` validator — registry validation still applies,
 *    so a stored plan whose capabilities no longer validate falls
 *    back to a fresh compile, never to an invalid chain.
 * 3. When a prior plan is reused, the result SAYS SO: `reuse` carries
 *    provenance (prior plan id, prior goal text, outcome, match
 *    kind, score) and `describeReuse` renders it in one line.
 *
 * Boundaries (out of scope, not built here): executing chains,
 * firing synthesized schedules (the Phase 3 follow-up), MCP tools
 * (Phase 5), governance wiring (Phase 6), paid actions, production
 * secrets/config. This module never creates, enables, or fires a
 * schedule and never touches the Phase 3 confirmation gate.
 *
 * DOCUMENTED LIMITATION — capability-fit retrieval: capability
 * descriptions are NOT embedded in the Vectorize index, so the
 * existing vector path cannot answer "which capabilities fit this
 * goal?". Vector retrieval here serves prior plans and stored
 * reports; capability selection stays on the deterministic Phase 2
 * compiler path (`compileGoal` / `compileChain` over the Phase 1
 * registry). Building capability embeddings would populate the same
 * index, not a new store — but it is not done here, rather than
 * building a parallel retrieval system to fake it.
 *
 * Reliability: recall failure never breaks compilation —
 * `compileGoalWithMemory` falls back to a fresh compile. The record
 * path propagates errors, matching the `VectorMemory.remember`
 * convention (callers wrap in try/catch, as the orchestrator does).
 */

import {
  compileChain,
  compileGoal,
  type CompiledChain,
} from "../orchestrate";
import type { RecalledPlan, VectorMemory } from "../memory/vector-memory";
import { semanticSearchReports } from "../services/reportSemanticIndex";

/** Same normalization as the Phase 2 compiler's goal matching. */
export function normalizeGoalText(goal: string): string {
  if (typeof goal !== "string") return "";
  return goal.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Default floor for semantic (non-exact) reuse matches. */
export const SEMANTIC_MIN_SCORE = 0.5;

/** Provenance for a reused prior plan — the result SAYS SO. */
export interface PlanReuse {
  planId: string;
  priorGoal: string;
  priorOutcome: "success" | "failure";
  priorSummary: string;
  score: number;
  matchedBy: "exact" | "semantic";
}

export interface ReusedPlan {
  plan: RecalledPlan;
  matchedBy: "exact" | "semantic";
}

function toReuse(reused: ReusedPlan): PlanReuse {
  return {
    planId: reused.plan.id,
    priorGoal: reused.plan.goal,
    priorOutcome: reused.plan.success ? "success" : "failure",
    priorSummary: reused.plan.summary,
    score: reused.plan.score,
    matchedBy: reused.matchedBy,
  };
}

/** One-line provenance statement for a reused plan. */
export function describeReuse(reuse: PlanReuse): string {
  return (
    `Reused prior plan ${reuse.planId} recorded for goal "${reuse.priorGoal}" ` +
    `(outcome: ${reuse.priorOutcome}, match: ${reuse.matchedBy}, ` +
    `score: ${reuse.score.toFixed(2)}).`
  );
}

/**
 * Record a compiled chain's outcome as plan memory keyed on goal
 * text. Returns the plan record id.
 */
export async function recordPlanOutcome(
  memory: VectorMemory,
  input: {
    goal: string;
    chain: CompiledChain;
    success: boolean;
    summary: string;
    timestamp?: string;
  },
): Promise<string> {
  return memory.rememberPlan({
    goal: input.goal,
    normalizedGoal: normalizeGoalText(input.goal),
    capabilityIds: input.chain.steps.map((s) => s.capabilityId),
    budgetCents: input.chain.budgetCents,
    recurrence: input.chain.recurrence,
    reusesStoredReport: input.chain.reusesStoredReport,
    success: input.success,
    summary: input.summary,
    timestamp: input.timestamp ?? new Date().toISOString(),
  });
}

/**
 * Find a reusable prior plan for a goal. Exact normalized-goal
 * matches win over score (and, among exact matches, the latest
 * recording wins); otherwise the best-scored match reuses only at
 * or above `minScore`. Returns null when nothing qualifies.
 */
export async function findReusablePlan(
  memory: VectorMemory,
  goalText: string,
  opts: { minScore?: number } = {},
): Promise<ReusedPlan | null> {
  const normalized = normalizeGoalText(goalText);
  if (normalized === "") return null;
  const minScore = opts.minScore ?? SEMANTIC_MIN_SCORE;
  const plans = await memory.recallPlans(goalText);
  if (plans.length === 0) return null;
  const exact = plans
    .filter((p) => p.normalizedGoal === normalized)
    .sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
  if (exact.length > 0) return { plan: exact[0], matchedBy: "exact" };
  const best = [...plans].sort((a, b) => b.score - a.score)[0];
  if (best.score >= minScore) return { plan: best, matchedBy: "semantic" };
  return null;
}

/**
 * Compile a goal with memory: recall a reusable prior plan first;
 * rebuild it through `compileChain` (registry validation applies);
 * fall back to a fresh `compileGoal` when there is no reusable plan,
 * the stored plan no longer validates, or recall fails. Without a
 * memory instance this is exactly the Phase 2 compiler.
 */
export async function compileGoalWithMemory(
  goalText: string,
  opts: {
    budgetCents: number;
    budgetCapCents?: number | null;
    memory?: VectorMemory | null;
    minScore?: number;
  },
): Promise<{ chain: CompiledChain | null; reuse: PlanReuse | null }> {
  const fresh = () => ({
    chain: compileGoal(goalText, {
      budgetCents: opts.budgetCents,
      budgetCapCents: opts.budgetCapCents ?? null,
    }),
    reuse: null as PlanReuse | null,
  });
  if (!opts.memory) return fresh();
  if (normalizeGoalText(goalText) === "") return { chain: null, reuse: null };
  let reused: ReusedPlan | null = null;
  try {
    reused = await findReusablePlan(opts.memory, goalText, {
      minScore: opts.minScore,
    });
  } catch {
    return fresh();
  }
  if (!reused) return fresh();
  const rebuilt = compileChain({
    goal: goalText,
    steps: reused.plan.capabilityIds.map((capabilityId) => ({ capabilityId })),
    budgetCents: reused.plan.budgetCents,
    budgetCapCents: opts.budgetCapCents ?? null,
    recurrence: reused.plan.recurrence,
    reusesStoredReport: reused.plan.reusesStoredReport,
  });
  if (!rebuilt) return fresh();
  return { chain: rebuilt, reuse: toReuse(reused) };
}

/** A stored report resolved for a serve leg, via the #337 index. */
export interface StoredReportResolution {
  reportId: string;
  via: "semantic";
  score: number;
}

/**
 * Resolve a report query to the top semantic hit in the existing
 * report index. Null when bindings are absent, the query is empty,
 * or nothing matches — the caller falls back to lexical lookup.
 */
export async function resolveStoredReportForServe(
  env: { AI?: any; VECTOR_MEMORY?: any },
  query: string,
): Promise<StoredReportResolution | null> {
  const hits = await semanticSearchReports(env, query);
  if (hits.length === 0) return null;
  return { reportId: hits[0].reportId, via: "semantic", score: hits[0].score };
}

/**
 * Serve-leg reuse: a chain that reuses a stored report resolves to
 * that report through the #337 semantic index instead of
 * regenerating. Any other chain returns null WITHOUT a vector call
 * — there is nothing to resolve.
 */
export async function resolveServeLeg(
  env: { AI?: any; VECTOR_MEMORY?: any },
  chain: CompiledChain,
  query: string,
): Promise<StoredReportResolution | null> {
  if (!chain.reusesStoredReport) return null;
  return resolveStoredReportForServe(env, query);
}
