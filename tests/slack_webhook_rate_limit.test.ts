import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  checkSlackWebhookRateLimit,
  isSlackWebhookUrl,
  SLACK_WEBHOOK_MAX_REQUESTS,
} from "../src/services/slackWebhookRateLimit";
import { resetRateLimits } from "../src/security/rateLimiter";
import { ETradeWebhookService } from "../src/services/tradingWebhooks";
import { ETradeBrowserService, type TransactionSnapData } from "../src/services/browserAgent";

/**
 * Issue #411 — Slack webhook calls are rate-limited per destination
 * (burst 5, ~1/sec sustained). Covers the guard itself and the three
 * delivery sites that POST to Slack webhooks: the outbound webhook
 * dispatcher (Slack destinations only) and the browser agent's two
 * snapshot deliveries.
 */
const SLACK_URL = "https://hooks.slack.com/services/T000/B000/XXXX";
const T0 = 1_000_000;

describe("Slack webhook rate-limit guard (#411)", () => {
  beforeEach(() => resetRateLimits());

  it("allows a burst of 5, then denies with a retry hint", () => {
    for (let i = 0; i < SLACK_WEBHOOK_MAX_REQUESTS; i++) {
      expect(checkSlackWebhookRateLimit(SLACK_URL, T0).allowed).toBe(true);
    }
    const denied = checkSlackWebhookRateLimit(SLACK_URL, T0);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBeGreaterThan(0);
    expect(denied.retryAfterMs).toBeLessThanOrEqual(5_000);
  });

  it("keeps destinations independent", () => {
    for (let i = 0; i < SLACK_WEBHOOK_MAX_REQUESTS; i++) {
      checkSlackWebhookRateLimit(SLACK_URL, T0);
    }
    expect(checkSlackWebhookRateLimit(SLACK_URL, T0).allowed).toBe(false);
    expect(
      checkSlackWebhookRateLimit("https://hooks.slack.com/services/T/B/OTHER", T0).allowed
    ).toBe(true);
  });

  it("refills at ~1/second", () => {
    for (let i = 0; i < SLACK_WEBHOOK_MAX_REQUESTS; i++) {
      checkSlackWebhookRateLimit(SLACK_URL, T0);
    }
    expect(checkSlackWebhookRateLimit(SLACK_URL, T0 + 999).allowed).toBe(false);
    expect(checkSlackWebhookRateLimit(SLACK_URL, T0 + 1_000).allowed).toBe(true);
    expect(checkSlackWebhookRateLimit(SLACK_URL, T0 + 1_000).allowed).toBe(false);
  });

  it("recognizes only hooks.slack.com as a Slack webhook", () => {
    expect(isSlackWebhookUrl(SLACK_URL)).toBe(true);
    expect(isSlackWebhookUrl("https://example.com/hook")).toBe(false);
    expect(isSlackWebhookUrl("https://hooks.slack.com.evil.com/services/x")).toBe(false);
    expect(isSlackWebhookUrl("not a url")).toBe(false);
  });
});

describe("outbound webhook dispatcher (#411)", () => {
  const SECRET = ["test", "signing", "secret"].join("-");
  let fetchCalls = 0;

  beforeEach(() => {
    resetRateLimits();
    fetchCalls = 0;
    vi.stubGlobal("fetch", async () => {
      fetchCalls += 1;
      return new Response("ok", { status: 200 });
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("limits Slack webhook dispatches per destination", async () => {
    const svc = new ETradeWebhookService(
      undefined,
      { OUTBOUND_WEBHOOK_SECRET: SECRET } as any,
      "user1"
    );
    const results = [];
    for (let i = 0; i < 6; i++) {
      results.push(await svc.dispatchOutboundWebhook("test.event", { n: i }, SLACK_URL));
    }
    expect(results.slice(0, 5).every((r) => r.success)).toBe(true);
    expect(fetchCalls).toBe(5);
    expect(results[5].success).toBe(false);
    expect(results[5].error).toMatch(/rate limit/i);
  });

  it("does not limit non-Slack webhook destinations", async () => {
    const svc = new ETradeWebhookService(
      undefined,
      { OUTBOUND_WEBHOOK_SECRET: SECRET } as any,
      "user1"
    );
    for (let i = 0; i < 6; i++) {
      const res = await svc.dispatchOutboundWebhook(
        "test.event",
        { n: i },
        "https://subscriber.example/hook"
      );
      expect(res.success).toBe(true);
    }
    expect(fetchCalls).toBe(6);
  });
});

describe("browser agent Slack deliveries (#411)", () => {
  const sampleTx: TransactionSnapData = {
    transactionId: "TX_RL_1",
    symbol: "AAPL",
    action: "BUY",
    quantity: 3,
    price: 200.0,
    orderType: "LIMIT",
    status: "EXECUTED",
    totalValue: 600.0,
    environment: "sandbox",
  };
  let slackFetches = 0;

  beforeEach(() => {
    resetRateLimits();
    slackFetches = 0;
    vi.stubGlobal("fetch", async (input: any) => {
      const url = String(input);
      if (new URL(url).hostname === "hooks.slack.com") {
        slackFetches += 1;
        return { ok: true, status: 200, json: async () => ({ ok: true }), text: async () => "ok" } as any;
      }
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () =>
          "<html><head><title>NVDA Quote</title></head><body><h1>NVDA</h1><p>Price data</p></body></html>",
        json: async () => ({}),
      } as any;
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("limits transaction snap deliveries", async () => {
    const service = new ETradeBrowserService({} as any);
    const results = [];
    for (let i = 0; i < 6; i++) {
      results.push(await service.sendTransactionSnapToSlack(sampleTx, { webhookUrl: SLACK_URL }));
    }
    expect(results.slice(0, 5).every((r) => r.success)).toBe(true);
    expect(slackFetches).toBe(5);
    expect(results[5].success).toBe(false);
    expect(results[5].error).toMatch(/rate limit/i);
  });

  it("limits page snapshot deliveries", async () => {
    const service = new ETradeBrowserService({} as any);
    const results = [];
    for (let i = 0; i < 6; i++) {
      results.push(
        await service.captureAndSendToSlack("https://example.com/quote/NVDA", {
          webhookUrl: SLACK_URL,
        })
      );
    }
    expect(results.slice(0, 5).every((r) => r.success)).toBe(true);
    expect(slackFetches).toBe(5);
    expect(results[5].success).toBe(false);
    expect(results[5].error).toMatch(/rate limit/i);
  });
});
