/**
 * Issue #1785: a scheduled options scan over a universe too large for one
 * Worker invocation's subrequest budget must route to the EXISTING
 * sharded path (planOptionsFeedShards: one paced per-symbol job, each
 * invocation with its own budget) instead of running monolithically
 * and deferring 97 of 100 symbols.
 *
 * Routing rule (see the constant in scheduledTasks.ts): a scheduled run
 * whose resolved symbol count exceeds what one budget covers at the
 * measured per-symbol cost takes the sharded branch. Explicit
 * `sharded: true` still shards regardless of size; small scheduled
 * runs and manual runs keep today's monolithic path.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ScheduledTasksService } from "../src/services/scheduledTasks";
import { DatabaseORM } from "../src/orm";
import type { Env } from "../src/types";
import type { AsyncJobSubmission } from "../src/types";

describe("scheduled options scan sharding (#1785)", () => {
  let mockEnv: Env;
  let mockOrm: DatabaseORM;

  beforeEach(() => {
    mockEnv = {
      ETRADE_ENVIRONMENT: "sandbox",
      ETRADE_SANDBOX_BASE_URL: "https://apisb.etrade.com",
      ETRADE_SANDBOX_CONSUMER_KEY: "mock_consumer_key",
      ETRADE_SANDBOX_CONSUMER_SECRET: "mock_consumer_secret",
    } as unknown as Env;
    const mockSql = { exec: vi.fn(() => []) };
    mockOrm = new DatabaseORM(mockSql as any);
  });

  function makeService(submitted: AsyncJobSubmission[]) {
    const shardSubmit = vi.fn(async (spec: AsyncJobSubmission) => {
      submitted.push(spec);
      return { jobId: `job-${submitted.length}`, status: "queued" as const, statusUrl: "/jobs/job" };
    });
    const service = new ScheduledTasksService(
      mockEnv, mockOrm, "test_trader",
      undefined, undefined, undefined, undefined, undefined, undefined,
      shardSubmit as never,
    );
    (service as any).guardScheduledAuth = async () => ({ blocked: false });
    (service as any).getScreenerAgent = () => ({ claimScheduledExecution: async () => true });
    (service as any).publishScreenerEvent = vi.fn(async () => {});
    return { service, shardSubmit };
  }

  function makeSymbols(n: number): string[] {
    return Array.from({ length: n }, (_, i) => `SYM${String(i).padStart(3, "0")}`);
  }

  it("a 100-symbol scheduled scan routes to the sharded path: one per-symbol job each", async () => {
    const submitted: AsyncJobSubmission[] = [];
    const { service } = makeService(submitted);
    const result = await service.autonomousOptionsAnalysis({
      symbols: makeSymbols(100),
      thesis: "bullish",
      riskProfile: "balanced",
      trigger: "scheduled",
    });
    expect((result.data as any)?.sharded).toBe(true);
    expect((result.data as any)?.chainId).toBeTruthy();
    expect(submitted).toHaveLength(100);
    for (const spec of submitted) {
      expect(spec.capability).toBe("shard.execute");
      expect((spec.payload as any)?.chain?.screenType).toBe("options");
    }
    const keys = submitted.map((s) => (s.payload as any)?.shard?.key);
    expect(new Set(keys).size).toBe(100);
    expect(String((result.data as any)?.summary)).toContain("100 paced symbol jobs");
  });

  it("a small scheduled scan keeps the monolithic path (no shards submitted)", async () => {
    const submitted: AsyncJobSubmission[] = [];
    const { service } = makeService(submitted);
    const result = await service.autonomousOptionsAnalysis({
      symbols: ["AAPL", "MSFT"],
      thesis: "bullish",
      riskProfile: "balanced",
      trigger: "scheduled",
    });
    expect(submitted).toHaveLength(0);
    expect((result.data as any)?.sharded).not.toBe(true);
  });

  it("explicit sharded: true still shards regardless of size", async () => {
    const submitted: AsyncJobSubmission[] = [];
    const { service } = makeService(submitted);
    const result = await service.autonomousOptionsAnalysis({
      symbols: ["AAPL", "MSFT"],
      thesis: "bullish",
      riskProfile: "balanced",
      trigger: "scheduled",
      sharded: true,
    });
    expect((result.data as any)?.sharded).toBe(true);
    expect(submitted).toHaveLength(2);
  });

  it("a large scheduled scan without the shard port fails honestly instead of running partial", async () => {
    const service = new ScheduledTasksService(mockEnv, mockOrm, "test_trader");
    (service as any).guardScheduledAuth = async () => ({ blocked: false });
    (service as any).getScreenerAgent = () => ({ claimScheduledExecution: async () => true });
    (service as any).publishScreenerEvent = vi.fn(async () => {});
    // The function's catch converts the sharded-branch throw into a
    // failure result + options.failed event (never a partial success).
    const result = await service.autonomousOptionsAnalysis({
      symbols: makeSymbols(100),
      thesis: "bullish",
      riskProfile: "balanced",
      trigger: "scheduled",
    });
    expect(result.success).toBe(false);
    expect(String((result as any).error)).toContain("Sharded options runs require the async-job submission port");
  });
});
