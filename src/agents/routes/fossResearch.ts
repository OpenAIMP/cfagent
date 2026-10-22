/**
 * Issue #359-14: foss research routes extracted from
 * OrchestratorAgent.routeRequest (src/agents/orchestrator.ts). Pure move -
 * no behavior change.
 *
 * Owns the non-alpaca FOSS market research & quoting routes in two groups
 * (invoked at their exact original positions in routeRequest's sequential
 * matching sequence):
 *
 * Group 1 (before the slice #359-13 handleAlpacaFossRoutes delegation):
 *   GET         /foss/quote
 *   GET         /foss/fundamentals
 *   GET         /foss/bars
 *   GET         /foss/research
 *
 * Group 2 (after the slice #359-13 handleAlpacaFossRoutes delegation):
 *   POST|GET    /foss/compare
 *   GET         /foss/providers
 *   POST|GET    /foss/screen, /yfinance/screen
 *
 * The alpaca-named FOSS routes (/foss/snapshot, /foss/alpaca/*) stay owned
 * by slice #359-13's handleAlpacaFossRoutes - this module never handles
 * them.
 *
 * Every handler ends with an explicit `return null` - never undefined.
 *
 * Handlers that used OrchestratorAgent state receive it via the explicit
 * FossResearchRouteContext parameter; there are no new globals and no
 * back-references into the class. Audit events stay funneled through the
 * single-owner recordAudit() via ctx.audit (no behavior change to audit
 * semantics). The canonical-report seam (#308) is untouched - these route
 * blocks never called the store seam directly; generateResearchReport
 * carries its own persistence inside the service.
 */

import { FossResearchService, fossBarsSourceLabel } from "../../services/fossResearch";
import { parseStockScreenRequest } from "../../trading";
import { YFinanceMarketScreener } from "../../trading";
import type { AgentName, Env } from "../../types";

/** The subset of OrchestratorAgent surface the foss research handlers need. */
export interface FossResearchRouteContext {
  /** Worker environment (owner: OrchestratorAgent - was `ctx.env`). */
  env: Env;
  /** Single-owner audit funnel (owner: OrchestratorAgent.recordAudit - was `this.audit`). */
  audit(
    type: string,
    agent: AgentName | "judge" | "nlq" | "orchestrator",
    payload: Record<string, unknown>
  ): void;
}

/**
 * Non-alpaca FOSS market research & quoting routes (quote, fundamentals,
 * bars, research). Invoked from routeRequest at the exact position the
 * original blocks occupied (before the handleAlpacaFossRoutes delegation);
 * returns a Response when one of the owned paths matches, or null to
 * continue sequential matching.
 */
