/**
 * Issue #140 (found during #123): the INBOUND webhook signature
 * verifier `verifyHmacSha256Signature` returned `true` when no secret
 * was configured — a self-described "permissive development mode".
 * In any deployment missing the secret, any caller presenting any
 * (or no) signature was treated as verified on every consumer:
 * TradingView alerts (order drafts created), E*TRADE broker
 * notifications (stored order statuses mutated to executed /
 * cancelled / rejected), and the NLQ webhook verifier wrapper.
 *
 * This is the mirror image of the outbound defect fixed in #123
 * (F20), and the fix mirrors it too: verification FAILS CLOSED.
 * No secret configured → not verified, at the verifier itself so
 * every present and future consumer is safe; the two trading
 * webhook processors additionally answer an honest 503 naming the
 * missing configuration, matching the /nlq/webhook route precedent.
 *
 * Harnesses follow the repo patterns: the MockSqlStorage ORM from
 * tests/scheduled_tasks.test.ts and source pins from the other
 * #115-family honesty suites.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";
import {
  verifyHmacSha256Signature,
  verifySlackSignature,
} from "../src/security/webhookSecurity";
import { computeHmacSha256Hex } from "../src/services/cryptoUtils";
import { ETradeWebhookService } from "../src/services/tradingWebhooks";
import type { Env } from "../src/types";

// Source pins read via cwd-relative paths (vitest runs at the repo
// root) — the pattern used by tests/claims_batch_honesty.test.ts.
const src = (rel: string) => readFileSync(`src/${rel}`, "utf8");

const BODY = JSON.stringify({ ticker: "NVDA", action: "BUY", quantity: 2 });
const SECRET = "unit-test-webhook-secret";

// ===========================================================================
// The verifier itself fails closed when no secret is configured
// ===========================================================================

describe("verifyHmacSha256Signature — unconfigured fails closed (#140)", () => {
  it("undefined secret: even a well-formed signature is NOT verified", async () => {
    const sig = await computeHmacSha256Hex("anything", BODY);
    expect(await verifyHmacSha256Signature(BODY, sig, undefined)).toBe(false);
    expect(await verifyHmacSha256Signature(BODY, sig)).toBe(false);
  });

  it("undefined secret: no signature at all is NOT verified", async () => {
    expect(await verifyHmacSha256Signature(BODY, null, undefined)).toBe(false);
    expect(await verifyHmacSha256Signature(BODY, "", undefined)).toBe(false);
  });

  it("empty-string secret counts as unconfigured", async () => {
    const sig = await computeHmacSha256Hex("anything", BODY);
    expect(await verifyHmacSha256Signature(BODY, sig, "")).toBe(false);
  });

  it("the service wrapper inherits the fail-closed behaviour", async () => {
    const svc = new ETradeWebhookService(undefined, {} as Env, "sess_140");
    const sig = await computeHmacSha256Hex("anything", BODY);
    expect(await svc.verifySignature(BODY, sig, undefined)).toBe(false);
    expect(await svc.verifySignature(BODY, null, undefined)).toBe(false);
  });
});

// ===========================================================================
// Configured verification still works — and still rejects bad input
// ===========================================================================

describe("verifyHmacSha256Signature — configured behaviour", () => {
  it("accepts a valid signature under the configured secret", async () => {
    const sig = await computeHmacSha256Hex(SECRET, BODY);
    expect(await verifyHmacSha256Signature(BODY, sig, SECRET)).toBe(true);
  });

  it("accepts a valid signature with the sha256= prefix", async () => {
    const sig = await computeHmacSha256Hex(SECRET, BODY);
    expect(await verifyHmacSha256Signature(BODY, `sha256=${sig}`, SECRET)).toBe(true);
  });

  it("rejects a signature made under a different secret", async () => {
    const sig = await computeHmacSha256Hex("some-other-secret", BODY);
    expect(await verifyHmacSha256Signature(BODY, sig, SECRET)).toBe(false);
  });

  it("rejects a missing signature", async () => {
    expect(await verifyHmacSha256Signature(BODY, null, SECRET)).toBe(false);
    expect(await verifyHmacSha256Signature(BODY, "", SECRET)).toBe(false);
  });

  it("rejects a valid signature over a tampered body", async () => {
    const sig = await computeHmacSha256Hex(SECRET, BODY);
    const tampered = JSON.stringify({ ticker: "NVDA", action: "SELL", quantity: 200 });
    expect(await verifyHmacSha256Signature(tampered, sig, SECRET)).toBe(false);
  });
});

// ===========================================================================
// The sibling verifier in the same module was already fail-closed — pin it
// ===========================================================================

describe("verifySlackSignature — fail-closed pin (same module)", () => {
  it("rejects when no signing secret is configured", async () => {
    const ts = String(Math.floor(Date.now() / 1000));
    expect(await verifySlackSignature("", ts, BODY, "v0=abc")).toBe(false);
  });
});

// ===========================================================================
// TradingView processor: unconfigured → honest 503, nothing created
// ===========================================================================

describe("processTradingViewAlert — secret configuration gate (#140)", () => {
  let sql: MockSqlStorage;
  let orm: DatabaseORM;
  const sessionId = "webhook_140_tv";

  beforeEach(() => {
    sql = new MockSqlStorage();
    orm = new DatabaseORM(sql);
    orm.initializeSchema(sessionId);
  });

  it("no TRADINGVIEW_WEBHOOK_SECRET: rejected 503 naming the missing config, no event, no draft", async () => {
    const svc = new ETradeWebhookService(orm, {} as Env, sessionId);
    const res = await svc.processTradingViewAlert(BODY, { "X-TradingView-Signature": "deadbeef" });

    expect(res.success).toBe(false);
    expect(res.statusCode).toBe(503);
    expect(res.message).toContain("TRADINGVIEW_WEBHOOK_SECRET");
    expect(res.message).toContain("not configured");
    expect(res.orderDraftId).toBeUndefined();
    expect(orm.events.findMany({ where: { type: "WEBHOOK_TRADINGVIEW_ALERT" } }).length).toBe(0);
  });

  it("configured + valid signature: alert accepted and an order draft created", async () => {
    const env = { TRADINGVIEW_WEBHOOK_SECRET: SECRET, APP_ENV: "TEST" } as unknown as Env;
    const svc = new ETradeWebhookService(orm, env, sessionId);
    const sig = await computeHmacSha256Hex(SECRET, BODY);
    const res = await svc.processTradingViewAlert(BODY, { "X-TradingView-Signature": sig });

    expect(res.success).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(res.orderDraftId).toBeTruthy();
  });

  it("configured + invalid signature: 401, nothing persisted", async () => {
    const env = { TRADINGVIEW_WEBHOOK_SECRET: SECRET, APP_ENV: "TEST" } as unknown as Env;
    const svc = new ETradeWebhookService(orm, env, sessionId);
    const res = await svc.processTradingViewAlert(BODY, { "X-TradingView-Signature": "0".repeat(64) });

    expect(res.success).toBe(false);
    expect(res.statusCode).toBe(401);
    expect(orm.events.findMany({ where: { type: "WEBHOOK_TRADINGVIEW_ALERT" } }).length).toBe(0);
  });
});

// ===========================================================================
// E*TRADE broker processor: unconfigured → 503, stored order state untouched
// ===========================================================================

describe("processETradeBrokerWebhook — secret configuration gate (#140)", () => {
  let sql: MockSqlStorage;
  let orm: DatabaseORM;
  const sessionId = "webhook_140_et";
  const fillBody = JSON.stringify({ eventType: "ORDER_FILLED", orderId: "ord_140_1" });

  beforeEach(() => {
    sql = new MockSqlStorage();
    orm = new DatabaseORM(sql);
    orm.initializeSchema(sessionId);
    orm.trades.create({
      id: "ord_140_1",
      sessionId,
      symbol: "NVDA",
      action: "BUY",
      orderType: "MARKET",
      quantity: 5,
      price: 100,
      totalValue: 500,
      status: "pending",
      proposerDid: "did:agent:openaimp:trading",
      proofSignature: "proof_140",
    });
  });

  it("no ETRADE_WEBHOOK_SECRET: rejected 503 and the stored order is NOT marked executed", async () => {
    const svc = new ETradeWebhookService(orm, {} as Env, sessionId);
    const res = await svc.processETradeBrokerWebhook(fillBody, { "X-ETrade-Signature": "deadbeef" });

    expect(res.success).toBe(false);
    expect(res.statusCode).toBe(503);
    expect(res.message).toContain("ETRADE_WEBHOOK_SECRET");
    expect(orm.trades.findById("ord_140_1")?.status).toBe("pending");
  });

  it("configured + valid signature: fill processed and the order becomes executed", async () => {
    const env = { ETRADE_WEBHOOK_SECRET: SECRET } as Env;
    const svc = new ETradeWebhookService(orm, env, sessionId);
    const sig = await computeHmacSha256Hex(SECRET, fillBody);
    const res = await svc.processETradeBrokerWebhook(fillBody, { "X-ETrade-Signature": sig });

    expect(res.success).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(orm.trades.findById("ord_140_1")?.status).toBe("executed");
  });

  it("configured + invalid signature: 401 and the stored order is untouched", async () => {
    const env = { ETRADE_WEBHOOK_SECRET: SECRET } as Env;
    const svc = new ETradeWebhookService(orm, env, sessionId);
    const res = await svc.processETradeBrokerWebhook(fillBody, { "X-ETrade-Signature": "0".repeat(64) });

    expect(res.success).toBe(false);
    expect(res.statusCode).toBe(401);
    expect(orm.trades.findById("ord_140_1")?.status).toBe("pending");
  });
});

// ===========================================================================
// Source pins: the permissive branch cannot come back
// ===========================================================================

describe("source pins (#140)", () => {
  it("webhookSecurity.ts has no permissive-when-unconfigured branch", () => {
    const security = src("security/webhookSecurity.ts");
    expect(security).not.toContain("if (!secret) return true");
    expect(security).not.toContain("accept in permissive");
  });

  it("both trading processors name their missing-secret configuration error", () => {
    const webhooks = src("services/tradingWebhooks.ts");
    expect(webhooks).toContain("TRADINGVIEW_WEBHOOK_SECRET is not configured");
    expect(webhooks).toContain("ETRADE_WEBHOOK_SECRET is not configured");
  });
});
