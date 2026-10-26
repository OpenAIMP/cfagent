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
import {
  resolveFossRestSwitch,
  fossSnapshotAudit,
  fossReadsAuditEvent,
  normalizeFossOrderInput,
  fossOrderAuditEvent,
  fossOrderAuditPayload,
} from "../../config/fossModes";

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
  /** #1727: optional session/user carriers for the FOSS switches (run comes from query `?mode=` / body `mode`, global env from `env`). Populated by the execution-context owner; unset carriers fall through to env. See src/config/fossModes.ts. */
  scopedFossModes?: import("../../config/fossModes").FossScopedModes;
}

/** #1727: adapts this module's route context to the fossModes switch host (the ctx audit type is narrower than the host's, so it is wrapped rather than passed through). */
function fossSwitchHost(ctx: AlpacaRouteContext) {
  return {
    scopedFossModes: ctx.scopedFossModes,
    env: ctx.env,
    audit: (type: string, agent: any, payload: Record<string, unknown>) => ctx.audit(type, agent, payload),
  };
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
  // #1727 F05: order mode (run body `mode` > session > user > env >
  // trading legacy). The route's own 400 wording ("Stock symbol is
  // required") and the trading normalization stay the default; foss
  // mode selects /foss normalization + full audit, mcp mode selects
  // verbatim input + alpaca.order.place. No HITL gate exists on this
  // path; the switch changes normalization + audit only.
  if (path.endsWith("/trading/alpaca/order") && request.method === "POST") {
    try {
      const body = (await request.json().catch(() => ({}))) as any;
      const orderMode = resolveFossRestSwitch(fossSwitchHost(ctx), "order", body.mode, "trading");
      const normalized = normalizeFossOrderInput(body, orderMode);

      if (!normalized.symbol || !String(normalized.symbol).trim()) {
        return Response.json({ error: "Stock symbol is required" }, { status: 400 });
      }

      const foss = new FossResearchService(ctx.env);
      const orderResult = await foss.placeAlpacaOrder(normalized);

      ctx.audit(fossOrderAuditEvent(orderMode), "trading", fossOrderAuditPayload(orderMode, normalized, orderResult));
      return Response.json(orderResult);
    } catch (err: any) {
      return Response.json({ error: err.message || "Failed to place Alpaca order" }, { status: 500 });
    }
  }

  // Get Alpaca Account & Buying Power
  // #1727 F04: reads mode, default none (this route's legacy: no
  // read audit). An explicit mode selects the mcp (query) or rest
  // (queried) audit; #1733 keeps the twin default question.
  if (path.endsWith("/trading/alpaca/account") && request.method === "GET") {
    try {
      const readsMode = resolveFossRestSwitch(fossSwitchHost(ctx), "reads", url.searchParams.get("mode"), "none");
      const foss = new FossResearchService(ctx.env);
      const account = await foss.getAlpacaAccount();
      const event = fossReadsAuditEvent(readsMode, "account");
      if (event) {
        ctx.audit(event, "trading", {
          success: account.success,
          accountId: account.account?.id,
          buyingPower: account.account?.buying_power,
          portfolioValue: account.account?.portfolio_value,
        });
      }
      return Response.json(account);
    } catch (err: any) {
      return Response.json({ error: err.message || "Failed to fetch Alpaca account" }, { status: 500 });
    }
  }

  // Get Alpaca Open Positions
  if (path.endsWith("/trading/alpaca/positions") && request.method === "GET") {
    try {
      const readsMode = resolveFossRestSwitch(fossSwitchHost(ctx), "reads", url.searchParams.get("mode"), "none");
      const foss = new FossResearchService(ctx.env);
      const positions = await foss.getAlpacaPositions();
      const event = fossReadsAuditEvent(readsMode, "positions");
      if (event) {
        ctx.audit(event, "trading", {
          success: positions.success,
          count: positions.positions?.length || 0,
          symbols: positions.positions?.map((p: any) => p.symbol) || [],
        });
      }
      return Response.json(positions);
    } catch (err: any) {
      return Response.json({ error: err.message || "Failed to fetch Alpaca positions" }, { status: 500 });
    }
  }

  // Get Alpaca Orders List
  if (path.endsWith("/trading/alpaca/orders") && request.method === "GET") {
    try {
      const readsMode = resolveFossRestSwitch(fossSwitchHost(ctx), "reads", url.searchParams.get("mode"), "none");
      const status = (url.searchParams.get("status") || "open") as any;
      const foss = new FossResearchService(ctx.env);
      const orders = await foss.getAlpacaOrders(status);
      const event = fossReadsAuditEvent(readsMode, "orders");
      if (event) {
        ctx.audit(event, "trading", {
          status,
          count: orders.orders?.length || 0,
        });
      }
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
  // #1727 F03: snapshot mode (run `?mode=` > session > user > env
  // > rest legacy). mcp = required symbol (400 when missing) +
  // foss.alpaca.snapshot audit; rest = NVDA default +
  // alpaca.snapshot_queried audit.
  if (path.endsWith("/foss/snapshot") && request.method === "GET") {
    try {
      const snapshotMode = resolveFossRestSwitch(fossSwitchHost(ctx), "snapshot", url.searchParams.get("mode"), "rest");
      const symbol = snapshotMode === "mcp" ? (url.searchParams.get("symbol") || "") : (url.searchParams.get("symbol") || "NVDA");
      if (snapshotMode === "mcp" && !symbol.trim()) {
        return Response.json({ error: "symbol is required" }, { status: 400 });
      }
      const foss = new FossResearchService(ctx.env);
      const snapshot = await foss.getAlpacaSnapshot(symbol);
      const [event, payload] = fossSnapshotAudit(snapshotMode, symbol, snapshot);
      ctx.audit(event, "trading", payload);
      return Response.json(snapshot);
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Failed to fetch Alpaca market snapshot" }, { status: 500 });
    }
  }

  // Alpaca Trading v2: Account Status & Balance with Agentic Tracing
  // #1727 F04: reads mode, default rest (this route's legacy
  // *_queried audit). mcp selects the *.query audit, none silences.
  if (path.endsWith("/foss/alpaca/account") && request.method === "GET") {
    try {
      const readsMode = resolveFossRestSwitch(fossSwitchHost(ctx), "reads", url.searchParams.get("mode"), "rest");
      const foss = new FossResearchService(ctx.env);
      const result = await foss.getAlpacaAccount();
      const event = fossReadsAuditEvent(readsMode, "account");
      if (event) {
        ctx.audit(event, "trading", {
          success: result.success,
          accountId: result.account?.id,
          buyingPower: result.account?.buying_power,
          portfolioValue: result.account?.portfolio_value,
        });
      }
      return Response.json(result);
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Failed to fetch Alpaca account" }, { status: 500 });
    }
  }

  // Alpaca Trading v2: Portfolio Positions with Agentic Tracing
  if (path.endsWith("/foss/alpaca/positions") && request.method === "GET") {
    try {
      const readsMode = resolveFossRestSwitch(fossSwitchHost(ctx), "reads", url.searchParams.get("mode"), "rest");
      const foss = new FossResearchService(ctx.env);
      const result = await foss.getAlpacaPositions();
      const event = fossReadsAuditEvent(readsMode, "positions");
      if (event) {
        ctx.audit(event, "trading", {
          success: result.success,
          count: result.positions?.length || 0,
          symbols: result.positions?.map((p: any) => p.symbol) || [],
        });
      }
      return Response.json(result);
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Failed to fetch Alpaca positions" }, { status: 500 });
    }
  }

  // Alpaca Trading v2: Order History Ledger with Agentic Tracing
  if (path.endsWith("/foss/alpaca/orders") && request.method === "GET") {
    try {
      const readsMode = resolveFossRestSwitch(fossSwitchHost(ctx), "reads", url.searchParams.get("mode"), "rest");
      const status = (url.searchParams.get("status") || "open") as "open" | "closed" | "all";
      const foss = new FossResearchService(ctx.env);
      const result = await foss.getAlpacaOrders(status);
      const event = fossReadsAuditEvent(readsMode, "orders");
      if (event) {
        ctx.audit(event, "trading", {
          status,
          count: result.orders?.length || 0,
        });
      }
      return Response.json(result);
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Failed to fetch Alpaca orders" }, { status: 500 });
    }
  }

  // Alpaca Trading v2: Place Order with Agent DID Attestation & Agentic Tracing
  // #1727 F05: order mode (run body `mode` > session > user > env >
  // foss legacy). The route's own 400 wording ("Symbol is
  // required") stays in every mode; trading mode selects /trading
  // normalization + minimal audit, mcp mode selects verbatim input
  // + alpaca.order.place.
  if (path.endsWith("/foss/alpaca/order") && request.method === "POST") {
    try {
      const body = (await request.json().catch(() => ({}))) as any;
      const orderMode = resolveFossRestSwitch(fossSwitchHost(ctx), "order", body.mode, "foss");
      const normalized = normalizeFossOrderInput(body, orderMode);

      if (!normalized.symbol || !String(normalized.symbol).trim()) {
        return Response.json({ error: "Symbol is required" }, { status: 400 });
      }

      const foss = new FossResearchService(ctx.env);
      const result = await foss.placeAlpacaOrder(normalized);

      ctx.audit(fossOrderAuditEvent(orderMode), "trading", fossOrderAuditPayload(orderMode, normalized, result));

      return Response.json(result);
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Failed to place Alpaca order" }, { status: 500 });
    }
  }
  return null;
}
