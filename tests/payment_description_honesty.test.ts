/**
 * Issue #514 (filed from #478): the payments create path invented a
 * product description when the caller supplied none. The route defaulted
 * the description to `AI Compute Tokens for ${customer}`, and the
 * strategy layer invented its own product lines per gateway — Stripe's
 * checkout product name, PayPal's purchase-unit description, and Lemon
 * Squeezy's product name — while Lemon Squeezy's product description was
 * an unrelated fabricated sentence ("Autonomous agent credit deposit
 * requested by …") sent regardless of what the caller supplied. The
 * new-payment form's seed copy was removed in #478; these were the
 * server-side counterparts. Fabricated content must not be presented as
 * real data (#151/#175/#478 family).
 *
 * The fix:
 * - the create route stores an EMPTY description when none is supplied
 *   (a supplied one passes through, trimmed, exactly as before);
 * - the route and the MCP draft_payment command no longer invent a
 *   customer name ("Enterprise Client") when none is supplied — the
 *   stored row records "" instead of a fabricated organization;
 * - Stripe / Lemon Squeezy product names fall back to the neutral
 *   non-product label "Payment" (both gateways require a name); PayPal's
 *   optional purchase-unit description is omitted when none is supplied;
 * - Lemon Squeezy's product description carries the caller's
 *   description (or ""), never the fabricated deposit sentence.
 *
 * Harness mirrors tests/payment_create_gateway_validation.test.ts
 * (#156): agent-SDK module mocks, MockSqlStorage, and fetch stubbed at
 * the real gateway endpoints with request bodies captured, so assertions
 * cover the stored row AND the payload each gateway actually receives.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// src/agents/orchestrator.ts pulls in `cloudflare:`-adjacent SDK entry
// points the node test loader cannot resolve. Mock them with plain
// stand-ins (same pattern as tests/payment_webhook_default_deny.test.ts).
vi.mock("@cloudflare/ai-chat", () => {
  return {
    AIChatAgent: class MockAIChatAgent {
      ctx: any;
      env: any;
      constructor(ctx: any, env: any) {
        this.ctx = ctx;
        this.env = env;
      }
    },
  };
});
vi.mock("agents", () => {
  return { routeAgentRequest: async () => null };
});
vi.mock("agents/mcp", () => {
  return { McpAgent: class MockMcpAgent {} };
});
vi.mock("agents/x402", () => {
  return { withX402: (cls: any) => cls };
});

import { OrchestratorAgent } from "../src/agents/orchestrator";
import { MockSqlStorage } from "./mock-sql";
import type { Env } from "../src/types";

const makeEnv = (overrides: Record<string, unknown> = {}): Env =>
  ({
    AI: {} as any,
    AI_SEARCH_ENDPOINT: "https://mock.search",
    SEARCH_AGENT: {} as any,
    AGENT_SESSIONS: {} as any,
    STRIPE_SECRET_KEY: "sk_test_mock",
    PAYPAL_CLIENT_ID: "paypal-client-id-514",
    PAYPAL_CLIENT_SECRET: "paypal-secret-514",
    LEMONSQUEEZY_API_KEY: "ls-api-key-514",
    LEMONSQUEEZY_STORE_ID: "store-514",
    ...overrides,
  }) as Env;

/** Every upstream request body, captured per gateway endpoint. */
let captured: { stripe?: URLSearchParams; paypal?: any; lemonsqueezy?: any } = {};

function stubGatewayFetch() {
  captured = {};
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: any, init?: any) => {
      const url = String(input);
      if (url.includes("api.stripe.com/v1/checkout/sessions")) {
        captured.stripe = new URLSearchParams(String(init?.body ?? ""));
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({ id: "cs_test_514", url: "https://checkout.stripe.com/c/pay/cs_test_514" }),
        } as any;
      }
      if (url.includes("/v1/oauth2/token")) {
        return { ok: true, status: 200, json: async () => ({ access_token: "tok-514" }) } as any;
      }
      if (url.includes("/v2/checkout/orders")) {
        captured.paypal = JSON.parse(String(init?.body ?? "{}"));
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: "PP-ORDER-514",
            links: [{ rel: "approve", href: "https://www.sandbox.paypal.com/checkoutnow?token=PP-ORDER-514" }],
          }),
        } as any;
      }
      if (url.includes("api.lemonsqueezy.com/v1/checkouts")) {
        captured.lemonsqueezy = JSON.parse(String(init?.body ?? "{}"));
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: { id: "ls_514", attributes: { url: "https://checkout.lemonsqueezy.com/ls_514" } },
          }),
        } as any;
      }
      throw new Error(`Unexpected fetch in test: ${url}`);
    })
  );
}

const FABRICATED = [
  "AI Compute Tokens",
  "AI Compute Credits",
  "AI Token Credits",
  "Autonomous agent credit deposit",
  "Enterprise Client",
];

