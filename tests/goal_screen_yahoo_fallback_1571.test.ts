/**
 * Issue #1571: goal-screen runs lack the #1527 Yahoo fallback when
 * E*TRADE auth is dead. The goal-screen path (autonomousGoalScreen)
 * does NOT go through autonomousMarketScreen's guard, so it has no
 * fallback coverage.
 *
 * Verified auth-dead behavior in-tree (before the fix): the goal
 * stock leg (DynamicMarketScreener.screenLive → acquireUniverse
 * "all-listings") reads the Nasdaq listings feed, not the broker —
 * so it is the guard + the Yahoo stock engine that are missing, not
 * a broker call inside the leg. The options leg
 * (DynamicOptionsScreener over etrade.client) IS broker-dependent
 * and fails per-class on auth-dead; it is unchanged by this slice
 * (stocks only, per the 2026-10-25 ruling).
 *
 * Contract pins (same semantics as #1527):
 * - A guard-blocked goal-screen run with stocks requested completes
 *   via Yahoo (the agent runs the stock leg on the Yahoo engine)
 *   instead of failing/partial-failing silently.
 * - The fallback run carries an explicit providerFallback marker on
 *   the agent request, the returned data, the run_completed audit,
 *   and the stage-chain bridge payload — and the goal PDF provenance
 *   names it as a Yahoo fallback, not plain Yahoo and never
 *   E*TRADE live.
 * - A fallback completion emits NO failure notice (no
 *   goal_screen.run_failed audit); the fallback labeling is the
 *   signal. The guard's deduped episode alert already fired inside
 *   the guard.
 * - A fallback that itself fails goes through the normal failure
 *   path (run_failed audit naming the fallback).
 * - E*TRADE-live runs and options-only runs are unchanged: no
 *   marker, and the guard is not even consulted for options-only
 *   runs (no stock leg to fall back).
 */
import { describe, it, expect, vi } from "vitest";
import { ScheduledTasksService } from "../src/services/scheduledTasks";
import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";
import type { Env } from "../src/types";
import type { GoalDrivenScreenResult } from "../src/services/goalDrivenScreen";
import {
  createYahooStockScreener,
  executeGoalScreenRun,
} from "../src/services/screeningRuntime";
import { generateGoalScreenPdf } from "../src/services/goalScreenReports";
import { STOCK_SCREENING_PROVIDER_ID } from "../src/trading/screeningProvider";

const FALLBACK_MARKER = { from: "etrade", reason: "etrade-auth-dead" } as const;

function fakeGoalResult(overrides: Partial<GoalDrivenScreenResult> = {}): GoalDrivenScreenResult {
  return {
    goalKind: "income",
    outlook: "bullish",
    plan: {
      goalKind: "income",
      outlook: "bullish",
      structures: ["cash_secured_put"],
      stockFilter: {},
      optionsFilter: {},
    },
    status: "complete",
    hits: [
      { assetClass: "stocks", providerId: STOCK_SCREENING_PROVIDER_ID, symbol: "AAPL" },
    ],
    counts: { stocksScanned: 100, stocksMatched: 1, optionsUnderlyingsScanned: 0, optionsContractsMatched: 0, hits: 1 },
    completedAt: "2026-10-25T12:00:00.000Z",
    ...overrides,
  };
}

function goalService(opts: {
  blocked: boolean;
  agentResult: () => GoalDrivenScreenResult;
  followupScheduler?: any;
}) {
  const mockEnv = {
    ETRADE_ENVIRONMENT: "sandbox",
    // #2051: goal_workflow is default-ON; these tests pin the
    // DIRECT fallback path, so they force the flag OFF rather
    // than follow the new default into the workflow path.
    FEATURE_FLAGS: JSON.stringify({ goal_workflow: false }),
  } as unknown as Env;
  const mockOrm = new DatabaseORM(new MockSqlStorage() as any);
  const service = new ScheduledTasksService(mockEnv, mockOrm, "test_trader");
  const audit = vi.fn(() => {});
  const guard = vi.fn(async () => (opts.blocked
    ? { blocked: true as const, error: "⚠️ [FAILURE_AUTH_NO_SESSION] E*TRADE connection missing — scheduled screen is blocked." }
    : { blocked: false as const }));
  const runGoalScreen = vi.fn(async (req: any) => {
    // Faithful stub of the agent contract: the agent echoes the
    // fallback marker onto the result it returns.
    const result = opts.agentResult();
    return {
      task: { id: "task-1", status: "completed" },
      executed: true,
      result: req.providerFallback ? { ...result, providerFallback: req.providerFallback } : result,
    };
  });
  (service as any).audit = audit;
  (service as any).guardScheduledAuth = guard;
  (service as any).getScreenerAgent = () => ({ runGoalScreen });
  if (opts.followupScheduler) (service as any).followupScheduler = opts.followupScheduler;
  return { service, audit, guard, runGoalScreen };
}

