/**
 * Issue #992: Scheduled callbacks (E*TRADE token renewal, scheduled market screen, strategy discovery, IV collection, order-draft expiry, reminders) — extracted from
 * OrchestratorAgent (src/agents/orchestrator.ts) with no behaviour
 * change. The class keeps state/lifecycle ownership and composes
 * these functions through the context builder in orchestrator.ts;
 * each function receives its dependencies explicitly via
 * ScheduledCallbacksContext.
 */

import type { AgentContext } from "agents";
import type { DatabaseORM } from "../../orm";
import type { Env } from "../../types";
import {
  ScheduledTasksService,
  type AutonomousStrategyDiscoveryOptions,
} from "../../services/scheduledTasks";
import {
  SqlDiscoveryRunStore,
  SqlIvHistoryStore,
  SqlScanRunStore,
  SqlStrategyProfileStore,
} from "../../trading";
import type { ScreenerExecutionContext } from "./scheduleMaintenance";

type ETradeEnvironment = "TEST" | "PROD";

/**
 * Ports the scheduled-callback functions receive from the class. The
 * in-flight slot sets are the class's own Set instances (shared by
 * reference so the re-entrancy guards keep working); storage and
 * lifecycle ownership stay in OrchestratorAgent.
 */
export interface ScheduledCallbacksContext {
  env: Env;
  agentCtx: AgentContext;
  /** The agent instance, for the (this as any) SDK escape hatches the bodies already used. */
  self: unknown;
  getScreenerExecutionContext: () => Promise<ScreenerExecutionContext | undefined>;
  removeUnownedBaselineSchedules: () => Promise<void>;
  getOrm: () => DatabaseORM;
  sessionKey: () => string;
  waitUntilStable: (options: { timeout: number }) => Promise<boolean>;
  scheduledScreenerSlots: Set<string>;
  scheduledDiscoverySlots: Set<string>;
}

/**
 * Cloudflare Agents Scheduled Callback: Proactively renews E*TRADE tokens before midnight ET
 */
export async function autoRenewETradeTokens(ctx: ScheduledCallbacksContext, payload?: { userLogin?: string; env?: string }): Promise<void> {
  try {
    await ctx.waitUntilStable({ timeout: 30_000 });
  } catch {
    // Continue if timeout or unhandled
  }
  const context = await ctx.getScreenerExecutionContext();
  const user = context?.userLogin || payload?.userLogin;
  if (!user) {
    await ctx.removeUnownedBaselineSchedules();
    console.warn("[OrchestratorAgent] Skipping token renewal without an authenticated account owner.");
    return;
  }
  const environment = context?.environment || payload?.env;
  const service = new ScheduledTasksService(ctx.env, ctx.getOrm(), user, new SqlScanRunStore(ctx.agentCtx.storage.sql));
  const res = await service.autoRenewETradeTokens(user, environment);
  if (!res.success) {
    console.warn("[OrchestratorAgent] autoRenewETradeTokens error:", res.error);
  }
}

/**
 * Cloudflare Agents Scheduled Callback: Runs periodic market screening
 * Protected with keepAliveWhile to avoid DO inactivity eviction
 */
