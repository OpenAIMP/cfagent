/**
 * Issue #359-16: task schedule management routes extracted from
 * OrchestratorAgent.routeRequest (src/agents/orchestrator.ts). Pure move -
 * no behavior change.
 *
 * Owns the contiguous schedules block (invoked at the EXACT original
 * position in routeRequest's sequential matching sequence, after the
 * screener + research delegation and before routeRequest's Not-found
 * fallthrough):
 *   GET         /schedules                        (list; ?type=cron|interval|delayed|scheduled)
 *   POST        /schedules/cancel                 (cancel by id)
 *   DELETE      /schedules/:id                    (cancel by id)
 *   GET         /schedules/:id                    (get by id)
 *   POST        /schedules/create                 (create; #111 callback allow-list)
 *   POST        /schedules                        (create alias)
 *   POST        /schedules/trigger-screen
 *   POST        /schedules/trigger-renew
 *   POST        /schedules/trigger-options-analysis
 *   POST        /schedules/trigger-retention      (issue #255)
 *   POST        /schedules/trigger-iv-collection  (issue #15)
 *   POST        /schedules/trigger-discovery      (issue #126)
 *
 * The handler ends with an explicit `return null` - never undefined.
 *
 * Handlers that used OrchestratorAgent state receive it via the explicit
 * SchedulesRouteContext parameter; there are no new globals and no
 * back-references into the class. The Agents SDK scheduler methods stay
 * owned by the Agent base class and arrive as narrow wrappers (the
 * `as keyof this` assertion pattern from the #109 NLQ scheduling port).
 * The #111 callback allow-list constants stay module-owned by
 * orchestrator.ts (CREATABLE_SCHEDULE_CALLBACKS is a public export) and
 * arrive via the context.
 */

import type { AgentContext, Schedule, ScheduleCriteria } from "agents";
import { resolveEnvironmentConfig } from "../../config/environment";
import { getStoredTokens, isTokenExpiredEt } from "../../security/etradeOAuth";
import { runStorageRetention } from "../../security/storageRetention";
import {
  SqlDiscoveryRunStore,
  SqlIvHistoryStore,
  SqlScanRunStore,
  SqlStrategyProfileStore,
  UNIVERSES,
  validateStrategyRequest,
  MAX_SAVED_REQUESTS_PER_RUN,
} from "../../trading";
import { ScheduledTasksService } from "../../services/scheduledTasks";
import type { DatabaseORM } from "../../orm";
import type { AgentName, Env } from "../../types";

/** Structural mirror of OrchestratorAgent's private ETradeEnvironment
 * (src/agents/orchestrator.ts). */
type ETradeEnvironment = "TEST" | "PROD";

/** Structural mirror of OrchestratorAgent's private ScreenerExecutionContext
 * (src/agents/orchestrator.ts). */
type ScreenerExecutionContext = { userLogin: string; environment?: ETradeEnvironment };

