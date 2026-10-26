/**
 * Issue #1738 — the Cloudflare Agents SDK adapter for the actor port.
 *
 * Binds each facet to the live Agents SDK runtime: the actor's own
 * DO storage (ctx.storage), the SDK scheduler (schedule-by-method-
 * name), and the SDK workflow doors (runWorkflow/sendWorkflowEvent
 * live on Agent — verified against agents 0.24.0 types, not assumed
 * from Think). No new addressing scheme is introduced: DO instances
 * are still addressed by idFromName/idFromString + get through the
 * existing bindings, and routeAgentRequest stays the framework seam
 * (Adapter S5 owns dispatch centralization; this adapter does not
 * duplicate it).
 */
import { AgentChatTurnRunner, generateTextModelTurn, type ModelTurnFn } from "./actorTurnRunner";
import { ActorSessionStore, type SessionStorageBackend } from "./actorSessionStore";
import type {
  ActorSchedulePort,
  ActorSessionPort,
  ActorStatePort,
  ActorTurnHooks,
  ActorTurnPort,
} from "./actorPorts";

/** DO ctx.storage satisfies this; the cast keeps the port free of SDK types. */
export function createCfActorSession(storage: SessionStorageBackend): ActorSessionPort {
  return new ActorSessionStore(storage);
}

export function createCfActorState(storage: {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  sql: { exec(sql: string, ...params: unknown[]): Iterable<unknown> };
}): ActorStatePort {
  return {
    get: async <T = unknown>(key: string): Promise<T | undefined> =>
      (await storage.get(key)) as T | undefined,
    put: (key, value) => storage.put(key, value),
    delete: (key) => storage.delete(key),
    sql: (sql, ...params) => storage.sql.exec(sql, ...params),
  };
}

/** Any object exposing the SDK scheduler surface (a real Agent qualifies). */
export interface SchedulerLike {
  schedule(when: unknown, callback: string, payload?: unknown, options?: unknown): Promise<unknown>;
  scheduleEvery(intervalSeconds: number, callback: string, payload?: unknown): Promise<unknown>;
  listSchedules(): Promise<unknown[]>;
  cancelSchedule(id: string): Promise<boolean>;
  getScheduleById?(id: string): Promise<unknown | undefined>;
}

export function createCfActorSchedule(agent: SchedulerLike): ActorSchedulePort {
  return {
    schedule: (when, callback, payload, options) => agent.schedule(when, callback, payload, options),
    scheduleEvery: (intervalSeconds, callback, payload) => agent.scheduleEvery(intervalSeconds, callback, payload),
    listSchedules: () => agent.listSchedules(),
    cancelSchedule: (id) => agent.cancelSchedule(id),
    getScheduleById: agent.getScheduleById
      ? (id) => agent.getScheduleById!(id)
      : undefined,
  };
}

/** Production turn runner: the agent's own hooks + generateText model turn. */
export function createCfActorTurn(
  hooks: ActorTurnHooks,
  session: ActorSessionPort,
  modelTurn: ModelTurnFn = generateTextModelTurn
): ActorTurnPort {
  return new AgentChatTurnRunner({ hooks, session, modelTurn });
}