export async function autonomousMarketScreen(ctx: ScheduledCallbacksContext, payload?: {
  sector?: string;
  universe?: string;
  maxItems?: number;
  broadcast?: boolean;
  trigger?: "manual" | "scheduled";
  userLogin?: string;
  environment?: ETradeEnvironment;
  emailTo?: string;
  slackChannel?: string;
  webhookUrl?: string;
  pushToSlack?: boolean;
  filters?: import("../../types").StockScreenerFilter;
}): Promise<void> {
  try {
    await ctx.waitUntilStable({ timeout: 30_000 });
  } catch {
    // Continue if timeout or unhandled
  }
  const runScreen = async () => {
    const trigger = payload?.trigger || "scheduled";
    const universe = payload?.universe || "NASDAQ100";
    const savedContext = await ctx.getScreenerExecutionContext();
    const userLogin = savedContext?.userLogin || payload?.userLogin;
    const environment = savedContext?.environment || payload?.environment;
    if (trigger === "scheduled" && !userLogin) {
      // A pre-auth startup schedule has no safe account mapping. Remove it
      // before it can emit the same Slack failure every hour.
      await ctx.removeUnownedBaselineSchedules();
      console.warn("[OrchestratorAgent] Skipping unowned scheduled market screen.");
      return;
    }
    if (trigger === "scheduled") {
      // Old or duplicate cron records can still invoke the same universe
      // more than once in an hour. Keep the last delivered slot per
      // universe in DO storage so only one run publishes to Slack.
      const slot = new Date().toISOString().slice(0, 16);
      const slotKey = `${universe}:${slot}`;
      ctx.scheduledScreenerSlots ??= new Set<string>();
      if (ctx.scheduledScreenerSlots.has(slotKey)) return;
      if (ctx.scheduledScreenerSlots.size > 32) ctx.scheduledScreenerSlots.clear();
      ctx.scheduledScreenerSlots.add(slotKey);
      const key = `screener:scheduled:last-slot:${universe}`;
      const last = await ctx.agentCtx.storage.get<{ slot: string }>(key);
      if (last?.slot === slot) {
        console.warn(`[OrchestratorAgent] Suppressing duplicate scheduled screen for ${universe} in ${slot}Z`);
        return;
      }
      await ctx.agentCtx.storage.put(key, { slot });
    }
    const orm = ctx.getOrm();
    // Scheduled callbacks have no authenticated HTTP headers. Use the
    // identity and environment saved from the user's schedules requests.
    const service = new ScheduledTasksService(ctx.env, orm, userLogin || "", new SqlScanRunStore(ctx.agentCtx.storage.sql));
    const res = await service.autonomousMarketScreen({ ...payload, userLogin, environment, trigger });
    if ((res as any).skipped) return;
    // Issue #212: persist the run for the "last results" UX endpoint.
    try {
      const key = "screener:last_runs";
      const existing = ((await ctx.agentCtx.storage.get(key)) as any[]) || [];
      const run = {
        timestamp: res.timestamp,
        sector: res.data?.sector || payload?.sector || "ALL",
        universe: res.data?.universe || payload?.universe || "NASDAQ100",
        success: res.success,
        totalScanned: res.data?.totalScanned ?? 0,
        matchedCount: res.data?.matchedCount ?? 0,
        // Issue #261: opportunities arrive pre-shaped from ScreenerAgent.
        opportunities: res.data?.opportunities || [],
        // Issue #253: full scanned set so the panel can render the
        // per-symbol data table. Already shaped by the shared pipeline.
        allStocks: res.data?.allStocks || [],
        pdfKey: res.data?.pdfKey,
        error: res.success ? undefined : res.error,
      };
      await ctx.agentCtx.storage.put(key, [run, ...existing].slice(0, 20));
      // Issue #278: persist the scheduled run's report durably
      // (mas_reports) so the AI Search agent can surface it later.
      // Issue #308: through the single generate→store seam — one
      // canonical row per generation (generationId = run id).
      orm.storeCanonicalReport({
        runId: `screener:${res.timestamp}`,
        generationId: `screener:${res.timestamp}`,
        title: `Autonomous market screen — ${res.data?.universe || payload?.universe || "NASDAQ100"}`,
        source: "screener",
        summary: res.success
          ? `Scanned ${run.totalScanned} symbols, ${run.matchedCount} matched, ${run.opportunities.length} opportunities.`
          : `Scheduled screen failed: ${res.error ?? "unknown error"}.`,
        body: {
          ...run,
          pdfKey: run.pdfKey,
          reportUrl: run.pdfKey
            ? `${ctx.env.APP_BASE_URL || "https://agent.openaimp.com"}/api/screener/report.pdf?key=${encodeURIComponent(String(run.pdfKey))}`
            : undefined,
        },
        createdAt: res.timestamp,
      });
    } catch {
      // Non-critical: persistence failure must not break the screen.
    }
    if (res.success && res.data?.opportunities && res.data.opportunities.length > 0) {
      if (typeof (ctx.self as any).broadcast === "function") {
        try {
          (ctx.self as any).broadcast(
            JSON.stringify({
              type: "market_alert",
              title: "Autonomous Screener Alert",
              count: res.data.opportunities.length,
              opportunities: res.data.opportunities,
              timestamp: res.timestamp,
            })
          );
        } catch {
          // Non-critical broadcast error
        }
      }
    } else if (!res.success) {
      // Failure surfacing (issue #112): a failed screen used to vanish
      // silently. The service now audits it and records a session
      // message; broadcast the failure too so live clients see it.
      // Deliberately no throw: platform callback retry is not used
      // for scheduled jobs — see the failure contract on
      // ScheduledTasksService.
      if (typeof (ctx.self as any).broadcast === "function") {
        try {
          (ctx.self as any).broadcast(
            JSON.stringify({
              type: "market_alert",
              title: "Autonomous Screener Failed",
              success: false,
              sector: payload?.sector,
              error: res.error,
              timestamp: res.timestamp,
            })
          );
        } catch {
          // Non-critical broadcast error
        }
      }
    }
  };

  if (typeof (ctx.self as any).keepAliveWhile === "function") {
    await (ctx.self as any).keepAliveWhile(runScreen);
  } else {
    await runScreen();
  }
}

