/**
 * #1169 S4-2 (revised scope): MAS searchKnowledge gets a SearchHub UI
 * instead of being retired. The retire plan is cancelled by user
 * directive — mas.ts is untouched; this file pins only the NEW route
 * (POST /search/mas) and the tab wiring around the unchanged tool.
 *
 * On the pristine tree these pins fail: the route 404s (handler
 * returns null) and the tab is absent. The 401/400 pins fail too —
 * no handler means no gate at all. Pins are node-env, no DOM; the
 * tool itself is invoked (not reimplemented), with a stubbed sql
 * store and a stubbed global fetch standing in for the AI Search
 * endpoint. The shared isolate cache is reset between tests so no
 * pin reads another pin's cached result.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { handleSearchHubRoutes } from "../src/agents/routes/searchHub";
import { __resetAiSearchCacheForTests } from "../src/services/aiSearchCache";

const REPORT_ROWS = [
  {
    id: "screener:bf-1",
    run_id: "screener:bf-1",
    title: "Market screen — ALL (bf-1)",
    source: "screener",
    summary: "Scanned 10 symbols, 2 matched.",
    body: "{}",
    created_at: "2026-10-28T00:00:00Z",
    body_r2_key: null,
  },
  {
    id: "goal-screen:bf-1",
    run_id: "goal-screen:bf-1",
    title: "Goal screen — growth (bullish)",
    source: "goal_screen",
    summary: "Goal screen done: 3 hits.",
    body: "{}",
    created_at: "2026-10-28T00:00:00Z",
    body_r2_key: null,
  },
];

function stubSql(rows: unknown[]) {
  return {
    exec: (query: string, ..._args: unknown[]) => {
      if (/^\s*SELECT/i.test(query)) return rows;
      return [];
    },
  };
}

function stubFetch(chunks: unknown[] | null, status = 200) {
  return async (_url: unknown, _init: unknown) => {
    if (chunks === null) {
      return { ok: false, status, json: async () => ({}) };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ result: { chunks } }),
    };
  };
}

let originalFetch: typeof fetch;

beforeEach(() => {
  __resetAiSearchCacheForTests();
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const callMas = (
  body: unknown,
  opts: { login?: string | null; sql?: unknown; env?: Record<string, unknown>; sessionId?: string } = {}
) => {
  const login = opts.login === undefined ? "tester" : opts.login;
  globalThis.fetch = stubFetch([{ title: "Doc A", snippet: "Alpha." }]) as any;
  return handleSearchHubRoutes(
    new Request("https://agent.internal/api/search/mas", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(login ? { "x-user-login": login } : {}),
      },
      body: JSON.stringify(body),
    }),
    new URL("https://agent.internal/api/search/mas"),
    "/api/search/mas",
    opts.sessionId ?? "sess-mas-1",
    {
      env: (opts.env ?? {}) as any,
      userLogin: login ?? "",
      sql: opts.sql as any,
      audit: () => {},
    } as any
  );
};

describe("#1169 S4-2 MAS search hub route", () => {
  it("POST /search/mas requires a session (shared 401)", async () => {
    const res = await callMas({ query: "options risk" }, { login: null, sql: stubSql([]) });
    expect(res).not.toBeNull();
    expect(res!.status).toBe(401);
    expect(await res!.json()).toEqual({
      success: false,
      error: "An authenticated E*TRADE account is required.",
    });
  });

  it("POST /search/mas rejects an empty query", async () => {
    const res = await callMas({ query: "  " }, { sql: stubSql([]) });
    expect(res).not.toBeNull();
    expect(res!.status).toBe(400);
  });

  it("POST /search/mas returns an honest 500 when sql is absent", async () => {
    const res = await callMas({ query: "options risk" }, { sql: undefined });
    expect(res).not.toBeNull();
    expect(res!.status).toBe(500);
    const body = await res!.json();
    expect(body.error).toMatch(/report store/);
  });

  it("merged shape: report chunks first, then index chunks, capped at 5", async () => {
    globalThis.fetch = stubFetch([
      { title: "Index 1", snippet: "One." },
      { title: "Index 2", snippet: "Two." },
      { title: "Index 3", snippet: "Three." },
      { title: "Index 4", snippet: "Four." },
    ]) as any;
    const res = await handleSearchHubRoutes(
      new Request("https://agent.internal/api/search/mas", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-user-login": "tester" },
        body: JSON.stringify({ query: "options risk" }),
      }),
      new URL("https://agent.internal/api/search/mas"),
      "/api/search/mas",
      "sess-mas-merged",
      { env: {} as any, userLogin: "tester", sql: stubSql(REPORT_ROWS) as any, audit: () => {} } as any
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = await res!.json();
    expect(body.query).toBe("options risk");
    expect(body.reportCount).toBe(2);
    expect(body.count).toBe(4);
    expect(body.chunks).toHaveLength(5);
    expect(body.chunks[0].source).toBe("scheduled_report");
    expect(body.chunks[1].source).toBe("scheduled_report");
    expect(body.chunks[2].title).toBe("Index 1");
    expect(body.source).toBe("Scheduled reports + Cloudflare AI Search");
  });

  it("upstream failure surfaces local reports honestly, resultsFound true", async () => {
    globalThis.fetch = stubFetch(null, 503) as any;
    const res = await handleSearchHubRoutes(
      new Request("https://agent.internal/api/search/mas", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-user-login": "tester" },
        body: JSON.stringify({ query: "options risk" }),
      }),
      new URL("https://agent.internal/api/search/mas"),
      "/api/search/mas",
      "sess-mas-local",
      { env: {} as any, userLogin: "tester", sql: stubSql(REPORT_ROWS) as any, audit: () => {} } as any
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = await res!.json();
    expect(body.resultsFound).toBe(true);
    expect(body.count).toBe(0);
    expect(body.reportCount).toBe(2);
    expect(body.chunks).toHaveLength(2);
    expect(body.message).toMatch(/locally/);
    expect(body.message).toMatch(/unavailable \(503\)/);
    expect(body.source).toBe("Scheduled reports");
  });

  it("total failure returns the error shape with no stub content", async () => {
    globalThis.fetch = stubFetch(null, 503) as any;
    const res = await handleSearchHubRoutes(
      new Request("https://agent.internal/api/search/mas", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-user-login": "tester" },
        body: JSON.stringify({ query: "options risk" }),
      }),
      new URL("https://agent.internal/api/search/mas"),
      "/api/search/mas",
      "sess-mas-total",
      { env: {} as any, userLogin: "tester", sql: stubSql([]) as any, audit: () => {} } as any
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = await res!.json();
    expect(body.error).toBe("Knowledge search upstream returned 503");
    expect(body.query).toBe("options risk");
    expect(body.chunks ?? []).toHaveLength(0);
  });

  it("flag-off passthrough: the route adds no provenance fields itself", async () => {
    globalThis.fetch = stubFetch([{ title: "Plain doc", snippet: "No provenance." }]) as any;
    const res = await handleSearchHubRoutes(
      new Request("https://agent.internal/api/search/mas", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-user-login": "tester" },
        body: JSON.stringify({ query: "plain doc query" }),
      }),
      new URL("https://agent.internal/api/search/mas"),
      "/api/search/mas",
      "sess-mas-flagoff",
      { env: {} as any, userLogin: "tester", sql: stubSql([]) as any, audit: () => {} } as any
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = await res!.json();
    expect(body.chunks).toHaveLength(1);
    expect(body.chunks[0]).not.toHaveProperty("bucketKey");
    expect(body.chunks[0]).not.toHaveProperty("servedFileLink");
    expect(body.chunks[0]).not.toHaveProperty("indexingState");
  });
});
