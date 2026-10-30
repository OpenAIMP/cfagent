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

  function blockedService(options: { episodeAlerted?: boolean } = {}) {
    const service = new ScheduledTasksService(mockEnv, mockOrm, "test_trader");
    const publish = vi.fn(async () => {});
    (service as any).publishScreenerEvent = publish;
    let callCount = 0;
    (service as any).guardScheduledAuth = async () => {
      callCount++;
      const alerted = options.episodeAlerted !== undefined ? options.episodeAlerted : callCount === 1;
      return {
        blocked: true,
        alerted,
        error: alerted
          ? "⚠️ [FAILURE_AUTH_NO_SESSION] E*TRADE connection missing — scheduled options screen is blocked. A connect alert has been sent for this episode."
          : "⚠️ [FAILURE_AUTH_NO_SESSION] E*TRADE connection missing — scheduled options screen is blocked. A connect alert was already sent for this episode; further runs today stay quiet.",
      };
    };
    return { service, publish };
  }

  it("an initial blocked run in an episode publishes options.failed with the coded error", async () => {
    const { service, publish } = blockedService({ episodeAlerted: true });
    const result = await service.autonomousOptionsAnalysis({
      symbols: ["AAPL"],
      thesis: "bullish",
      riskProfile: "balanced",
    });
    expect(result.success).toBe(false);
    expect(String((result as any).error)).toContain("[FAILURE_AUTH_NO_SESSION]");
    const events = publish.mock.calls.map((c) => c[0]);
    const failed = events.find((e: any) => e.type === "options.failed");
    expect(failed).toBeDefined();
    expect(failed.error).toContain("[FAILURE_AUTH_NO_SESSION]");
    expect(failed.trigger).toBe("scheduled");
  });

  it("a subsequent blocked run in the same episode stays quiet (#1583)", async () => {
    const { service, publish } = blockedService();
    // Run 1: initial blocked run in episode (alerted: true) -> publishes options.failed
    const r1 = await service.autonomousOptionsAnalysis({ symbols: ["AAPL"], thesis: "bullish" });
    expect(r1.success).toBe(false);

    // Run 2: subsequent blocked run in same episode (alerted: false) -> quiet contract
    const r2 = await service.autonomousOptionsAnalysis({ symbols: ["AAPL"], thesis: "bullish" });
    expect(r2.success).toBe(false);
    expect(String((r2 as any).error)).toContain("[FAILURE_AUTH_NO_SESSION]");
    expect(String((r2 as any).error)).toContain("further runs today stay quiet");

    // Only run 1 published failure event; run 2 stayed quiet
    const failed = publish.mock.calls.map((c) => c[0]).filter((e: any) => e.type === "options.failed");
    expect(failed).toHaveLength(1);
  });
});
