/**
 * #1734 (parent #1717, slice (n)): cloudflare / browser / misc MCP
 * unpaired + divergent tools — scan appendix (n).
 *
 * Red pins for this slice:
 * - The (n) pairing decisions live in the pure port
 *   src/config/cloudflareBrowserMiscModes.ts: browser + webhook +
 *   sandbox stay MCP-only, backtest is NOT the REST backtest's pair
 *   (synthetic demo vs walk-forward live-history — distinct
 *   operations), ai_search is divergent-by-design vs knowledge_search
 *   (M01 / #1723, different corpus + envelope — KNOWLEDGE_MODE does
 *   not govern it), think is a CONFIRMED pair (one harness, both
 *   surfaces) whose only input gap was accountBalanceUSD.
 * - execute_durable_twap consumes #1726's ETRADE_PREVIEW_MODE
 *   (local | broker) instead of hardcoding the local draft: run >
 *   session > user > global env > builtin local; invalid fails closed
 *   to local + etrade.config_error audit; broker slices run through
 *   previewOrderRemote; the envelope labels previewMode. Preview-only
 *   in BOTH modes: executed:false, HITL execution still required, the
 *   E04 execute gate is never switched.
 * - think_trade_validation forwards accountBalanceUSD to the harness
 *   (the REST route already accepted it; the MCP tool did not).
 * - No new switch is invented here and no endpoint is removed:
 *   the port's switch list is deliberately empty.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";
import {
  N_PAIRING_DECISIONS,
  N_1734_SWITCHES,
} from "../src/config/cloudflareBrowserMiscModes";
import {
  BrowserInspectCommand,
  BrowserScreenshotCommand,
  DispatchTradingWebhookCommand,
  SandboxRunCommand,
  QuantBacktestCommand,
  ThinkTradeValidationCommand,
  AISearchFinancialDocsCommand,
  DurableTWAPOrderCommand,
} from "../src/mcp/cloudflareAgentCommands";
import { ETradeService } from "../src/services/etrade";
import { ETradeThinkHarness } from "../src/services/thinkHarness";

const stubContext = (auditLog: any[], env: Record<string, unknown> = {}) => {
  const orm = new DatabaseORM(new MockSqlStorage());
  orm.initializeSchema("test-session");
  return {
    env: { ETRADE_ENVIRONMENT: "sandbox", ...env },
    orm,
    sessionId: "test-session",
    audit: (type: string, agent: any, payload: Record<string, unknown>) =>
      auditLog.push({ type, agent, payload }),
  } as any;
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("#1734 pairing-decision port", () => {
  it("covers all eight (n) tools, with no invented switch", () => {
    expect(N_1734_SWITCHES).toEqual([]);
    const tools = N_PAIRING_DECISIONS.map((d) => d.tool).sort();
    expect(tools).toEqual(
      [
        "ai_search_financial_docs",
        "browser_inspect_page",
        "browser_screenshot",
        "dispatch_trading_webhook",
        "execute_durable_twap",
        "run_quant_backtest",
        "run_sandbox_command",
        "think_trade_validation",
      ].sort()
    );
  });

  it("pins browser + webhook + sandbox as MCP-only (their neighbours are different operations)", () => {
    const byTool = new Map(N_PAIRING_DECISIONS.map((d) => [d.tool, d]));
    expect(byTool.get("browser_inspect_page")?.pairing).toBe("mcp-only");
    expect(byTool.get("browser_screenshot")?.pairing).toBe("mcp-only");
    expect(byTool.get("dispatch_trading_webhook")?.pairing).toBe("mcp-only");
    expect(byTool.get("run_sandbox_command")?.pairing).toBe("mcp-only");
    // The neighbours the scan warns against filing as pairs are named,
    // so a future reader cannot mistake them for pairs.
    expect(byTool.get("browser_screenshot")?.restNeighbour).toContain("browser/snapshot");
    expect(byTool.get("dispatch_trading_webhook")?.restNeighbour).toContain("nlq/webhook");
  });

  it("pins backtest as distinct operations, not a pair", () => {
    const row = N_PAIRING_DECISIONS.find((d) => d.tool === "run_quant_backtest");
    expect(row?.pairing).toBe("distinct-operations");
    expect(row?.justification).toContain("synthetic");
    expect(row?.justification).toContain("walk-forward");
  });

  it("pins ai_search as divergent-by-design vs knowledge_search (M01 / #1723), not governed by KNOWLEDGE_MODE", () => {
    const row = N_PAIRING_DECISIONS.find((d) => d.tool === "ai_search_financial_docs");
    expect(row?.pairing).toBe("divergent-by-design");
    expect(row?.justification).toContain("KNOWLEDGE_MODE");
    expect(row?.justification).toContain("1723");
  });

  it("pins think as a confirmed pair on one harness", () => {
    const row = N_PAIRING_DECISIONS.find((d) => d.tool === "think_trade_validation");
    expect(row?.pairing).toBe("confirmed-pair");
    expect(row?.restNeighbour).toContain("etrade/think/evaluate");
  });

  it("command names match the port rows exactly", () => {
    const commands = [
      new BrowserInspectCommand(),
      new BrowserScreenshotCommand(),
      new DispatchTradingWebhookCommand(),
      new SandboxRunCommand(),
      new QuantBacktestCommand(),
      new ThinkTradeValidationCommand(),
      new AISearchFinancialDocsCommand(),
      new DurableTWAPOrderCommand(),
    ];
    expect(commands.map((c) => c.name).sort()).toEqual(
      N_PAIRING_DECISIONS.map((d) => d.tool).sort()
    );
  });

  it("honesty markers survive: sandbox executed:false, TWAP preview-only, backtest synthetic", () => {
    expect(new SandboxRunCommand().description).toContain("executed:false");
    expect(new DurableTWAPOrderCommand().description).toContain("does NOT place orders");
    expect(new QuantBacktestCommand().description).toContain("SYNTHETIC");
  });
});

describe("#1734 execute_durable_twap consumes ETRADE_PREVIEW_MODE (#1726)", () => {
  it("defaults to the local draft (legacy) and labels previewMode local", async () => {
    const localSpy = vi
      .spyOn(ETradeService.prototype, "previewOrder")
      .mockImplementation(() => ({ orderId: "ord_local", status: "previewed", estimatedPrice: 100, estimatedTotal: 500 } as any));
    const remoteSpy = vi.spyOn(ETradeService.prototype, "previewOrderRemote");
    const auditLog: any[] = [];
    const result: any = await new DurableTWAPOrderCommand().execute(
      { symbol: "NVDA", action: "BUY", totalQuantity: 10, slices: 2 },
      stubContext(auditLog)
    );
    expect(result.previewMode).toBe("local");
    expect(result.status).toBe("previewed");
    expect(result.executed).toBe(false);
    expect(localSpy).toHaveBeenCalledTimes(2);
    expect(remoteSpy).not.toHaveBeenCalled();
    expect(auditLog).toHaveLength(1);
    expect(auditLog[0].type).toBe("twap.previewed");
    expect(auditLog[0].payload.previewMode).toBe("local");
    expect(auditLog[0].payload.executed).toBe(false);
  });

  it("run mode=broker previews every slice through previewOrderRemote and labels it", async () => {
    const remoteSpy = vi
      .spyOn(ETradeService.prototype, "previewOrderRemote")
      .mockImplementation(async () => ({ orderId: "ord_broker", status: "previewed", estimatedPrice: 101, estimatedTotal: 505 } as any));
    const localSpy = vi.spyOn(ETradeService.prototype, "previewOrder");
    const auditLog: any[] = [];
    const result: any = await new DurableTWAPOrderCommand().execute(
      { symbol: "NVDA", action: "BUY", totalQuantity: 10, slices: 2, mode: "broker" },
      stubContext(auditLog)
    );
    expect(result.previewMode).toBe("broker");
    expect(result.status).toBe("previewed");
    expect(result.executed).toBe(false);
    expect(remoteSpy).toHaveBeenCalledTimes(2);
    expect(localSpy).not.toHaveBeenCalled();
    expect(result.previews.every((p: any) => p.orderId === "ord_broker")).toBe(true);
    expect(auditLog[0].payload.previewMode).toBe("broker");
  });

  it("env ETRADE_PREVIEW_MODE=broker selects broker without a run mode", async () => {
    const remoteSpy = vi
      .spyOn(ETradeService.prototype, "previewOrderRemote")
      .mockImplementation(async () => ({ orderId: "ord_env", status: "previewed", estimatedPrice: 102, estimatedTotal: 102 } as any));
    const auditLog: any[] = [];
    const result: any = await new DurableTWAPOrderCommand().execute(
      { symbol: "NVDA", action: "SELL", totalQuantity: 1, slices: 1 },
      stubContext(auditLog, { ETRADE_PREVIEW_MODE: "broker" })
    );
    expect(result.previewMode).toBe("broker");
    expect(remoteSpy).toHaveBeenCalledTimes(1);
  });

  it("an invalid mode fails closed to local and audits etrade.config_error", async () => {
    const localSpy = vi
      .spyOn(ETradeService.prototype, "previewOrder")
      .mockImplementation(() => ({ orderId: "ord_local", status: "previewed", estimatedPrice: 100, estimatedTotal: 100 } as any));
    const auditLog: any[] = [];
    const result: any = await new DurableTWAPOrderCommand().execute(
      { symbol: "NVDA", action: "BUY", totalQuantity: 1, slices: 1, mode: "bogus" },
      stubContext(auditLog)
    );
    expect(result.previewMode).toBe("local");
    expect(localSpy).toHaveBeenCalledTimes(1);
    const configError = auditLog.find((e) => e.type === "etrade.config_error");
    expect(configError).toBeDefined();
    expect(configError.payload.switch).toBe("ETRADE_PREVIEW_MODE");
    expect(configError.payload.failedClosedTo).toBe("local");
    expect(auditLog.find((e) => e.type === "twap.previewed")).toBeDefined();
  });

  it("the mode input is in the tool schema (json + zod)", () => {
    const cmd = new DurableTWAPOrderCommand();
    expect((cmd.jsonSchema.properties as any).mode).toBeDefined();
    const parsed: any = cmd.zodSchema.parse({
      symbol: "NVDA",
      action: "BUY",
      totalQuantity: 10,
      slices: 2,
      mode: "broker",
    });
    expect(parsed.mode).toBe("broker");
  });
});

describe("#1734 think_trade_validation forwards accountBalanceUSD", () => {
  it("passes the REST route's optional balance input through to the harness", async () => {
    let captured: any = null;
    vi.spyOn(ETradeThinkHarness.prototype, "evaluateTradeWithThinking").mockImplementation(async (input: any) => {
      captured = input;
      return { approved: true, recommendation: "APPROVE" } as any;
    });
    const auditLog: any[] = [];
    await new ThinkTradeValidationCommand().execute(
      { symbol: "NVDA", action: "BUY", quantity: 10, accountBalanceUSD: 12345 },
      stubContext(auditLog)
    );
    expect(captured.accountBalanceUSD).toBe(12345);
    expect(captured.symbol).toBe("NVDA");
    expect(captured.userLogin).toBe("test-session");
    expect(auditLog[0].type).toBe("think.evaluated");
  });

  it("the balance input is in the tool schema (json + zod)", () => {
    const cmd = new ThinkTradeValidationCommand();
    expect((cmd.jsonSchema.properties as any).accountBalanceUSD).toBeDefined();
    const parsed: any = cmd.zodSchema.parse({
      symbol: "NVDA",
      action: "BUY",
      quantity: 10,
      accountBalanceUSD: 12345,
    });
    expect(parsed.accountBalanceUSD).toBe(12345);
  });
});
