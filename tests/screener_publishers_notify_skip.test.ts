/**
 * Issue #424: when a market-screen failure cannot be notified anywhere
 * (no cfpay A2A, no Slack token/webhook, no outbound webhook), the
 * publishers used to drop it silently — the failure existed only in the
 * audit of the run itself. The skip is now audited as
 * `screener.failure_notify_skipped` so the silence is on the record.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { ScreenerEventBus } from "../src/events/screenerEvents";
import { registerScreenerPublishers } from "../src/events/screenerPublishers";
import { ETradeWebhookService } from "../src/services/tradingWebhooks";
import type { Env } from "../src/types";

const FAILED_EVENT = {
  type: "screener.failed" as const,
  timestamp: "2026-10-20T18:00:00.000Z",
  universe: "NASDAQ100",
  trigger: "scheduled" as const,
  sector: "ALL",
  error: "E*TRADE unavailable",
};

describe("publishFailed notify-skip audit (#424)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("audits screener.failure_notify_skipped when no channel is configured", async () => {
    const create = vi.fn();
    const orm = { events: { create } } as any;
    const bus = new ScreenerEventBus();
    registerScreenerPublishers(bus, { env: {} as Env, orm, userLogin: "trader1" });
    await bus.publish(FAILED_EVENT);
    const skip = create.mock.calls
      .map((c) => c[0])
      .find((e) => e.type === "screener.failure_notify_skipped");
    expect(skip).toBeDefined();
    expect(skip.payload.error).toBe("E*TRADE unavailable");
    expect(skip.sessionId).toBe("trader1");
  });

  it("does not audit a skip when a webhook channel fires", async () => {
    const webhookSpy = vi
      .spyOn(ETradeWebhookService.prototype, "dispatchOutboundWebhook")
      .mockResolvedValue({ success: true } as any);
    const create = vi.fn();
    const orm = { events: { create } } as any;
    const bus = new ScreenerEventBus();
    registerScreenerPublishers(bus, {
      env: { OUTBOUND_WEBHOOK_URL: "https://example.com/hook" } as Env,
      orm,
      userLogin: "trader1",
    });
    await bus.publish(FAILED_EVENT);
    expect(webhookSpy).toHaveBeenCalledTimes(1);
    const skip = create.mock.calls
      .map((c) => c[0])
      .find((e) => e.type === "screener.failure_notify_skipped");
    expect(skip).toBeUndefined();
  });
});
