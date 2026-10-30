/**
 * Issue #1661 (service-path blob capture, epic #1116) — the slice's NEW behaviour.
 * TDD Red: the threading pins FAIL on the pre-slice tree (constructions without
 * platformDeps/storage, helper/getUniverseDeps without a storage param, route
 * calls without a storage arg) and pass after threading.
 *
 * What each pin proves, honestly:
 *  - Source pins (S1/S3/S4-route-legs): the construction/call site carries the
 *    handle. Mechanism: readFileSync, same precedent as thin_router_inventory.
 *    They prove threading, not a fetched row.
 *  - Module-spy pins (S2/S4-helper): the handle reaches the bundle/adapter call
 *    (captured call input identity). The spy wraps the real function and
 *    delegates to it, so the call still executes; only the input is observed.
 *  - Mechanism pins (precondition, disclosed — they pass on control too):
 *    bundle-with-storage writes a capture row (p1378 :380 pattern) and the
 *    yahoo adapter with capture options writes a capture row. They prove the
 *    mechanism the threaded legs rely on, not the threading itself.
 *  - Contract pins (disclosed — pass on control too): without storage the
 *    helper still builds outcome-only (no capture key in the adapter options).
 *
 * Legs that cannot execute-pin in vitest (no network, DO base unimportable):
 * S1's live capture (scheduled discovery fetch) and S3's discovery run are
 * covered by the helper mechanism pins + source pins + acceptance grep —
 * never claimed as executing fetch pins.
 *
 * No secret-shaped literals: this file contains no credentials, keys, or
 * tokens in any form.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  nasdaqUniverseRouteBundle,
  nasdaqUniverseProviderFromRoute,
  bindNasdaqUniverseDeps,
} from "../src/trading/screenerPipeline";
import { createYahooDataProvider } from "../src/trading/dataProviders/adapters";
import {
  ensureCaptureTable,
  listCapturesByRun,
} from "../src/trading/dataProviders/captureStore";
import { MockSqlStorage } from "./mock-sql";
import type { NasdaqStockListing } from "../src/services/nasdaqListings";

const RUN = { runId: "run-service-capture-1661", tenantId: "test-tenant", userLogin: "tester" };

function fakeBlobStorage() {
  const store = new Map<string, unknown>();
  return {
    get: async (key: string) => store.get(key),
    put: async (key: string, value: unknown) => {
      store.set(key, value);
    },
  };
}

function stubListings(): NasdaqStockListing[] {
  return [
    { symbol: "AAPL", companyName: "Apple Inc.", exchange: "NASDAQ", lastPrice: 150, change: 1, changePercent: 0.5, sector: "Technology", marketCap: 3e12 } as NasdaqStockListing,
    { symbol: "MSFT", companyName: "Microsoft Corp.", exchange: "NASDAQ", lastPrice: 300, change: 1, changePercent: 0.5, sector: "Technology", marketCap: 2.5e12 } as NasdaqStockListing,
  ];
}

const src = (rel: string) => readFileSync(`src/${rel}`, "utf8");

/** Text of the `new ScheduledTasksService` construction immediately before a marker call. */
function constructionBefore(fileSrc: string, marker: string): string {
  const markerIdx = fileSrc.indexOf(marker);
  expect(markerIdx).toBeGreaterThan(-1);
  const ctorIdx = fileSrc.lastIndexOf("new ScheduledTasksService", markerIdx);
  expect(ctorIdx).toBeGreaterThan(-1);
  return fileSrc.slice(ctorIdx, markerIdx);
}

/** The single source line containing a needle. */
function lineWith(fileSrc: string, needle: string): string {
  const line = fileSrc.split("\n").find((l) => l.includes(needle));
  expect(line).toBeDefined();
  return line!;
}

