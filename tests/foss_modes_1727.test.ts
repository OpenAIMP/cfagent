/**
 * #1727 (parent #1717, slice (g)): FOSS MCP vs REST unification —
 * SEVEN runtime config switches over the scan appendix (g) pairs
 * (F01–F05), one per pair, resolved in src/config/fossModes.ts.
 *
 * RED pins (written BEFORE the implementation; the first run must
 * fail on the missing module). Both modes are pinned per pair:
 * the default (per-surface legacy — MCP surface keeps MCP behavior,
 * REST surfaces keep REST behavior, exactly the #1726 accepted
 * interpretation of the identical standing-rule text) AND the
 * switched mode, plus fail-closed on invalid values.
 *
 * Switches (values case-insensitive, whitespace ignored):
 * - FOSS_QUOTE_MODE: "mcp" | "rest" (F01 quote)
 * - FOSS_FUNDAMENTALS_MODE: "mcp" | "rest" (F01 fundamentals)
 * - FOSS_RESEARCH_MODE: "mcp" | "rest" (F01 research; audit-name
 *   decision recorded: the REST spelling `foss.research_generated`
 *   is the canonical spelling for new consumers — it matches the
 *   past-tense underscore convention of the whole /foss *_queried
 *   family — while the MCP spelling `foss.research.generated`
 *   stays available under mode=mcp; neither spelling is deleted)
 * - FOSS_BARS_MODE: "mcp" | "rest" (F02 bars)
 * - FOSS_SNAPSHOT_MODE: "mcp" | "rest" (F03 snapshot)
 * - FOSS_ALPACA_READS_MODE: "mcp" | "rest" | "none" (F04 reads;
 *   three-way: MCP *.query vs /foss *_queried vs /trading silence.
 *   Defaults: MCP→mcp, /foss→rest, /trading→none, so #1733 (m)
 *   keeps full freedom over the REST-twin default — this slice
 *   wires the lever, it does not pre-decide the twin question)
 * - FOSS_ALPACA_ORDER_MODE: "mcp" | "foss" | "trading" (F05 place
 *   order; three-way normalization + audit. Defaults: MCP→mcp,
 *   /foss→foss, /trading→trading)
 *
 * Resolution order (owner directive 2026-10-26):
 *   run (MCP input `mode` / REST query `?mode=` / body `mode`)
 *   > session > user (optional `scopedFossModes` carriers)
 *   > global env > built-in (per-surface legacy).
 * First non-blank level wins; an unrecognized winning value FAILS
 * CLOSED to the surface legacy, console-logged + audited as
 * `foss.config_error` (no fall-through).
 *
 * Scan-vs-code corrections pinned here (appendix (g) was written
 * against an older tree; current main governs):
 * - MCP quote/fundamentals DO audit today (foss.quote.fetched /
 *   foss.fundamentals.fetched) — the appendix claim that MCP
 *   audits "snapshot/bars/research but not quote/fundamentals"
 *   is stale; the audit-presence divergence is REST-silence vs
 *   MCP-audit, not MCP-inconsistency.
 * - MCP orders status DOES default to open today (zod default +
 *   execute `|| "open"` + service default) — the scan's "no
 *   default" claim is stale; status default is pinned, not
 *   switched, and is open in every mode on every surface.
 * - MCP account/positions/orders audit payloads are IDENTICAL to
 *   the /foss *_queried payloads — F04's divergence is the event
 *   NAME (+ /trading silence), not the payload.
 * - FossResearchService.getHistoricalBars defaults provider to
 *   yfinance — MCP's 3-arg call and REST's explicit default
 *   already agree on the VALUE; F02's divergence is the provider
 *   OVERRIDE + envelope + audit, not the default value.
 *
 * No endpoint is removed, no code path is deleted. Alpaca order
 * placement carries no HITL gate on either surface today; this
 * slice neither adds nor weakens one — the order switch changes
 * input normalization + audit only, never the service call's
 * placement semantics, and no switch value can disable an
 * enforcement (there is none on this path to disable).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/services/fossResearch", () => {
  const fns = {
    getQuote: vi.fn(async (symbol: string, provider?: string) => ({
      symbol,
      price: 195.5,
      provider: provider || "hybrid",
      provenance: "live",
    })),
    getFundamentals: vi.fn(async (symbol: string) => ({
      symbol,
      marketCap: 1000,
      peTrailing: 25,
      provenance: "live",
    })),
    getHistoricalBars: vi.fn(async (symbol: string, _tf: string, _limit: number, provider?: string) => {
      (fns as any).__lastBarsArgs = [symbol, _tf, _limit, provider];
      return [{ t: 1, c: 100, provenance: "live" }];
    }),
    generateResearchReport: vi.fn(async (symbol: string) => ({
      symbol,
      analystRating: "buy",
      agentAttestation: { did: "did:test:123" },
      provenance: "live",
    })),
    getAlpacaSnapshot: vi.fn(async (symbol: string) => ({
      symbol,
      assetClass: "us_equity",
      latestTrade: { price: 195.5 },
      latestQuote: { bidPrice: 195.0, askPrice: 196.0 },
      provenance: "live",
    })),
    getAlpacaAccount: vi.fn(async () => ({
      success: true,
      account: { id: "acc1", buying_power: 10000, portfolio_value: 50000 },
    })),
    getAlpacaPositions: vi.fn(async () => ({
      success: true,
      positions: [{ symbol: "NVDA" }],
    })),
    getAlpacaOrders: vi.fn(async (status?: string) => {
      (fns as any).__lastOrdersStatus = status;
      return { success: true, orders: [{ id: "o1" }] };
    }),
    placeAlpacaOrder: vi.fn(async (params: any) => {
      (fns as any).__lastOrderParams = params;
      return {
        success: true,
        orderId: "ord1",
        status: "accepted",
        symbol: params.symbol,
        qty: params.qty,
        side: params.side,
      };
    }),
  };
  const seen: any[] = [];
  class MockFossResearchService {
    constructor(...args: any[]) {
      seen.push({ ctor: args, svc: this });
      Object.assign(this, fns);
    }
  }
  const fossBarsSourceLabel = (provider: string, provenance: string) =>
    provenance === "live" ? `MOCK-LIVE ${provider}` : `MOCK-GENERATED ${provider}`;
  return {
    FossResearchService: MockFossResearchService,
    fossBarsSourceLabel,
    __mockFoss: { fns, seen },
  };
});

vi.mock("../src/trading", async () => {
  const schemas = await vi.importActual<any>("../src/trading/screeningSchemas");
  return { parseStockScreenRequest: schemas.parseStockScreenRequest };
});

import {
  FOSS_QUOTE_MODE_SWITCH,
  FOSS_FUNDAMENTALS_MODE_SWITCH,
  FOSS_RESEARCH_MODE_SWITCH,
  FOSS_BARS_MODE_SWITCH,
  FOSS_SNAPSHOT_MODE_SWITCH,
  FOSS_ALPACA_READS_MODE_SWITCH,
  FOSS_ALPACA_ORDER_MODE_SWITCH,
  fossConfigErrorEvent,
  levelsForFossSwitch,
  resolveFossQuoteMode,
  resolveFossFundamentalsMode,
  resolveFossResearchMode,
  resolveFossBarsMode,
  resolveFossSnapshotMode,
  resolveFossAlpacaReadsMode,
  resolveFossAlpacaOrderMode,
  resolveFossRestSwitch,
} from "../src/config/fossModes";
import {
  FossGetQuoteCommand,
  FossFundamentalsCommand,
  FossHistoricalBarsCommand,
  FossMarketResearchCommand,
  FossAlpacaSnapshotCommand,
  FossAlpacaAccountCommand,
  FossAlpacaPositionsCommand,
  FossAlpacaOrdersCommand,
  FossAlpacaPlaceOrderCommand,
} from "../src/mcp/fossCommands";
import {
  handleFossQuoteResearchRoutes,
  type FossResearchRouteContext,
} from "../src/agents/routes/fossResearch";
import {
  handleAlpacaFossRoutes,
  handleAlpacaTradingRoutes,
  type AlpacaRouteContext,
} from "../src/agents/routes/alpaca";
import * as fossMod from "../src/services/fossResearch";

const fossMocks = (fossMod as any).__mockFoss as { fns: any; seen: any[] };

function mcpCtx(overrides: any = {}) {
  return {
    env: {},
    orm: {},
    sessionId: "test-user",
    audit: vi.fn(),
    ...overrides,
  };
}

function auditEvents(ctx: any): Array<[string, any, any]> {
  return (ctx.audit as any).mock.calls as Array<[string, any, any]>;
}

function auditNames(ctx: any): string[] {
  return auditEvents(ctx).map((c) => c[0]);
}

function restCtx(overrides: any = {}): FossResearchRouteContext & AlpacaRouteContext {
  return {
    env: {},
    audit: vi.fn(),
    getScreenerAgent: (() => {
      throw new Error("screener not under test");
    }) as any,
    persistScreenerReportCanonical: (async () => {}) as any,
    ...overrides,
  } as any;
}

async function getBody(res: Response | null): Promise<any> {
  expect(res).not.toBeNull();
  return res!.json();
}

beforeEach(() => {
  vi.clearAllMocks();
  fossMocks.seen.length = 0;
});

/* ================= A. Resolver unit pins ================= */