/**
 * Cloudflare Agents Scheduled Callback: Scheduled Strategy Discovery
 * (issue #126, PR-E). Re-runs the schedule payload's SAVED
 * StrategyRequests verbatim through the discovery pipeline and
 * persists the run (SqlDiscoveryRunStore) for the panel to read
 * back. Mirrors the autonomousOptionsAnalysis wrapper: saved
 * execution context wins for identity/environment, unowned
 * scheduled fires are skipped, duplicate fires within the same
 * minute slot for the same saved-request set are suppressed, and
 * results AND failures are broadcast (issue #112) — the service
 * itself audits and records the session message. Deliberately no
 * throw: see the failure contract on ScheduledTasksService.
 */
export async function autonomousStrategyDiscovery(ctx: ScheduledCallbacksContext, payload?: AutonomousStrategyDiscoveryOptions): Promise<void> {
  try {
    await ctx.waitUntilStable({ timeout: 30_000 });
  } catch {
    // Continue if timeout or unhandled
  }
  const runDiscovery = async () => {
    const savedContext = await ctx.getScreenerExecutionContext();
    const userLogin = savedContext?.userLogin || payload?.userLogin || "";
    const environment = savedContext?.environment || payload?.environment;
    if (payload?.trigger !== "manual" && !userLogin) {
      await ctx.removeUnownedBaselineSchedules();
      console.warn("[OrchestratorAgent] Skipping unowned scheduled strategy discovery.");
      return;
    }
    if (payload?.trigger !== "manual") {
      // Duplicate-fire suppression, keyed on the saved-request set
      // (not a thesis): the same schedule re-firing inside one
      // minute slot is a platform duplicate; a different request
      // set in the same minute is a different run and proceeds.
      // Issue #533: profile-derived payloads carry no requests —
      // the slot keys on the derived identity (input model, symbol
      // source, profile) instead, so two different derived
      // schedules in the same minute never suppress each other.
      // Saved-request payloads hash exactly as before. Issue #534:
      // no-view payloads carry no requests either — their
      // constraint sets join the key the same way (absent on the
      // other models, where JSON.stringify drops the key and the
      // hash is unchanged).
      const slot = new Date().toISOString().slice(0, 16);
      const requestsJson = JSON.stringify(
        payload?.requests ?? {
          inputModel: payload?.inputModel,
          symbols: payload?.symbols,
          watchlistName: payload?.watchlistName,
          profileId: payload?.profileId,
          constraintSets: payload?.constraintSets,
        }
      );
      let hash = 0;
      for (let i = 0; i < requestsJson.length; i++) {
        hash = ((hash << 5) - hash + requestsJson.charCodeAt(i)) | 0;
      }
      const slotKey = `${userLogin}:${slot}:${(hash >>> 0).toString(36)}`;
      ctx.scheduledDiscoverySlots ??= new Set<string>();
      if (ctx.scheduledDiscoverySlots.has(slotKey)) return;
      if (ctx.scheduledDiscoverySlots.size > 32) ctx.scheduledDiscoverySlots.clear();
      ctx.scheduledDiscoverySlots.add(slotKey);
      const key = `discovery:scheduled:last-slot:${(hash >>> 0).toString(36)}`;
      const last = await ctx.agentCtx.storage.get<{ slot: string; userLogin: string }>(key);
      if (last?.slot === slot && last?.userLogin === userLogin) {
        console.warn(`[OrchestratorAgent] Suppressing duplicate scheduled strategy discovery in ${slot}Z`);
        return;
      }
      await ctx.agentCtx.storage.put(key, { slot, userLogin });
    }
    const service = new ScheduledTasksService(
      ctx.env,
      ctx.getOrm(),
      userLogin,
      new SqlScanRunStore(ctx.agentCtx.storage.sql),
      undefined,
      new SqlDiscoveryRunStore(ctx.agentCtx.storage.sql),
      new SqlStrategyProfileStore(ctx.agentCtx.storage.sql)
    );
    const res = await service.autonomousStrategyDiscovery({ ...payload, userLogin, environment });
    if ((res as any).skipped) return;
    if (typeof (ctx.self as any).broadcast === "function") {
      try {
        if (res.success && res.data) {
          (ctx.self as any).broadcast(
            JSON.stringify({
              type: "discovery_alert",
              title: "Scheduled Strategy Discovery",
              success: true,
              runId: res.data.runId,
              status: res.data.status,
              symbols: res.data.symbols,
              requestCount: res.data.requestCount,
              completedCount: res.data.completedCount,
              failedCount: res.data.failedCount,
              timestamp: res.timestamp,
            })
          );
        } else if (!res.success) {
          (ctx.self as any).broadcast(
            JSON.stringify({
              type: "discovery_alert",
              title: "Scheduled Strategy Discovery Failed",
              success: false,
              symbols: payload?.requests?.length
                ? payload.requests.map((r) => r?.symbol)
                : (payload?.symbols ?? (payload?.constraintSets ?? []).map((s) => s?.symbol)),
              error: res.error,
              timestamp: res.timestamp,
            })
          );
        }
      } catch {
        // Non-critical broadcast error
      }
    }
  };

  if (typeof (ctx.self as any).keepAliveWhile === "function") {
    await (ctx.self as any).keepAliveWhile(runDiscovery);
  } else {
    await runDiscovery();
  }
}