describe("goal-screen Yahoo fallback (#1571)", () => {
  it("a guard-blocked run with stocks requested completes via Yahoo with the fallback marker and no failure audit", async () => {
    const bridge = vi.fn(async () => {});
    const { service, audit, guard, runGoalScreen } = goalService({
      blocked: true,
      agentResult: () => fakeGoalResult(),
      followupScheduler: bridge,
    });
    const result = await service.autonomousGoalScreen({
      goalKind: "income",
      stageChain: {} as any,
    });
    expect(result.success).toBe(true);
    // The guard is consulted for the stock leg, exactly once.
    expect(guard).toHaveBeenCalledTimes(1);
    expect(guard.mock.calls[0][2]).toBe("stock");
    // The agent request rides Yahoo + the marker.
    expect(runGoalScreen).toHaveBeenCalledTimes(1);
    const req = runGoalScreen.mock.calls[0][0];
    expect(req.provider).toBe("yahoo");
    expect(req.providerFallback).toEqual({ ...FALLBACK_MARKER });
    // Marker on the returned data and the completion audit.
    expect((result as any).data.providerFallback).toEqual({ ...FALLBACK_MARKER });
    const completed = audit.mock.calls.find((c) => c[0] === "goal_screen.run_completed");
    expect(completed).toBeDefined();
    expect(completed[1].providerFallback).toEqual({ ...FALLBACK_MARKER });
    // No failure notice on fallback success.
    expect(audit.mock.calls.find((c) => c[0] === "goal_screen.run_failed")).toBeUndefined();
    // The stage-chain bridge payload names the fallback.
    expect(bridge).toHaveBeenCalledTimes(1);
    expect(bridge.mock.calls[0][0].providerFallback).toEqual({ ...FALLBACK_MARKER });
  });

  it("a fallback that itself fails takes the normal failure path naming the fallback", async () => {
    const { service, audit, runGoalScreen } = goalService({
      blocked: true,
      agentResult: () => fakeGoalResult({ status: "failed", hits: [], counts: { stocksScanned: 0, stocksMatched: 0, optionsUnderlyingsScanned: 0, optionsContractsMatched: 0, hits: 0 } }),
    });
    const result = await service.autonomousGoalScreen({ goalKind: "income" });
    expect(result.success).toBe(false);
    expect(runGoalScreen).toHaveBeenCalledTimes(1);
    expect(runGoalScreen.mock.calls[0][0].provider).toBe("yahoo");
    const failed = audit.mock.calls.find((c) => c[0] === "goal_screen.run_failed");
    expect(failed).toBeDefined();
    expect(failed[1].providerFallback).toEqual({ ...FALLBACK_MARKER });
  });

  it("an E*TRADE-live run is unchanged: no marker anywhere", async () => {
    const { service, audit, guard, runGoalScreen } = goalService({
      blocked: false,
      agentResult: () => fakeGoalResult(),
    });
    const result = await service.autonomousGoalScreen({ goalKind: "income" });
    expect(result.success).toBe(true);
    expect(guard).toHaveBeenCalledTimes(1);
    const req = runGoalScreen.mock.calls[0][0];
    expect(req.provider).toBeUndefined();
    expect(req.providerFallback).toBeUndefined();
    expect((result as any).data.providerFallback).toBeUndefined();
    const completed = audit.mock.calls.find((c) => c[0] === "goal_screen.run_completed");
    expect(completed[1].providerFallback).toBeUndefined();
  });

  it("an options-only run never consults the guard and carries no marker", async () => {
    const { service, guard, runGoalScreen } = goalService({
      blocked: true,
      agentResult: () => fakeGoalResult(),
    });
    const result = await service.autonomousGoalScreen({
      goalKind: "income",
      assetClasses: ["options"],
    });
    expect(result.success).toBe(true);
    expect(guard).not.toHaveBeenCalled();
    const req = runGoalScreen.mock.calls[0][0];
    expect(req.provider).toBeUndefined();
    expect(req.providerFallback).toBeUndefined();
  });

  it("executeGoalScreenRun stamps the marker onto the recorded result when the agent did not", async () => {
    const mockOrm = new DatabaseORM(new MockSqlStorage() as any);
    const agent = {
      runGoalScreen: vi.fn(async () => ({
        task: { id: "task-9", status: "completed" },
        executed: true,
        result: fakeGoalResult(),
      })),
    };
    const out = await executeGoalScreenRun({
      agent: agent as any,
      orm: mockOrm as any,
      env: {},
      userLogin: "alice",
      scenario: { goalKind: "income", direction: "bullish", portfolioRef: { kind: "hypothetical" } } as any,
      scenarioSource: "built",
      trigger: "scheduled",
      idempotencyKey: "goal-screen:test:1571:stamp",
      provider: "yahoo",
      providerFallback: { ...FALLBACK_MARKER },
    } as any);
    expect(out.executed).toBe(true);
    expect((out.result as any)?.providerFallback).toEqual({ ...FALLBACK_MARKER });
    expect((out as any).providerFallback).toEqual({ ...FALLBACK_MARKER });
  });

  it("the Yahoo stock screener screens live Yahoo quotes, not the listings feed", async () => {
    const yahooDeps = {
      fetchYahooQuote: async (symbol: string) => ({
        symbol,
        provenance: "live",
        price: symbol === "AAPL" ? 200 : 100,
        previousClose: symbol === "AAPL" ? 190 : 100,
        companyName: symbol,
      }),
      fetchYahooBatchQuotes: async (symbols: string[]) => symbols.map((symbol) => ({
        symbol,
        provenance: "live",
        price: symbol === "AAPL" ? 200 : 100,
        previousClose: symbol === "AAPL" ? 190 : 100,
        companyName: symbol,
      })),
    };
    const screener = createYahooStockScreener(yahooDeps as any);
    const result = await screener.screenMarkets({});
    // Both Yahoo symbols screened; AAPL's +5.26% move passes the
    // default screen while the flat symbol does not dominate — the
    // point is the quotes came from the injected Yahoo deps, not
    // from any listings fixture or broker.
    expect(result.totalScanned).toBeGreaterThan(0);
    expect(result.stocks.map((s: any) => s.symbol)).toContain("AAPL");
  });

  it("the goal PDF provenance names a fallback run as a Yahoo fallback, never as E*TRADE live", async () => {
    // pdf-lib draws text as hex strings inside Flate-compressed
    // content streams: inflate every stream, decode the hex runs,
    // and search the decoded text. This asserts on the PDF's actual
    // rendered content, not on its byte layout.
    const { inflateSync } = await import("node:zlib");
    function pdfText(bytes: Uint8Array): string {
      const buf = Buffer.from(bytes);
      const text = buf.toString("latin1");
      const dictRe = /<<[^>]*?\/Length (\d+)[^>]*?>>\s*stream\r?\n/g;
      const parts: string[] = [];
      let dm: RegExpExecArray | null;
      while ((dm = dictRe.exec(text)) !== null) {
        const len = parseInt(dm[1], 10);
        const start = dm.index + dm[0].length;
        const raw = buf.subarray(start, start + len);
        let out: string;
        try {
          out = inflateSync(raw).toString("latin1");
        } catch {
          out = raw.toString("latin1");
        }
        out = out.replace(/<([0-9A-Fa-f]+)>/g, (_m, hex: string) =>
          Buffer.from(hex, "hex").toString("latin1")
        );
        parts.push(out);
      }
      return parts.join("\n");
    }
    const text = pdfText(
      await generateGoalScreenPdf(
        fakeGoalResult({ providerFallback: { ...FALLBACK_MARKER } } as any)
      )
    );
    expect(text).toMatch(/Yahoo/);
    expect(text).toMatch(/fallback/i);
    expect(text).not.toMatch(/E\*TRADE live/);
    // Control: a plain run carries no fallback line.
    const plain = pdfText(await generateGoalScreenPdf(fakeGoalResult()));
    expect(plain).not.toMatch(/fallback/i);
  });
});