describe("fossModes resolver", () => {
  it("exposes the seven switch names and the config_error event", () => {
    expect(FOSS_QUOTE_MODE_SWITCH).toBe("FOSS_QUOTE_MODE");
    expect(FOSS_FUNDAMENTALS_MODE_SWITCH).toBe("FOSS_FUNDAMENTALS_MODE");
    expect(FOSS_RESEARCH_MODE_SWITCH).toBe("FOSS_RESEARCH_MODE");
    expect(FOSS_BARS_MODE_SWITCH).toBe("FOSS_BARS_MODE");
    expect(FOSS_SNAPSHOT_MODE_SWITCH).toBe("FOSS_SNAPSHOT_MODE");
    expect(FOSS_ALPACA_READS_MODE_SWITCH).toBe("FOSS_ALPACA_READS_MODE");
    expect(FOSS_ALPACA_ORDER_MODE_SWITCH).toBe("FOSS_ALPACA_ORDER_MODE");
    expect(fossConfigErrorEvent()).toBe("foss.config_error");
  });

  it("falls through blank levels to the built-in legacy", () => {
    const r = resolveFossQuoteMode({ run: undefined, session: "", user: "  ", env: undefined }, "mcp");
    expect(r.mode).toBe("mcp");
    expect(r.invalid).toBe(false);
    expect(r.level).toBe("builtin");
  });

  it("resolves run > session > user > env", () => {
    const base = { run: "rest", session: "mcp", user: "mcp", env: "mcp" };
    expect(resolveFossQuoteMode(base, "mcp").mode).toBe("rest");
    expect(resolveFossQuoteMode(base, "mcp").level).toBe("run");
    expect(resolveFossQuoteMode({ ...base, run: undefined }, "mcp").mode).toBe("mcp");
    expect(resolveFossQuoteMode({ ...base, run: undefined }, "mcp").level).toBe("session");
    expect(resolveFossQuoteMode({ run: undefined, session: undefined, user: "rest", env: "mcp" }, "mcp").level).toBe("user");
    expect(resolveFossQuoteMode({ run: undefined, session: undefined, user: undefined, env: "rest" }, "mcp").level).toBe("env");
  });

  it("normalizes case + whitespace", () => {
    expect(resolveFossBarsMode({ run: "  REST " }, "mcp").mode).toBe("rest");
    expect(resolveFossAlpacaReadsMode({ run: "NONE" }, "mcp").mode).toBe("none");
    expect(resolveFossAlpacaOrderMode({ run: "FOSS" }, "mcp").mode).toBe("foss");
  });

  it("fails closed to the legacy on an unrecognized winning value, with NO fall-through", () => {
    const r = resolveFossQuoteMode({ run: "bogus", session: "rest", env: "rest" }, "mcp");
    expect(r.mode).toBe("mcp");
    expect(r.invalid).toBe(true);
    expect(r.raw).toBe("bogus");
    expect(r.level).toBe("run");
  });

  it("rejects values outside each switch's own vocabulary", () => {
    expect(resolveFossAlpacaReadsMode({ run: "foss" }, "mcp").invalid).toBe(true);
    expect(resolveFossAlpacaOrderMode({ run: "rest" }, "mcp").invalid).toBe(true);
    expect(resolveFossAlpacaReadsMode({ run: "rest" }, "mcp").invalid).toBe(false);
    expect(resolveFossAlpacaOrderMode({ run: "trading" }, "mcp").invalid).toBe(false);
  });

  it("levelsForFossSwitch maps session/user carriers", () => {
    const levels = levelsForFossSwitch({ session: { quote: "rest" }, user: { quote: "mcp" } }, "quote", "RUN", "ENV");
    expect(levels).toEqual({ run: "RUN", session: "rest", user: "mcp", env: "ENV" });
  });

  it("resolveFossRestSwitch audits foss.config_error on invalid and returns the legacy", () => {
    const host: any = { env: {}, audit: vi.fn(), scopedFossModes: undefined };
    const mode = resolveFossRestSwitch(host, "quote", "bogus", "rest");
    expect(mode).toBe("rest");
    expect(host.audit).toHaveBeenCalledWith(
      "foss.config_error",
      "research",
      expect.objectContaining({ switch: "FOSS_QUOTE_MODE", raw: "bogus", level: "run", failedClosedTo: "rest" })
    );
  });

  it("resolveFossRestSwitch does not audit on valid values", () => {
    const host: any = { env: {}, audit: vi.fn(), scopedFossModes: undefined };
    expect(resolveFossRestSwitch(host, "quote", "mcp", "rest")).toBe("mcp");
    expect(host.audit).not.toHaveBeenCalled();
  });
});

