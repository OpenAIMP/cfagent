/**
 * Issue #359-11: E*TRADE options routes extracted from
 * OrchestratorAgent.routeRequest (src/agents/orchestrator.ts). Pure move -
 * no behavior change.
 *
 * Owns the contiguous options block (between the E*TRADE broker
 * account-activity delegation and the E*TRADE watchlists block):
 *   GET  /etrade/options/chains
 *   GET  /options/latest                       (#223 autonomous options runs)
 *   POST /etrade/options/strategy          (#314 advertised spelling -
 *         delegates to the single-owner strategy-discovery handler)
 *   GET  /etrade/options/expire-dates
 *   GET  /etrade/options/scans
 *   GET  /etrade/options/scans/diff
 *   GET  /etrade/options/discovery-runs        (#126 scheduled discovery)
 *   GET  /etrade/options/discovery-runs/:id    (#126 scheduled discovery)
 *   GET  /etrade/options/iv-history
 *   GET  /etrade/options/profiles
 *   POST /etrade/options/profiles
 *   POST /trading/options/llm-ideas
 *   POST /trading/options/compare
 *   POST /trading/options/recommend        (the #314 single-owner handler)
 *   GET  /trading/options/catalog
 *   POST /trading/options/strategies | POST /trading/options/best-trade
 *   POST|GET /trading/options/screen
 *   POST|GET /trading/options/unified
 *   POST|GET /trading/options/config
 *
 * The blocks were contiguous in routeRequest, so this module exports ONE
 * handler invoked from routeRequest at the EXACT position the original
 * blocks occupied in the sequential matching sequence. It returns a Response
 * when one of its paths matches, or null when none does (the orchestrator
 * then continues its sequential matching).
 *
 * Every handler ends with an explicit `return null` - never undefined.
 *
 * BOUNDARY DISCIPLINE (#290): all trading access goes through the
 * src/trading/index.ts boundary ("../../trading"), exactly as the inline
 * code did. No direct imports of trading internals.
 *
 * The #314 single-owner handleOptionsStrategyRecommend moved here with its
 * block (slice #359-09 did the same for handleEnvironmentSwitch): it is
 * called only by the two strategy routes owned by this module.
 *
 * Handlers that used OrchestratorAgent state receive it via the explicit
 * EtradeOptionsRouteContext parameter; there are no new globals and no
 * back-references into the class. The requestedEnv binding stays inline in
 * routeRequest and is passed through the context (it is shared with the
 * the watchlists module below (#359-12); passed through the context).
 */

import type { AgentContext } from "agents";
import { readOptionsRuns } from "../optionsRuns";
import { ETradeService } from "../../services/etrade";
import { recordStrategyCandidates } from "../../services/strategyReviews";
import {
  DynamicOptionsScreener,
  recommendOptionStrategies,
  validateStrategyRequest,
  SqlScanRunStore,
  SqlDiscoveryRunStore,
  diffScanRuns,
  SqlIvHistoryStore,
  UnifiedOptionsService,
  SqlStrategyProfileStore,
  flattenWatchlistSymbols,
  getIvHistoryEntry,
  resolveTrackedSymbols,
  validateStrategyProfile,
  type StrategyProfileSpec,
  generateSyntheticOptionChains,
  describeLlmInput,
  rankCandidatesWithLlm,
  buildCalibratedOptionChains,
  OptionsAgentPipeline,
  type RiskProfile,
  type StrategyScreenFilter,
  defaultRegistry,
  REQUESTED_STRATEGY_NAMES,
  type StrategyRequest,
} from "../../trading";
import { getEtapiConfig, setRuntimeEtapiConfigOverrides } from "../../config/etapiConfig";
import { isDemoCalibratedChainsEnabled } from "../../config/demoMode";
import { getCuratedStockUniverse } from "../../config/curatedStockUniverse";
import { DEFAULT_AI_MODEL } from "../model";
import type { Env, ETradeOptionChain, ETradeOptionExpireDate } from "../../types";
import type { DatabaseORM, SqlStorage } from "../../orm";
import type { ScreenerAgent } from "../screener-agent";
import { deliverScreenerToSlackA2A } from "../../services/screenerSlackDelivery";

/** The subset of OrchestratorAgent surface the E*TRADE options handlers need. */
export interface EtradeOptionsRouteContext {
  /** Worker environment (owner: OrchestratorAgent - was `this.env`). */
  env: Env;
  /** ORM accessor (owner: OrchestratorAgent - was `this.getOrm()`). */
  getOrm(): DatabaseORM;
  /** Durable Object agent context (owner: OrchestratorAgent - was `this.ctx`),
   * used for the SqlStorage-backed stores. */
  agentCtx: AgentContext;
  /** Table initializer (owner: OrchestratorAgent - was `this.ensureTables()`). */
  ensureTables(): SqlStorage;
  /** Requested E*TRADE environment (owner: routeRequest local - stays inline,
   * shared with the watchlists module (#359-12); passed through here). */
  requestedEnv: "TEST" | "PROD" | undefined;
  /** Screener agent (owner: OrchestratorAgent - was `this.getScreenerAgent()`). */
  getScreenerAgent(userLogin?: string): ScreenerAgent;
}

/**
 * Issue #314 — single-owner handler for options strategy discovery
 * (Workflow A2). Both spellings (`/trading/options/recommend` and the
 * advertised `POST /api/etrade/options/strategy`) delegate here, so the
 * strategy request is validated once and evaluated once by the real
 * engine (E*TRADE chain snapshot -> screened contracts ->
 * recommendOptionStrategies), with byte-identical responses.
 *
 * Honest subset vs the docs: the engine computes Black-Scholes Greeks,
 * model-implied probability of profit (N(d2)), expected value, payoff
 * curves, and a volatility-ALIGNMENT score per candidate. It does not
 * compute a standalone "IV rank" field; IV enters through the per-leg
 * impliedVolatility and the volatility-alignment score weight.
 */
export async function handleOptionsStrategyRecommend(
  request: Request,
  deps: { orm: any; env: Env; sessionKey: string; requestedEnv: "TEST" | "PROD" | undefined }
): Promise<Response> {
  const body = await request.json().catch(() => null) as Partial<StrategyRequest> | null;
  const validationError = validateStrategyRequest(body);
  if (validationError) {
    return Response.json({ error: validationError }, { status: 400 });
  }

  try {
    const strategyRequest = body as StrategyRequest;
    const userLogin = request.headers.get("x-user-login") || deps.sessionKey || "default_trader";
    const etrade = new ETradeService(deps.orm, deps.env, userLogin, deps.requestedEnv);
    const screener = new DynamicOptionsScreener(etrade.client);
    const screened = await screener.screenOptions({
      underlyingSymbols: [strategyRequest.symbol.toUpperCase().trim()],
      contractType: "BOTH",
      minDte: strategyRequest.minDte,
      maxDte: strategyRequest.maxDte,
      minVolume: strategyRequest.minVolume,
      minOpenInterest: strategyRequest.minOpenInterest,
      maxSpreadPct: strategyRequest.maxSpreadPct,
      maxQuoteAgeSeconds: strategyRequest.maxQuoteAgeSeconds,
      limit: strategyRequest.contractLimit,
    });
    const recommendations = recommendOptionStrategies(screened.contracts, strategyRequest, strategyRequest.candidateLimit);
    return Response.json({
      ...recommendations,
      contracts: screened.contracts,
      screen: {
        scannedAt: screened.scannedAt,
        underlyingsScanned: screened.totalUnderlyingsScanned,
        contractsEvaluated: screened.totalContractsEvaluated,
        contractsMatched: screened.matchedCount,
        quoteQuality: screened.quoteQuality,
        fetchErrors: screened.fetchErrors,
        warnings: screened.warnings,
        validationError: screened.validationError,
        status: screened.status,
      },
      contractRejections: (screened.rejections || []).slice(0, 50),
    });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Options recommendation failed" }, { status: 400 });
  }
}

