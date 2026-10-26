/**
 * Consolidation #1236 (feed seam): the feed stage job on the async-job
 * substrate — executor branch, completion hook planning the generate
 * stage, per-stage retry, and the feed submission route.
 *
 * The feed handler module is mocked (importOriginal + overridden
 * executor) so no broker is involved; the hook planning function under
 * test is the REAL one.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/services/feedSnapshotJob", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/feedSnapshotJob")>();
  return {
    ...actual,
    executeFeedSnapshotJob: vi.fn(),
  };
});

import { executeFeedSnapshotJob } from "../src/services/feedSnapshotJob";
import {
  submitAsyncJob,
  executeAsyncJob,
  retryAsyncJob,
  type AsyncJobsContext,
} from "../src/agents/orchestrator/asyncJobs";
import { handleSchedulesRoutes } from "../src/agents/routes/schedules";
import type { StrategyRequest } from "../src/trading/options/strategyEngine";

const mockedExecute = vi.mocked(executeFeedSnapshotJob);

const VALID_REQUEST: StrategyRequest = {
  symbol: "NVDA",
  thesis: "bullish",
  targetPrice: 200,
  targetDate: "2027-12-18",
  expectedIvDirection: "unchanged",
  maxPlannedLoss: 500,
  minRewardRisk: 1,
  minDte: 1,
  maxDte: 365,
  allowedStrategies: ["long_call", "long_put"],
  candidateLimit: 5,
};

// Minimal mas_async_jobs fake: real column projection + WHERE
// filtering + status flips, so claim/retry/hook reads behave like
// SQLite for the statements this substrate issues.
class FakeJobSql {
  rows: Array<Record<string, unknown>> = [];

  exec(query: string, ...args: unknown[]): { rowsWritten: number } & Iterable<Record<string, unknown>> {
    const q = query.trim().replace(/\s+/g, " ");
    const done = (rows: Array<Record<string, unknown>>, rowsWritten = 0) =>
      Object.assign([...rows], { rowsWritten });
    if (/^CREATE TABLE/i.test(q) || /^CREATE INDEX/i.test(q) || /^PRAGMA/i.test(q)) return done([]);
    if (/^DELETE FROM/i.test(q)) return done([]);
    if (/^INSERT INTO mas_async_jobs/i.test(q)) {
      const cols = q.match(/\(([^)]+)\)/)![1].split(",").map((c) => c.trim());
      const valueTokens = q.match(/VALUES \(([^)]+)\)/i)![1].split(",").map((c) => c.trim());
      const row: Record<string, unknown> = {};
      let argIndex = 0;
      cols.forEach((col, i) => {
        const token = valueTokens[i];
        row[col] = token === "?" ? (args[argIndex++] ?? null) : token.replace(/^'|'$/g, "");
      });
      this.rows.push(row);
      return done([], 1);
    }
    if (/^INSERT INTO/i.test(q)) return done([]);
    if (/^UPDATE mas_async_jobs/i.test(q)) {
      const setPart = q.match(/SET (.+?) WHERE/i)![1];
      const wherePart = q.match(/WHERE (.+)$/i)![1];
      const assignments = setPart.split(",").map((s) => s.trim());
      const conditions = wherePart.split(" AND ").map((s) => s.trim());
      let argIndex = 0;
      const setValues: Record<string, unknown> = {};
      for (const a of assignments) {
        const [col, token] = a.split("=").map((s) => s.trim());
        setValues[col] = token === "?" ? args[argIndex++] : token.replace(/^'|'$/g, "");
      }
      const condValues: Array<{ col: string; value: unknown }> = [];
      for (const c of conditions) {
        const [col, token] = c.split("=").map((s) => s.trim());
        condValues.push({ col, value: token === "?" ? args[argIndex++] : token.replace(/^'|'$/g, "") });
      }
      let written = 0;
      for (const row of this.rows) {
        if (condValues.every(({ col, value }) => row[col] === value)) {
          Object.assign(row, setValues);
          written++;
        }
      }
      return done([], written);
    }
    if (/^SELECT/i.test(q)) {
      const colsPart = q.match(/SELECT (.+?) FROM mas_async_jobs/i)![1].trim();
      let rows = [...this.rows];
      const whereMatch = q.match(/WHERE (.+)$/i);
      if (whereMatch) {
        const conditions = whereMatch[1].split(" AND ").map((s) => s.trim());
        let argIndex = 0;
        for (const c of conditions) {
          const [col, token] = c.split("=").map((s) => s.trim());
          const value = token === "?" ? args[argIndex++] : token.replace(/^'|'$/g, "");
          rows = rows.filter((r) => r[col] === value);
        }
      }
      if (colsPart === "*") return done(rows);
      const cols = colsPart.split(",").map((c) => c.trim());
      return done(rows.map((r) => Object.fromEntries(cols.map((c) => [c, r[c] ?? null]))));
    }
    throw new Error(`FakeJobSql: unsupported query: ${q.slice(0, 100)}`);
  }
}

function makeCtx(sql: FakeJobSql): AsyncJobsContext {
  return {
    env: {} as any,
    agentCtx: { storage: { sql } } as any,
    ensureTables: () => sql as any,
    sessionKey: () => "tester",
    schedule: vi.fn(async () => ({})) as any,
    audit: vi.fn() as any,
    getOrm: () => ({} as any),
    routeRequest: vi.fn(async () => { throw new Error("routeRequest unused in feed tests"); }) as any,
    nlqSchedulingPort: () => ({} as any),
    nlqStockScreenPort: () => ({} as any),
    followupReportPort: () => ({ getStockPdf: async () => null, getOptionsPdf: async () => null }),
    followupDeliveryPort: () => ({ deliver: async () => ({ ok: true }), notify: async () => ({ ok: true }) }),
  };
}

const FEED_RESULT = {
  status: "completed" as const,
  artifacts: [{
    artifactId: "feed-1", symbol: "NVDA", asOf: "2026-10-26T05:00:00.000Z",
    dataSource: "live", contractCount: 3, loadParams: { symbol: "NVDA", minDte: 1, maxDte: 365 },
  }],
  failures: [],
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("feed.snapshot job on the async-job substrate (#1236)", () => {
  it("plans the generate stage on feed completion, same chain, trigger body carrying the artifacts", async () => {
    const sql = new FakeJobSql();
    const ctx = makeCtx(sql);
    mockedExecute.mockResolvedValueOnce({ ...FEED_RESULT, chainTo: { requests: [VALID_REQUEST] } } as any);
    const chainId = "chain-feed-1";
    const submitted = await submitAsyncJob(ctx, {
      capability: "feed.snapshot",
      payload: {
        userLogin: "tester",
        symbols: [{ symbol: "NVDA", loadParams: { symbol: "NVDA", minDte: 1, maxDte: 365 } }],
        chainTo: { requests: [VALID_REQUEST] },
      },
      stage: "feed",
      chainId,
    } as any);
    await executeAsyncJob(ctx, { jobId: submitted.jobId });
    const feedRow = sql.rows.find((r) => r.job_id === submitted.jobId);
    expect(feedRow?.status).toBe("completed");
    const generateRows = sql.rows.filter((r) => r.capability === "http.request");
    expect(generateRows).toHaveLength(1);
    const generate = generateRows[0];
    expect(generate.stage).toBe("generate");
    expect(generate.chain_id).toBe(chainId);
    expect(generate.parent_job_id).toBe(submitted.jobId);
    const body = JSON.parse(String((JSON.parse(String(generate.payload_json)) as any).body));
    expect(body.requests).toEqual([VALID_REQUEST]);
    expect(body.snapshotInput).toEqual({ artifacts: { NVDA: "feed-1" } });
    const headers = (JSON.parse(String(generate.payload_json)) as any).headers;
    expect(headers["x-user-login"]).toBe("tester");
    expect((JSON.parse(String(generate.payload_json)) as any).pathAndQuery).toBe("/api/schedules/trigger-discovery");
  });

  it("plans nothing when the feed job carries no chainTo (standalone refresh)", async () => {
    const sql = new FakeJobSql();
    const ctx = makeCtx(sql);
    mockedExecute.mockResolvedValueOnce({ ...FEED_RESULT } as any);
    const submitted = await submitAsyncJob(ctx, {
      capability: "feed.snapshot",
      payload: { userLogin: "tester", symbols: [{ symbol: "NVDA" }] },
      stage: "feed",
    } as any);
    await executeAsyncJob(ctx, { jobId: submitted.jobId });
    expect(sql.rows.filter((r) => r.capability === "http.request")).toHaveLength(0);
  });

  it("plans nothing when the feed job fails (completion hooks never run)", async () => {
    const sql = new FakeJobSql();
    const ctx = makeCtx(sql);
    mockedExecute.mockRejectedValueOnce(new Error("broker unavailable"));
    const submitted = await submitAsyncJob(ctx, {
      capability: "feed.snapshot",
      payload: {
        userLogin: "tester",
        symbols: [{ symbol: "NVDA" }],
        chainTo: { requests: [VALID_REQUEST] },
      },
      stage: "feed",
      chainId: "chain-feed-2",
    } as any);
    await executeAsyncJob(ctx, { jobId: submitted.jobId });
    const feedRow = sql.rows.find((r) => r.job_id === submitted.jobId);
    expect(feedRow?.status).toBe("failed");
    expect(sql.rows.filter((r) => r.capability === "http.request")).toHaveLength(0);
  });

  it("retries a failed feed job from its recorded payload, keeping stage + chain", async () => {
    const sql = new FakeJobSql();
    const ctx = makeCtx(sql);
    mockedExecute.mockRejectedValueOnce(new Error("broker unavailable"));
    const submitted = await submitAsyncJob(ctx, {
      capability: "feed.snapshot",
      payload: { userLogin: "tester", symbols: [{ symbol: "NVDA" }] },
      stage: "feed",
      chainId: "chain-feed-3",
    } as any);
    await executeAsyncJob(ctx, { jobId: submitted.jobId });
    const retried = await retryAsyncJob(ctx, submitted.jobId);
    const retryRow = sql.rows.find((r) => r.job_id === retried.jobId);
    expect(retryRow?.status).toBe("queued");
    expect(retryRow?.stage).toBe("feed");
    expect(retryRow?.chain_id).toBe("chain-feed-3");
    expect((JSON.parse(String(retryRow?.payload_json)) as any).retryOf).toBe(submitted.jobId);
  });
});

describe("POST /api/schedules/feed-snapshot route (#1236)", () => {
  async function callRoute(body: unknown, headers: Record<string, string> = { "x-user-login": "tester" }) {
    const captured: Array<unknown> = [];
    const request = new Request("https://agent.internal/api/schedules/feed-snapshot", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    const response = await handleSchedulesRoutes(
      request,
      new URL(request.url),
      "/api/schedules/feed-snapshot",
      "sess-1",
      {
        getScreenerExecutionContext: async () => ({ userLogin: headers["x-user-login"] }),
        submitAsyncJob: async (spec: unknown) => {
          captured.push(spec);
          return { jobId: "job-feed-route", status: "queued", statusUrl: "/api/jobs/job-feed-route" };
        },
        audit: () => {},
        env: {},
      } as any,
    );
    return { response, captured };
  }

  it("derives the feed symbols + filters from chainTo.requests and mints a chain", async () => {
    const { response, captured } = await callRoute({ chainTo: { requests: [VALID_REQUEST], emailTo: "a@example.com" } });
    expect(response?.status).toBe(200);
    const spec = captured[0] as any;
    expect(spec.capability).toBe("feed.snapshot");
    expect(spec.stage).toBe("feed");
    expect(typeof spec.chainId).toBe("string");
    expect(spec.payload.userLogin).toBe("tester");
    expect(spec.payload.symbols).toEqual([{
      symbol: "NVDA",
      loadParams: expect.objectContaining({ symbol: "NVDA", minDte: 1, maxDte: 365 }),
    }]);
    expect(spec.payload.chainTo.requests).toEqual([VALID_REQUEST]);
    expect(spec.payload.chainTo.emailTo).toBe("a@example.com");
  });

  it("accepts a standalone symbol list with no chain", async () => {
    const { response, captured } = await callRoute({ symbols: ["NVDA"] });
    expect(response?.status).toBe(200);
    const spec = captured[0] as any;
    expect(spec.payload.symbols).toEqual([{ symbol: "NVDA" }]);
    expect(spec.chainId).toBeUndefined();
    expect(spec.payload.chainTo).toBeUndefined();
  });

  it("returns 401 without an identity and 400 for bad payloads", async () => {
    const noAuth = await callRoute({ symbols: ["NVDA"] }, {});
    expect(noAuth.response?.status).toBe(401);
    expect(noAuth.captured).toHaveLength(0);
    const empty = await callRoute({});
    expect(empty.response?.status).toBe(400);
    const badTicker = await callRoute({ symbols: ["!!!"] });
    expect(badTicker.response?.status).toBe(400);
    const emptyChain = await callRoute({ chainTo: { requests: [] } });
    expect(emptyChain.response?.status).toBe(400);
    const invalidRequest = await callRoute({ chainTo: { requests: [{}] } });
    expect(invalidRequest.response?.status).toBe(400);
  });
});
