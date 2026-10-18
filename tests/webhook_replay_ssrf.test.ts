/**
 * Issue #143 P0 (webhook replay protection + emailTo domain allowlist).
 * (The outbound SSRF guard, issue #240, already landed in PR #242 as
 * `assertSafeOutboundWebhookUrl` with its own tests/webhook_ssrf.test.ts —
 * it is not re-tested here.)
 *
 * The audit's line-level verification confirmed: inbound HMAC verification
 * is already correct (constant-time, fail-closed, 5-minute windows), but a
 * replayed still-valid delivery was processed twice (the "event
 * deduplication" docstring was false: the ID was minted fresh per call).
 *
 * Harness follows the repo patterns: MockSqlStorage + DatabaseORM from
 * tests/agentic_payments.test.ts, valid signatures via computeHmacSha256Hex
 * (as in tests/inbound_webhook_failclosed.test.ts).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";
import { computeHmacSha256Hex } from "../src/services/cryptoUtils";
import { ETradeWebhookService } from "../src/services/tradingWebhooks";
import {
  WEBHOOK_REPLAY_TTL_MS,
  deriveTradingViewNonce,
  deriveETradeNonce,
  deriveNlqNonce,
  OrmReplayStore,
  MemoryReplayStore,
  validateEmailRecipient,
} from "../src/security/webhookReplay";
import type { Env } from "../src/types";

const TV_SECRET = "unit-test-tv-secret";
const ET_SECRET = "unit-test-etrade-secret";

function makeOrm(): DatabaseORM {
  const sql = new MockSqlStorage();
  const orm = new DatabaseORM(sql);
  orm.initializeSchema("sess_replay_test");
  return orm;
}

function tvEnv(): Env {
  return { TRADINGVIEW_WEBHOOK_SECRET: TV_SECRET } as Env;
}

function etEnv(): Env {
  return { ETRADE_WEBHOOK_SECRET: ET_SECRET } as Env;
}

// ===========================================================================
// Replay: TradingView alerts
// ===========================================================================

describe("TradingView inbound replay protection (#143 P0)", () => {
  let orm: DatabaseORM;
  beforeEach(() => {
    orm = makeOrm();
  });

  const BODY = JSON.stringify({ ticker: "NVDA", action: "BUY", quantity: 2 });

  async function send(body: string, svc?: ETradeWebhookService) {
    const s = svc ?? new ETradeWebhookService(orm, tvEnv(), "sess_tv");
    const sig = await computeHmacSha256Hex(TV_SECRET, body);
    return s.processTradingViewAlert(body, { "X-TradingView-Signature": sig });
  }

  it("processes a fresh alert once (200)", async () => {
    const res = await send(BODY);
    expect(res.success).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(res.orderDraftId).toBeTruthy();
  });

  it("rejects an identical replay with 409 and does not draft a second order", async () => {
    const first = await send(BODY);
    expect(first.success).toBe(true);
    const replay = await send(BODY);
    expect(replay.success).toBe(false);
    expect(replay.statusCode).toBe(409);
    expect(replay.message).toMatch(/replay/i);
    expect(replay.orderDraftId).toBeUndefined();
  });

  it("treats a different body as a different event (200)", async () => {
    await send(BODY);
    const other = JSON.stringify({ ticker: "NVDA", action: "BUY", quantity: 3 });
    const res = await send(other);
    expect(res.success).toBe(true);
    expect(res.statusCode).toBe(200);
  });

  it("nonce derivation is deterministic per delivery and distinct per body", async () => {
    const n1 = await deriveTradingViewNonce("sig", BODY);
    const n2 = await deriveTradingViewNonce("sig", BODY);
    const n3 = await deriveTradingViewNonce("sig", BODY + "x");
    expect(n1).toBe(n2);
    expect(n1).not.toBe(n3);
    expect(n1.startsWith("tv:")).toBe(true);
  });
});

// ===========================================================================
// Replay: E*TRADE broker notifications
// ===========================================================================

describe("E*TRADE inbound replay protection (#143 P0)", () => {
  let orm: DatabaseORM;
  beforeEach(() => {
    orm = makeOrm();
  });

  async function send(payload: Record<string, unknown>) {
    const body = JSON.stringify(payload);
    const svc = new ETradeWebhookService(orm, etEnv(), "sess_et");
    const sig = await computeHmacSha256Hex(ET_SECRET, body);
    return svc.processETradeBrokerWebhook(body, { "X-ETrade-Signature": sig });
  }

  const base = () => ({
    eventType: "ORDER_FILLED",
    orderId: "ord_123",
    timestamp: "2026-10-18T09:00:00.000Z",
  });

  it("processes a fresh broker notification once (200)", async () => {
    const res = await send(base());
    expect(res.success).toBe(true);
    expect(res.statusCode).toBe(200);
  });

  it("rejects a replayed notification with 409 (semantic identity)", async () => {
    const first = await send(base());
    expect(first.success).toBe(true);
    const replay = await send(base());
    expect(replay.success).toBe(false);
    expect(replay.statusCode).toBe(409);
    expect(replay.message).toMatch(/replay/i);
  });

  it("a new timestamp for the same order is a new event (200)", async () => {
    await send(base());
    const res = await send({ ...base(), timestamp: "2026-10-18T09:00:01.000Z" });
    expect(res.success).toBe(true);
    expect(res.statusCode).toBe(200);
  });

  it("semantic nonce prefers orderId:eventType:timestamp", async () => {
    const n = await deriveETradeNonce(
      { orderId: "ord_1", eventType: "ORDER_FILLED", timestamp: "t" },
      "sig",
      "body"
    );
    expect(n).toBe("etrade:ord_1:ORDER_FILLED:t");
    const hashed = await deriveETradeNonce({ eventType: "ORDER_FILLED" } as any, "sig", "body");
    expect(hashed.startsWith("etrade:")).toBe(true);
    expect(hashed).not.toBe(n);
  });
});

// ===========================================================================
// Replay stores
// ===========================================================================

describe("replay stores", () => {
  it("OrmReplayStore: first claim passes, replay rejected, expired nonce reclaimable", async () => {
    const orm = makeOrm();
    const store = new OrmReplayStore(orm);
    expect(await store.claim("n1", "test")).toBe(false);
    expect(await store.claim("n1", "test")).toBe(true);
    // ttl 0 => already expired at claim time
    expect(await store.claim("n2", "test", 0)).toBe(false);
    expect(await store.claim("n2", "test", 0)).toBe(false);
    expect(WEBHOOK_REPLAY_TTL_MS).toBe(24 * 60 * 60 * 1000);
  });

  it("MemoryReplayStore: first claim passes, replay rejected", async () => {
    const store = new MemoryReplayStore();
    expect(await store.claim("m1", "test")).toBe(false);
    expect(await store.claim("m1", "test")).toBe(true);
  });

  it("NLQ nonce derivation is deterministic", async () => {
    const a = await deriveNlqNonce("q", "a@x.com", "t");
    const b = await deriveNlqNonce("q", "a@x.com", "t");
    expect(a).toBe(b);
    expect(a.startsWith("nlq:")).toBe(true);
  });
});

// ===========================================================================
// emailTo domain allowlist (#143 P0)
// ===========================================================================

describe("validateEmailRecipient — domain allowlist (#143 P0)", () => {
  it("accepts listed domains (case-insensitive)", () => {
    expect(validateEmailRecipient("trader@corp.org", "corp.org, example.com")).toEqual({ ok: true });
    expect(validateEmailRecipient("TRADER@CORP.ORG", "corp.org")).toEqual({ ok: true });
  });

  it("rejects unlisted domains", () => {
    const r = validateEmailRecipient("attacker@evil.com", "corp.org");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/allowlist/);
  });

  it("rejects malformed addresses regardless of allowlist", () => {
    expect(validateEmailRecipient("not-an-email", "corp.org").ok).toBe(false);
    expect(validateEmailRecipient("a@b", "corp.org").ok).toBe(false);
  });

  it("unset allowlist preserves format-only behavior", () => {
    expect(validateEmailRecipient("anyone@anywhere.io", undefined)).toEqual({ ok: true });
    expect(validateEmailRecipient("anyone@anywhere.io", "")).toEqual({ ok: true });
    expect(validateEmailRecipient("bad address", undefined).ok).toBe(false);
  });
});