describe("S1 scheduled discovery constructions", () => {
  it("scheduled callback discovery construction passes platformDeps with blobStorage", () => {
    const block = constructionBefore(
      src("agents/orchestrator/scheduledCallbacks.ts"),
      "service.autonomousStrategyDiscovery({ ...payload, userLogin: resolvedLogin, environment })"
    );
    expect(block).toContain("blobStorage");
  });

  it("trigger-discovery route construction passes platformDeps with blobStorage", () => {
    const block = constructionBefore(
      src("agents/routes/schedules.ts"),
      "service.autonomousStrategyDiscovery(built.value"
    );
    expect(block).toContain("blobStorage");
  });
});

describe("S2 fit runner storage threading (module-spy)", () => {
  it("passes storage to the universe bundle call and blobStorage to the history call", async () => {
    vi.resetModules();
    const bundleInputs: any[] = [];
    const historyInputs: any[] = [];
    vi.doMock("../src/trading", async () => {
      const actual: any = await vi.importActual("../src/trading");
      return {
        ...actual,
        nasdaqUniverseRouteBundle: async (input: any) => {
          bundleInputs.push(input);
          return actual.nasdaqUniverseRouteBundle(input);
        },
        resolveYahooHistoryDeps: async (input: any) => {
          historyInputs.push(input);
          return actual.resolveYahooHistoryDeps(input);
        },
      };
    });
    try {
      const { createFitDiscoveryRunner } = await import("../src/services/fitDiscoveryRunner");
      const blob = fakeBlobStorage();
      const sql = new MockSqlStorage();
      ensureCaptureTable(sql as never);
      const runner = createFitDiscoveryRunner({
        env: {} as never,
        userLogin: "tester",
        sql: sql as never,
        settingRead: () => null,
        storage: blob as never,
        provider: {} as never,
      });
      await runner
        .run({ direction: "name_to_strategies", symbol: "AAA", outlook: "bullish" } as never)
        .catch(() => null);
      expect(bundleInputs.length).toBeGreaterThan(0);
      expect(bundleInputs[0].storage).toBe(blob);
      expect(historyInputs.length).toBeGreaterThan(0);
      expect(historyInputs[0].blobStorage).toBe(blob);
    } finally {
      vi.doUnmock("../src/trading");
      vi.resetModules();
    }
  });

  it("without storage the runner still resolves outcome-only (contract, passes on control)", async () => {
    vi.resetModules();
    const bundleInputs: any[] = [];
    const historyInputs: any[] = [];
    vi.doMock("../src/trading", async () => {
      const actual: any = await vi.importActual("../src/trading");
      return {
        ...actual,
        nasdaqUniverseRouteBundle: async (input: any) => {
          bundleInputs.push(input);
          return actual.nasdaqUniverseRouteBundle(input);
        },
        resolveYahooHistoryDeps: async (input: any) => {
          historyInputs.push(input);
          return actual.resolveYahooHistoryDeps(input);
        },
      };
    });
    try {
      const { createFitDiscoveryRunner } = await import("../src/services/fitDiscoveryRunner");
      const sql = new MockSqlStorage();
      ensureCaptureTable(sql as never);
      const runner = createFitDiscoveryRunner({
        env: {} as never,
        userLogin: "tester",
        sql: sql as never,
        settingRead: () => null,
        provider: {} as never,
      });
      await runner
        .run({ direction: "name_to_strategies", symbol: "AAA", outlook: "bullish" } as never)
        .catch(() => null);
      expect(bundleInputs.length).toBeGreaterThan(0);
      expect(bundleInputs[0].storage).toBeUndefined();
      expect(historyInputs.length).toBeGreaterThan(0);
      expect(historyInputs[0].blobStorage).toBeUndefined();
    } finally {
      vi.doUnmock("../src/trading");
      vi.resetModules();
    }
  });
});

describe("S3 discoveryService at asyncJobs", () => {
  it("asyncJobs passes blobStorage to createDiscoveryService", () => {
    const line = lineWith(
      src("agents/orchestrator/asyncJobs.ts"),
      "createDiscoveryService({"
    );
    expect(line).toContain("blobStorage");
  });
});

