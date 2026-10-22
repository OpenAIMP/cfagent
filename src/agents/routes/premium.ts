/**
 * Issue #359-08: premium paid-trading routes extracted from OrchestratorAgent.routeRequest
 * (src/agents/orchestrator.ts). Pure move - no behavior change.
 *
 * Owns the Paid Trading Service blocks:
 * /premium/options-scan (Institutional Options & Greeks Screener, $0.05 USDC),
 * /premium/market-research (Autonomous Equity Research Report, $0.10 USDC),
 * /premium/stock-signals (Real-Time Quantitative Anomaly Signals, $0.02 USDC).
 * Each is a payment-gated endpoint (ETradeAgenticPaymentService.handleGatedEndpoint)
 * matching `path.includes("/premium/...")` for GET and POST.
 * The three blocks were contiguous in routeRequest (between the Cloudflare
 * Agentic Payments block and the Environment & E*TRADE Trading APIs block),
 * so this module exports ONE handler invoked from routeRequest at the EXACT
 * position the original blocks occupied in the sequential matching sequence.
 * It returns a Response when one of its paths matches, or null when none
 * does - matching order relative to all other handlers is preserved by the
 * call site.
 *
 * Canonical-copy reporting (#307/#308) is preserved exactly: the options
 * scan stores source "options_scanner", the market research report stores
 * source "research_report" (generation id = sha256 of the report JSON),
 * both inside try/catch so persistence failure cannot break the endpoint.
 *
 * Handlers that used OrchestratorAgent state receive it via the explicit
 * PremiumRouteContext parameter; there are no new globals and no
 * back-references into the class.
 */

import {
  ETradeAgenticPaymentService,
  TRADING_PAID_SERVICES,
  payerScopeId,
} from "../../services/agenticPayments";
import { FossResearchService } from "../../services/fossResearch";
import { UnifiedOptionsService } from "../../trading";
import { parseOptionsScreenRequest } from "../../trading";
import { getCuratedStockBySymbol } from "../../config/curatedStockUniverse";
import type { NasdaqStockListing } from "../../services/nasdaqListings";
import { sha256Hex } from "../../services/scheduledReports";
import type { Env } from "../../types";
import type { DatabaseORM } from "../../orm";
import type { ScreenerAgent } from "../screener-agent";

/** The subset of OrchestratorAgent surface the premium handlers need. */
export interface PremiumRouteContext {
  /** Worker environment (owner: OrchestratorAgent - was `this.env`). */
  env: Env;
  /** ORM accessor (owner: OrchestratorAgent - was `this.getOrm()`). */
  getOrm(): DatabaseORM;
  /** Screener agent (owner: OrchestratorAgent.getScreenerAgent) — issue #1007: premium stock-signals execute through the one stock pipeline via this agent, with the Yahoo data-source adapter as provider. */
  getScreenerAgent(userLogin?: string): ScreenerAgent;
  /** Canonical-copy screener persistence (owner: OrchestratorAgent.persistScreenerReportCanonical) — the REST idiom. */
  persistScreenerReportCanonical(result: {
    timestamp: string;
    universe?: unknown;
    sector?: unknown;
    provider?: unknown;
    success: boolean;
    totalScanned: number;
    matchedCount: number;
    opportunities: unknown[];
    allStocks: unknown[];
    pdfKey?: string;
    error?: string;
    trigger?: unknown;
    userLogin?: string;
  }): void;
}

/**
 * Issue #183: build the payment service for a premium request. The
 * worker (src/server.ts) sets the x-user-login header ONLY from the
 * caller's verified session and strips it for anonymous traffic, which
 * is served by the shared premium-gateway instance. So: header present
 * → session traffic, per-user behaviour unchanged; header absent →
 * anonymous traffic, and the service runs payer-bound so every
 * persisted payment row/event is scoped by the VERIFIED payer
 * (services/agenticPayments.ts payerScopeId), never by an asserted
 * login and never pooled under the gateway instance's identity.
 */