/**
 * Cloudflare Agents Scheduled Callback: Daily IV History Collection
 * (issue #15). Persists one ATM IV record per tracked name per day;
 * names whose chains fail are reported failed in the run's audit —
 * no record is ever fabricated for a missing day.
 */
export async function collectIvHistory(ctx: ScheduledCallbacksContext, payload?: { symbols?: string[]; environment?: string; userLogin?: string }): Promise<void> {
  try {
    await ctx.waitUntilStable({ timeout: 30_000 });
  } catch {
    // Continue if timeout or unhandled
  }
  const runCollection = async () => {
    const context = await ctx.getScreenerExecutionContext();
    const userLogin = context?.userLogin || payload?.userLogin;
    if (!userLogin) {
      await ctx.removeUnownedBaselineSchedules();
      console.warn("[OrchestratorAgent] Skipping IV collection without an authenticated account owner.");
      return;
    }
    const environment = context?.environment || payload?.environment;
    const service = new ScheduledTasksService(
      ctx.env,
      ctx.getOrm(),
      userLogin,
      new SqlScanRunStore(ctx.agentCtx.storage.sql),
      new SqlIvHistoryStore(ctx.agentCtx.storage.sql)
    );
    const res = await service.collectDailyIvHistory({ symbols: payload?.symbols, environment });
    if (!res.success) {
      console.warn("[OrchestratorAgent] collectIvHistory error:", res.error);
    } else if (typeof (ctx.self as any).broadcast === "function") {
      try {
        (ctx.self as any).broadcast(
          JSON.stringify({
            type: "iv_collection",
            title: "Daily IV History Collection",
            date: res.data?.date,
            recorded: res.data?.recorded,
            alreadyRecorded: res.data?.alreadyRecorded,
            failed: res.data?.failed,
            tracked: res.data?.trackedCount,
            timestamp: res.timestamp,
          })
        );
      } catch {
        // Non-critical broadcast error
      }
    }
  };

  if (typeof (ctx.self as any).keepAliveWhile === "function") {
    await (ctx.self as any).keepAliveWhile(runCollection);
  } else {
    await runCollection();
  }
}

/**
 * Cloudflare Agents Scheduled Callback: Auto-expires a stale unconfirmed order draft
 */
export async function expireStaleOrderDraft(ctx: ScheduledCallbacksContext, payload: { orderId: string; userLogin?: string }): Promise<void> {
  if (!payload?.orderId) return;
  const service = new ScheduledTasksService(ctx.env, ctx.getOrm(), payload.userLogin || ctx.sessionKey(), new SqlScanRunStore(ctx.agentCtx.storage.sql));
  await service.expireStaleOrderDraft(payload.orderId);
}

/**
 * Cloudflare Agents Scheduled Callback: Dispatches a user reminder
 */
export async function sendScheduledReminder(ctx: ScheduledCallbacksContext, payload: { reminderId: string; message: string; userLogin?: string }): Promise<void> {
  if (!payload?.reminderId) return;
  const service = new ScheduledTasksService(ctx.env, ctx.getOrm(), payload.userLogin || ctx.sessionKey(), new SqlScanRunStore(ctx.agentCtx.storage.sql));
  const res = await service.dispatchReminder(payload.reminderId, payload.message);
  if (typeof (ctx.self as any).broadcast === "function") {
    try {
      // Issue #123 (F19): the broadcast mirrors the dispatch result —
      // a reminder whose chat-history delivery failed is broadcast in
      // the same message family with success: false + the error (the
      // #112 failure-surfacing pattern), never as a fired reminder.
      (ctx.self as any).broadcast(
        JSON.stringify(
          res.success
            ? {
                type: "scheduled_reminder",
                reminderId: payload.reminderId,
                message: payload.message,
                timestamp: res.timestamp,
              }
            : {
                type: "scheduled_reminder",
                reminderId: payload.reminderId,
                message: payload.message,
                success: false,
                error: res.error,
                timestamp: res.timestamp,
              }
        )
      );
    } catch {
      // Non-critical broadcast error
    }
  }
}