describe("S4 seam helper + route legs", () => {
  it("seam helper forwards storage into the nasdaq adapter construction", async () => {
    vi.resetModules();
    const adapterOptions: any[] = [];
    vi.doMock("../src/trading/dataProviders/adapters", async () => {
      const actual: any = await vi.importActual("../src/trading/dataProviders/adapters");
      return {
        ...actual,
        verifyNasdaqDataProvider: async () => ({ ok: true, summary: "mocked verify" }),
        createNasdaqDataProvider: (...args: any[]) => {
          adapterOptions.push(args[1]);
          return actual.createNasdaqDataProvider(...args);
        },
      };
    });
    try {
      const { nasdaqUniverseSeamFromSql } = await import("../src/trading/screenerPipeline");
      const sql = new MockSqlStorage();
      ensureCaptureTable(sql as never);
      const blob = fakeBlobStorage();
      const seam = await nasdaqUniverseSeamFromSql(sql as never, {} as never, "tester", blob as never);
      expect(seam?.universeRoute).toBeDefined();
      expect(adapterOptions.length).toBeGreaterThan(0);
      expect(adapterOptions[0]?.capture?.blobStorage).toBe(blob);
    } finally {
      vi.doUnmock("../src/trading/dataProviders/adapters");
      vi.resetModules();
    }
  });

  it("seam helper without storage builds outcome-only (contract, passes on control)", async () => {
    vi.resetModules();
    const adapterOptions: any[] = [];
    vi.doMock("../src/trading/dataProviders/adapters", async () => {
      const actual: any = await vi.importActual("../src/trading/dataProviders/adapters");
      return {
        ...actual,
        verifyNasdaqDataProvider: async () => ({ ok: true, summary: "mocked verify" }),
        createNasdaqDataProvider: (...args: any[]) => {
          adapterOptions.push(args[1]);
          return actual.createNasdaqDataProvider(...args);
        },
      };
    });
    try {
      const { nasdaqUniverseSeamFromSql } = await import("../src/trading/screenerPipeline");
      const sql = new MockSqlStorage();
      ensureCaptureTable(sql as never);
      const seam = await nasdaqUniverseSeamFromSql(sql as never, {} as never, "tester");
      expect(seam?.universeRoute).toBeDefined();
      expect(adapterOptions.length).toBeGreaterThan(0);
      expect(adapterOptions[0]?.capture).toBeUndefined();
      expect(adapterOptions[0]?.outcomeRecorder).toBeDefined();
    } finally {
      vi.doUnmock("../src/trading/dataProviders/adapters");
      vi.resetModules();
    }
  });

  it("getUniverseDeps forwards storage into the seam", async () => {
    vi.resetModules();
    const adapterOptions: any[] = [];
    vi.doMock("../src/trading/dataProviders/adapters", async () => {
      const actual: any = await vi.importActual("../src/trading/dataProviders/adapters");
      return {
        ...actual,
        verifyNasdaqDataProvider: async () => ({ ok: true, summary: "mocked verify" }),
        createNasdaqDataProvider: (...args: any[]) => {
          adapterOptions.push(args[1]);
          return actual.createNasdaqDataProvider(...args);
        },
      };
    });
    try {
      const { ETradeService } = await import("../src/services/etrade");
      const sql = new MockSqlStorage();
      ensureCaptureTable(sql as never);
      const blob = fakeBlobStorage();
      // The ctor detects an ORM by `"trades" in ormOrEnv` — the mock
      // must carry it or the service treats it as Env and orm is lost.
      const orm = { trades: {}, getSql: () => sql } as never;
      const etrade = new ETradeService(orm, {} as never, "tester");
      const deps = await etrade.getUniverseDeps(blob as never);
      expect(deps).toBeDefined();
      expect(adapterOptions.length).toBeGreaterThan(0);
      expect(adapterOptions[0]?.capture?.blobStorage).toBe(blob);
    } finally {
      vi.doUnmock("../src/trading/dataProviders/adapters");
      vi.resetModules();
    }
  });

  it("all six options-discovery route sites pass storage to getUniverseDeps (none bare)", () => {
    const calls: string[] = [];
    for (const rel of ["agents/routes/etradeOptions.ts", "agents/routes/etradeOptionsEvaluate.ts"]) {
      for (const line of src(rel).split("\n")) {
        if (line.includes("getUniverseDeps?.(")) calls.push(line.trim());
      }
    }
    expect(calls.length).toBe(6);
    for (const call of calls) {
      expect(call).not.toMatch(/getUniverseDeps\?\.\(\)/);
    }
  });

  it("backtest route passes blobStorage to resolveYahooHistoryDeps", () => {
    const fileSrc = src("agents/routes/screenerResearch.ts");
    const start = fileSrc.indexOf("resolveYahooHistoryDeps({");
    expect(start).toBeGreaterThan(-1);
    const span = fileSrc.slice(start, fileSrc.indexOf("});", start));
    expect(span).toContain("blobStorage");
  });

  it("NLQ route site passes blobStorage + storage to the discovery runners", () => {
    const line = lineWith(
      src("agents/routes/mcpChatNlq.ts"),
      "createDiscoveryService({"
    );
    expect(line).toContain("blobStorage");
    expect(line).toContain("storage:");
  });

  it("trading-integrations route site passes blobStorage + storage to the discovery runners", () => {
    const fileSrc = src("agents/routes/tradingIntegrations.ts");
    const disc = lineWith(fileSrc, "discoveryRunner: createDiscoveryService({");
    expect(disc).toContain("blobStorage");
    const fit = lineWith(fileSrc, "fitDiscoveryRunner: createFitDiscoveryRunner({");
    expect(fit).toContain("storage:");
  });
});

