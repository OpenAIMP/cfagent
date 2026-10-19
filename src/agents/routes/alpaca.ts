/**
 * Issue #359-13: alpaca routes extracted from
 * OrchestratorAgent.routeRequest (src/agents/orchestrator.ts). Pure move -
 * no behavior change.
 *
 * Owns the alpaca-named route blocks in two groups (invoked at their exact
 * original positions in routeRequest's sequential matching sequence):
 *
 * Group 1 (after the watchlists delegation): the "Alpaca Trading API v2
 * Endpoints" section —
 *   POST        /trading/alpaca/order
 *   GET         /trading/alpaca/account
 *   GET         /trading/alpaca/positions
 *   GET         /trading/alpaca/orders
 *
 * Group 2 (between the /foss/research block and the /foss/compare block):
 * the alpaca-named FOSS routes (the non-alpaca /foss/quote, /foss/fundamentals,
 * /foss/bars, /foss/research and /foss/compare blocks moved to slice
 * #359-14's foss research module — src/agents/routes/fossResearch.ts) —
 *   GET         /foss/snapshot
 *   GET         /foss/alpaca/account
 *   GET         /foss/alpaca/positions
 *   GET         /foss/alpaca/orders
 *   POST        /foss/alpaca/order
 *
 * Every handler ends with an explicit `return null` - never undefined.
 *
 * Handlers that used OrchestratorAgent state receive it via the explicit
 * AlpacaRouteContext parameter; there are no new globals and no
 * back-references into the class. Audit events stay funneled through the
 * single-owner recordAudit() via ctx.audit (no behavior change to audit
 * semantics). Alpaca credential handling is byte-identical — the module
 * constructs FossResearchService exactly as the inline blocks did.
 */

import { FossResearchService } from "../../services/fossResearch";
import type { AgentName, Env } from "../../types";

