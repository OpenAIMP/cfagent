/**
 * Issue #992: NLQ ports (scheduling + stock-screen bindings for the NLQ executor) — extracted from
 * OrchestratorAgent (src/agents/orchestrator.ts) with no behaviour
 * change. The class keeps state/lifecycle ownership and composes
 * these functions through the context builder in orchestrator.ts;
 * each function receives its dependencies explicitly via
 * NlqPortsContext.
 */

import type { ScheduleOptions } from "agents";
import type { AgentScheduleItem } from "../../types";
import type { NLQSchedulingPort, NLQSocialBriefPort, NLQStockScreenPort } from "../nlq";
import type { ScreenerAgent, ScreenerRunRequest } from "../screener-agent";
import type { SocialBriefStore } from "../social/briefStore";

/**
 * Ports the NLQ-port constructors receive from the class. The schedule
 * functions are the Agent base class's own methods, bound by the class
 * with the `keyof this` cast the SDK signature requires (the same
 * binding routeRequest's contexts use).
 */
export interface NlqPortsContext {
  schedule: (when: Date | number | string, callback: string, payload?: unknown, options?: ScheduleOptions) => Promise<unknown>;
  scheduleEvery: (intervalSeconds: number, callback: string, payload?: unknown) => Promise<unknown>;
  cancelSchedule: (id: string) => Promise<boolean>;
  listSchedules: () => Promise<unknown[]>;
  getScreenerAgent: (userLogin?: string) => ScreenerAgent;
  getSocialBriefStore: () => SocialBriefStore | null;
}

/**
 * Issue #109: binds this agent's Cloudflare Agents scheduling API
 * into the narrow port the NLQ executor consumes, so schedules
 * created/listed/cancelled from natural language are real SDK
 * schedules with real ids.
 *
 * Issue #108: the bindings call the typed Agent methods directly —
 * schedule/scheduleEvery/cancelSchedule/listSchedules are typed
 * members of the Agent base class, so the old `(this as any)` +
 * typeof-guard layer is gone. The port receives callback names as
 * plain strings from NLQ plan parsing; the narrow `as keyof this`
 * assertion is the one cast that remains, because the SDK signature
 * requires a method-name key. It cannot fabricate success: an
 * unknown name makes the SDK call throw, and the NLQ executor
 * converts any throw into an honest failure reply.
 */
export function nlqSchedulingPort(ctx: NlqPortsContext): NLQSchedulingPort {
  return {
    schedule: async (when, callback, payload, options) =>
      (await ctx.schedule(when, callback, payload, options)) as AgentScheduleItem,
    scheduleEvery: async (intervalSeconds, callback, payload) =>
      (await ctx.scheduleEvery(intervalSeconds, callback, payload)) as AgentScheduleItem,
    cancelSchedule: async (id) => await ctx.cancelSchedule(id),
    listSchedules: async () => (await ctx.listSchedules()) as AgentScheduleItem[],
  };
}

/**
 * Issue #982: the NLQ stock-screen port — binds the ScreenerAgent
 * (the stock screening service the REST /etrade/screen route
 * delegates to) into the NLQ execution deps, so NLQ stock screens
 * run the same pipeline as REST screens. The agent persists its
 * own run record; the canonical mas_reports copy is persisted by
 * the NLQ executor at its layer, mirroring how the REST route
 * persists it at its layer (persistScreenerReportCanonical).
 * maxItems 10: the port's consumers take up to ten standout picks
 * (the watchlist_save fallback's top-10).
 */
export function nlqStockScreenPort(ctx: NlqPortsContext): NLQStockScreenPort {
  return {
    runScreen: async ({ filters, userLogin }) => {
      const universe = typeof (filters as { universe?: unknown })?.universe === "string"
        ? ((filters as { universe?: string }).universe as ScreenerRunRequest["universe"])
        : undefined;
      return ctx.getScreenerAgent(userLogin).runScreen({
        trigger: "manual",
        filters,
        universe,
        userLogin,
        maxItems: 10,
      });
    },
  };
}

/**
 * #1077 Phase 5b slice 2: the NLQ social-brief port — binds the
 * durable brief store into the NLQ execution deps, so an explicit
 * "set social brief" request in trusted chat writes the day's brief
 * the social goal will publish. Returns null when no store is
 * available, so callers pass no port and the executor fails honestly
 * instead of writing to nowhere.
 */
export function nlqSocialBriefPort(ctx: NlqPortsContext): NLQSocialBriefPort | null {
  const store = ctx.getSocialBriefStore();
  if (!store) return null;
  return {
    setBrief: async ({ date, text }) => {
      await store.putBrief(date, text);
    },
  };
}
