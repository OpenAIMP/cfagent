/**
 * Issue #1369 (job-truth program #1332): the stock twin of #1358.
 * A preflight-blocked scheduled stock run must go through the same
 * failure path as any other failure — audit + session message +
 * screener.failed bus event — instead of returning early with
 * { success: false } while only the once-per-episode alert fires.
 * The episode dedup stays on the alert itself, never on the per-run
 * notice: every blocked run in the episode notifies. The guard sits
 * before the sharded dispatch, so a blocked sharded run must notify
 * through the same catch and must never submit a shard chain.
 *
 * SUPERSEDED IN PART by #1527 (2026-10-25 ruling): a blocked run
 * first attempts the whole-run Yahoo fallback. These pins now cover
 * the case where the fallback itself fails — that is the failure
 * path that must notify. The fallback-success case (no failure
 * notice; the marker is the signal) is pinned in
 * tests/scheduled_stock_yahoo_fallback_1527.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ScheduledTasksService } from "../src/services/scheduledTasks";
import { DatabaseORM } from "../src/orm";
import type { Env } from "../src/types";

describe("autonomousMarketScreen preflight-blocked failure path (#1369)", () => {
  let mockEnv: Env;
  let mockOrm: DatabaseORM;

  beforeEach(() => {
    const mockSql = { exec: vi.fn(() => []) };
    mockEnv = {
      ETRADE_ENVIRONMENT: "sandbox",
      ETRADE_SANDBOX_BASE_URL: "https://apisb.etrade.com",
      ETRADE_SANDBOX_CONSUMER_KEY: "mock_consumer_key",
      ETRADE_SANDBOX_CONSUMER_SECRET: "mock_consumer_secret",
    } as unknown as Env;
    mockOrm = new DatabaseORM(mockSql as any);
  });

  function blockedService() {
    const service = new ScheduledTasksService(mockEnv, mockOrm, "test_trader");
    const publish = vi.fn(async () => {});
    (service as any).publishScreenerEvent = publish;
    (service as any).guardScheduledAuth = async () => ({
      blocked: true,
      error: "⚠️ [FAILURE_AUTH_NO_SESSION] E*TRADE connection missing — scheduled stock screen is blocked.",
    });
    // Issue #1527: a blocked run attempts the Yahoo fallback first,
    // so the failure path here is the fallback failing — not the
    // guard block itself. The fallback failure must notify.
    (service as any).getScreenerAgent = () => ({
      runScreen: async () => {
        throw new Error("Yahoo quotes unavailable");
      },
    });
    return { service, publish };
  }

  it("a blocked run whose Yahoo fallback fails publishes screener.failed instead of returning silently", async () => {
    const { service, publish } = blockedService();
    const result = await service.autonomousMarketScreen({});
    expect(result.success).toBe(false);
    expect(String((result as any).error)).toContain("Yahoo quotes unavailable");
    const events = publish.mock.calls.map((c) => c[0]);
    const failed = events.find((e: any) => e.type === "screener.failed");
    expect(failed).toBeDefined();
    expect(failed.error).toContain("Yahoo quotes unavailable");
    expect(failed.trigger).toBe("scheduled");
    expect(events.find((e: any) => e.type === "screener.completed")).toBeUndefined();
  });

  it("a second blocked run in the same episode notifies again (no dedup on the per-run notice)", async () => {
    const { service, publish } = blockedService();
    await service.autonomousMarketScreen({});
    await service.autonomousMarketScreen({});
    const failed = publish.mock.calls.map((c) => c[0]).filter((e: any) => e.type === "screener.failed");
    expect(failed).toHaveLength(2);
  });

  it("a blocked sharded run notifies through the same catch and never submits a shard chain", async () => {
    const { service, publish } = blockedService();
    const shardSubmit = vi.fn(async () => ({ jobId: "never" }));
    (service as any).shardSubmit = shardSubmit;
    const result = await service.autonomousMarketScreen({ sharded: true });
    expect(result.success).toBe(false);
    expect(String((result as any).error)).toContain("Yahoo quotes unavailable");
    const failed = publish.mock.calls.map((c) => c[0]).filter((e: any) => e.type === "screener.failed");
    expect(failed).toHaveLength(1);
    expect(shardSubmit).not.toHaveBeenCalled();
  });
});
