/**
 * Issue #223: autonomous options-analysis runs were only ever visible in the
 * live broadcast. The scheduler now keeps the last 20 runs in Durable Object
 * storage and `GET /api/options/latest` reads them back.
 *
 * Pinned here: the retention rule (newest first, capped), the "history is
 * auxiliary" contract (a storage miss never invents runs and never throws on
 * the write path), and the route's own behaviour.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  OPTIONS_RUNS_KEY,
  OPTIONS_RUNS_LIMIT,
  readOptionsRuns,
  recordOptionsRun,
  type OptionsRunRecord,
} from "../src/agents/optionsRuns";
import {
  handleEtradeOptionsRoutes,
  type EtradeOptionsRouteContext,
} from "../src/agents/routes/etradeOptions";

function makeRun(overrides: Partial<OptionsRunRecord> = {}): OptionsRunRecord {
  return {
    timestamp: "2026-10-20T12:00:00.000Z",
    success: true,
    trigger: "scheduled",
    thesis: "bullish",
    symbols: ["AAPL", "NVDA"],
    withTrades: 2,
    summary: "2 setups",
    opportunities: [{ symbol: "AAPL" }],
    ...overrides,
  };
}

function memoryStorage(initial: Record<string, unknown> = {}) {
  const store = new Map<string, unknown>(Object.entries(initial));
  return {
    store,
    get: vi.fn(async (key: string) => store.get(key)),
    put: vi.fn(async (key: string, value: unknown) => {
      store.set(key, value);
    }),
  };
}

function routeContext(storage: unknown): EtradeOptionsRouteContext {
  return {
    env: {} as any,
    getOrm: () => ({}) as any,
    agentCtx: { storage } as any,
    ensureTables: () => ({}) as any,
    requestedEnv: undefined,
    getScreenerAgent: vi.fn() as any,
  } as unknown as EtradeOptionsRouteContext;
}

async function callLatest(storage: unknown, method = "GET") {
  const url = new URL("https://agent.internal/options/latest");
  return handleEtradeOptionsRoutes(
    new Request(url, { method }),
    url,
    "/options/latest",
    "session-1",
    routeContext(storage)
  );
}

describe("options run history (#223)", () => {
  it("prepends runs so the newest is first", async () => {
    const storage = memoryStorage();
    await recordOptionsRun(storage, makeRun({ timestamp: "2026-10-20T11:00:00.000Z" }));
    await recordOptionsRun(storage, makeRun({ timestamp: "2026-10-20T12:00:00.000Z" }));

    const runs = await readOptionsRuns(storage);
    expect(runs.map((r) => r.timestamp)).toEqual([
      "2026-10-20T12:00:00.000Z",
      "2026-10-20T11:00:00.000Z",
    ]);
  });

  it(`retains at most ${OPTIONS_RUNS_LIMIT} runs`, async () => {
    const storage = memoryStorage();
    for (let i = 0; i < OPTIONS_RUNS_LIMIT + 5; i++) {
      await recordOptionsRun(storage, makeRun({ timestamp: `2026-10-20T12:${String(i).padStart(2, "0")}:00.000Z` }));
    }
    const runs = await readOptionsRuns(storage);
    expect(runs).toHaveLength(OPTIONS_RUNS_LIMIT);
    // The newest write leads; the oldest five fell off the tail.
    expect(runs[0].timestamp).toBe(`2026-10-20T12:${String(OPTIONS_RUNS_LIMIT + 4).padStart(2, "0")}:00.000Z`);
  });

  it("does not fabricate history when storage is unavailable", async () => {
    expect(await readOptionsRuns(undefined)).toEqual([]);
    const recorded = await recordOptionsRun(undefined, makeRun());
    expect(recorded).toHaveLength(1);
  });

  it("treats a non-array stored value as empty history", async () => {
    const storage = memoryStorage({ [OPTIONS_RUNS_KEY]: { not: "an array" } });
    expect(await readOptionsRuns(storage)).toEqual([]);
  });

  it("serves GET /options/latest from DO storage", async () => {
    const storage = memoryStorage({ [OPTIONS_RUNS_KEY]: [makeRun()] });
    const res = await callLatest(storage);
    expect(res?.status).toBe(200);
    const body = (await res!.json()) as any;
    expect(body.count).toBe(1);
    expect(body.runs[0].symbols).toEqual(["AAPL", "NVDA"]);
    expect(body.timestamp).toBeTruthy();
  });

  it("reports a storage failure as a 500 instead of an empty success", async () => {
    const storage = {
      get: vi.fn(async () => {
        throw new Error("storage down");
      }),
      put: vi.fn(),
    };
    const res = await callLatest(storage);
    expect(res?.status).toBe(500);
    const body = (await res!.json()) as any;
    expect(body.error).toContain("storage down");
    expect(body.runs).toEqual([]);
  });

  it("leaves non-GET requests on the normal routing path", async () => {
    const res = await callLatest(memoryStorage(), "POST");
    expect(res).toBeNull();
  });

  it("is wired into the scheduled callback, not re-declared in the orchestrator", () => {
    const src = readFileSync(new URL("../src/agents/orchestrator.ts", import.meta.url), "utf-8");
    const start = src.indexOf("async autonomousOptionsAnalysis(");
    const end = src.indexOf("async autonomousStrategyDiscovery(", start);
    const body = src.slice(start, end);
    // Issue #2091: the wrapper delegates to the shared recorder
    // (recordOptionsOrchestratorRun) instead of inlining the writes —
    // the "not re-declared" intent holds, via delegation. The helper
    // itself must still call the shared history writer and log a
    // storage failure instead of swallowing it.
    expect(body).toContain("recordOptionsOrchestratorRun(");
    const helper = readFileSync(new URL("../src/services/optionsServeRecord.ts", import.meta.url), "utf-8");
    expect(helper).toContain("recordOptionsRun(deps.storage");
    expect(helper).toContain("Could not persist options run");
    // The route lives in the options route module.
    expect(src).not.toContain('path.endsWith("/options/latest")');
  });

  it("surfaces the runs in the options schedule panel", () => {
    const ui = [
      "../src/client/ScheduledOptionsManager.tsx",
      "../src/client/scheduledOptionsManager/LatestRunsSection.tsx",
    ]
      .map((p) => readFileSync(new URL(p, import.meta.url), "utf-8"))
      .join("\n");
    expect(ui).toContain("subscribeOptionsLatest(");
    expect(ui).toContain("Latest Autonomous Options Runs");
    expect(ui).toContain("run.summary");
    // A failed run must show its error, not a blank card.
    expect(ui).toContain("run.error");
    // #2470 S4: the fetch itself lives in the shared module now.
    const shared = readFileSync(
      new URL("../src/client/optionsLatestShared.ts", import.meta.url),
      "utf-8",
    );
    expect(shared).toContain('const ENDPOINT = "/api/options/latest"');
    expect(shared).toContain("globalThis.fetch(ENDPOINT)");
  });
});