/**
 * Handles the E*TRADE options routes (chains / expire-dates / scans /
 * iv-history / profiles / strategy) and the trading/options routes
 * (llm-ideas / compare / recommend / catalog / strategies / screen /
 * unified / config). Returns a Response on match, null when no options path
 * matches (the orchestrator then continues its sequential matching).
 */
export async function handleEtradeOptionsRoutes(
  request: Request,
  url: URL,
  path: string,
  sessionId: string,
  ctx: EtradeOptionsRouteContext
): Promise<Response | null> {
  const sql = ctx.ensureTables();

    // Issue #223: latest autonomous options-analysis runs. Results were only
    // ever visible in the live broadcast; the scheduler now keeps the last 20
    // runs in DO storage so the panel can render what actually ran.
    // server.ts strips the /api prefix, so the DO sees /options/latest.
    if (path.endsWith("/options/latest") && request.method === "GET") {
      try {
        const runs = await readOptionsRuns((ctx.agentCtx as { storage?: unknown } | undefined)?.storage);
        return Response.json({
          count: runs.length,
          runs,
          timestamp: new Date().toISOString(),
        });
      } catch (err: any) {
        return Response.json(
          { error: err?.message || "Failed to load options runs", runs: [] },
          { status: 500 }
        );
      }
    }

    // Real E*TRADE REST API: Option Chains
    if (path.endsWith("/etrade/options/chains") && request.method === "GET") {
      try {
        const symbol = (url.searchParams.get("symbol") || "NVDA").toUpperCase().trim();
        const expiryYear = url.searchParams.get("expiryYear") ? Number(url.searchParams.get("expiryYear")) : undefined;
        const expiryMonth = url.searchParams.get("expiryMonth") ? Number(url.searchParams.get("expiryMonth")) : undefined;
        const expiryDay = url.searchParams.get("expiryDay") ? Number(url.searchParams.get("expiryDay")) : undefined;
        const strikePrice = url.searchParams.get("strikePrice") ? Number(url.searchParams.get("strikePrice")) : undefined;
        const noOfStrikes = url.searchParams.get("noOfStrikes") ? Number(url.searchParams.get("noOfStrikes")) : undefined;
        const chainType = (url.searchParams.get("chainType") as "CALL" | "PUT" | "CALLPUT") || undefined;
        const userLogin = request.headers.get("x-user-login") || sessionId || "default_trader";
        const etrade = new ETradeService(ctx.getOrm(), ctx.env, userLogin, ctx.requestedEnv);
        const chain = await etrade.getOptionChains({
          symbol,
          expiryYear,
          expiryMonth,
          expiryDay,
          strikePrice,
          noOfStrikes,
          chainType,
        });
        if (!chain) {
          // Issue #155: a null chain with a recorded client error is an
          // upstream failure (expired OAuth, missing credentials,
          // network), not an empty chain — surface it as a 502 naming
          // the cause instead of a fabricated 200 empty payload.
          const upstreamError = etrade.getLastError();
          if (upstreamError) {
            return Response.json({ error: upstreamError, symbol }, { status: 502 });
          }
        }
        return Response.json(chain || { symbol, underlyingPrice: 0, pairs: [] });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to fetch option chains" }, { status: 500 });
      }
    }

    // Issue #314: the advertised POST /api/etrade/options/strategy spelling
    // (docs/ANALYSIS_AND_EXECUTION_WORKFLOWS.md, Workflow A2) delegates to
    // the same single-owner strategy-discovery handler as
    // /trading/options/recommend — one logic owner, byte-identical contract.
    if (path.endsWith("/etrade/options/strategy") && request.method === "POST") {
      return handleOptionsStrategyRecommend(request, {
        orm: ctx.getOrm(),
        env: ctx.env,
        sessionKey: sessionId,
        requestedEnv: ctx.requestedEnv,
      });
    }

    // Real E*TRADE REST API: Option Expire Dates
    if (path.endsWith("/etrade/options/expire-dates") && request.method === "GET") {
      try {
        const symbol = (url.searchParams.get("symbol") || "NVDA").toUpperCase().trim();
        const expiryType = url.searchParams.get("expiryType") || undefined;
        const userLogin = request.headers.get("x-user-login") || sessionId || "default_trader";
        const etrade = new ETradeService(ctx.getOrm(), ctx.env, userLogin, ctx.requestedEnv);
        const dates = await etrade.getOptionExpireDates(symbol, expiryType);
        if (dates.length === 0) {
          // Issue #155: distinguish an upstream failure (client error
          // recorded) from a symbol that genuinely has no expirations —
          // only the genuine empty keeps the 200 empty payload.
          const upstreamError = etrade.getLastError();
          if (upstreamError) {
            return Response.json({ error: upstreamError, symbol }, { status: 502 });
          }
        }
        return Response.json({ count: dates.length, dates });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to fetch option expire dates" }, { status: 500 });
      }
    }

    // Persisted opportunity scan runs (issue #27): scans executed with a
    // store attached (NLQ path + unified opportunities route) are
    // retrievable here with their full provenance, and two runs can be
    // diffed run-over-run. Declared in list → diff → by-id order: the
    // diff route must win over the by-id pattern below.
    if (path.endsWith("/etrade/options/scans") && request.method === "GET") {
      try {
        const limit = url.searchParams.get("limit") ? Number(url.searchParams.get("limit")) : 25;
        const offset = url.searchParams.get("offset") ? Number(url.searchParams.get("offset")) : 0;
        // Issue #103: history is scoped per user, like profiles —
        // runs the caller saved are theirs; legacy runs saved before
        // scoping (no user_login) remain visible to everyone.
        const userLogin = request.headers.get("x-user-login") || sessionId || "default_trader";
        const store = new SqlScanRunStore(sql);
        const scans = await store.list({ limit, offset, userLogin });
        return Response.json({ count: scans.length, scans });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to list scan runs" }, { status: 500 });
      }
    }

    if (path.endsWith("/etrade/options/scans/diff") && request.method === "GET") {
      try {
        const fromId = url.searchParams.get("from") || "";
        const toId = url.searchParams.get("to") || "";
        if (!fromId || !toId) {
          return Response.json({ error: "from and to scan run ids are required" }, { status: 400 });
        }
        // Issue #103: both runs must be visible to the caller — an
        // invisible run produces the same 404 as a missing one, so a
        // diff can never leak another user's run (or its existence).
        const userLogin = request.headers.get("x-user-login") || sessionId || "default_trader";
        const store = new SqlScanRunStore(sql);
        const from = await store.get(fromId, { userLogin });
        const to = await store.get(toId, { userLogin });
        if (!from || !to) {
          return Response.json({ error: "scan run not found" }, { status: 404 });
        }
        return Response.json({
          from: { id: from.id, generatedAt: from.generatedAt },
          to: { id: to.id, generatedAt: to.generatedAt },
          diff: diffScanRuns(from.result, to.result),
        });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to diff scan runs" }, { status: 500 });
      }
    }

    const scanRunIdMatch = path.match(/\/etrade\/options\/scans\/([^/]+)$/);
    if (scanRunIdMatch && request.method === "GET") {
      try {
        // Issue #103: scoped like the list — another user's run is
        // indistinguishable from a pruned one (same 404).
        const userLogin = request.headers.get("x-user-login") || sessionId || "default_trader";
        const store = new SqlScanRunStore(sql);
        const run = await store.get(decodeURIComponent(scanRunIdMatch[1]), { userLogin });
        if (!run) {
          return Response.json({ error: "scan run not found" }, { status: 404 });
        }
        return Response.json(run);
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to fetch scan run" }, { status: 500 });
      }
    }

    // Persisted scheduled-discovery runs (issue #126, PR-E): executions
    // of autonomousStrategyDiscovery (scheduled fires and manual
    // triggers) are retrievable here with their provenance, saved
    // requests, and per-symbol outcomes. Scoped per user exactly like
    // the scan runs above (issue #103 rule, enforced by the store).
    if (path.endsWith("/etrade/options/discovery-runs") && request.method === "GET") {
      try {
        const limit = url.searchParams.get("limit") ? Number(url.searchParams.get("limit")) : 25;
        const offset = url.searchParams.get("offset") ? Number(url.searchParams.get("offset")) : 0;
        const userLogin = request.headers.get("x-user-login") || sessionId || "default_trader";
        const store = new SqlDiscoveryRunStore(sql);
        const runs = await store.list({ limit, offset, userLogin });
        return Response.json({ count: runs.length, runs });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to list discovery runs" }, { status: 500 });
      }
    }

    const discoveryRunIdMatch = path.match(/\/etrade\/options\/discovery-runs\/([^/]+)$/);
    if (discoveryRunIdMatch && request.method === "GET") {
      try {
        // Issue #103: scoped like the list — another user's run is
        // indistinguishable from a pruned one (same 404).
        const userLogin = request.headers.get("x-user-login") || sessionId || "default_trader";
        const store = new SqlDiscoveryRunStore(sql);
        const run = await store.get(decodeURIComponent(discoveryRunIdMatch[1]), { userLogin });
        if (!run) {
          return Response.json({ error: "discovery run not found" }, { status: 404 });
        }
        return Response.json(run);
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to fetch discovery run" }, { status: 500 });
      }
    }

    // IV history (issue #15): the daily collector's stored series,
    // read back as IV rank / percentile with honest coverage. A name
    // with no records is a state (observations 0, warmingUp true,
    // latest null), never a 404 — absence of history is exactly what
    // a warming-up system is supposed to report. Without ?symbol=,
    // returns the per-name coverage summary for every tracked name
    // (curated ∪ watchlists) plus any name that has records.
    if (path.endsWith("/etrade/options/iv-history") && request.method === "GET") {
      try {
        const store = new SqlIvHistoryStore(sql);
        const symbolParam = url.searchParams.get("symbol");
        if (symbolParam) {
          const entry = await getIvHistoryEntry(store, symbolParam);
          // ?series=true includes the full time series for charting.
          if (url.searchParams.get("series") === "true") {
            const series = await store.listSeries(symbolParam.toUpperCase(), { limit: 365 });
            return Response.json({
              ...entry,
              series: series.reverse().map((r) => ({
                date: r.date,
                atmIv: r.atmIv,
                spot: r.spot,
              })),
            });
          }
          return Response.json(entry);
        }
        let watchlistSymbols: string[] = [];
        try {
          watchlistSymbols = flattenWatchlistSymbols(ctx.getOrm().watchlists.findMany({}));
        } catch {
          // Watchlist read failure → curated universe only.
        }
        const tracked = resolveTrackedSymbols(
          getCuratedStockUniverse().map((s) => s.symbol),
          watchlistSymbols
        );
        const recorded = await store.listSymbols();
        const names = [...new Set([...tracked, ...recorded])].sort();
        const entries = [];
        for (const symbol of names) {
          entries.push(await getIvHistoryEntry(store, symbol));
        }
        return Response.json({ count: entries.length, names: entries });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to fetch IV history" }, { status: 500 });
      }
    }

    // Saved strategy profiles (issue #28): named, versioned "my
    // strategy" objects, scoped per user. Scans and single-name actions
    // resolve them by name (NLQ) or id/name (unified body) and stamp
    // the applied profile into scan provenance. Validation is the
    // route's job (validateStrategyProfile); the store enforces only
    // per-user name uniqueness. The profiles UI panel is issue #84's
    // surface — these routes are the API it will consume.
    if (path.endsWith("/etrade/options/profiles") && request.method === "GET") {
      try {
        const userLogin = request.headers.get("x-user-login") || sessionId || "default_trader";
        const store = new SqlStrategyProfileStore(sql);
        const profiles = await store.list(userLogin);
        return Response.json({ count: profiles.length, profiles });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to list strategy profiles" }, { status: 500 });
      }
    }

    if (path.endsWith("/etrade/options/profiles") && request.method === "POST") {
      try {
        const userLogin = request.headers.get("x-user-login") || sessionId || "default_trader";
        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        const { name, ...spec } = body;
        const profileName = typeof name === "string" ? name : "";
        const validationError = validateStrategyProfile(profileName, spec as StrategyProfileSpec);
        if (validationError) {
          return Response.json({ error: validationError }, { status: 400 });
        }
        const store = new SqlStrategyProfileStore(sql);
        try {
          const profile = await store.create(userLogin, profileName, spec as StrategyProfileSpec);
          return Response.json(profile, { status: 201 });
        } catch (err) {
          return Response.json({ error: err instanceof Error ? err.message : "Failed to create strategy profile" }, { status: 400 });
        }
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to create strategy profile" }, { status: 500 });
      }
    }

    const profileIdMatch = path.match(/\/etrade\/options\/profiles\/([^/]+)$/);
    if (profileIdMatch && request.method === "GET") {
      try {
        const userLogin = request.headers.get("x-user-login") || sessionId || "default_trader";
        const store = new SqlStrategyProfileStore(sql);
        const profile = await store.get(userLogin, decodeURIComponent(profileIdMatch[1]));
        if (!profile) {
          return Response.json({ error: "profile not found" }, { status: 404 });
        }
        return Response.json(profile);
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to fetch strategy profile" }, { status: 500 });
      }
    }

    if (profileIdMatch && request.method === "PUT") {
      try {
        const userLogin = request.headers.get("x-user-login") || sessionId || "default_trader";
        const store = new SqlStrategyProfileStore(sql);
        const existing = await store.get(userLogin, decodeURIComponent(profileIdMatch[1]));
        if (!existing) {
          return Response.json({ error: "profile not found" }, { status: 404 });
        }
        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        const { name, ...spec } = body;
        // The body name wins when present; otherwise the profile keeps
        // its current name (validation runs against the effective one).
        const profileName = typeof name === "string" ? name : existing.name;
        const validationError = validateStrategyProfile(profileName, spec as StrategyProfileSpec);
        if (validationError) {
          return Response.json({ error: validationError }, { status: 400 });
        }
        try {
          const updated = await store.update(userLogin, existing.id, spec as StrategyProfileSpec, typeof name === "string" ? name : undefined);
          return Response.json(updated);
        } catch (err) {
          return Response.json({ error: err instanceof Error ? err.message : "Failed to update strategy profile" }, { status: 400 });
        }
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to update strategy profile" }, { status: 500 });
      }
    }

    if (profileIdMatch && request.method === "DELETE") {
      try {
        const userLogin = request.headers.get("x-user-login") || sessionId || "default_trader";
        const store = new SqlStrategyProfileStore(sql);
        const deleted = await store.delete(userLogin, decodeURIComponent(profileIdMatch[1]));
        if (!deleted) {
          return Response.json({ error: "profile not found" }, { status: 404 });
        }
        return Response.json({ deleted: true });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to delete strategy profile" }, { status: 500 });
      }
    }

    // ==========================================
    // Dynamic Options Screener Engine Endpoint
    // ==========================================
    if (path.endsWith("/trading/options/llm-ideas") && request.method === "POST") {
      const body = await request.json().catch(() => null) as { symbol?: unknown; question?: unknown; refresh?: unknown } | null;
      const symbol = typeof body?.symbol === "string" ? body.symbol.trim().toUpperCase() : "";
      const question = typeof body?.question === "string" ? body.question.trim() : "";
      const forceRefresh = body?.refresh === true;
      if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol)) {
        return Response.json({ error: "Provide a valid stock ticker symbol." }, { status: 400 });
      }
      if (!question || question.length > 4000) {
        return Response.json({ error: "Provide a natural-language question up to 4,000 characters." }, { status: 400 });
      }

      let retrievedExpirations: ETradeOptionExpireDate[] = [];
      const retrievedChains: ETradeOptionChain[] = [];
      let usedSyntheticChains = false;
      const orm = ctx.getOrm();
      const cached = !forceRefresh ? orm.getOptionsChain(symbol) : null;

      try {
        const userLogin = request.headers.get("x-user-login") || sessionId || "default_trader";
        const etrade = new ETradeService(orm, ctx.env, userLogin, ctx.requestedEnv);

        if (cached && cached.expirations.length > 0 && cached.chains.length > 0) {
          retrievedExpirations = cached.expirations;
          for (const c of cached.chains) {
            retrievedChains.push(c);
          }
        } else {
          let expirations = await etrade.client.getOptionExpireDates(symbol);
          if (expirations.length === 0) {
            // Fall back to unscoped option chain request if expiration calendar endpoint was empty
            const fallbackChain = await etrade.client.getOptionChains({
              symbol,
              includeWeekly: true,
              chainType: "CALLPUT",
              includeRawResponse: true,
            }).catch(() => null);
            if (fallbackChain && fallbackChain.selectedExpiry && fallbackChain.pairs.length > 0) {
              expirations = [fallbackChain.selectedExpiry];
              retrievedChains.push(fallbackChain);
            }
          }

          if (expirations.length > 0 && retrievedChains.length === 0) {
            retrievedExpirations = expirations;

            // Target up to 18 most active expirations across near, mid, and long term to prevent unconstrained latency
            const targetExpirations = expirations.length > 18
              ? [...expirations.slice(0, 10), ...expirations.slice(10, 16), ...expirations.slice(-2)]
              : expirations;

            // Fetch option chains with concurrency chunking (4 parallel requests at a time)
            const chunkSize = 4;
            for (let i = 0; i < targetExpirations.length; i += chunkSize) {
              const chunk = targetExpirations.slice(i, i + chunkSize);
              const chunkChains = await Promise.all(
                chunk.map((expiry) =>
                  etrade.client.getOptionChains({
                    symbol,
                    expiryYear: expiry.year,
                    expiryMonth: expiry.month,
                    expiryDay: expiry.day,
                    includeWeekly: true,
                    chainType: "CALLPUT",
                    includeRawResponse: true,
                  })
                )
              );
              for (const chain of chunkChains) {
                if (chain) retrievedChains.push(chain);
              }
            }
          } else if (expirations.length > 0) {
            retrievedExpirations = expirations;
          }

          if (retrievedChains.length > 0) {
            // Persist into durable SQLite table (10-minute TTL)
            orm.setOptionsChain(symbol, retrievedExpirations, retrievedChains, 600);
          }
        }

        let contractCount = retrievedChains.reduce(
          (count, chain) => count + chain.pairs.reduce((pairCount, pair) => pairCount + Number(Boolean(pair.call)) + Number(Boolean(pair.put)), 0),
          0,
        );

        if (contractCount === 0) {
          const isTestEnv = ctx.requestedEnv === "TEST" || !etrade.client.getEnvConfig().isLive;
          if (isTestEnv) {
            usedSyntheticChains = true;
            const synthetic = generateSyntheticOptionChains(symbol);
            retrievedExpirations = synthetic.expirations;
            retrievedChains.length = 0;
            for (const sc of synthetic.chains) {
              retrievedChains.push(sc);
            }
            contractCount = retrievedChains.reduce(
              (count, chain) => count + chain.pairs.reduce((pairCount, pair) => pairCount + Number(Boolean(pair.call)) + Number(Boolean(pair.put)), 0),
              0,
            );
          } else {
            throw new Error(etrade.client.lastError || `E*TRADE returned no option contracts for ${symbol} in PROD environment; no LLM request was sent.`);
          }
        }

        if (contractCount === 0) {
          throw new Error(`E*TRADE returned no option contracts for ${symbol}; no LLM request was sent.`);
        }

        const rawData = {
          symbol,
          question,
          // Provenance (issue #29): synthetic chains are TEST-only and must never be
          // indistinguishable from live E*TRADE chains downstream.
          dataSource: usedSyntheticChains ? "synthetic option chains (TEST environment)" : "E*TRADE option chains",
          expirations: retrievedExpirations,
          optionChains: retrievedChains.map((chain) => chain.raw ?? chain),
        };
        // Issue #47 (follow-up to #29): this endpoint no longer runs the
        // llm_ideas map-reduce (horizon groups over raw chains, existence-only
        // verification, no risk constraints). Following the compare pattern —
        // and the unified service's llm_ideas disposition in slice 4 — the
        // quant pipeline runs first and the LLM evaluates its verified
        // candidates, never overwriting the quant ranking. The response keeps
        // the panel's shape: a single "pipeline" group carries the evaluation
        // so rendering, exports, and provenance badges keep working.
        const spot = retrievedChains.find((chain) => Number.isFinite(chain.underlyingPrice) && chain.underlyingPrice > 0)?.underlyingPrice ?? 100;
        const questionLower = question.toLowerCase();
        const thesis: StrategyRequest["thesis"] = /bear|downside|\bshort\b/.test(questionLower)
          ? "bearish"
          : /range|sideways|neutral|income|theta/.test(questionLower)
            ? "range_bound"
            : /volatil|big move|large move|breakout/.test(questionLower)
              ? "large_move"
              : "bullish";
        const strategyRequest: StrategyRequest = {
          symbol,
          thesis,
          targetPrice: Math.round(spot * (thesis === "bullish" ? 1.05 : thesis === "bearish" ? 0.95 : 1) * 100) / 100,
          targetDate: new Date(Date.now() + 30 * 86400000).toISOString().split("T")[0],
          expectedIvDirection: "unchanged",
          maxPlannedLoss: 100000,
          minRewardRisk: 0,
          allowedStrategies: ["all"],
        };
        const pipeline = new OptionsAgentPipeline(new DynamicOptionsScreener(etrade.client));
        const pipelineResult = await pipeline.run(strategyRequest, { riskProfile: "balanced" });
        const topRanked = pipelineResult.ranked.slice(0, 10);
        const candidates = topRanked.map((r) => r.candidate);
        let llmJudgment: Awaited<ReturnType<typeof rankCandidatesWithLlm>> | null = null;
        let llmError: string | null = null;
        if (candidates.length > 0) {
          try {
            // Issue #707: inject recent human review decisions as ranking context.
            let humanFeedback: string | undefined;
            try {
              const { listStrategyReviews } = await import("../../services/strategyReviews");
              const { buildHumanFeedbackContext, buildReflectionFeedbackContext } = await import("../../trading");
              const { getActiveLearnings } = await import("../../services/learnings");
              const recent = listStrategyReviews(ctx.getOrm()).slice(0, 20);
              humanFeedback = buildHumanFeedbackContext(recent) || undefined;
              // Issue #775: append reflection adjustments so the Act step acts.
              try {
                const learnings = getActiveLearnings(ctx.getOrm() as any, "screener");
                const reflectionCtx = buildReflectionFeedbackContext(
                  learnings.map((l) => ({ observation: l.observation, confidence: l.confidence }))
                );
                if (reflectionCtx) {
                  humanFeedback = humanFeedback
                    ? `${humanFeedback}\n\n${reflectionCtx}`
                    : reflectionCtx;
                  console.log(`[Options] Ranking with reflection adjustments (${learnings.length} learnings)`);
                }
              } catch {}
              if (humanFeedback) {
                console.log(`[Options] Ranking with human feedback context (${recent.length} recent decisions)`);
              }
            } catch {}
            llmJudgment = await rankCandidatesWithLlm(ctx.env, strategyRequest, "balanced", pipelineResult.snapshot.contracts, candidates, humanFeedback);
          } catch (err) {
            llmError = err instanceof Error ? err.message : "LLM evaluation failed.";
          }
        }
        const llmStatus = llmJudgment ? "complete" as const : "error" as const;
        const llmModel = llmJudgment?.model || ctx.env.AI_MODEL || DEFAULT_AI_MODEL;
        const llmErrorText = llmError ?? "The quant pipeline produced no candidates for this symbol.";
        const rationaleByCandidate = new Map((llmJudgment?.ranked ?? []).map((judgment) => [judgment.candidateId, judgment.rationale]));
        const answer = llmJudgment
          ? llmJudgment.ranked.slice(0, 3).map((judgment, idx) => {
              const candidate = candidates.find((c) => c.id === judgment.candidateId);
              return `${idx + 1}. ${candidate ? candidate.label : judgment.candidateId} — ${judgment.rationale}`;
            }).join("\n")
          : llmErrorText;
        const candidateContractSymbols = [...new Set(candidates.flatMap((c) => c.legs.map((leg) => leg.symbol)))];
        const groupResults = [{
          id: "pipeline",
          label: "Quant pipeline candidates",
          status: llmStatus,
          model: llmModel,
          answer,
          error: llmStatus === "error" ? llmErrorText : undefined,
          contractSymbols: candidateContractSymbols,
          contractWarnings: [] as string[],
          contractDetails: [] as unknown[],
          expirationCount: retrievedExpirations.length,
          contractCount,
          sentContractCount: candidates.length,
          estimatedInputTokens: 0,
          inputTruncated: false,
        }];
        const finalAnalysis = {
          status: llmStatus,
          model: llmModel,
          answer: llmStatus === "complete" ? answer : undefined,
          error: llmStatus === "error" ? llmErrorText : undefined,
          rankings: topRanked.map((r, idx) => ({
            rank: idx + 1,
            groupId: "pipeline",
            strategy: r.candidate.label,
            rationale: rationaleByCandidate.get(r.candidate.id) ?? "",
          })),
          systemPrompt: "",
          userPrompt: question,
          isFallback: false,
        };
        const llmInputExport = {
          id: "pipeline",
          label: "Quant pipeline candidates",
          symbol,
          question,
          expirations: retrievedExpirations,
          optionChains: retrievedChains.map((chain) => chain.raw ?? chain),
          systemPrompt: "Quant pipeline candidate evaluation (issue #47): the LLM evaluates verified candidates; it does not generate strategies.",
          userPrompt: question,
          selection: { contractCount, candidateCount: candidates.length },
          groupInputs: [] as unknown[],
          finalRanking: { systemPrompt: "", userPrompt: question },
        };
        // Issue #653: record candidates for the review UI (best-effort).
        try {
          recordStrategyCandidates(ctx.getOrm(), symbol, topRanked.map((r, idx) => ({
            id: r.candidate.id,
            label: r.candidate.label,
            rank: idx + 1,
            rationale: rationaleByCandidate.get(r.candidate.id) ?? "",
            quantStatus: "verified",
          })));
        } catch {}
        const dataCoverage = {
          expirationCount: retrievedExpirations.length,
          chainCount: retrievedChains.length,
          contractCount,
          sentContractCount: contractCount,
          estimatedInputTokens: 0,
          inputTruncated: false,
          cached: Boolean(cached),
          fetchedAt: cached?.fetchedAt || Date.now(),
        };
        return Response.json({
          mode: "llm_evaluation_of_quant_candidates",
          isSynthetic: usedSyntheticChains,
          notice: usedSyntheticChains
            ? "Synthetic option chains preview (TEST environment). Not verified live market data."
            : "Quant-verified candidates evaluated by the LLM (compare pattern, issue #47); the quant pipeline's ranking stands.",
          llm: {
            status: llmStatus,
            model: llmModel,
            answer: llmStatus === "complete" ? answer : undefined,
            error: llmStatus === "error" ? llmErrorText : undefined,
            contractSymbols: candidateContractSymbols,
          },
          quant: {
            ranked: topRanked,
            scoreWeights: pipelineResult.strategies.scoreWeights,
            candidateCount: candidates.length,
          },
          groups: groupResults,
          finalAnalysis,
          llmInput: llmInputExport,
          retrievedData: rawData,
          dataCoverage,
        });
      } catch (err) {
        const error = err instanceof Error ? err.message : "Failed to retrieve complete E*TRADE option data.";
        const failedContractCount = retrievedChains.reduce(
          (count, chain) => count + chain.pairs.reduce((pairCount, pair) => pairCount + Number(Boolean(pair.call)) + Number(Boolean(pair.put)), 0),
          0,
        );
        const fallbackLlmInput = retrievedChains.length > 0 ? {
          id: "all",
          label: "All Expirations",
          symbol,
          question,
          expirations: retrievedExpirations,
          optionChains: retrievedChains.map((chain) => chain.raw ?? chain),
          systemPrompt: "Normalized options contract dataset",
          userPrompt: question,
          selection: {
            contractsAvailable: failedContractCount,
            contractsIncluded: failedContractCount,
            truncated: false,
          },
        } : undefined;
        return Response.json({
          error,
          mode: "llm_evaluation_of_quant_candidates",
          llm: { status: "error", model: ctx.env.AI_MODEL || DEFAULT_AI_MODEL, error },
          llmInput: fallbackLlmInput,
          retrievedData: {
            symbol,
            question,
            dataSource: usedSyntheticChains ? "synthetic option chains (TEST environment)" : "E*TRADE option chains",
            expirations: retrievedExpirations,
            optionChains: retrievedChains.map((chain) => chain.raw ?? chain),
          },
          dataCoverage: {
            expirationCount: retrievedExpirations.length,
            chainCount: retrievedChains.length,
            contractCount: failedContractCount,
            sentContractCount: 0,
            estimatedInputTokens: 0,
            inputTruncated: false,
          },
        }, { status: 502 });
      }
    }

    if (path.endsWith("/trading/options/compare") && request.method === "POST") {
      const body = await request.json().catch(() => null) as (Partial<StrategyRequest> & {
        riskProfile?: RiskProfile;
        alternatives?: number;
      }) | null;
      const validationError = validateStrategyRequest(body);
      if (validationError || !body) {
        return Response.json({ error: validationError || "Invalid strategy request." }, { status: 400 });
      }
      if (body.riskProfile !== undefined && !["conservative", "balanced", "aggressive"].includes(body.riskProfile)) {
        return Response.json({ error: "riskProfile must be conservative, balanced, or aggressive." }, { status: 400 });
      }

      try {
        const strategyRequest = body as StrategyRequest;
        const userLogin = request.headers.get("x-user-login") || sessionId || "default_trader";
        const etrade = new ETradeService(ctx.getOrm(), ctx.env, userLogin, ctx.requestedEnv);
        const pipeline = new OptionsAgentPipeline(new DynamicOptionsScreener(etrade.client));
        const result = await pipeline.run(strategyRequest, {
          riskProfile: body.riskProfile,
          alternatives: body.alternatives,
        });
        const poolByType = new Map<string, { type: string; label: string; generated: number; bestScore: number }>();
        for (const c of result.strategies.candidates) {
          const e = poolByType.get(c.type) || { type: c.type, label: c.label, generated: 0, bestScore: 0 };
          e.generated += 1;
          e.bestScore = Math.max(e.bestScore, c.score);
          poolByType.set(c.type, e);
        }
        const common = {
          llmInput: describeLlmInput(strategyRequest, body.riskProfile || "balanced", result.snapshot.contracts, result.ranked.slice(0, 20).map((ranked) => ranked.candidate)),
          quantStrategyPool: [...poolByType.values()],
          screen: result.snapshot.screen,
          contracts: result.snapshot.contracts,
          contractRejections: result.snapshot.rejections,
        };

        if (path.endsWith("/trading/options/compare")) {
          const candidates = result.ranked.slice(0, 20);
          try {
            const llm = await rankCandidatesWithLlm(
              ctx.env,
              strategyRequest,
              body.riskProfile || "balanced",
              result.snapshot.contracts,
              candidates.map((ranked) => ranked.candidate),
            );
            return Response.json({
              mode: "same_candidate_ranking",
              quant: {
                ranked: candidates,
                scoreWeights: result.strategies.scoreWeights,
                candidateCount: candidates.length,
              },
              llm: { status: "complete", ...llm },
              ...common,
            });
          } catch (err) {
            return Response.json({
              mode: "same_candidate_ranking",
              quant: {
                ranked: candidates,
                scoreWeights: result.strategies.scoreWeights,
                candidateCount: candidates.length,
              },
              llm: {
                status: "error",
                model: ctx.env.AI_MODEL || DEFAULT_AI_MODEL,
                error: err instanceof Error ? err.message : "LLM ranking failed.",
              },
              ...common,
            });
          }
        }

      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Options candidate generation failed." }, { status: 500 });
      }
    }

    if (path.endsWith("/trading/options/recommend") && request.method === "POST") {
      return handleOptionsStrategyRecommend(request, {
        orm: ctx.getOrm(),
        env: ctx.env,
        sessionKey: sessionId,
        requestedEnv: ctx.requestedEnv,
      });
    }

    // Unified Options Strategy Catalog (Single source of truth: 74 registered strategies & 114 aliases)
    if (path.endsWith("/trading/options/catalog") && request.method === "GET") {
      const list = defaultRegistry.list().map((s) => ({
        id: s.id,
        name: s.label,
        category: s.category,
        description: s.description,
        aliases: s.aliases,
        theses: s.theses,
        usesStock: s.usesStock,
        multiExpiry: s.multiExpiry,
      }));
      return Response.json({
        success: true,
        count: list.length,
        total: list.length,
        strategies: list,
        aliases: REQUESTED_STRATEGY_NAMES,
        demoCalibratedChainsEnabled: isDemoCalibratedChainsEnabled(),
      });
    }

    // Strategy screener (capability 2) and best-trade picker (capability 3) over the options data agent (capability 1)
    // Issue #275: strategy catalog with direction tags (GET).
    if (path.endsWith("/trading/options/catalog") && request.method === "GET") {
      try {
        const strategies = defaultRegistry.list().map((s) => ({
          id: s.id,
          label: s.label,
          category: s.category,
          description: s.description,
          theses: s.theses ?? [],
          aliases: s.aliases ?? [],
        }));
        return Response.json({ count: strategies.length, strategies });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to load catalog" }, { status: 500 });
      }
    }

    if ((path.endsWith("/trading/options/strategies") || path.endsWith("/trading/options/best-trade")) && request.method === "POST") {
      const body = await request.json().catch(() => null) as (Partial<StrategyRequest> & {
        strategyFilter?: StrategyScreenFilter;
        riskProfile?: RiskProfile;
        alternatives?: number;
      }) | null;
      const validationError = validateStrategyRequest(body);
      if (validationError || !body) {
        return Response.json({ error: validationError }, { status: 400 });
      }
      if (body.riskProfile !== undefined && !["conservative", "balanced", "aggressive"].includes(body.riskProfile)) {
        return Response.json({ error: "riskProfile must be conservative, balanced, or aggressive." }, { status: 400 });
      }
      try {
        const userLogin = request.headers.get("x-user-login") || sessionId || "default_trader";
        const etrade = new ETradeService(ctx.getOrm(), ctx.env, userLogin, ctx.requestedEnv);
        const pipeline = new OptionsAgentPipeline(new DynamicOptionsScreener(etrade.client));
        const result = await pipeline.run(body as StrategyRequest, {
          strategyFilter: body.strategyFilter,
          riskProfile: body.riskProfile,
          alternatives: body.alternatives,
        });
        const common = {
          screen: result.snapshot.screen,
          contracts: result.snapshot.contracts,
          contractRejections: result.snapshot.rejections,
          dataSource: result.snapshot.dataSource,
          snapshotError: result.snapshot.validationError,
        };
        if (path.endsWith("/best-trade")) {
          return Response.json({ bestTrade: result.bestTrade, evaluations: result.strategies.evaluations, nameLedger: result.strategies.nameLedger, ...common });
        }
        return Response.json({
          status: result.ranked.length > 0 ? "ranked_candidates" : "no_candidates",
          ranked: result.ranked,
          riskReports: result.riskReports,
          screenedOut: result.screenedOut.slice(0, 50),
          excluded: result.strategies.excluded,
          ...common,
        });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Options strategy pipeline failed" }, { status: 400 });
      }
    }

    if (path.endsWith("/trading/options/screen") && (request.method === "POST" || request.method === "GET")) {
      let filter: any = {};
      try {
        if (request.method === "POST") {
          filter = (await request.json().catch(() => ({}))) as any;
        } else {
          // Parse GET query params
          filter = {
            sector: url.searchParams.get("sector") || undefined,
            contractType: url.searchParams.get("contractType") || undefined,
            minDelta: url.searchParams.get("minDelta") ? Number(url.searchParams.get("minDelta")) : undefined,
            maxDelta: url.searchParams.get("maxDelta") ? Number(url.searchParams.get("maxDelta")) : undefined,
            minGamma: url.searchParams.get("minGamma") ? Number(url.searchParams.get("minGamma")) : undefined,
            maxGamma: url.searchParams.get("maxGamma") ? Number(url.searchParams.get("maxGamma")) : undefined,
            minTheta: url.searchParams.get("minTheta") ? Number(url.searchParams.get("minTheta")) : undefined,
            maxTheta: url.searchParams.get("maxTheta") ? Number(url.searchParams.get("maxTheta")) : undefined,
            minImpliedVolatility: url.searchParams.get("minIv") ? Number(url.searchParams.get("minIv")) : undefined,
            maxImpliedVolatility: url.searchParams.get("maxIv") ? Number(url.searchParams.get("maxIv")) : undefined,
            minVolume: url.searchParams.get("minVolume") ? Number(url.searchParams.get("minVolume")) : undefined,
            minOpenInterest: url.searchParams.get("minOi") ? Number(url.searchParams.get("minOi")) : undefined,
            maxSpreadPct: url.searchParams.get("maxSpreadPct") ? Number(url.searchParams.get("maxSpreadPct")) : undefined,
            maxQuoteAgeSeconds: url.searchParams.get("maxQuoteAgeSeconds") ? Number(url.searchParams.get("maxQuoteAgeSeconds")) : undefined,
            minDte: url.searchParams.get("minDte") ? Number(url.searchParams.get("minDte")) : undefined,
            maxDte: url.searchParams.get("maxDte") ? Number(url.searchParams.get("maxDte")) : undefined,
            moneyness: url.searchParams.get("moneyness") || undefined,
            underlyingSymbols: url.searchParams.get("symbols") ? url.searchParams.get("symbols")!.split(",").map((s) => s.trim()) : undefined,
            maxUnderlyings: url.searchParams.get("maxUnderlyings") ? Number(url.searchParams.get("maxUnderlyings")) : undefined,
            limit: url.searchParams.get("limit") ? Number(url.searchParams.get("limit")) : undefined,
          };
        }

        const userLogin = request.headers.get("x-user-login") || sessionId || "default_trader";
        const etrade = new ETradeService(ctx.getOrm(), ctx.env, userLogin, ctx.requestedEnv);
        const screener = new DynamicOptionsScreener(etrade.client);
        let result = await screener.screenOptions(filter);

        // Demo-mode fallback (issue #65): generated chains may substitute for an
        // empty live screen ONLY in dev/demo deployments with the gate enabled,
        // and the result is stamped dataSource "calibrated-demo". Production is
        // live-only: an empty live screen returns empty, with its fetch errors.
        if (result.contracts.length === 0 && isDemoCalibratedChainsEnabled() && filter.underlyingSymbols && filter.underlyingSymbols.length > 0 && filter.underlyingSymbols[0] !== "BROKEN") {
          const fallbackChains = buildCalibratedOptionChains(filter.underlyingSymbols, filter.minDte ?? 0, filter.maxDte ?? 90);
          if (fallbackChains.length > 0) {
            const chainItems = fallbackChains.map((c) => ({ symbol: c.symbol, chain: c }));
            const fallbackResult = screener.evaluateChains(chainItems, filter, filter.underlyingSymbols.length, {
              warnings: ["Calibrated demo chains — generated data for development/demo, not live market data."],
            });
            if (fallbackResult.contracts.length > 0) {
              fallbackResult.dataSource = "calibrated-demo";
              result = fallbackResult;
            }
          }
        }
        if (result.dataSource === undefined) result.dataSource = "live";

        // Issue #294/#421/#423/#424 (PR #432): manual screens honor pushToSlack
        // — PDF generated, stored per-run, delivered via the Slack A2A path
        // with a reportUrl; failures notify too.
        let optionsReportUrl: string | undefined;
        let optionsPdfKey: string | undefined;
        let pdfBytes: Uint8Array | undefined;
        let fileName: string | undefined;

        try {
          const { generatePdfAssetWithBytes } = await import("../report-asset-agent");
          const asset = await generatePdfAssetWithBytes(ctx.env, userLogin, "options", result);
          if (asset) {
            pdfBytes = asset.bytes;
            fileName = asset.fileName;
            optionsPdfKey = asset.key;
          } else {
            const { generateOptionsPdf, optionsPdfFileName } = await import("../../trading");
            pdfBytes = await generateOptionsPdf(result);
            fileName = optionsPdfFileName(result);
            optionsPdfKey = `options:pdf:${fileName}`;
          }
          if (pdfBytes && fileName) {
            const screenerAgent = ctx.getScreenerAgent(userLogin);
            let binary = "";
            for (let i = 0; i < pdfBytes.length; i += 8192) binary += String.fromCharCode(...pdfBytes.subarray(i, i + 8192));
            const storedKey = await screenerAgent.storeOptionsPdf(btoa(binary), fileName);
            if (!optionsPdfKey) optionsPdfKey = storedKey;
            optionsReportUrl = `/api/options/report.pdf?key=${encodeURIComponent(optionsPdfKey)}`;
          }
        } catch (pdfErr) {
          console.warn("[Orchestrator] Manual options contract PDF generation failed:", pdfErr instanceof Error ? pdfErr.message : String(pdfErr));
        }

        // Deliver over A2A to Slack channel unless caller explicitly opted out
        const shouldNotifySlack = filter.pushToSlack !== false && filter.pushToSlack !== "false";
        if (shouldNotifySlack) {
          const slackChannel = filter.slackChannel || (ctx.env as any).SCREENER_SLACK_CHANNEL || (ctx.env as any).SLACK_CHANNEL;
          const summary = `📊 Options Contract Screen — ${(filter.underlyingSymbols || []).join(", ") || filter.universe || "selected underlyings"}\n${result.totalUnderlyingsScanned} underlyings scanned · ${result.totalContractsEvaluated} contracts evaluated · ${result.matchedCount} matched.\n${result.filterSummary || ""}`;
          try {
            const sent = await deliverScreenerToSlackA2A(ctx.env, {
              text: summary,
              channel: slackChannel,
              ...(pdfBytes && fileName ? {
                pdf: {
                  bytes: pdfBytes,
                  fileName,
                  title: `Options Contract Screen — ${new Date().toISOString().slice(0, 10)}`,
                  comment: `📄 Options contract screener PDF\n\n${summary}`,
                },
              } : {}),
            });
            if (!sent.ok) console.warn("[Orchestrator] Slack A2A options contract PDF delivery failed:", sent.error);
          } catch (slackErr) {
            console.warn("[Orchestrator] Slack A2A options delivery error:", slackErr instanceof Error ? slackErr.message : String(slackErr));
          }
        }

        const generatedAt = new Date().toISOString();
        const generationId = `options_scanner:manual:${generatedAt}`;
        ctx.getOrm().storeCanonicalReport({
          runId: generationId,
          generationId,
          title: `Options contract screen — ${(filter.underlyingSymbols || []).join(", ") || filter.universe || "selected underlyings"}`,
          source: "options_scanner",
          summary: `${result.totalUnderlyingsScanned} underlyings scanned, ${result.totalContractsEvaluated} contracts evaluated, ${result.matchedCount} matched.`,
          body: { generatedAt, filter, result, pdfKey: optionsPdfKey, reportUrl: optionsReportUrl },
          createdAt: generatedAt,
        });

        return Response.json({ ...result, pdfKey: optionsPdfKey, reportUrl: optionsReportUrl });
      } catch (err) {
        const error = err instanceof Error ? err.message : "Options screening failed";
        if (filter.pushToSlack === true || filter.pushToSlack === "true" || filter.pushToSlack === "1") {
          const sent = await deliverScreenerToSlackA2A(ctx.env, {
            channel: filter.slackChannel || (ctx.env as any).SCREENER_SLACK_CHANNEL,
            text: `⚠️ Options Contract Screen FAILED — ${(filter.underlyingSymbols || []).join(", ") || filter.universe || "selected underlyings"}\nError: ${error}`,
          });
          if (!sent.ok) console.warn("[Orchestrator] Slack A2A options contract failure notification failed:", sent.error);
        }
        return Response.json({ error }, { status: 500 });
      }
    }

    // Omnichannel Unified Options Intelligence Endpoint
    if (path.endsWith("/trading/options/unified") && (request.method === "POST" || request.method === "GET")) {
      try {
        let reqData: any = {};
        if (request.method === "POST") {
          reqData = (await request.json().catch(() => ({}))) as any;
        } else {
          reqData = {
            action: url.searchParams.get("action") || "screen",
            symbol: url.searchParams.get("symbol") || undefined,
            symbols: url.searchParams.get("symbols") ? url.searchParams.get("symbols")!.split(",").map((s) => s.trim()) : undefined,
            thesis: url.searchParams.get("thesis") || undefined,
            targetPrice: url.searchParams.get("targetPrice") ? Number(url.searchParams.get("targetPrice")) : undefined,
            riskProfile: url.searchParams.get("riskProfile") || undefined,
            channel: url.searchParams.get("channel") || "ui",
            limit: url.searchParams.get("limit") ? Number(url.searchParams.get("limit")) : undefined,
          };
        }

        const userLogin = request.headers.get("x-user-login") || sessionId || "default_trader";
        const service = new UnifiedOptionsService(ctx.env, userLogin, ctx.requestedEnv, ctx.getOrm(), new SqlScanRunStore(ctx.agentCtx.storage.sql), new SqlStrategyProfileStore(ctx.agentCtx.storage.sql));
        const result = await service.execute(reqData);

        let reportUrl: string | undefined;
        let pdfKey: string | undefined;
        let scannerPdfBytes: Uint8Array | undefined;
        let scannerPdfFileName: string | undefined;

        if (reqData.action === "opportunities" && result.success) {
          const timestamp = new Date().toISOString();
          try {
            const { generatePdfAssetWithBytes } = await import("../report-asset-agent");
            const asset = await generatePdfAssetWithBytes(ctx.env, userLogin, "options", result.data);
            if (asset) {
              scannerPdfBytes = asset.bytes;
              scannerPdfFileName = asset.fileName;
              pdfKey = asset.key;
            } else {
              const { generateOptionsPdf, optionsPdfFileName } = await import("../../trading");
              scannerPdfBytes = await generateOptionsPdf(result.data);
              scannerPdfFileName = optionsPdfFileName(result.data);
              pdfKey = `options:pdf:${scannerPdfFileName}`;
            }
            if (scannerPdfBytes && scannerPdfFileName) {
              const screenerAgent = ctx.getScreenerAgent(userLogin);
              let binary = "";
              for (let i = 0; i < scannerPdfBytes.length; i += 8192) binary += String.fromCharCode(...scannerPdfBytes.subarray(i, i + 8192));
              const storedKey = await screenerAgent.storeOptionsPdf(btoa(binary), scannerPdfFileName);
              if (!pdfKey) pdfKey = storedKey;
              reportUrl = `/api/options/report.pdf?key=${encodeURIComponent(pdfKey)}`;
            }
          } catch (pdfErr) {
            console.warn("[Orchestrator] Manual options PDF generation failed:", pdfErr instanceof Error ? pdfErr.message : String(pdfErr));
          }

          const shouldNotifySlack = reqData.pushToSlack !== false && reqData.pushToSlack !== "false";
          if (shouldNotifySlack) {
            const slackChannel = reqData.slackChannel || (ctx.env as any).SCREENER_SLACK_CHANNEL || (ctx.env as any).SLACK_CHANNEL;
            try {
              const slackPayload = result.toSlack();
              const text = typeof slackPayload === "string" ? slackPayload : slackPayload.text || JSON.stringify(slackPayload);
              const matchCount = result.data?.opportunities?.length ?? result.data?.matchedCount ?? 0;
              const sent = await deliverScreenerToSlackA2A(ctx.env, {
                text,
                channel: slackChannel,
                ...(scannerPdfBytes && scannerPdfFileName ? {
                  pdf: {
                    bytes: scannerPdfBytes,
                    fileName: scannerPdfFileName,
                    title: `Options Scanner Report — manual ${timestamp.slice(0, 10)}`,
                    comment: `📄 Manual options scan PDF — ${matchCount} matches\n\n${text}`,
                  },
                } : {}),
              });
              if (!sent.ok) console.warn("[Orchestrator] Slack A2A PDF delivery (manual options) failed:", sent.error);
            } catch (slackErr) {
              console.warn("[Orchestrator] Slack notification (manual options) error:", slackErr instanceof Error ? slackErr.message : String(slackErr));
            }
          }

          const generatedAt = timestamp;
          const generationId = `options_scanner:${generatedAt}:${reqData.thesis || "mixed"}`;
          ctx.getOrm().storeCanonicalReport({
            runId: generationId,
            generationId,
            title: `Options scanner — ${reqData.thesis || "mixed"} (${generatedAt.slice(0, 10)})`,
            source: "options_scanner",
            summary: result.summary,
            body: { generatedAt, request: reqData, report: result.toWebhook(), pdfKey, reportUrl },
            createdAt: generatedAt,
          });
        } else if (!result.success && reqData.pushToSlack !== false && reqData.pushToSlack !== "false") {
          const slackChannel = reqData.slackChannel || (ctx.env as any).SCREENER_SLACK_CHANNEL || (ctx.env as any).SLACK_CHANNEL;
          const slackPayload = result.toSlack();
          const text = typeof slackPayload === "string" ? slackPayload : slackPayload.text || JSON.stringify(slackPayload);
          const sent = await deliverScreenerToSlackA2A(ctx.env, { text, channel: slackChannel });
          if (!sent.ok) console.warn("[Orchestrator] Slack A2A notification (manual options failed) error:", sent.error);
        }

        const channel = reqData.channel || "ui";
        if (channel === "slack") {
          return Response.json(result.toSlack());
        }
        if (channel === "email") {
          return Response.json({ html: result.toEmailHtml(), text: result.toEmailText(), summary: result.summary });
        }
        if (channel === "voice") {
          return Response.json(result.toVoice());
        }
        if (channel === "webhook") {
          return Response.json({ ...result.toWebhook(), reportUrl });
        }
        if (channel === "mcp") {
          return Response.json(result.toMcp());
        }
        return Response.json({ ...result.toUi(), reportUrl });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Unified options query failed" }, { status: 500 });
      }
    }

    // Dynamic ETAPI Options Configuration & Tuning Endpoint
    if (path.endsWith("/trading/options/config") && (request.method === "POST" || request.method === "GET")) {
      try {
        if (request.method === "POST") {
          const body = (await request.json().catch(() => ({}))) as any;
          if (body.reset) {
            setRuntimeEtapiConfigOverrides(null);
          } else if (body.overrides) {
            setRuntimeEtapiConfigOverrides(body.overrides);
          }
          return Response.json({
            success: true,
            environment: ctx.requestedEnv,
            config: getEtapiConfig(ctx.env, ctx.requestedEnv),
            message: body.reset ? "Reset configuration to environment defaults" : "Runtime configuration overrides applied",
          });
        }
        return Response.json({
          success: true,
          environment: ctx.requestedEnv,
          config: getEtapiConfig(ctx.env, ctx.requestedEnv),
        });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to access options configuration" }, { status: 500 });
      }
    }

    // Issue #653: strategy candidate review endpoints.
    if (path.endsWith("/options/strategy-reviews") && request.method === "GET") {
      try {
        const { listStrategyReviews } = await import("../../services/strategyReviews");
        const decision = url.searchParams.get("decision") || undefined;
        return Response.json({ reviews: listStrategyReviews(ctx.getOrm(), decision) });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to list reviews" }, { status: 500 });
      }
    }
    if (path.endsWith("/options/strategy-reviews/decide") && request.method === "POST") {
      try {
        const { decideStrategyReview } = await import("../../services/strategyReviews");
        const body = (await request.json().catch(() => ({}))) as any;
        const { id, decision } = body;
        if (!id || (decision !== "approved" && decision !== "rejected")) {
          return Response.json({ error: "id and decision (approved|rejected) required" }, { status: 400 });
        }
        const ok = decideStrategyReview(ctx.getOrm(), id, decision);
        return Response.json({ success: ok });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to record decision" }, { status: 500 });
      }
    }

  return null;
}