function premiumPaymentService(
  ctx: PremiumRouteContext,
  sessionId: string,
  request: Request
): ETradeAgenticPaymentService {
  const payerBound = !request.headers.get("x-user-login");
  return new ETradeAgenticPaymentService(ctx.getOrm(), ctx.env, sessionId, undefined, { payerBound });
}

/**
 * Handles the premium paid-trading routes. Returns a Response on match,
 * null when no premium path matches (the orchestrator then continues its
 * sequential matching).
 */
export async function handlePremiumRoutes(
  request: Request,
  url: URL,
  path: string,
  sessionId: string,
  ctx: PremiumRouteContext
): Promise<Response | null> {
  // Paid Trading Service: Institutional Options & Greeks Screener ($0.05 USDC)
  if (path.includes("/premium/options-scan") && (request.method === "GET" || request.method === "POST")) {
    const paymentService = premiumPaymentService(ctx, sessionId, request);
    const tier = TRADING_PAID_SERVICES.OPTIONS_SCREENER;

    return paymentService.handleGatedEndpoint(
      request,
      tier.resource,
      tier.priceUSD,
      tier.description,
      async (receipt) => {
        let filter: any = {};
        if (request.method === "POST") {
          filter = (await request.json().catch(() => ({}))) as any;
        } else {
          filter = {
            underlyingSymbols: url.searchParams.get("symbol") ? [url.searchParams.get("symbol")!.toUpperCase().trim()] : undefined,
            maxUnderlyings: url.searchParams.get("maxUnderlyings") ? Number(url.searchParams.get("maxUnderlyings")) : undefined,
            contractType: url.searchParams.get("contractType") || "BOTH",
            minDelta: url.searchParams.get("minDelta") ? Number(url.searchParams.get("minDelta")) : undefined,
            maxDelta: url.searchParams.get("maxDelta") ? Number(url.searchParams.get("maxDelta")) : undefined,
            minVolume: url.searchParams.get("minVolume") ? Number(url.searchParams.get("minVolume")) : undefined,
            minOpenInterest: url.searchParams.get("minOpenInterest") ? Number(url.searchParams.get("minOpenInterest")) : undefined,
            maxSpreadPct: url.searchParams.get("maxSpreadPct") ? Number(url.searchParams.get("maxSpreadPct")) : undefined,
            maxQuoteAgeSeconds: url.searchParams.get("maxQuoteAgeSeconds") ? Number(url.searchParams.get("maxQuoteAgeSeconds")) : undefined,
            minDte: url.searchParams.get("minDte") ? Number(url.searchParams.get("minDte")) : undefined,
            maxDte: url.searchParams.get("maxDte") ? Number(url.searchParams.get("maxDte")) : undefined,
            limit: url.searchParams.get("limit") ? Number(url.searchParams.get("limit")) : undefined,
          };
        }
        // Issue #959: the paid scan takes the same OptionScreenerFilter
        // shape as every other options screen — validate through the
        // ONE shared schema; a mis-shaped filter fails explicitly with
        // the field named (in the endpoint's usual failure shape).
        const parsedPremiumFilter = parseOptionsScreenRequest(filter);
        if (!parsedPremiumFilter.ok) {
          return { success: false, service: tier.name, receipt, error: parsedPremiumFilter.error };
        }
        filter = parsedPremiumFilter.value.filter;
        // Issue #183: the fulfillment identity is the session login
        // (x-user-login, set by the worker from the verified session)
        // for signed-in traffic. For anonymous gateway traffic there is
        // deliberately NO x-user-login — the identity is the VERIFIED
        // payer scope from the payment receipt. That scope is not an app
        // login and holds no stored E*TRADE tokens, so broker access
        // fails honestly ("OAuth Token Missing") instead of running
        // under a caller-asserted login. The previous fallbacks
        // (sessionId, then a shared "premium_subscriber") are gone.
        const userLogin = request.headers.get("x-user-login") || payerScopeId(receipt.payer);
        const rawEnvHdr = (request.headers.get("x-environment") || url.searchParams.get("env") || "").toUpperCase().trim();
        const reqEnvLocal = (rawEnvHdr === "TEST" || rawEnvHdr === "PROD") ? rawEnvHdr : undefined;
        // Issue #982 (screening consolidation S2): the paid scan
        // executes through UnifiedOptionsService — the same service
        // the REST routes call — instead of a route-local engine. The
        // service's screen data IS the screen result this body has
        // always carried; the caller's filter rides through with its
        // symbols/limit lifted onto the request so the effective
        // filter is unchanged. Payment gating above and the canonical
        // persistence below are untouched.
        const service = new UnifiedOptionsService(ctx.env, userLogin, reqEnvLocal, ctx.getOrm());
        const serviceResponse = await service.execute({
          action: "screen",
          channel: "webhook",
          filter,
          symbols: filter.underlyingSymbols,
          limit: filter.limit,
        });
        const result = serviceResponse.data;
        const failed = result.status === "error";
        // Issue #307/#308: store the canonical options-scan report copy
        // (one row per generation) so scans are searchable via AI Search.
        try {
          const timestamp = new Date().toISOString();
          const symbols = Array.isArray(filter?.underlyingSymbols)
            ? filter.underlyingSymbols.join(",")
            : "";
          ctx.getOrm().storeCanonicalReport({
            runId: `options_scanner:${timestamp}`,
            generationId: `options_scanner:${timestamp}`,
            title: `Options scan — ${symbols || "universe"} (${filter?.contractType || "BOTH"})`,
            source: "options_scanner",
            summary: failed
              ? `Options scan failed: ${result.validationError || result.fetchErrors?.[0]?.reason || "upstream error"}.`
              : `Options scan completed for ${symbols || "the default universe"} (thesis: ${filter?.contractType || "BOTH"}).`,
            body: { filter, result, failed },
            createdAt: timestamp,
          });
        } catch {
          // Non-critical: persistence failure must not break the scan.
        }
        return {
          success: !failed,
          service: tier.name,
          receipt,
          screenResult: result,
          ...(failed
            ? {
                error:
                  result.validationError ||
                  result.fetchErrors?.[0]?.reason ||
                  "Options screen failed upstream; no data could be fetched.",
              }
            : {}),
        };
      }
    );
  }

  // Paid Trading Service: Autonomous Equity Research Report ($0.10 USDC)
  if (path.includes("/premium/market-research") && (request.method === "GET" || request.method === "POST")) {
    const paymentService = premiumPaymentService(ctx, sessionId, request);
    const tier = TRADING_PAID_SERVICES.MARKET_RESEARCH;

    return paymentService.handleGatedEndpoint(
      request,
      tier.resource,
      tier.priceUSD,
      tier.description,
      async (receipt) => {
        let symbol = "NVDA";
        if (request.method === "POST") {
          const body = (await request.json().catch(() => ({}))) as any;
          if (body.symbol) symbol = String(body.symbol).toUpperCase().trim();
        } else {
          const sym = url.searchParams.get("symbol");
          if (sym) symbol = sym.toUpperCase().trim();
        }

        const foss = new FossResearchService(ctx.env);
        const report = await foss.generateResearchReport(symbol);
        // Issue #308: store the canonical copy at generation time (one
        // row per content hash) so the report is searchable via AI Search.
        try {
          const timestamp = new Date().toISOString();
          const reportJson = JSON.stringify(report ?? {});
          const generationId = await sha256Hex(reportJson);
          ctx.getOrm().storeCanonicalReport({
            runId: generationId,
            generationId,
            title: `Market research — ${symbol}`,
            source: "research_report",
            summary: `Equity research report for ${symbol}.`,
            body: report ?? {},
            createdAt: timestamp,
          });
        } catch {
          // Non-critical: persistence failure must not break the report.
        }
        return {
          success: true,
          service: tier.name,
          receipt,
          report,
        };
      }
    );
  }

  // Paid Trading Service: Real-Time Quantitative Anomaly Signals ($0.02 USDC)
  if (path.includes("/premium/stock-signals") && (request.method === "GET" || request.method === "POST")) {
    const paymentService = premiumPaymentService(ctx, sessionId, request);
    const tier = TRADING_PAID_SERVICES.STOCK_SIGNALS;

    return paymentService.handleGatedEndpoint(
      request,
      tier.resource,
      tier.priceUSD,
      tier.description,
      async (receipt) => {
        let symbols = ["NVDA", "AAPL", "MSFT", "TSLA"];
        if (request.method === "POST") {
          const body = (await request.json().catch(() => ({}))) as any;
          if (Array.isArray(body.symbols) && body.symbols.length > 0) symbols = body.symbols;
        } else {
          const sym = url.searchParams.get("symbols") || url.searchParams.get("symbol");
          if (sym) symbols = sym.split(",").map(s => s.trim().toUpperCase());
        }
        symbols = symbols.map((s) => String(s).trim().toUpperCase()).filter(Boolean);

        // Issue #1007 (consolidation S3): the paid signals execute
        // through the ONE stock pipeline — ScreenerAgent with the
        // Yahoo data-source adapter as provider — instead of the
        // retired second FOSS engine. The requested symbols
        // are the run's explicit universe (membership only; prices come
        // from live Yahoo quotes via the adapter). The run stores a
        // canonical report in the REST idiom, like every other stock
        // screen. Identity follows the #183 rule used by the options
        // scan above: session login when present, else the verified
        // payer scope.
        const userLogin = request.headers.get("x-user-login") || payerScopeId(receipt.payer);
        const listings: NasdaqStockListing[] = symbols.map((symbol) => {
          const curated = getCuratedStockBySymbol(symbol);
          return {
            symbol,
            companyName: curated?.companyName || symbol,
            exchange: curated?.exchange || "nasdaq",
            change: 0,
            changePercent: 0,
            sector: curated?.sector,
          };
        });
        const agent = ctx.getScreenerAgent(userLogin);
        let result;
        try {
          result = await agent.runScreen({
            trigger: "manual",
            provider: "yahoo",
            symbols: listings,
            maxSymbols: listings.length,
            maxItems: listings.length,
            filters: {},
            userLogin,
          });
        } catch (screenErr) {
          const error = screenErr instanceof Error ? screenErr.message : String(screenErr);
          if (error.includes("already running")) {
            return { success: false, service: tier.name, receipt, error: "Screen already running; retry shortly.", retryable: true };
          }
          throw screenErr;
        }
        ctx.persistScreenerReportCanonical({ ...result, userLogin });
        if (!result.success) {
          // Honest failure (the options-scan idiom above): Yahoo
          // unavailable fails the fulfillment visibly — no signals are
          // fabricated from another provider or from static data.
          return {
            success: false,
            service: tier.name,
            receipt,
            error: result.error || "Yahoo Finance unavailable; no stock signals could be produced.",
          };
        }
        // Signals are the pipeline's screened rows for the requested
        // symbols (allStocks rows that survived screening; with the
        // empty filter here that is every quoted symbol).
        // `confidence` is pipeline-derived — the screening indicator
        // composite (indicators.screenScore, 0–100) normalized to
        // 0–1. The hard-coded constant this replaces is gone.
        // NOTE (response-shape change, disclosed): the old engine's
        // per-signal `volume` field is not carried on the pipeline's
        // scanned-stock shape, so it is dropped rather than fabricated.
        const signals = result.allStocks
          .filter((stock) => stock.signal !== "unknown")
          .map((stock) => ({
            symbol: stock.symbol,
            price: stock.lastPrice,
            changePercent: stock.changePercent,
            rsi: stock.rsi14 ?? undefined,
            signalType: (stock.rsi14 != null && stock.rsi14 < 35) ? "OVERSOLD_BOUNCE" : (stock.rsi14 != null && stock.rsi14 > 70) ? "OVERBOUGHT_MOMENTUM" : "TREND_CONTINUATION",
            confidence: Number((stock.indicators.screenScore / 100).toFixed(2)),
            timestamp: result.timestamp,
          }));

        return {
          success: true,
          service: tier.name,
          receipt,
          count: signals.length,
          signals,
        };
      }
    );
  }

  return null;
}
