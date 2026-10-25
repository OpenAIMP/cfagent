/**
 * Issue #1358 (job-truth program #1332): a preflight-blocked
 * scheduled options run must go through the same failure path as
 * any other failure — audit + session message + Slack notice (when
 * configured) + options.failed bus event — instead of returning
 * early with { success: false } while only the once-per-episode
 * alert fires. The episode dedup stays on the alert itself, never
 * on the per-run notice: every blocked run in the episode notifies.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ScheduledTasksService } from "../src/services/scheduledTasks";
import { DatabaseORM } from "../src/orm";
import type { Env } from "../src/types";

describe("autonomousOptionsAnalysis preflight-blocked failure path (#1358)", () => {
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
      error: "⚠️ [AUTH_003] E*TRADE connection missing — scheduled options screen is blocked.",
    });
    return { service, publish };
  }

  it("a blocked run publishes options.failed with the coded error instead of returning silently", async () => {
    const { service, publish } = blockedService();
    const result = await service.autonomousOptionsAnalysis({
      symbols: ["AAPL"],
      thesis: "bullish",
      riskProfile: "balanced",
    });
    expect(result.success).toBe(false);
    expect(String((result as any).error)).toContain("[AUTH_003]");
    const events = publish.mock.calls.map((c) => c[0]);
    const failed = events.find((e: any) => e.type === "options.failed");
    expect(failed).toBeDefined();
    expect(failed.error).toContain("[AUTH_003]");
    expect(failed.trigger).toBe("scheduled");
  });

  it("a second blocked run in the same episode notifies again (no dedup on the per-run notice)", async () => {
    const { service, publish } = blockedService();
    await service.autonomousOptionsAnalysis({ symbols: ["AAPL"], thesis: "bullish" });
    await service.autonomousOptionsAnalysis({ symbols: ["AAPL"], thesis: "bullish" });
    const failed = publish.mock.calls.map((c) => c[0]).filter((e: any) => e.type === "options.failed");
    expect(failed).toHaveLength(2);
  });
});