export async function handleFossQuoteResearchRoutes(
  request: Request,
  url: URL,
  path: string,
  sessionId: string,
  ctx: FossResearchRouteContext
): Promise<Response | null> {
  // Real-time quote (Yahoo Finance, Alpaca, or Hybrid)
  if (path.endsWith("/foss/quote") && request.method === "GET") {
    try {
      const symbol = url.searchParams.get("symbol") || "NVDA";
      const provider = (url.searchParams.get("provider") || "hybrid") as any;
      const foss = new FossResearchService(ctx.env);
      const quote = await foss.getQuote(symbol, provider);
      return Response.json(quote);
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Failed to fetch FOSS quote" }, { status: 500 });
    }
  }

  // Company fundamentals & valuation metrics (yfinance)
  if (path.endsWith("/foss/fundamentals") && request.method === "GET") {
    try {
      const symbol = url.searchParams.get("symbol") || "NVDA";
      const foss = new FossResearchService(ctx.env);
      const fundamentals = await foss.getFundamentals(symbol);
      return Response.json(fundamentals);
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Failed to fetch fundamentals" }, { status: 500 });
    }
  }

  // Historical OHLCV bars (yfinance / Alpaca)
  if (path.endsWith("/foss/bars") && request.method === "GET") {
    try {
      const symbol = url.searchParams.get("symbol") || "NVDA";
      const timeframe = url.searchParams.get("timeframe") || "1D";
      const limit = Number(url.searchParams.get("limit") || "30");
      const provider = (url.searchParams.get("provider") || "yfinance") as "yfinance" | "alpaca" | "hybrid";
      const foss = new FossResearchService(ctx.env);
      const bars = await foss.getHistoricalBars(symbol, timeframe, limit, provider);
      // Issue #117: `source` is stamped from the bars' actual provenance —
      // a provider API name only when the bars were really fetched live;
      // generated/static fallback bars are labelled as such, and the
      // provenance rides in the response alongside the per-bar fields.
      const provenance = bars[0]?.provenance ?? "generated";
      return Response.json({
        symbol: symbol.toUpperCase(),
        provider,
        timeframe,
        count: bars.length,
        bars,
        provenance,
        source: fossBarsSourceLabel(provider, provenance),
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Failed to fetch historical bars" }, { status: 500 });
    }
  }

  // Comprehensive equity research report with Agent DID stamp
  if (path.endsWith("/foss/research") && request.method === "GET") {
    try {
      const symbol = url.searchParams.get("symbol") || "NVDA";
      const foss = new FossResearchService(ctx.env);
      const report = await foss.generateResearchReport(symbol);
      ctx.audit("foss.research_generated", "research", { symbol, rating: report.analystRating, did: report.agentAttestation.did, provenance: report.provenance });
      return Response.json(report);
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Failed to generate research report" }, { status: 500 });
    }
  }

  return null;
}

/**
 * Non-alpaca FOSS comparison, provider status, and screening routes.
 * Invoked from routeRequest at the exact position the original blocks
 * occupied (after the handleAlpacaFossRoutes delegation); returns a
 * Response when one of the owned paths matches, or null to continue
 * sequential matching.
 */
export async function handleFossCompareScreenRoutes(
  request: Request,
  url: URL,
  path: string,
  sessionId: string,
  ctx: FossResearchRouteContext
): Promise<Response | null> {
  // Multi-ticker valuation comparison
  if (path.endsWith("/foss/compare") && (request.method === "POST" || request.method === "GET")) {
    try {
      let symbols = ["NVDA", "AAPL", "MSFT"];
      if (request.method === "POST") {
        const body = (await request.json().catch(() => ({}))) as any;
        if (Array.isArray(body.symbols) && body.symbols.length > 0) {
          symbols = body.symbols;
        }
      } else {
        const symParam = url.searchParams.get("symbols");
        if (symParam) symbols = symParam.split(",").map(s => s.trim());
      }
      const foss = new FossResearchService(ctx.env);
      const comparison = await foss.compareStocks(symbols);
      return Response.json({ count: comparison.length, comparison });
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Failed to compare stocks" }, { status: 500 });
    }
  }

  // FOSS provider statuses (Yahoo Finance + Alpaca)
  if (path.endsWith("/foss/providers") && request.method === "GET") {
    try {
      const foss = new FossResearchService(ctx.env);
      const statuses = foss.getProviderStatuses();
      return Response.json({ providers: statuses });
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Failed to fetch FOSS providers" }, { status: 500 });
    }
  }

  // Dedicated Yahoo Finance (FOSS) Market Screener
  if ((path.endsWith("/foss/screen") || path.endsWith("/yfinance/screen")) && (request.method === "POST" || request.method === "GET")) {
    try {
      const filters = request.method === "POST" ? ((await request.json().catch(() => ({}))) as any) : {};
      if (request.method === "GET") {
        if (url.searchParams.get("sector")) filters.sector = url.searchParams.get("sector");
        if (url.searchParams.get("search")) filters.search = url.searchParams.get("search");
        if (url.searchParams.get("maxRsi")) filters.maxRsi = Number(url.searchParams.get("maxRsi"));
        if (url.searchParams.get("minRsi")) filters.minRsi = Number(url.searchParams.get("minRsi"));
        if (url.searchParams.get("maxPeRatio")) filters.maxPeRatio = Number(url.searchParams.get("maxPeRatio"));
        if (url.searchParams.get("gainersOnly")) filters.gainersOnly = url.searchParams.get("gainersOnly") === "true";
        if (url.searchParams.get("losersOnly")) filters.losersOnly = url.searchParams.get("losersOnly") === "true";
      }
      // Issue #959: the FOSS screen takes the same StockScreenerFilter
      // shape as the E*TRADE screen — validate through the ONE shared
      // stock-screen schema (the universe/minScore envelope fields are
      // accepted and split out; this engine never read them).
      const parsedScreen = parseStockScreenRequest(filters);
      if (!parsedScreen.ok) {
        return Response.json({ error: parsedScreen.error }, { status: 400 });
      }
      const screener = new YFinanceMarketScreener();
      const results = await screener.screenMarkets(parsedScreen.value.filters);
      ctx.audit("foss.screener.executed", "research", { filterSummary: results.filterSummary, count: results.stocks.length });
      return Response.json({
        ...results,
        results: results.stocks,
        stocks: results.stocks,
      });
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Failed to run Yahoo Finance screener" }, { status: 500 });
    }
  }

  return null;
}
