/**
 * Issue #359-13: characterization for the alpaca route extraction.
 *
 * Pins (a) the route inventory and relative order of the two extracted
 * handlers in src/agents/routes/alpaca.ts — the matching order in
 * routeRequest is load-bearing, so each module handler must match the
 * (path, method) pairs in the same sequence as the original inline blocks;
 * (b) the two delegation call sites in orchestrator.ts, at the exact
 * original positions (trading group after the watchlists delegation; foss
 * group between /foss/research and /foss/compare); (c) behavior with a
 * mocked FossResearchService: owned paths return a Response (200 / 400 /
 * 500 exactly as before), non-owned paths return null (the orchestrator
 * keeps routing) — each handler ends with an explicit `return null`, never
 * undefined (slice #359-08 caught a missing-return-null bug on exactly
 * this); (d) audit events stay funneled through ctx.audit with the same
 * event names; (e) FossResearchService is constructed with ctx.env
 * byte-identically (no credential/env semantics change).
 *
 * LANDMARK RULE (#405): position assertions anchor to DELEGATION CALLS or
 * own-domain markers, never to a neighboring domain's inline comments or
 * blocks. The trading delegation's lower bound anchors to the slice-12
 * watchlists delegation call (the reciprocal note slice #359-12 left in
 * tests/watchlists_routes_extraction.test.ts). The foss delegation anchors
 * to the trading delegation call (both own-domain). The upper bound is
 * NOT asserted: the /foss/compare block is slice #359-14's (foss research)
 * domain and still inline; slice #377 must anchor its foss delegation's
 * lower bound to the handleAlpacaFossRoutes(...) delegation call when it
 * extracts that block (reciprocal of this note).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";

vi.mock("../src/services/fossResearch", () => {
  const fns = {
    placeAlpacaOrder: vi.fn(async (args: any) => ({
      success: true,
      status: "accepted",
      orderId: "order-1",
      order: args,
    })),
    getAlpacaAccount: vi.fn(async () => ({
      success: true,
      account: { id: "acct-1", buying_power: "100000", portfolio_value: "250000" },
    })),
    getAlpacaPositions: vi.fn(async () => ({
      success: true,
      positions: [{ symbol: "NVDA", qty: "10" }],
    })),
    getAlpacaOrders: vi.fn(async (status: string) => ({
      success: true,
      status,
      orders: [{ id: "o1" }],
    })),
    getAlpacaSnapshot: vi.fn(async (symbol: string) => ({
      symbol,
      latestTrade: { price: 140.5 },
      latestQuote: { bidPrice: 140.4, askPrice: 140.6 },
      assetClass: "us_equity",
    })),
  };
  const seen: any[] = [];
  class MockFossResearchService {
    constructor(...args: any[]) {
      seen.push({ ctor: args, svc: this });
      Object.assign(this, fns);
    }
  }
  return { FossResearchService: MockFossResearchService, __mockFoss: { fns, seen } };
});

import {
  handleAlpacaTradingRoutes,
  handleAlpacaFossRoutes,
  type AlpacaRouteContext,
} from "../src/agents/routes/alpaca";
import * as fossMod from "../src/services/fossResearch";

const mocks = (fossMod as any).__mockFoss as {
  fns: Record<string, ReturnType<typeof vi.fn>>;
  seen: Array<{ ctor: any[]; svc: any }>;
};

const src = (rel: string) => readFileSync(`src/${rel}`, "utf8");

const baseCtx = (overrides: Partial<AlpacaRouteContext> = {}): AlpacaRouteContext =>
  ({
    env: { MARKER: "env" } as any,
    audit: vi.fn(),
    ...overrides,
  }) as AlpacaRouteContext;

const req = (method: string, path: string, body?: unknown) =>
  new Request(`https://agent.internal${path}`, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

const urlOf = (path: string) => new URL(`https://agent.internal${path}`);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.seen.length = 0;
});

const TRADING_MARKERS = [
  'path.endsWith("/trading/alpaca/order") && request.method === "POST"',
  'path.endsWith("/trading/alpaca/account") && request.method === "GET"',
  'path.endsWith("/trading/alpaca/positions") && request.method === "GET"',
  'path.endsWith("/trading/alpaca/orders") && request.method === "GET"',
];

const FOSS_MARKERS = [
  'path.endsWith("/foss/snapshot") && request.method === "GET"',
  'path.endsWith("/foss/alpaca/account") && request.method === "GET"',
  'path.endsWith("/foss/alpaca/positions") && request.method === "GET"',
  'path.endsWith("/foss/alpaca/orders") && request.method === "GET"',
  'path.endsWith("/foss/alpaca/order") && request.method === "POST"',
];

function assertOrdered(moduleSrc: string, markers: string[]) {
  let last = -1;
  for (const marker of markers) {
    const idx = moduleSrc.indexOf(marker, last + 1);
    expect(idx, `expected route marker in module: ${marker}`).toBeGreaterThan(-1);
    expect(idx, `route marker out of order: ${marker}`).toBeGreaterThan(last);
    last = idx;
  }
}

describe("alpaca route inventory (extraction #376)", () => {
  it("the trading route conditions appear in the module in the original relative order", () => {
    const tradingSrc = src("agents/routes/alpaca.ts").split("handleAlpacaFossRoutes")[0];
    assertOrdered(tradingSrc, TRADING_MARKERS);
  });

  it("the foss route conditions appear in the module in the original relative order", () => {
    const fossSrc = src("agents/routes/alpaca.ts").split("handleAlpacaFossRoutes")[1];
    assertOrdered(fossSrc, FOSS_MARKERS);
    // The non-alpaca foss routes are NOT moved (slice #359-14's domain).
    for (const cond of [
      'path.endsWith("/foss/quote")',
      'path.endsWith("/foss/fundamentals")',
      'path.endsWith("/foss/bars")',
      'path.endsWith("/foss/research")',
      'path.endsWith("/foss/compare")',
    ]) {
      expect(fossSrc, `sibling foss route must stay inline: ${cond}`).not.toContain(cond);
    }
  });

  it("the original inline blocks are gone from orchestrator.ts; two delegations stand at the original positions", () => {
    const orchSrc = src("agents/orchestrator.ts");
    const moduleSrc = src("agents/routes/alpaca.ts");
    expect(moduleSrc).toContain("export async function handleAlpacaTradingRoutes");
    expect(moduleSrc).toContain("export async function handleAlpacaFossRoutes");
    expect(moduleSrc).toContain("export interface AlpacaRouteContext");
    for (const cond of [...TRADING_MARKERS, ...FOSS_MARKERS].map((m) =>
      m.split(" && ")[0]
    )) {
      expect(orchSrc, `inline condition should be gone: ${cond}`).not.toContain(cond);
    }
    // Exactly one call site each.
    for (const needle of [
      "handleAlpacaTradingRoutes(request, url, path, sessionId,",
      "handleAlpacaFossRoutes(request, url, path, sessionId,",
    ]) {
      expect(orchSrc.split(needle).length - 1, `expected exactly one call site: ${needle}`).toBe(1);
    }
    // FossResearchService import moved into the module but STAYS in
    // orchestrator.ts: the remaining inline FOSS blocks still use it.
    expect(moduleSrc).toContain('import { FossResearchService } from "../../services/fossResearch"');
    expect(orchSrc).toContain('import { FossResearchService, fossBarsSourceLabel } from "../services/fossResearch"');
  });

  it("the trading delegation sits after the watchlists delegation; the foss delegation follows it", () => {
    const orchSrc = src("agents/orchestrator.ts");
    const tradingIdx = orchSrc.indexOf("handleAlpacaTradingRoutes(request, url, path, sessionId,");
    const fossIdx = orchSrc.indexOf("handleAlpacaFossRoutes(request, url, path, sessionId,");
    // Lower bound: the slice-12 watchlists delegation call (delegation-call
    // anchor per the #405 rule).
    const watchlistsIdx = orchSrc.indexOf("handleWatchlistsRoutes(request, url, path, sessionId,");
    expect(watchlistsIdx).toBeGreaterThan(-1);
    expect(tradingIdx, "trading delegation must follow the watchlists delegation").toBeGreaterThan(
      watchlistsIdx
    );
    expect(fossIdx, "foss delegation must follow the trading delegation").toBeGreaterThan(
      tradingIdx
    );
    // NOTE for slice #359-14 (foss research): anchor its delegation's lower
    // bound to the handleAlpacaFossRoutes(...) delegation call above.
  });
});

describe("handleAlpacaTradingRoutes behavior", () => {
  it("returns null for paths it does not own (orchestrator keeps routing)", async () => {
    expect(
      await handleAlpacaTradingRoutes(req("GET", "/api/audit"), urlOf("/api/audit"), "/api/audit", "s", baseCtx())
    ).toBeNull();
    // Wrong method for an owned path is not owned.
    expect(
      await handleAlpacaTradingRoutes(
        req("GET", "/api/trading/alpaca/order"),
        urlOf("/api/trading/alpaca/order"),
        "/api/trading/alpaca/order",
        "s",
        baseCtx()
      )
    ).toBeNull();
    // Sibling-domain paths are not owned (foss alpaca belongs to the other handler).
    expect(
      await handleAlpacaTradingRoutes(
        req("GET", "/api/foss/alpaca/account"),
        urlOf("/api/foss/alpaca/account"),
        "/api/foss/alpaca/account",
        "s",
        baseCtx()
      )
    ).toBeNull();
  });

  it("returns an explicit null, never undefined, for non-owned paths", async () => {
    for (const h of [handleAlpacaTradingRoutes, handleAlpacaFossRoutes]) {
      const res = await h(req("GET", "/api/nothing-here"), urlOf("/api/nothing-here"), "/api/nothing-here", "s", baseCtx());
      expect(res).not.toBeUndefined();
      expect(res).toBeNull();
    }
  });

  it("places an order and audits with the original event name", async () => {
    const ctx = baseCtx();
    const res = await handleAlpacaTradingRoutes(
      req("POST", "/api/trading/alpaca/order", { symbol: "NVDA", qty: 2, side: "buy" }),
      urlOf("/api/trading/alpaca/order"),
      "/api/trading/alpaca/order",
      "s",
      ctx
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    expect(await res!.json()).toMatchObject({ success: true, status: "accepted" });
    expect(mocks.fns.placeAlpacaOrder).toHaveBeenCalledWith(
      expect.objectContaining({ symbol: "NVDA", qty: 2, side: "buy" })
    );
    expect(ctx.audit).toHaveBeenCalledWith(
      "alpaca.order_placed",
      "trading",
      expect.objectContaining({ symbol: "NVDA", qty: 2, side: "buy" })
    );
    // Credential/env handling: the service is constructed with ctx.env untouched.
    expect(mocks.seen[0].ctor[0]).toBe(ctx.env);
  });

  it("rejects an order without a symbol with 400 (no audit, no service call)", async () => {
    const ctx = baseCtx();
    const res = await handleAlpacaTradingRoutes(
      req("POST", "/api/trading/alpaca/order", { qty: 1 }),
      urlOf("/api/trading/alpaca/order"),
      "/api/trading/alpaca/order",
      "s",
      ctx
    );
    expect(res!.status).toBe(400);
    expect(await res!.json()).toEqual({ error: "Stock symbol is required" });
    expect(mocks.fns.placeAlpacaOrder).not.toHaveBeenCalled();
    expect(ctx.audit).not.toHaveBeenCalled();
  });

  it("serves account, positions, and orders list", async () => {
    const ctx = baseCtx();
    for (const p of ["/api/trading/alpaca/account", "/api/trading/alpaca/positions"]) {
      const res = await handleAlpacaTradingRoutes(req("GET", p), urlOf(p), p, "s", ctx);
      expect(res!.status).toBe(200);
      expect((await res!.json()).success).toBe(true);
    }
    const res = await handleAlpacaTradingRoutes(
      req("GET", "/api/trading/alpaca/orders?status=closed"),
      urlOf("/api/trading/alpaca/orders?status=closed"),
      "/api/trading/alpaca/orders",
      "s",
      ctx
    );
    expect(res!.status).toBe(200);
    expect(mocks.fns.getAlpacaOrders).toHaveBeenCalledWith("closed");
  });

  it("returns 500 when the service throws", async () => {
    mocks.fns.getAlpacaAccount.mockRejectedValueOnce(new Error("boom"));
    const res = await handleAlpacaTradingRoutes(
      req("GET", "/api/trading/alpaca/account"),
      urlOf("/api/trading/alpaca/account"),
      "/api/trading/alpaca/account",
      "s",
      baseCtx()
    );
    expect(res!.status).toBe(500);
    expect(await res!.json()).toEqual({ error: "boom" });
  });
});

describe("handleAlpacaFossRoutes behavior", () => {
  it("returns null for paths it does not own (orchestrator keeps routing)", async () => {
    expect(
      await handleAlpacaFossRoutes(req("GET", "/api/audit"), urlOf("/api/audit"), "/api/audit", "s", baseCtx())
    ).toBeNull();
    // Sibling-domain paths are not owned (slice #359-14's domain stays inline).
    for (const p of ["/api/foss/quote", "/api/foss/bars", "/api/foss/research", "/api/foss/compare"]) {
      expect(
        await handleAlpacaFossRoutes(req("GET", p), urlOf(p), p, "s", baseCtx()),
        p
      ).toBeNull();
    }
    // Trading-alpaca paths belong to the other handler.
    expect(
      await handleAlpacaFossRoutes(
        req("POST", "/api/trading/alpaca/order"),
        urlOf("/api/trading/alpaca/order"),
        "/api/trading/alpaca/order",
        "s",
        baseCtx()
      )
    ).toBeNull();
  });

  it("serves the snapshot and audits with the original event name", async () => {
    const ctx = baseCtx();
    const res = await handleAlpacaFossRoutes(
      req("GET", "/api/foss/snapshot?symbol=NVDA"),
      urlOf("/api/foss/snapshot?symbol=NVDA"),
      "/api/foss/snapshot",
      "s",
      ctx
    );
    expect(res!.status).toBe(200);
    expect(await res!.json()).toMatchObject({ symbol: "NVDA" });
    expect(ctx.audit).toHaveBeenCalledWith(
      "alpaca.snapshot_queried",
      "trading",
      expect.objectContaining({ symbol: "NVDA", price: 140.5 })
    );
  });

  it("serves foss alpaca account/positions/orders and audits each", async () => {
    const ctx = baseCtx();
    for (const [p, event] of [
      ["/api/foss/alpaca/account", "alpaca.account_queried"],
      ["/api/foss/alpaca/positions", "alpaca.positions_queried"],
      ["/api/foss/alpaca/orders", "alpaca.orders_queried"],
    ] as const) {
      const res = await handleAlpacaFossRoutes(req("GET", p), urlOf(p), p, "s", ctx);
      expect(res!.status, p).toBe(200);
      expect((await res!.json()).success, p).toBe(true);
      expect(ctx.audit, event).toHaveBeenCalledWith(event, "trading", expect.anything());
    }
  });

  it("places a foss alpaca order with the original body aliases and audits", async () => {
    const ctx = baseCtx();
    const res = await handleAlpacaFossRoutes(
      req("POST", "/api/foss/alpaca/order", { symbol: "aapl", quantity: 5, orderAction: "sell" }),
      urlOf("/api/foss/alpaca/order"),
      "/api/foss/alpaca/order",
      "s",
      ctx
    );
    expect(res!.status).toBe(200);
    expect(mocks.fns.placeAlpacaOrder).toHaveBeenCalledWith(
      expect.objectContaining({ symbol: "AAPL", qty: 5, side: "sell" })
    );
    expect(ctx.audit).toHaveBeenCalledWith(
      "alpaca.order_placed",
      "trading",
      expect.objectContaining({ symbol: "AAPL", qty: 5, side: "sell" })
    );
  });

  it("rejects a foss order without a symbol with 400", async () => {
    const res = await handleAlpacaFossRoutes(
      req("POST", "/api/foss/alpaca/order", {}),
      urlOf("/api/foss/alpaca/order"),
      "/api/foss/alpaca/order",
      "s",
      baseCtx()
    );
    expect(res!.status).toBe(400);
    expect(await res!.json()).toEqual({ error: "Symbol is required" });
  });
});