describe("POST /payments/create — no invented description or customer (#514)", () => {
  beforeEach(stubGatewayFetch);
  afterEach(() => vi.unstubAllGlobals());

  const makeAgent = (env: Env) => {
    const sql = new MockSqlStorage();
    const ctx = {
      id: { toString: () => "payments-creator-514" },
      storage: { sql },
      waitUntil: vi.fn(),
    };
    const agent = new OrchestratorAgent(ctx as any, env);
    return { agent, sql };
  };

  const postCreate = (agent: OrchestratorAgent, body: Record<string, unknown>) =>
    agent.onRequest(
      new Request("https://agent.internal/payments/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
    );

  const allTx = (sql: MockSqlStorage) =>
    Array.from(sql.exec("SELECT * FROM mas_transactions")) as any[];
  const baselineIds = (sql: MockSqlStorage) => new Set(allTx(sql).map((r) => r.id as string));
  const newTx = (sql: MockSqlStorage, base: Set<string>) => allTx(sql).filter((r) => !base.has(r.id));

  it("stripe, no description supplied: stored note is empty and the Stripe product name is the neutral label", async () => {
    const { agent, sql } = makeAgent(makeEnv());
    const base = baselineIds(sql);
    const res = await postCreate(agent, { amount: 25, customer: "Acme Corp", gateway: "stripe" });
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.success).toBe(true);
    expect(json.transaction.note).toBe("");
    const rows = newTx(sql, base);
    expect(rows).toHaveLength(1);
    expect(rows[0].note).toBe("");
    const name = captured.stripe?.get("line_items[0][price_data][product_data][name]");
    expect(name).toBe("Payment");
    for (const bad of FABRICATED) expect(name ?? "").not.toContain(bad);
  });

  it("stripe, description supplied: it reaches the stored row and the Stripe product name unchanged", async () => {
    const { agent, sql } = makeAgent(makeEnv());
    const base = baselineIds(sql);
    const res = await postCreate(agent, {
      amount: 25,
      customer: "Acme Corp",
      gateway: "stripe",
      description: "Q3 consulting engagement",
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.transaction.note).toBe("Q3 consulting engagement");
    const rows = newTx(sql, base);
    expect(rows).toHaveLength(1);
    expect(rows[0].note).toBe("Q3 consulting engagement");
    expect(captured.stripe?.get("line_items[0][price_data][product_data][name]")).toBe("Q3 consulting engagement");
  });

  it("no customer supplied: the stored row records an empty customer, not a fabricated organization", async () => {
    const { agent, sql } = makeAgent(makeEnv());
    const base = baselineIds(sql);
    const res = await postCreate(agent, { amount: 25, gateway: "stripe" });
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.success).toBe(true);
    expect(json.transaction.customer).toBe("");
    const rows = newTx(sql, base);
    expect(rows).toHaveLength(1);
    expect(rows[0].customer).toBe("");
  });

  it("paypal, no description supplied: the purchase unit carries no description at all", async () => {
    const { agent, sql } = makeAgent(makeEnv());
    const base = baselineIds(sql);
    const res = await postCreate(agent, { amount: 25, customer: "Acme Corp", gateway: "paypal" });
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.success).toBe(true);
    expect(json.transaction.note).toBe("");
    const rows = newTx(sql, base);
    expect(rows).toHaveLength(1);
    expect(rows[0].note).toBe("");
    const unit = captured.paypal?.purchase_units?.[0];
    expect(unit).toBeDefined();
    expect("description" in unit).toBe(false);
    expect(JSON.stringify(captured.paypal)).not.toContain("AI Compute Credits");
  });

  it("paypal, description supplied: the purchase unit carries it unchanged", async () => {
    const { agent } = makeAgent(makeEnv());
    const res = await postCreate(agent, {
      amount: 25,
      customer: "Acme Corp",
      gateway: "paypal",
      description: "Hosting renewal — October",
    });
    expect(res.status).toBe(200);
    expect(captured.paypal?.purchase_units?.[0]?.description).toBe("Hosting renewal — October");
  });

  it("lemonsqueezy, no description supplied: neutral product name and an empty product description", async () => {
    const { agent, sql } = makeAgent(makeEnv());
    const base = baselineIds(sql);
    const res = await postCreate(agent, { amount: 25, customer: "Acme Corp", gateway: "lemonsqueezy" });
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.success).toBe(true);
    const rows = newTx(sql, base);
    expect(rows).toHaveLength(1);
    expect(rows[0].note).toBe("");
    const opts = captured.lemonsqueezy?.data?.attributes?.product_options;
    expect(opts?.name).toBe("Payment");
    expect(opts?.description).toBe("");
    for (const bad of FABRICATED) expect(JSON.stringify(captured.lemonsqueezy)).not.toContain(bad);
  });

  it("lemonsqueezy, description supplied: name and product description both carry it", async () => {
    const { agent } = makeAgent(makeEnv());
    const res = await postCreate(agent, {
      amount: 25,
      customer: "Acme Corp",
      gateway: "lemonsqueezy",
      description: "API usage — September",
    });
    expect(res.status).toBe(200);
    const opts = captured.lemonsqueezy?.data?.attributes?.product_options;
    expect(opts?.name).toBe("API usage — September");
    expect(opts?.description).toBe("API usage — September");
  });
});

describe("Source pins (#514)", () => {
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((entry) => {
      const p = join(dir, entry);
      return statSync(p).isDirectory() ? walk(p) : [p];
    });

  it("no file under src/ contains the fabricated product lines or the fabricated customer name", () => {
    const offenders: string[] = [];
    for (const file of walk("src")) {
      if (!file.endsWith(".ts") && !file.endsWith(".tsx")) continue;
      const text = readFileSync(file, "utf8");
      for (const bad of FABRICATED) {
        if (text.includes(bad)) offenders.push(`${file}: ${bad}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the create route stores the caller's description or an empty string — no template fallback", () => {
    const route = readFileSync("src/agents/routes/payments.ts", "utf8");
    expect(route).toContain('const description = (body.description || "").trim();');
    expect(route).toContain('const customer = (body.customer || "").trim();');
  });
});