/* ================= B. MCP command pins ================= */

describe("MCP foss commands", () => {
  it("F01 quote default (mcp): symbol required, audits foss.quote.fetched", async () => {
    const ctx = mcpCtx();
    await expect(new FossGetQuoteCommand().execute({} as any, ctx)).rejects.toThrow("symbol is required");
    const out = await new FossGetQuoteCommand().execute({ symbol: "NVDA" } as any, ctx);
    expect(out.price).toBe(195.5);
    expect(auditNames(ctx)).toContain("foss.quote.fetched");
    expect(auditNames(ctx)).not.toContain("foss.config_error");
  });

  it("F01 quote mode=rest: missing symbol defaults to NVDA, no quote audit", async () => {
    const ctx = mcpCtx();
    const out = await new FossGetQuoteCommand().execute({ mode: "rest" } as any, ctx);
    expect(fossMocks.fns.getQuote).toHaveBeenCalledWith("NVDA", "hybrid");
    expect(out.symbol).toBe("NVDA");
    expect(auditNames(ctx)).not.toContain("foss.quote.fetched");
  });

  it("F01 quote env FOSS_QUOTE_MODE=rest: rest behavior; session carrier honored; run beats session", async () => {
    const ctxEnv = mcpCtx({ env: { FOSS_QUOTE_MODE: "rest" } });
    await new FossGetQuoteCommand().execute({} as any, ctxEnv);
    expect(fossMocks.fns.getQuote).toHaveBeenCalledWith("NVDA", "hybrid");
    expect(auditNames(ctxEnv)).not.toContain("foss.quote.fetched");

    const ctxSession = mcpCtx({ scopedFossModes: { session: { quote: "rest" } } });
    await new FossGetQuoteCommand().execute({} as any, ctxSession);
    expect(fossMocks.fns.getQuote).toHaveBeenCalledWith("NVDA", "hybrid");

    const ctxRunBeats = mcpCtx({ scopedFossModes: { session: { quote: "rest" } } });
    await new FossGetQuoteCommand().execute({ symbol: "AAPL", mode: "mcp" } as any, ctxRunBeats);
    expect(fossMocks.fns.getQuote).toHaveBeenCalledWith("AAPL", "hybrid");
    expect(auditNames(ctxRunBeats)).toContain("foss.quote.fetched");
  });

  it("F01 quote invalid mode fails closed to mcp + audits foss.config_error", async () => {
    const ctx = mcpCtx();
    await expect(new FossGetQuoteCommand().execute({ mode: "bogus" } as any, ctx)).rejects.toThrow("symbol is required");
    expect(auditNames(ctx)).toContain("foss.config_error");
    expect(auditEvents(ctx).find((c) => c[0] === "foss.config_error")![2]).toMatchObject({
      switch: "FOSS_QUOTE_MODE",
      raw: "bogus",
      failedClosedTo: "mcp",
    });
  });

  it("F01 fundamentals default audits foss.fundamentals.fetched; rest mode defaults NVDA with no audit", async () => {
    const ctx = mcpCtx();
    await expect(new FossFundamentalsCommand().execute({} as any, ctx)).rejects.toThrow("symbol is required");
    await new FossFundamentalsCommand().execute({ symbol: "MSFT" } as any, ctx);
    expect(auditNames(ctx)).toContain("foss.fundamentals.fetched");
    const ctxRest = mcpCtx();
    await new FossFundamentalsCommand().execute({ mode: "rest" } as any, ctxRest);
    expect(fossMocks.fns.getFundamentals).toHaveBeenCalledWith("NVDA");
    expect(auditNames(ctxRest)).not.toContain("foss.fundamentals.fetched");
  });

  it("F01 research default audits foss.research.generated; rest mode audits foss.research_generated + NVDA default", async () => {
    const ctx = mcpCtx();
    await new FossMarketResearchCommand().execute({ symbol: "NVDA" } as any, ctx);
    expect(auditNames(ctx)).toContain("foss.research.generated");
    expect(auditNames(ctx)).not.toContain("foss.research_generated");
    const ctxRest = mcpCtx();
    const report = await new FossMarketResearchCommand().execute({ mode: "rest" } as any, ctxRest);
    expect(report.symbol).toBe("NVDA");
    expect(auditNames(ctxRest)).toContain("foss.research_generated");
    expect(auditNames(ctxRest)).not.toContain("foss.research.generated");
    const payload = auditEvents(ctxRest).find((c) => c[0] === "foss.research_generated")![2];
    expect(payload).toMatchObject({ symbol: "NVDA", rating: "buy", did: "did:test:123" });
  });

  it("F02 bars default (mcp): small envelope + foss.bars.fetched audit, no provider override", async () => {
    const ctx = mcpCtx();
    const out = await new FossHistoricalBarsCommand().execute({ symbol: "NVDA" } as any, ctx);
    expect(out).toEqual({ symbol: "NVDA", count: 1, provenance: "live", bars: expect.any(Array) });
    expect(out).not.toHaveProperty("provider");
    expect(out).not.toHaveProperty("timeframe");
    expect(out).not.toHaveProperty("timestamp");
    expect(auditNames(ctx)).toContain("foss.bars.fetched");
    expect(fossMocks.fns.__lastBarsArgs[3]).toBeUndefined();
  });

  it("F02 bars rest mode: provider passed (default yfinance), fuller envelope, no bars audit", async () => {
    const ctx = mcpCtx();
    const out = await new FossHistoricalBarsCommand().execute({ symbol: "NVDA", mode: "rest" } as any, ctx);
    expect(fossMocks.fns.__lastBarsArgs).toEqual(["NVDA", "1D", 30, "yfinance"]);
    expect(out).toMatchObject({ symbol: "NVDA", provider: "yfinance", timeframe: "1D", count: 1, provenance: "live" });
    expect(out).toHaveProperty("bars");
    expect(out).toHaveProperty("source");
    expect(out).toHaveProperty("timestamp");
    expect(auditNames(ctx)).not.toContain("foss.bars.fetched");
    const ctxAlpaca = mcpCtx();
    await new FossHistoricalBarsCommand().execute({ symbol: "NVDA", mode: "rest", provider: "alpaca" } as any, ctxAlpaca);
    expect(fossMocks.fns.__lastBarsArgs[3]).toBe("alpaca");
  });

  it("F02 bars mcp mode ignores a provider input (legacy 3-arg call)", async () => {
    const ctx = mcpCtx();
    await new FossHistoricalBarsCommand().execute({ symbol: "NVDA", mode: "mcp", provider: "alpaca" } as any, ctx);
    expect(fossMocks.fns.__lastBarsArgs[3]).toBeUndefined();
    expect(auditNames(ctx)).toContain("foss.bars.fetched");
  });

  it("F03 snapshot default audits foss.alpaca.snapshot; rest mode defaults NVDA + alpaca.snapshot_queried", async () => {
    const ctx = mcpCtx();
    await expect(new FossAlpacaSnapshotCommand().execute({} as any, ctx)).rejects.toThrow("symbol is required");
    await new FossAlpacaSnapshotCommand().execute({ symbol: "NVDA" } as any, ctx);
    const mcpPayload = auditEvents(ctx).find((c) => c[0] === "foss.alpaca.snapshot")![2];
    expect(mcpPayload).toMatchObject({ symbol: "NVDA", assetClass: "us_equity", tradePrice: 195.5 });
    const ctxRest = mcpCtx();
    await new FossAlpacaSnapshotCommand().execute({ mode: "rest" } as any, ctxRest);
    const restPayload = auditEvents(ctxRest).find((c) => c[0] === "alpaca.snapshot_queried")![2];
    expect(restPayload).toMatchObject({ symbol: "NVDA", price: 195.5, bid: 195.0, ask: 196.0, assetClass: "us_equity" });
    expect(auditNames(ctxRest)).not.toContain("foss.alpaca.snapshot");
  });

  it("F04 account/positions/orders default audits *.query; rest mode audits *_queried with the same payloads; none mode is silent", async () => {
    const ctx = mcpCtx();
    await new FossAlpacaAccountCommand().execute({} as any, ctx);
    await new FossAlpacaPositionsCommand().execute({} as any, ctx);
    await new FossAlpacaOrdersCommand().execute({} as any, ctx);
    expect(auditNames(ctx)).toEqual(expect.arrayContaining(["alpaca.account.query", "alpaca.positions.query", "alpaca.orders.query"]));
    expect(fossMocks.fns.__lastOrdersStatus).toBe("open");
    const ctxRest = mcpCtx();
    await new FossAlpacaAccountCommand().execute({ mode: "rest" } as any, ctxRest);
    await new FossAlpacaPositionsCommand().execute({ mode: "rest" } as any, ctxRest);
    await new FossAlpacaOrdersCommand().execute({ status: "closed", mode: "rest" } as any, ctxRest);
    expect(auditNames(ctxRest)).toEqual(
      expect.arrayContaining(["alpaca.account_queried", "alpaca.positions_queried", "alpaca.orders_queried"])
    );
    expect(fossMocks.fns.__lastOrdersStatus).toBe("closed");
    expect(auditEvents(ctxRest).find((c) => c[0] === "alpaca.account_queried")![2]).toMatchObject({
      success: true,
      accountId: "acc1",
      buyingPower: 10000,
      portfolioValue: 50000,
    });
    const ctxNone = mcpCtx();
    await new FossAlpacaAccountCommand().execute({ mode: "none" } as any, ctxNone);
    expect(ctxNone.audit).not.toHaveBeenCalled();
  });

  it("F05 place order default (mcp): verbatim input + alpaca.order.place full audit", async () => {
    const ctx = mcpCtx();
    await new FossAlpacaPlaceOrderCommand().execute(
      { symbol: "nvda", qty: 2, side: "buy", type: "limit", limit_price: 100, quantity: 99, orderAction: "sell" } as any,
      ctx
    );
    expect(fossMocks.fns.__lastOrderParams).toMatchObject({ symbol: "nvda", qty: 2, side: "buy" });
    expect(fossMocks.fns.__lastOrderParams.qty).not.toBe(99);
    const payload = auditEvents(ctx).find((c) => c[0] === "alpaca.order.place")![2];
    expect(payload).toMatchObject({ symbol: "nvda", qty: 2, side: "buy", type: "limit", limitPrice: 100, orderId: "ord1", status: "accepted", success: true });
  });

  it("F05 place order foss mode: /foss normalization + alpaca.order_placed full audit", async () => {
    const ctx = mcpCtx();
    await new FossAlpacaPlaceOrderCommand().execute(
      { symbol: " nvda ", quantity: 3, orderAction: "BUY", orderType: "LIMIT", limitPrice: 101, mode: "foss" } as any,
      ctx
    );
    expect(fossMocks.fns.__lastOrderParams).toMatchObject({ symbol: "NVDA", qty: 3, side: "buy", type: "limit", limit_price: 101, time_in_force: "day" });
    const payload = auditEvents(ctx).find((c) => c[0] === "alpaca.order_placed")![2];
    expect(payload).toMatchObject({ symbol: "NVDA", qty: 3, side: "buy", type: "limit", limitPrice: 101, orderId: "ord1", status: "accepted", success: true });
  });

  it("F05 place order trading mode: /trading normalization + minimal alpaca.order_placed audit; qty defaults to 1", async () => {
    const ctx = mcpCtx();
    await new FossAlpacaPlaceOrderCommand().execute({ symbol: " nvda ", side: "buy", mode: "trading" } as any, ctx);
    expect(fossMocks.fns.__lastOrderParams).toMatchObject({ symbol: "nvda", qty: 1, side: "buy" });
    const payload = auditEvents(ctx).find((c) => c[0] === "alpaca.order_placed")![2];
    expect(payload).toEqual({ symbol: "nvda", qty: 1, side: "buy", status: "accepted" });
  });

  it("F05 place order invalid mode fails closed to mcp + audits foss.config_error", async () => {
    const ctx = mcpCtx();
    await new FossAlpacaPlaceOrderCommand().execute({ symbol: "NVDA", qty: 1, side: "buy", mode: "bogus" } as any, ctx);
    expect(auditNames(ctx)).toContain("foss.config_error");
    expect(auditNames(ctx)).toContain("alpaca.order.place");
  });
});

