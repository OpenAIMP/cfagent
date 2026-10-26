/**
 * Issue #1738 — actor port factory (mirrors createMessagingPorts /
 * createWorkflowPorts).
 *
 * `runtime: "cf"` binds the port to a live Agents SDK actor (its
 * ctx.storage + scheduler + hooks); `runtime: "in-memory"` binds it
 * to Map/array-backed facets for tests. Both runtimes satisfy the
 * same conformance suite, which is the independence proof: swapping
 * the runtime never touches the actor's domain code.
 */
import {
  createCfActorSchedule,
  createCfActorSession,
  createCfActorState,
  createCfActorTurn,
  type SchedulerLike,
} from "./cfAgentsAdapter";
import {
  createInMemoryActorSchedule,
  createInMemoryActorSession,
  createInMemoryActorState,
  createInMemoryActorTurn,
} from "./inMemoryActorAdapter";
import type { ActorPort, ActorTurnHooks } from "./actorPorts";

export type ActorRuntime = "cf" | "in-memory";

export interface CreateActorPortsDeps {
  hooks: ActorTurnHooks;
  /** Live actor's ctx.storage (cf) — unused for in-memory. */
  storage?: {
    get(key: string): Promise<unknown>;
    put(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<void>;
    sql: { exec(sql: string, ...params: unknown[]): Iterable<unknown> };
  };
  /** Live actor's scheduler surface (cf) — unused for in-memory. */
  scheduler?: SchedulerLike;
}

export function createActorPorts(runtime: ActorRuntime, deps: CreateActorPortsDeps): ActorPort {
  if (runtime === "in-memory") {
    const session = createInMemoryActorSession();
    return {
      state: createInMemoryActorState(),
      schedule: createInMemoryActorSchedule(),
      session,
      turn: createInMemoryActorTurn(deps.hooks, session),
    };
  }
  if (!deps.storage || !deps.scheduler) {
    throw new Error("createActorPorts(cf) requires storage and scheduler.");
  }
  const session = createCfActorSession(deps.storage);
  return {
    state: createCfActorState(deps.storage),
    schedule: createCfActorSchedule(deps.scheduler),
    session,
    turn: createCfActorTurn(deps.hooks, session),
  };
}