/** The subset of OrchestratorAgent surface the schedules handlers need. */
export interface SchedulesRouteContext {
  /** Worker environment (owner: OrchestratorAgent - was `this.env`). */
  env: Env;
  /** Durable Object agent context (owner: OrchestratorAgent - was `this.ctx`),
   * used for the SqlStorage-backed stores. */
  agentCtx: AgentContext;
  /** Audit funnel (owner: OrchestratorAgent.audit - was `this.audit`). */
  audit(
    type: string,
    agent: AgentName | "judge" | "nlq" | "orchestrator",
    payload: Record<string, unknown>
  ): void;
  /** SDK schedule listing (owner: Agent base class - was `this.listSchedules`). */
  listSchedules(criteria?: ScheduleCriteria): Promise<Schedule<unknown>[]>;
  /** SDK schedule cancellation (owner: Agent base class - was `this.cancelSchedule`). */
  cancelSchedule(id: string): Promise<boolean>;
  /** SDK schedule lookup (owner: Agent base class - was `this.getScheduleById`). */
  getScheduleById(id: string): Promise<Schedule<unknown> | undefined>;
  /** SDK scheduler (owner: Agent base class - was `this.schedule`). */
  schedule(
    when: Date | string | number,
    callback: string,
    payload?: unknown,
    options?: { idempotent?: boolean }
  ): Promise<Schedule<unknown>>;
  /** SDK interval scheduler (owner: Agent base class - was `this.scheduleEvery`). */
  scheduleEvery(
    intervalSeconds: number,
    callback: string,
    payload?: unknown
  ): Promise<Schedule<unknown>>;
  /** Execution-context accessor (owner: OrchestratorAgent.getScreenerExecutionContext - was `this.getScreenerExecutionContext`). */
  getScreenerExecutionContext(): Promise<ScreenerExecutionContext | undefined>;
  /** ORM accessor (owner: OrchestratorAgent.getOrm - was `this.getOrm()`). */
  getOrm(): DatabaseORM;
  /** Scheduled market screen (owner: OrchestratorAgent.autonomousMarketScreen - was `this.autonomousMarketScreen`). */
  autonomousMarketScreen(payload?: {
    sector?: string;
    universe?: string;
    maxItems?: number;
    broadcast?: boolean;
    trigger?: "manual" | "scheduled";
    userLogin?: string;
    environment?: ETradeEnvironment;
  }): Promise<void>;
  /** E*TRADE token renewal (owner: OrchestratorAgent.autoRenewETradeTokens - was `this.autoRenewETradeTokens`). */
  autoRenewETradeTokens(payload?: { userLogin?: string; env?: string }): Promise<void>;
  /** #111 user-creatable callback allow-list (owner: orchestrator.ts module const CREATABLE_SCHEDULE_CALLBACKS). */
  creatableScheduleCallbacks: readonly string[];
  /** Account-scoped callback set (owner: orchestrator.ts module const ACCOUNT_SCOPED_SCHEDULE_CALLBACKS). */
  accountScopedScheduleCallbacks: ReadonlySet<string>;
}

/**
 * Task schedule management routes. Invoked from routeRequest at the exact
 * position the original block occupied (after the
 * handleScreenerResearchRoutes delegation, before the Not-found
 * fallthrough); returns a Response when one of the owned paths matches, or
 * null to continue sequential matching.
 */