/* ================= C. REST route pins ================= */

describe("REST foss routes", () => {
  it("F01 /foss/quote default: NVDA, no audit; ?mode=mcp: required 400 + foss.quote.fetched", async () => {
    const ctx = restCtx();
    const res = await handleFossQuoteResearchRoutes(new Request("https://x/api/foss/quote"), new URL("https://x/api/foss/quote"), "/api/foss/quote", "s", ctx);
    const body = await getBody(res);
    expect(body.symbol).toBe("NVDA");
    expect(ctx.audit).not.toHaveBeenCalled();
    const ctxMcp = restCtx();
    const missing = await handleFossQuoteResearchRoutes(new Request("https://x/api/foss/quote?mode=mcp"), new URL("https://x/api/foss/quote?mode=mcp"), "/api/foss/quote", "s", ctxMcp);
    expect(missing!.status).toBe(400);
    expect(await missing!.json()).toEqual({ error: "symbol is required" });
    await handleFossQuoteResearchRoutes(new Request("https://x/api/foss/quote?symbol=AAPL&mode=mcp"), new URL("https://x/api/foss/quote?symbol=AAPL&mode=mcp"), "/api/foss/quote", "s", ctxMcp);
    expect((ctxMcp.audit as any).mock.calls.map((c: any) => c[0])).toContain("foss.quote.fetched");
  });

  it("F01 /foss/quote invalid mode fails closed to rest + audits foss.config_error", async () => {
    const ctx = restCtx();
    const res = await handleFossQuoteResearchRoutes(new Request("https://x/api/foss/quote?mode=bogus"), new URL("https://x/api/foss/quote?mode=bogus"), "/api/foss/quote", "s", ctx);
    expect((await getBody(res)).symbol).toBe("NVDA");
    expect((ctx.audit as any).mock.calls.map((c: any) => c[0])).toContain("foss.config_error");
  });

  it("F01 /foss/fundamentals default: NVDA, no audit; mcp mode audits foss.fundamentals.fetched", async () => {
    const ctx = restCtx();
    const res = await handleFossQuoteResearchRoutes(new Request("https://x/api/foss/fundamentals"), new URL("https://x/api/foss/fundamentals"), "/api/foss/fundamentals", "s", ctx);
    expect((await getBody(res)).symbol).toBe("NVDA");
    expect(ctx.audit).not.toHaveBeenCalled();
    const ctxMcp = restCtx();
    await handleFossQuoteResearchRoutes(new Request("https://x/api/foss/fundamentals?symbol=MSFT&mode=mcp"), new URL("https://x/api/foss/fundamentals?symbol=MSFT&mode=mcp"), "/api/foss/fundamentals", "s", ctxMcp);
    expect((ctxMcp.audit as any).mock.calls.map((c: any) => c[0])).toContain("foss.fundamentals.fetched");
  });

  it("F01 /foss/research default audits foss.research_generated; mcp mode audits foss.research.generated", async () => {
    const ctx = restCtx();
    await handleFossQuoteResearchRoutes(new Request("https://x/api/foss/research"), new URL("https://x/api/foss/research"), "/api/foss/research", "s", ctx);
    expect((ctx.audit as any).mock.calls.map((c: any) => c[0])).toContain("foss.research_generated");
    const ctxMcp = restCtx();
    await handleFossQuoteResearchRoutes(new Request("https://x/api/foss/research?symbol=NVDA&mode=mcp"), new URL("https://x/api/foss/research?symbol=NVDA&mode=mcp"), "/api/foss/research", "s", ctxMcp);
    expect((ctxMcp.audit as any).mock.calls.map((c: any) => c[0])).toContain("foss.research.generated");
    const missing = await handleFossQuoteResearchRoutes(new Request("https://x/api/foss/research?mode=mcp&symbol="), new URL("https://x/api/foss/research?mode=mcp&symbol="), "/api/foss/research", "s", restCtx());
    expect(missing!.status).toBe(400);
  });

  it("F02 /foss/bars default: fuller envelope + provider yfinance, no audit; mcp mode: small envelope + foss.bars.fetched", async () => {
    const ctx = restCtx();
    const res = await handleFossQuoteResearchRoutes(new Request("https://x/api/foss/bars"), new URL("https://x/api/foss/bars"), "/api/foss/bars", "s", ctx);
    const body = await getBody(res);
    expect(body).toMatchObject({ symbol: "NVDA", provider: "yfinance", timeframe: "1D", count: 1, provenance: "live" });
    expect(body).toHaveProperty("bars");
    expect(body).toHaveProperty("source");
    expect(body).toHaveProperty("timestamp");
    expect(ctx.audit).not.toHaveBeenCalled();
    const ctxMcp = restCtx();
    const resMcp = await handleFossQuoteResearchRoutes(new Request("https://x/api/foss/bars?symbol=NVDA&mode=mcp"), new URL("https://x/api/foss/bars?symbol=NVDA&mode=mcp"), "/api/foss/bars", "s", ctxMcp);
    const bodyMcp = await getBody(resMcp);
    expect(bodyMcp).toEqual({ symbol: "NVDA", count: 1, provenance: "live", bars: expect.any(Array) });
    expect((ctxMcp.audit as any).mock.calls.map((c: any) => c[0])).toContain("foss.bars.fetched");
    expect(fossMocks.fns.__lastBarsArgs[3]).toBeUndefined();
  });

  it("F02 /foss/bars rest mode honors an explicit provider", async () => {
    const ctx = restCtx();
    const res = await handleFossQuoteResearchRoutes(new Request("https://x/api/foss/bars?symbol=NVDA&provider=alpaca"), new URL("https://x/api/foss/bars?symbol=NVDA&provider=alpaca"), "/api/foss/bars", "s", ctx);
    expect((await getBody(res)).provider).toBe("alpaca");
    expect(fossMocks.fns.__lastBarsArgs[3]).toBe("alpaca");
  });

  it("F03 /foss/snapshot default: NVDA + alpaca.snapshot_queried; mcp mode: required 400 + foss.alpaca.snapshot", async () => {
    const ctx = restCtx();
    await handleAlpacaFossRoutes(new Request("https://x/api/foss/snapshot"), new URL("https://x/api/foss/snapshot"), "/api/foss/snapshot", "s", ctx);
    expect((ctx.audit as any).mock.calls.map((c: any) => c[0])).toContain("alpaca.snapshot_queried");
    const ctxMcp = restCtx();
    const missing = await handleAlpacaFossRoutes(new Request("https://x/api/foss/snapshot?mode=mcp"), new URL("https://x/api/foss/snapshot?mode=mcp"), "/api/foss/snapshot", "s", ctxMcp);
    expect(missing!.status).toBe(400);
    await handleAlpacaFossRoutes(new Request("https://x/api/foss/snapshot?symbol=AAPL&mode=mcp"), new URL("https://x/api/foss/snapshot?symbol=AAPL&mode=mcp"), "/api/foss/snapshot", "s", ctxMcp);
    expect((ctxMcp.audit as any).mock.calls.map((c: any) => c[0])).toContain("foss.alpaca.snapshot");
  });

  it("F04 /foss/alpaca reads default *_queried; mcp mode *.query; none mode silent; env none silences", async () => {
    const ctx = restCtx();
    await handleAlpacaFossRoutes(new Request("https://x/api/foss/alpaca/account"), new URL("https://x/api/foss/alpaca/account"), "/api/foss/alpaca/account", "s", ctx);
    await handleAlpacaFossRoutes(new Request("https://x/api/foss/alpaca/positions"), new URL("https://x/api/foss/alpaca/positions"), "/api/foss/alpaca/positions", "s", ctx);
    await handleAlpacaFossRoutes(new Request("https://x/api/foss/alpaca/orders?status=closed"), new URL("https://x/api/foss/alpaca/orders?status=closed"), "/api/foss/alpaca/orders", "s", ctx);
    const names = (ctx.audit as any).mock.calls.map((c: any) => c[0]);
    expect(names).toEqual(expect.arrayContaining(["alpaca.account_queried", "alpaca.positions_queried", "alpaca.orders_queried"]));
    expect(fossMocks.fns.__lastOrdersStatus).toBe("closed");
    const ctxMcp = restCtx();
    await handleAlpacaFossRoutes(new Request("https://x/api/foss/alpaca/account?mode=mcp"), new URL("https://x/api/foss/alpaca/account?mode=mcp"), "/api/foss/alpaca/account", "s", ctxMcp);
    expect((ctxMcp.audit as any).mock.calls.map((c: any) => c[0])).toContain("alpaca.account.query");
    const ctxNone = restCtx();
    await handleAlpacaFossRoutes(new Request("https://x/api/foss/alpaca/account?mode=none"), new URL("https://x/api/foss/alpaca/account?mode=none"), "/api/foss/alpaca/account", "s", ctxNone);
    expect(ctxNone.audit).not.toHaveBeenCalled();
    const ctxEnv = restCtx({ env: { FOSS_ALPACA_READS_MODE: "none" } });
    await handleAlpacaFossRoutes(new Request("https://x/api/foss/alpaca/account"), new URL("https://x/api/foss/alpaca/account"), "/api/foss/alpaca/account", "s", ctxEnv);
    expect(ctxEnv.audit).not.toHaveBeenCalled();
  });

  it("F04 /trading/alpaca reads default: NO audit (legacy, #1733 ground preserved); mode selects query/queried", async () => {
    const ctx = restCtx();
    await handleAlpacaTradingRoutes(new Request("https://x/api/trading/alpaca/account"), new URL("https://x/api/trading/alpaca/account"), "/api/trading/alpaca/account", "s", ctx);
    await handleAlpacaTradingRoutes(new Request("https://x/api/trading/alpaca/orders"), new URL("https://x/api/trading/alpaca/orders"), "/api/trading/alpaca/orders", "s", ctx);
    expect(ctx.audit).not.toHaveBeenCalled();
    expect(fossMocks.fns.__lastOrdersStatus).toBe("open");
    const ctxRest = restCtx();
    await handleAlpacaTradingRoutes(new Request("https://x/api/trading/alpaca/account?mode=rest"), new URL("https://x/api/trading/alpaca/account?mode=rest"), "/api/trading/alpaca/account", "s", ctxRest);
    expect((ctxRest.audit as any).mock.calls.map((c: any) => c[0])).toContain("alpaca.account_queried");
    const ctxMcp = restCtx();
    await handleAlpacaTradingRoutes(new Request("https://x/api/trading/alpaca/account?mode=mcp"), new URL("https://x/api/trading/alpaca/account?mode=mcp"), "/api/trading/alpaca/account", "s", ctxMcp);
    expect((ctxMcp.audit as any).mock.calls.map((c: any) => c[0])).toContain("alpaca.account.query");
  });

  it("F05 /foss/alpaca/order default: foss normalization + full audit; trading/mcp modes select their contracts", async () => {
    const ctx = restCtx();
    const res = await handleAlpacaFossRoutes(
      new Request("https://x/api/foss/alpaca/order", { method: "POST", body: JSON.stringify({ symbol: "nvda", quantity: 3, orderAction: "BUY", orderType: "LIMIT", limitPrice: 101 }) }),
      new URL("https://x/api/foss/alpaca/order"),
      "/api/foss/alpaca/order",
      "s",
      ctx
    );
    expect((await getBody(res)).success).toBe(true);
    expect(fossMocks.fns.__lastOrderParams).toMatchObject({ symbol: "NVDA", qty: 3, side: "buy", type: "limit", limit_price: 101 });
    const payload = (ctx.audit as any).mock.calls.find((c: any) => c[0] === "alpaca.order_placed")![2];
    expect(payload).toMatchObject({ symbol: "NVDA", qty: 3, side: "buy", type: "limit", limitPrice: 101, orderId: "ord1", success: true });
    const ctxTrading = restCtx();
    await handleAlpacaFossRoutes(
      new Request("https://x/api/foss/alpaca/order", { method: "POST", body: JSON.stringify({ symbol: " nvda ", mode: "trading" }) }),
      new URL("https://x/api/foss/alpaca/order"),
      "/api/foss/alpaca/order",
      "s",
      ctxTrading
    );
    expect(fossMocks.fns.__lastOrderParams).toMatchObject({ symbol: "nvda", qty: 1 });
    expect((ctxTrading.audit as any).mock.calls.find((c: any) => c[0] === "alpaca.order_placed")![2]).toEqual({
      symbol: "nvda",
      qty: 1,
      side: "buy",
      status: "accepted",
    });
    const ctxMcp = restCtx();
    await handleAlpacaFossRoutes(
      new Request("https://x/api/foss/alpaca/order", { method: "POST", body: JSON.stringify({ symbol: "nvda", qty: 2, side: "buy", mode: "mcp" }) }),
      new URL("https://x/api/foss/alpaca/order"),
      "/api/foss/alpaca/order",
      "s",
      ctxMcp
    );
    expect(fossMocks.fns.__lastOrderParams).toMatchObject({ symbol: "nvda", qty: 2 });
    expect((ctxMcp.audit as any).mock.calls.map((c: any) => c[0])).toContain("alpaca.order.place");
  });

  it("F05 /trading/alpaca/order default: trading normalization + minimal audit; foss mode selects foss contract", async () => {
    const ctx = restCtx();
    await handleAlpacaTradingRoutes(
      new Request("https://x/api/trading/alpaca/order", { method: "POST", body: JSON.stringify({ symbol: " nvda " }) }),
      new URL("https://x/api/trading/alpaca/order"),
      "/api/trading/alpaca/order",
      "s",
      ctx
    );
    expect(fossMocks.fns.__lastOrderParams).toMatchObject({ symbol: "nvda", qty: 1, side: "buy" });
    expect((ctx.audit as any).mock.calls.find((c: any) => c[0] === "alpaca.order_placed")![2]).toEqual({
      symbol: "nvda",
      qty: 1,
      side: "buy",
      status: "accepted",
    });
    const ctxFoss = restCtx();
    await handleAlpacaTradingRoutes(
      new Request("https://x/api/trading/alpaca/order", { method: "POST", body: JSON.stringify({ symbol: "nvda", quantity: 4, orderAction: "SELL", orderType: "LIMIT", limitPrice: 99, mode: "foss" }) }),
      new URL("https://x/api/trading/alpaca/order"),
      "/api/trading/alpaca/order",
      "s",
      ctxFoss
    );
    expect(fossMocks.fns.__lastOrderParams).toMatchObject({ symbol: "NVDA", qty: 4, side: "sell", type: "limit", limit_price: 99 });
    expect((ctxFoss.audit as any).mock.calls.find((c: any) => c[0] === "alpaca.order_placed")![2]).toMatchObject({
      symbol: "NVDA",
      type: "limit",
      limitPrice: 99,
      orderId: "ord1",
      success: true,
    });
  });

  it("F05 order routes keep their missing-symbol 400s in every mode", async () => {
    const ctx = restCtx();
    const res = await handleAlpacaFossRoutes(
      new Request("https://x/api/foss/alpaca/order", { method: "POST", body: JSON.stringify({ qty: 1 }) }),
      new URL("https://x/api/foss/alpaca/order"),
      "/api/foss/alpaca/order",
      "s",
      ctx
    );
    expect(res!.status).toBe(400);
    const ctxT = restCtx();
    const resT = await handleAlpacaTradingRoutes(
      new Request("https://x/api/trading/alpaca/order", { method: "POST", body: JSON.stringify({}) }),
      new URL("https://x/api/trading/alpaca/order"),
      "/api/trading/alpaca/order",
      "s",
      ctxT
    );
    expect(resT!.status).toBe(400);
  });
});