describe("mechanism pins (precondition, disclosed — pass on control too)", () => {
  it("bundle with storage writes a capture row under the run id (p1378 :380 pattern)", async () => {
    const sql = new MockSqlStorage();
    ensureCaptureTable(sql as never);
    const bundle = await nasdaqUniverseRouteBundle({
      sql: sql as never,
      storage: fakeBlobStorage() as never,
      env: {} as never,
      userLogin: "tester",
      runId: RUN.runId,
      tenantId: RUN.tenantId,
      fetchListings: (async () => stubListings()) as never,
    });
    const provider = nasdaqUniverseProviderFromRoute(bundle.registry, bundle.configs, bundle.routes);
    const deps = bindNasdaqUniverseDeps(provider, bundle.runContext);
    expect(await deps.fetchListings()).toEqual(stubListings());
    const byRun = listCapturesByRun(sql as never, RUN.tenantId, RUN.runId);
    expect(byRun.length).toBe(1);
    expect(byRun[0].providerId).toBe("nasdaq");
    expect(byRun[0].rawSha256).toBeTruthy();
  });

  it("yahoo adapter with capture options writes a capture row for historicalBars", async () => {
    const sql = new MockSqlStorage();
    ensureCaptureTable(sql as never);
    const blob = fakeBlobStorage();
    const stubMarketData = {
      isConfigured: () => true,
      getHistoricalBars: async () => [
        { date: "2026-09-01", open: 100, high: 101, low: 99, close: 100.5, volume: 1000 },
      ],
    } as never;
    const adapter = createYahooDataProvider(stubMarketData, {} as never, {
      capture: { sql: sql as never, blobStorage: blob as never, env: {} as never },
    } as never);
    const res = await adapter.getHistoricalBars!("AAA", "1D", 60, {
      runId: RUN.runId,
      tenantId: RUN.tenantId,
      userLogin: "tester",
    });
    expect(res.result).toBeDefined();
    const byRun = listCapturesByRun(sql as never, RUN.tenantId, RUN.runId);
    expect(byRun.length).toBe(1);
    expect(byRun[0].providerId).toBe("yahoo");
    expect(byRun[0].capability).toBe("historicalBars");
    expect(byRun[0].rawSha256).toBeTruthy();
  });
});
