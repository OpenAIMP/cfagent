/**
 * Issue #2223 (slice 1) — A2A-owned agent resolution.
 *
 * The dispatcher used to resolve names through the planner's
 * OPERATION_CATALOG (src/orchestrate.ts). That map cannot serve A2A:
 * it has no "orchestrator" entry, its tasks/memory/nlq entries name
 * bindings that do not exist, and it carries no instance names —
 * while A2A needs per-agent instance names (SURVEY §1, §2):
 *
 * - trading keeps its verbatim resolution (the one working path):
 *   TRADING_AGENT, instance "trading" (the service identity's
 *   instance, #1185).
 * - The orchestrator's five surface names (orchestrator, search,
 *   tasks, memory, nlq) all resolve to ONE instance of
 *   OrchestratorAgent (SEARCH_AGENT binding): the shared
 *   orchestrator address. Five names on five instances would
 *   fragment the mas_memory / mas_transactions / mas_reports
 *   stores those operations share (SURVEY §6.4).
 * - scheduled resolves to the live "default" instance: the bare
 *   name would start a virgin instance that seeds default
 *   schedules on first read and serves plausible-looking wrong
 *   state (SURVEY §1.4).
 * - payments keeps parity: no instance override, the URL name is
 *   the instance (its handler lands in a later slice).
 *
 * OPERATION_CATALOG is deliberately NOT touched: adding entries
 * there changes planner behavior (SURVEY §2). This map is A2A's
 * own; the anti-drift pins tie the cards to what is served.
 */
import { SHARED_ORCHESTRATOR_INSTANCE } from "../security/serviceIdentity";
import type { Env } from "../types";

export interface A2AResolution {
  /** Durable Object namespace binding name in wrangler.jsonc. */
  binding: string;
  /**
   * Durable Object instance name. A string pins the instance; a
   * function computes it from env and may return null when the
   * agent is not configured for this deployment (the dispatcher
   * then fails honestly instead of starting a wrong instance).
   * Absent = the URL name is the instance name.
   */
  instanceName?: string | ((env: Env) => string | null);
}

export const A2A_RESOLUTIONS: Readonly<Record<string, A2AResolution>> = {
  trading: { binding: "TRADING_AGENT", instanceName: "trading" },
  orchestrator: { binding: "SEARCH_AGENT", instanceName: SHARED_ORCHESTRATOR_INSTANCE },
  search: { binding: "SEARCH_AGENT", instanceName: SHARED_ORCHESTRATOR_INSTANCE },
  tasks: { binding: "SEARCH_AGENT", instanceName: SHARED_ORCHESTRATOR_INSTANCE },
  memory: { binding: "SEARCH_AGENT", instanceName: SHARED_ORCHESTRATOR_INSTANCE },
  nlq: { binding: "SEARCH_AGENT", instanceName: SHARED_ORCHESTRATOR_INSTANCE },
  payments: { binding: "PAYMENTS_AGENT" },
  scheduled: { binding: "SCHEDULED_AGENT", instanceName: "default" },
  aisearch: { binding: "AI_SEARCH_AGENT" },
};

/** Resolve an A2A agent name, or undefined when A2A does not serve it. */
export function resolveA2AAgent(name: string): A2AResolution | undefined {
  return A2A_RESOLUTIONS[name];
}

/**
 * The instance name a resolution dispatches to: the pinned string,
 * the function's result (null = not configured), or the URL name
 * when the entry carries no override.
 */
export function resolveA2AInstanceName(
  resolution: A2AResolution,
  name: string,
  env: Env,
): string | null {
  const instanceName = resolution.instanceName;
  if (instanceName === undefined) return name;
  if (typeof instanceName === "function") return instanceName(env);
  return instanceName;
}
