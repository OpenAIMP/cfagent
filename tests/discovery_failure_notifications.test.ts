/**
 * Issue #424: failed screener runs do not notify Slack.
 *
 * The market screen's failures fan out through the event bus publishers and
 * the options analysis failure sends a Slack A2A notice — but scheduled
 * strategy discovery failures were audit + session-message only, invisible
 * to anyone not watching the app. These tests pin the fan-out for the
 * discovery variants, and the audited skip when no channel is configured.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ScheduledTasksService } from "../src/services/scheduledTasks";
import { DatabaseORM } from "../src/orm";
import { ETradeSlackTradingService } from "../src/trading/slack/agent";
import { ETradeWebhookService } from "../src/services/tradingWebhooks";
import type { Env } from "../src/types";

function makeService(env: Partial<Env>) {
  const mockSql = { exec: vi.fn(() => []) };
  const orm = new DatabaseORM(mockSql as any);
  const fullEnv = {
    ETRADE_ENVIRONMENT: "sandbox",
    ETRADE_SANDBOX_BASE_URL: "https://apisb.etrade.com",
    ETRADE_SANDBOX_CONSUMER_KEY: "mock_consumer_key",
    ETRADE_SANDBOX_CONSUMER_SECRET: "mock_consumer_secret",
    ...env,
  } as unknown as Env;
  return new ScheduledTasksService(fullEnv, orm, "test_trader");
}

describe("strategy discovery failure notifications (#424)", () => {
  let slackSpy: ReturnType<typeof vi.spyOn>;
  let webhookSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    slackSpy = vi
      .spyOn(ETradeSlackTradingService.prototype, "postSlackMessage")
      .mockResolvedValue({ ok: true } as any);
    webhookSpy = vi
      .spyOn(ETradeWebhookService.prototype, "dispatchOutboundWebhook")
      .mockResolvedValue({ success: true } as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("notifies Slack + webhook when a saved-request discovery run fails", async () => {
    const service = makeService({
      SLACK_BOT_TOKEN: "xoxb-test",
      OUTBOUND_WEBHOOK_URL: "https://example.com/hook",
    });
    const result = await service.autonomousStrategyDiscovery({ requests: [] });
    expect(result.success).toBe(false);
    expect(slackSpy).toHaveBeenCalledTimes(1);
    const slackText = (slackSpy.mock.calls[0][0] as any).text as string;
    expect(slackText).toContain("Strategy Discovery FAILED");
    expect(webhookSpy).toHaveBeenCalledTimes(1);
    expect(webhookSpy.mock.calls[0][0]).toBe("options.strategy_discovery_failed");
  });

  it("notifies on the profile-derived path too", async () => {
    const service = makeService({
      SLACK_BOT_TOKEN: "xoxb-test",
      OUTBOUND_WEBHOOK_URL: "https://example.com/hook",
    });
    const result = await service.autonomousStrategyDiscovery({
      inputModel: "profile-derived",
      profileId: "profile-1",
      symbols: ["AAPL"],
    });
    expect(result.success).toBe(false);
    expect(slackSpy).toHaveBeenCalledTimes(1);
    expect(webhookSpy).toHaveBeenCalledTimes(1);
  });

  it("audits the skip when no notification channel is configured", async () => {
    const service = makeService({});
    const auditSpy = vi.fn();
    (service as any).audit = auditSpy;
    const result = await service.autonomousStrategyDiscovery({ requests: [] });
    expect(result.success).toBe(false);
    expect(slackSpy).not.toHaveBeenCalled();
    expect(webhookSpy).not.toHaveBeenCalled();
    const skip = auditSpy.mock.calls.find(
      (c) => c[0] === "options.strategy_discovery_notify_skipped"
    );
    expect(skip).toBeDefined();
  });
});