/** The subset of OrchestratorAgent surface the alpaca handlers need. */
export interface AlpacaRouteContext {
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
 * Alpaca Trading API v2 Endpoints. Invoked from routeRequest at the exact position the original blocks occupied (after the watchlists delegation); returns a Response when one of the /trading/alpaca paths matches, or null to continue sequential matching.
 */
export async function handleAlpacaTradingRoutes(
  request: Request,
  url: URL,
  path: string,
  sessionId: string,
  ctx: AlpacaRouteContext
): Promise<Response | null> {
  // ==========================================
  // Alpaca Trading API v2 Endpoints
  // ==========================================

  // Place Alpaca Live / Paper Order
  if (path.endsWith("/trading/alpaca/order") && request.method === "POST") {
    try {
      const body = (await request.json().catch(() => ({}))) as any;
      const symbol = (body.symbol || "").trim();
      const qty = Number(body.qty) || 1;
      const side = (body.side || "buy").toLowerCase() as "buy" | "sell";
      const type = body.type || "market";
      const limit_price = body.limit_price !== undefined ? Number(body.limit_price) : undefined;
      const time_in_force = body.time_in_force || "day";

      if (!symbol) {
        return Response.json({ error: "Stock symbol is required" }, { status: 400 });
      }

      const foss = new FossResearchService(ctx.env);
      const orderResult = await foss.placeAlpacaOrder({
        symbol,
        qty,
        side,
        type,
        limit_price,
        time_in_force,
      });

      ctx.audit("alpaca.order_placed", "trading", { symbol, qty, side, status: orderResult.status });
      return Response.json(orderResult);
    } catch (err: any) {
      return Response.json({ error: err.message || "Failed to place Alpaca order" }, { status: 500 });
    }
  }

  // Get Alpaca Account & Buying Power
  if (path.endsWith("/trading/alpaca/account") && request.method === "GET") {
    try {
      const foss = new FossResearchService(ctx.env);
      const account = await foss.getAlpacaAccount();
      return Response.json(account);
    } catch (err: any) {
      return Response.json({ error: err.message || "Failed to fetch Alpaca account" }, { status: 500 });
    }
  }

  // Get Alpaca Open Positions
  if (path.endsWith("/trading/alpaca/positions") && request.method === "GET") {
    try {
      const foss = new FossResearchService(ctx.env);
      const positions = await foss.getAlpacaPositions();
      return Response.json(positions);
    } catch (err: any) {
      return Response.json({ error: err.message || "Failed to fetch Alpaca positions" }, { status: 500 });
    }
  }

  // Get Alpaca Orders List
  if (path.endsWith("/trading/alpaca/orders") && request.method === "GET") {
    try {
      const status = (url.searchParams.get("status") || "open") as any;
      const foss = new FossResearchService(ctx.env);
      const orders = await foss.getAlpacaOrders(status);
      return Response.json(orders);
    } catch (err: any) {
      return Response.json({ error: err.message || "Failed to fetch Alpaca orders" }, { status: 500 });
    }
  }

  return null;
}
/**
 * Alpaca-named FOSS routes. Invoked from routeRequest at the exact position the original blocks occupied (between /foss/research and /foss/compare); returns a Response when one of the alpaca foss paths matches, or null to continue sequential matching.
 */
export async function handleAlpacaFossRoutes(
  request: Request,
  url: URL,
  path: string,
  sessionId: string,
  ctx: AlpacaRouteContext
): Promise<Response | null> {
  // Alpaca real-time market snapshot & NBBO spread
  if (path.endsWith("/foss/snapshot") && request.method === "GET") {
    try {
      const symbol = url.searchParams.get("symbol") || "NVDA";
      const foss = new FossResearchService(ctx.env);
      const snapshot = await foss.getAlpacaSnapshot(symbol);
      ctx.audit("alpaca.snapshot_queried", "trading", {
        symbol,
        price: snapshot.latestTrade?.price,
        bid: snapshot.latestQuote?.bidPrice,
        ask: snapshot.latestQuote?.askPrice,
        assetClass: snapshot.assetClass,
      });
      return Response.json(snapshot);
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Failed to fetch Alpaca market snapshot" }, { status: 500 });
    }
  }

  // Alpaca Trading v2: Account Status & Balance with Agentic Tracing
  if (path.endsWith("/foss/alpaca/account") && request.method === "GET") {
    try {
      const foss = new FossResearchService(ctx.env);
      const result = await foss.getAlpacaAccount();
      ctx.audit("alpaca.account_queried", "trading", {
        success: result.success,
        accountId: result.account?.id,
        buyingPower: result.account?.buying_power,
        portfolioValue: result.account?.portfolio_value,
      });
      return Response.json(result);
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Failed to fetch Alpaca account" }, { status: 500 });
    }
  }

  // Alpaca Trading v2: Portfolio Positions with Agentic Tracing
  if (path.endsWith("/foss/alpaca/positions") && request.method === "GET") {
    try {
      const foss = new FossResearchService(ctx.env);
      const result = await foss.getAlpacaPositions();
      ctx.audit("alpaca.positions_queried", "trading", {
        success: result.success,
        count: result.positions?.length || 0,
        symbols: result.positions?.map((p: any) => p.symbol) || [],
      });
      return Response.json(result);
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Failed to fetch Alpaca positions" }, { status: 500 });
    }
  }

  // Alpaca Trading v2: Order History Ledger with Agentic Tracing
  if (path.endsWith("/foss/alpaca/orders") && request.method === "GET") {
    try {
      const status = (url.searchParams.get("status") || "open") as "open" | "closed" | "all";
      const foss = new FossResearchService(ctx.env);
      const result = await foss.getAlpacaOrders(status);
      ctx.audit("alpaca.orders_queried", "trading", {
        status,
        count: result.orders?.length || 0,
      });
      return Response.json(result);
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Failed to fetch Alpaca orders" }, { status: 500 });
    }
  }

  // Alpaca Trading v2: Place Order with Agent DID Attestation & Agentic Tracing
  if (path.endsWith("/foss/alpaca/order") && request.method === "POST") {
    try {
      const body = (await request.json().catch(() => ({}))) as any;
      const symbol = (body.symbol || "").toUpperCase().trim();
      const qty = Number(body.qty || body.quantity || 1);
      const side = (body.side || body.orderAction || "buy").toLowerCase() as "buy" | "sell";
      const type = (body.type || body.orderType || "market").toLowerCase() as any;
      const limit_price = body.limit_price || body.limitPrice ? Number(body.limit_price || body.limitPrice) : undefined;
      const time_in_force = body.time_in_force || "day";

      if (!symbol) {
        return Response.json({ error: "Symbol is required" }, { status: 400 });
      }

      const foss = new FossResearchService(ctx.env);
      const result = await foss.placeAlpacaOrder({
        symbol,
        qty,
        side,
        type,
        limit_price,
        time_in_force,
      });

      ctx.audit("alpaca.order_placed", "trading", {
        symbol,
        qty,
        side,
        type,
        limitPrice: limit_price,
        orderId: result.orderId,
        status: result.status,
        success: result.success,
      });

      return Response.json(result);
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Failed to place Alpaca order" }, { status: 500 });
    }
  }
  return null;
}