export async function handleSchedulesRoutes(
  request: Request,
  url: URL,
  path: string,
  sessionId: string,
  ctx: SchedulesRouteContext
): Promise<Response | null> {
    // List all schedules (supports ?type=cron|interval|delayed|scheduled)
    if ((path.endsWith("/schedules") || path.endsWith("/api/schedules") || path === "/schedules" || path === "/api/schedules") && request.method === "GET") {
      try {
        // Issue #108: the typed listSchedules() is called directly. The
        // old fallback chain (listSchedules → scheduler.list → deprecated
        // getSchedules → 200 with an empty list) is deleted: it masked a
        // broken scheduling binding as "you have no schedules" (audit
        // finding F14). A failure now surfaces as the 500 below.
        const typeParam = url.searchParams.get("type");
        const schedules = await ctx.listSchedules(
          typeParam ? { type: typeParam as ScheduleCriteria["type"] } : undefined
        );
        return Response.json({
          count: schedules.length,
          schedules,
          timestamp: new Date().toISOString(),
        });
      } catch (err: any) {
        return Response.json({ error: err.message || "Failed to list schedules", schedules: [] }, { status: 500 });
      }
    }

    // Cancel a schedule by ID (POST /api/schedules/cancel or DELETE /api/schedules/:id)
    if (
      ((path.endsWith("/schedules/cancel") || path.includes("/schedules/cancel/")) && request.method === "POST") ||
      (path.includes("/schedules/") && request.method === "DELETE")
    ) {
      try {
        const body = (await request.json().catch(() => ({}))) as any;
        const scheduleId =
          body.scheduleId ||
          body.id ||
          url.searchParams.get("id") ||
          path.split("/schedules/cancel/")[1] ||
          path.split("/schedules/")[1] ||
          "";

        if (!scheduleId) {
          return Response.json({ error: "Schedule ID is required" }, { status: 400 });
        }
        const cancelled = await ctx.cancelSchedule(scheduleId);
        ctx.audit("schedule.cancelled", "orchestrator", { scheduleId, success: cancelled });
        return Response.json({ scheduleId, cancelled });
      } catch (err: any) {
        return Response.json({ error: err.message || "Failed to cancel schedule" }, { status: 500 });
      }
    }

    // Get specific schedule by ID (GET /api/schedules/:id)
    if (path.includes("/schedules/") && request.method === "GET") {
      try {
        const scheduleId = path.split("/schedules/").pop() || "";
        const schedule = await ctx.getScheduleById(scheduleId);
        if (!schedule) {
          return Response.json({ error: `Schedule '${scheduleId}' not found` }, { status: 404 });
        }
        return Response.json(schedule);
      } catch (err: any) {
        return Response.json({ error: err.message || "Failed to get schedule" }, { status: 500 });
      }
    }

    // Create a schedule (delayed, scheduled, cron, or interval)
    if ((path.endsWith("/schedules/create") || (path.endsWith("/schedules") && request.method === "POST"))) {
      try {
        const body = (await request.json().catch(() => ({}))) as any;
        const { scheduleType, callback, payload, delayInSeconds, intervalSeconds, cron, date } = body;

        if (!callback) {
          return Response.json({ error: "Callback method name is required" }, { status: 400 });
        }

        // Callback allow-list (#111): this public route may only arm the
        // user-creatable callbacks in ctx.creatableScheduleCallbacks.
        // Anything else — including internal-only callbacks such as
        // executeAsyncJob and expireStaleOrderDraft — is rejected, and no
        // schedule is created.
        if (!(ctx.creatableScheduleCallbacks as readonly string[]).includes(callback)) {
          return Response.json(
            {
              success: false,
              error: `Callback '${callback}' is not allowed: POST /api/schedules/create only accepts ${ctx.creatableScheduleCallbacks.join(", ")}`,
            },
            { status: 400 }
          );
        }

        // Stamp screening schedules with the identity established by the
        // authenticated Worker forwarder. Never trust a caller-supplied
        // payload.userLogin to select another account's E*TRADE credentials.
        const context = await ctx.getScreenerExecutionContext();
        const headerUserLogin = request.headers.get("x-user-login") || "";
        const trustedUserLogin = context?.userLogin || (/^[A-Za-z0-9._-]{1,80}$/.test(headerUserLogin) ? headerUserLogin : "");
        const headerEnvironment = (request.headers.get("x-environment") || "").toUpperCase();
        const trustedEnvironment = context?.environment ||
          (headerEnvironment === "TEST" || headerEnvironment === "PROD"
            ? headerEnvironment
            : resolveEnvironmentConfig(ctx.env).name as ETradeEnvironment);
        if (ctx.accountScopedScheduleCallbacks.has(callback) && !trustedUserLogin) {
          return Response.json({ success: false, error: "An authenticated E*TRADE account is required to create screening schedules." }, { status: 401 });
        }
        if (ctx.accountScopedScheduleCallbacks.has(callback)) {
          const storedTokens = await getStoredTokens(ctx.env, trustedUserLogin, trustedEnvironment);
          if (!storedTokens || isTokenExpiredEt(storedTokens.storedAt)) {
            return Response.json({
              success: false,
              error: "Connect an E*TRADE account for this environment before creating an account-scoped schedule.",
            }, { status: 409 });
          }
        }
        const { userLogin: _untrustedUserLogin, environment: _untrustedEnvironment, ...safePayload } =
          payload && typeof payload === "object" ? payload : {};
        const universe = typeof safePayload.universe === "string" ? safePayload.universe : undefined;
        if (universe && !(universe in UNIVERSES)) {
          return Response.json({ success: false, error: `Unknown screening universe '${universe}'.` }, { status: 400 });
        }
        if (universe === "ALL") {
          return Response.json({ success: false, error: "Choose one specific universe for a scheduled screen." }, { status: 400 });
        }
        if (callback === "autonomousMarketScreen" && !universe) {
          return Response.json({ success: false, error: "Stock schedules require one explicit universe." }, { status: 400 });
        }
        if (safePayload.symbols !== undefined &&
            (!Array.isArray(safePayload.symbols) || safePayload.symbols.some((symbol: unknown) => typeof symbol !== "string" || !/^[A-Z0-9./-]{1,16}$/i.test(symbol)))) {
          return Response.json({ success: false, error: "symbols must be an array of valid ticker strings." }, { status: 400 });
        }
        if (callback === "autonomousStrategyDiscovery") {
          // Issue #126: a discovery schedule re-runs SAVED requests
          // verbatim, so the payload must carry complete, valid
          // StrategyRequests at creation time — an empty or malformed
          // list is rejected here rather than armed to fail honestly
          // on every fire. The service re-validates at execution.
          // Issue #533 adds the profile-derived input model: the
          // payload names a Strategy Profile plus ONE symbol source
          // (explicit symbols, or a watchlist name resolved at fire
          // time). Arm-time validation there is SHAPE ONLY — the
          // profile may be edited or deleted after arming, and both
          // are honest fire-time outcomes, so existence is
          // deliberately NOT checked here.
          const inputModel = (safePayload as any).inputModel;
          if (
            inputModel !== undefined &&
            inputModel !== "saved-request" &&
            inputModel !== "profile-derived"
          ) {
            return Response.json({ success: false, error: `Unknown discovery inputModel '${inputModel}'. Use "saved-request" or "profile-derived".` }, { status: 400 });
          }
          if (inputModel === "profile-derived") {
            const profileId = (safePayload as any).profileId;
            if (typeof profileId !== "string" || !profileId.trim()) {
              return Response.json({ success: false, error: "Profile-derived discovery schedules require payload.profileId (the Strategy Profile to derive targets under)." }, { status: 400 });
            }
            const hasSymbols = (safePayload as any).symbols !== undefined;
            const hasWatchlist = (safePayload as any).watchlistName !== undefined;
            if (hasSymbols === hasWatchlist) {
              return Response.json({ success: false, error: "Profile-derived discovery schedules require exactly one symbol source: payload.symbols or payload.watchlistName." }, { status: 400 });
            }
            if (hasSymbols) {
              const derivedSymbols = (safePayload as any).symbols;
              if (!Array.isArray(derivedSymbols) || derivedSymbols.length === 0) {
                return Response.json({ success: false, error: "payload.symbols must name at least one symbol for a profile-derived discovery schedule." }, { status: 400 });
              }
              if (derivedSymbols.length > MAX_SAVED_REQUESTS_PER_RUN) {
                return Response.json({ success: false, error: `Profile-derived discovery schedules are capped at ${MAX_SAVED_REQUESTS_PER_RUN} symbols per schedule.` }, { status: 400 });
              }
              // Ticker shape itself is enforced by the generic
              // payload.symbols check above, which runs for every
              // callback.
            }
            if (hasWatchlist) {
              const watchlistName = (safePayload as any).watchlistName;
              if (typeof watchlistName !== "string" || !watchlistName.trim()) {
                return Response.json({ success: false, error: "payload.watchlistName must be a non-empty watchlist name." }, { status: 400 });
              }
            }
          } else {
            const savedRequests = (safePayload as any).requests;
            if (!Array.isArray(savedRequests) || savedRequests.length === 0) {
              return Response.json({ success: false, error: "Discovery schedules require at least one saved strategy request in payload.requests." }, { status: 400 });
            }
            if (savedRequests.length > MAX_SAVED_REQUESTS_PER_RUN) {
              return Response.json({ success: false, error: `Discovery schedules are capped at ${MAX_SAVED_REQUESTS_PER_RUN} saved requests per schedule.` }, { status: 400 });
            }
            for (let i = 0; i < savedRequests.length; i++) {
              const requestError = validateStrategyRequest(savedRequests[i]);
              if (requestError) {
                const symbol = typeof savedRequests[i]?.symbol === "string" ? savedRequests[i].symbol : "?";
                return Response.json({ success: false, error: `Saved discovery request ${i + 1} (${symbol}) is invalid: ${requestError}` }, { status: 400 });
              }
            }
          }
        }
        if (ctx.accountScopedScheduleCallbacks.has(callback) && safePayload.maxItems !== undefined &&
            (!Number.isSafeInteger(safePayload.maxItems) || safePayload.maxItems < 0 || safePayload.maxItems > 10000)) {
          return Response.json({ success: false, error: "maxItems must be a whole number from 0 to 10000." }, { status: 400 });
        }
        const effectiveUniverse = universe ||
          (callback === "autonomousOptionsAnalysis" && (!safePayload.symbols || safePayload.symbols.length === 0) ? "NASDAQ100" : undefined);
        const defaultMaxItems = effectiveUniverse
          ? UNIVERSES[effectiveUniverse as keyof typeof UNIVERSES].defaultMaxSymbols
          : (safePayload.symbols?.length || 0);
        const screeningPayload = ctx.accountScopedScheduleCallbacks.has(callback)
          ? {
              ...safePayload,
              ...(effectiveUniverse ? { universe: effectiveUniverse } : {}),
              maxItems: safePayload.maxItems ?? defaultMaxItems,
              ...(trustedUserLogin ? { userLogin: trustedUserLogin } : {}),
              ...(trustedEnvironment ? { environment: trustedEnvironment } : {}),
              trigger: "scheduled",
            }
          : payload;

        // No fabricated success (#111): this route never invents a
        // schedule id or reports success for a schedule that does not
        // exist. Issue #108: the calls below use the typed Agents SDK
        // API directly — schedule/scheduleEvery are typed members of
        // the Agent base class, so the old missing-method guard is
        // gone; if a typed call throws, the catch below returns the
        // same honest 503 {success:false} shape.
        let schedule: Schedule<unknown> | undefined;
        if (scheduleType === "interval" && intervalSeconds) {
          schedule = await ctx.scheduleEvery(Number(intervalSeconds), callback, screeningPayload);
        } else if (scheduleType === "cron" && cron) {
          schedule = await ctx.schedule(cron, callback, screeningPayload, { idempotent: body.idempotent !== false });
        } else if (scheduleType === "scheduled" && date) {
          schedule = await ctx.schedule(new Date(date), callback, screeningPayload);
        } else if (delayInSeconds !== undefined) {
          schedule = await ctx.schedule(Number(delayInSeconds), callback, screeningPayload);
        } else {
          return Response.json(
            { error: "Invalid schedule parameters: provide intervalSeconds, cron, date, or delayInSeconds" },
            { status: 400 }
          );
        }

        ctx.audit("schedule.created", "orchestrator", { scheduleId: schedule?.id, callback, scheduleType });
        return Response.json({ success: true, schedule });
      } catch (err: any) {
        // A throwing SDK scheduling call created nothing, so it gets the
        // honest 503 {success:false, error} shape (#111), worded as what
        // it is — scheduling was unavailable and no schedule was created
        // — never a success response and never a fabricated id.
        return Response.json(
          { success: false, error: `Scheduling unavailable: ${err.message || "Failed to create schedule"}` },
          { status: 503 }
        );
      }
    }

    // Trigger autonomous market screen immediately on demand
    if (path.endsWith("/schedules/trigger-screen") && request.method === "POST") {
      try {
        const body = (await request.json().catch(() => ({}))) as any;
        const userLogin = request.headers.get("x-user-login") || undefined;
        const rawEnvironment = (request.headers.get("x-environment") || "").toUpperCase();
        const environment = rawEnvironment === "TEST" || rawEnvironment === "PROD" ? rawEnvironment : undefined;
        await ctx.autonomousMarketScreen({ ...body, userLogin, environment, trigger: "manual" });
        return Response.json({ success: true, message: "Autonomous market screen triggered" });
      } catch (err: any) {
        return Response.json({ error: err.message || "Failed to trigger market screen" }, { status: 500 });
      }
    }

    // Trigger E*TRADE token renewal immediately on demand
    if (path.endsWith("/schedules/trigger-renew") && request.method === "POST") {
      try {
        const context = await ctx.getScreenerExecutionContext();
        const userLogin = request.headers.get("x-user-login") || context?.userLogin;
        if (!userLogin) return Response.json({ success: false, error: "An authenticated E*TRADE account is required." }, { status: 401 });
        const rawEnvironment = (request.headers.get("x-environment") || "").toUpperCase();
        const environment = rawEnvironment === "TEST" || rawEnvironment === "PROD" ? rawEnvironment : context?.environment;
        await ctx.autoRenewETradeTokens({ userLogin, env: environment });
        return Response.json({ success: true, message: "E*TRADE token renewal triggered" });
      } catch (err: any) {
        return Response.json({ error: err.message || "Failed to trigger token renewal" }, { status: 500 });
      }
    }

    // Trigger autonomous options analysis immediately on demand
    if (path.endsWith("/schedules/trigger-options-analysis") && request.method === "POST") {
      try {
        const body = (await request.json().catch(() => ({}))) as any;
        const context = await ctx.getScreenerExecutionContext();
        const userLogin = request.headers.get("x-user-login") || context?.userLogin || "";
        const rawEnvironment = (request.headers.get("x-environment") || "").toUpperCase();
        const environment = rawEnvironment === "TEST" || rawEnvironment === "PROD"
          ? rawEnvironment
          : context?.environment;
        const service = new ScheduledTasksService(ctx.env, ctx.getOrm(), userLogin, new SqlScanRunStore(ctx.agentCtx.storage.sql));
        const result = await service.autonomousOptionsAnalysis({ ...body, userLogin, environment, trigger: "manual" });
        return Response.json(result);
      } catch (err: any) {
        return Response.json({ error: err.message || "Failed to trigger options analysis" }, { status: 500 });
      }
    }

    // Nightly mas_messages retention pass (issue #255, part of #143).
    // The Worker's scheduled() handler fires this at the 0 4 * * * cron.
    if (path.endsWith("/schedules/trigger-retention") && request.method === "POST") {
      try {
        const result = runStorageRetention(ctx.getOrm(), {
          retentionDays: ctx.env.MAS_MESSAGES_RETENTION_DAYS,
        });
        return Response.json({ success: true, ...result });
      } catch (err: any) {
        return Response.json({ error: err.message || "Failed to run storage retention" }, { status: 500 });
      }
    }

    // Trigger the daily IV history collection immediately on demand
    // (issue #15) — same per-name outcomes the scheduled run produces;
    // idempotent per (symbol, day), so a manual rerun is safe.
    if (path.endsWith("/schedules/trigger-iv-collection") && request.method === "POST") {
      try {
        const body = (await request.json().catch(() => ({}))) as any;
        const context = await ctx.getScreenerExecutionContext();
        const userLogin = request.headers.get("x-user-login") || context?.userLogin;
        if (!userLogin) return Response.json({ success: false, error: "An authenticated E*TRADE account is required." }, { status: 401 });
        const rawEnvironment = (request.headers.get("x-environment") || "").toUpperCase();
        const environment = rawEnvironment === "TEST" || rawEnvironment === "PROD" ? rawEnvironment : context?.environment;
        const service = new ScheduledTasksService(
          ctx.env,
          ctx.getOrm(),
          userLogin,
          new SqlScanRunStore(ctx.agentCtx.storage.sql),
          new SqlIvHistoryStore(ctx.agentCtx.storage.sql)
        );
        const result = await service.collectDailyIvHistory({ ...body, userLogin, environment });
        return Response.json(result);
      } catch (err: any) {
        return Response.json({ error: err.message || "Failed to trigger IV collection" }, { status: 500 });
      }
    }

    // Trigger scheduled strategy discovery immediately on demand
    // (issue #126) — re-runs the body's SAVED StrategyRequests verbatim
    // through the discovery pipeline and persists the run as a
    // "manual-trigger" discovery run. An account identity is required:
    // runs are per-user records and execute under the owner's E*TRADE
    // session (mirrors trigger-iv-collection's 401). Issue #533: a body
    // carrying inputModel "profile-derived" (+ profileId and symbols
    // or watchlistName) flows through the same call — the service
    // branches on the discriminator — and abstentions ride back in the
    // result data alongside failures.
    if (path.endsWith("/schedules/trigger-discovery") && request.method === "POST") {
      try {
        const body = (await request.json().catch(() => ({}))) as any;
        const context = await ctx.getScreenerExecutionContext();
        const userLogin = request.headers.get("x-user-login") || context?.userLogin;
        if (!userLogin) return Response.json({ success: false, error: "An authenticated E*TRADE account is required." }, { status: 401 });
        const rawEnvironment = (request.headers.get("x-environment") || "").toUpperCase();
        const environment = rawEnvironment === "TEST" || rawEnvironment === "PROD"
          ? rawEnvironment
          : context?.environment;
        const service = new ScheduledTasksService(
          ctx.env,
          ctx.getOrm(),
          userLogin,
          new SqlScanRunStore(ctx.agentCtx.storage.sql),
          undefined,
          new SqlDiscoveryRunStore(ctx.agentCtx.storage.sql),
          new SqlStrategyProfileStore(ctx.agentCtx.storage.sql)
        );
        const result = await service.autonomousStrategyDiscovery({ ...body, userLogin, environment, trigger: "manual" });
        return Response.json(result);
      } catch (err: any) {
        return Response.json({ error: err.message || "Failed to trigger strategy discovery" }, { status: 500 });
      }
    }
  return null;
}
