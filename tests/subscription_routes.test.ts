/**
 * Issues #2020/#2127 — subscription endpoints through
 * handleAgenticPaymentsRoutes: plans as operator data, the
 * route-owned cfpay checkout, purchase activation on verified
 * payment, cancel-at-period-end, and the effective-tier status
 * read — plus the submit route's effective-tier wiring.
 *
 * D1 is shared, so there is no canonical-instance hop: the
 * handler builds both store adapters straight from
 * ctx.env.AGENT_DB. Tests supply a MockD1Database (node:sqlite,
 * the slice0 pattern) with migrations 0007 + 0008 applied, so
 * the real Drizzle adapters run. cfpay is stubbed at fetch:
 * checkout.create returns an opaque payload, checkout.status
 * returns the test's chosen fulfillment state.
 */
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  handleAgenticPaymentsRoutes,
  type AgenticPaymentsRouteContext,
} from "../src/agents/routes/agenticPayments";
import {
  createD1CommercialDb,
  D1CommercialAdapter,
  ensureCommercialSchema,
} from "../src/data/d1CommercialAdapter";
import {
  createD1SubscriptionDb,
  D1SubscriptionAdapter,
  ensureSubscriptionSchema,
} from "../src/data/d1SubscriptionAdapter";
import type { DatabaseORM } from "../src/orm";

/** Minimal D1Database stand-in over node:sqlite (test-only, mirrors slice0). */
class MockD1Database {
  readonly sqlite = new DatabaseSync(":memory:");
  prepare(sql: string) {
    const db = this.sqlite;
    return {
      bind(...params: unknown[]) {
        return {
          async run() {
            const info = db.prepare(sql).run(...(params as any[]));
            return {
              success: true,
              meta: { changes: info.changes, last_row_id: info.lastInsertRowid },
              results: [],
            };
          },
          async all() {
            return { results: db.prepare(sql).all(...(params as any[])) };
          },
          async first() {
            return db.prepare(sql).get(...(params as any[])) ?? null;
          },
          async raw() {
            return db
              .prepare(sql)
              .all(...(params as any[]))
              .map((row: any) => Object.values(row));
          },
        };
      },
    };
  }
}

async function setup(opts: { monetization?: boolean; cfpayToken?: boolean } = {}) {
  const mock = new MockD1Database();
  const commercialDb = createD1CommercialDb(mock as unknown as D1Database);
  await ensureCommercialSchema(commercialDb);
  const subsDb = createD1SubscriptionDb(mock as unknown as D1Database);
  await ensureSubscriptionSchema(subsDb);
  let capturedParams: any = null;
  const binding = {
    create: vi.fn(async ({ id, params }: { id: string; params?: unknown }) => {
      capturedParams = params;
      return { workflowId: id };
    }),
    get: vi.fn(async () => ({ status: async () => ({ status: "completed" }) })),
  };
  const screenerBinding = {
    create: vi.fn(async ({ id }: { id: string }) => ({ id })),
    get: vi.fn(async () => {
      throw new Error("not found");
    }),
  };
  const env: Record<string, unknown> = {
    AGENT_DB: mock,
    COMMERCIAL_STORE_OPERATORS: "op1",
    PAYMENT_WORKFLOW: binding,
    SCREENER_WORKFLOW: screenerBinding,
  };
  if (opts.monetization) env.MONETIZATION_ENABLED = "true";
  if (opts.cfpayToken) env.CFPAY_A2A_TOKEN = "test-token";
  const ctx = {
    env,
    getOrm: () => ({}) as DatabaseORM,
    audit: vi.fn(),
  } as unknown as AgenticPaymentsRouteContext;
  return { ctx, env, binding, captured: () => capturedParams };
}

const req = (method: string, path: string, login: string | null, body?: unknown) =>
  new Request(`https://agent.internal${path}`, {
    method,
    headers: {
      ...(login ? { "x-user-login": login } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

const call = (
  ctx: AgenticPaymentsRouteContext,
  method: string,
  path: string,
  login: string | null,
  body?: unknown,
) => {
  const url = new URL(`https://agent.internal${path}`);
  return handleAgenticPaymentsRoutes(req(method, path, login, body), url, url.pathname, "sess-1", ctx);
};

const bodyOf = async (res: Response | null) => (await res?.json()) as any;

/** Stub fetch so cfpayA2AOperation sees JSON-RPC data parts. */
function stubCfpay(statusPayload: Record<string, unknown> | null, ok = true) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: any) => {
      const parsed = JSON.parse(init.body as string);
      const dataPart = parsed.params.message.parts[0].data as { operation: string };
      const payload =
        dataPart.operation === "checkout.create"
          ? { ok: true, checkoutId: "co_1" }
          : (statusPayload ?? { ok: false, error: "not_found" });
      return {
        ok,
        status: ok ? 200 : 502,
        json: async () => ({
          result: { artifacts: [{ parts: [{ kind: "data", data: payload }] }] },
        }),
      };
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

async function createPlan(ctx: AgenticPaymentsRouteContext, plan: Record<string, unknown>) {
  const res = await call(ctx, "POST", "/payments/agentic/commercial/plans", "op1", plan);
  expect(res?.status).toBe(200);
  return (await bodyOf(res)).plan;
}

describe("subscription plans", () => {
  it("auth matrix: anonymous cannot list, non-operator cannot create, operator can", async () => {
    const { ctx } = await setup();
    expect((await call(ctx, "GET", "/payments/agentic/commercial/plans", null))?.status).toBe(401);
    expect((await call(ctx, "POST", "/payments/agentic/commercial/plans", "u1", { name: "P", priceUSD: 5, periodDays: 30, includedRuns: 0 }))?.status).toBe(403);
    const plan = await createPlan(ctx, { name: "Pro", priceUSD: 20, periodDays: 30, includedRuns: 10 });
    expect(plan.id).toMatch(/^plan-/);
    const listed = await bodyOf(await call(ctx, "GET", "/payments/agentic/commercial/plans", "u1"));
    expect(listed.plans.map((p: any) => p.id)).toEqual([plan.id]);
  });

  it("validates plan input and deactivation", async () => {
    const { ctx } = await setup();
    expect((await call(ctx, "POST", "/payments/agentic/commercial/plans", "op1", { priceUSD: 5, periodDays: 30, includedRuns: 0 }))?.status).toBe(400);
    expect((await call(ctx, "POST", "/payments/agentic/commercial/plans", "op1", { name: "P", priceUSD: 0, periodDays: 30, includedRuns: 0 }))?.status).toBe(400);
    const plan = await createPlan(ctx, { name: "P", priceUSD: 5, periodDays: 30, includedRuns: 0 });
    expect((await call(ctx, "POST", "/payments/agentic/commercial/plans/deactivate", "u1", { planId: plan.id }))?.status).toBe(403);
    expect((await call(ctx, "POST", "/payments/agentic/commercial/plans/deactivate", "op1", { planId: "missing" }))?.status).toBe(404);
    const off = await bodyOf(await call(ctx, "POST", "/payments/agentic/commercial/plans/deactivate", "op1", { planId: plan.id }));
    expect(off.plan.active).toBe(false);
    expect((await bodyOf(await call(ctx, "GET", "/payments/agentic/commercial/plans", "u1"))).plans).toEqual([]);
  });
});

describe("subscription checkout + purchase", () => {
  it("flag OFF refuses checkout and purchase before any cfpay call", async () => {
    const { ctx } = await setup({ cfpayToken: true });
    stubCfpay({ status: "fulfilled" });
    const plan = await createPlan(ctx, { name: "P", priceUSD: 5, periodDays: 30, includedRuns: 0 });
    expect((await call(ctx, "POST", "/payments/agentic/commercial/subscription/checkout", "u1", { planId: plan.id, tenantId: "t1", email: "u1@example.com" }))?.status).toBe(403);
    expect((await call(ctx, "POST", "/payments/agentic/commercial/subscription/purchase", "u1", { planId: plan.id, tenantId: "t1", checkoutRequestId: "sub-x" }))?.status).toBe(403);
  });

  it("cfpay unconfigured fails closed with 503", async () => {
    const { ctx } = await setup({ monetization: true });
    const plan = await createPlan(ctx, { name: "P", priceUSD: 5, periodDays: 30, includedRuns: 0 });
    expect((await call(ctx, "POST", "/payments/agentic/commercial/subscription/checkout", "u1", { planId: plan.id, tenantId: "t1", email: "u1@example.com" }))?.status).toBe(503);
    expect((await call(ctx, "POST", "/payments/agentic/commercial/subscription/purchase", "u1", { planId: plan.id, tenantId: "t1", checkoutRequestId: "sub-x" }))?.status).toBe(503);
  });

  it("unfulfilled checkout activates nothing (402), fulfilled activates (and replays 409)", async () => {
    const { ctx } = await setup({ monetization: true, cfpayToken: true });
    const plan = await createPlan(ctx, { name: "Pro", priceUSD: 20, periodDays: 30, includedRuns: 10 });
    stubCfpay({ status: "pending" });
    const checkout = await bodyOf(
      await call(ctx, "POST", "/payments/agentic/commercial/subscription/checkout", "u1", { planId: plan.id, tenantId: "t1", email: "u1@example.com" }),
    );
    expect(checkout.checkoutRequestId).toMatch(/^sub-/);
    expect(checkout.plan.priceUSD).toBe(20);
    const denied = await call(ctx, "POST", "/payments/agentic/commercial/subscription/purchase", "u1", {
      planId: plan.id, tenantId: "t1", checkoutRequestId: checkout.checkoutRequestId,
    });
    expect(denied?.status).toBe(402);
    const empty = await bodyOf(await call(ctx, "GET", "/payments/agentic/commercial/subscription?userId=u1", "u1"));
    expect(empty.subscriptions).toEqual([]);
    expect(empty.effectiveTier).toBe("Free");

    stubCfpay({ status: "fulfilled" });
    const bought = await bodyOf(
      await call(ctx, "POST", "/payments/agentic/commercial/subscription/purchase", "u1", {
        planId: plan.id, tenantId: "t1", checkoutRequestId: checkout.checkoutRequestId,
      }),
    );
    expect(bought.subscription.status).toBe("active");
    expect(bought.subscription.planId).toBe(plan.id);
    expect(bought.subscription.providerPaymentRef).toBe(checkout.checkoutRequestId);
    expect(bought.subscription.periodEndMs).toBeGreaterThan(bought.subscription.periodStartMs);
    expect(bought.account.tierSource).toBe("subscription");
    expect(bought.account.includedRuns).toBe(10);
    expect(bought.effectiveTier).toBe("Subscribed");
    expect((ctx.audit as any).mock.calls.some(([t]: [string]) => t === "commercial.subscription.activated")).toBe(true);

    const replay = await call(ctx, "POST", "/payments/agentic/commercial/subscription/purchase", "u1", {
      planId: plan.id, tenantId: "t1", checkoutRequestId: checkout.checkoutRequestId,
    });
    expect(replay?.status).toBe(409);
  });

  it("rejects foreign checkout ids, inactive plans, and tenant mismatch", async () => {
    const { ctx } = await setup({ monetization: true, cfpayToken: true });
    stubCfpay({ status: "fulfilled" });
    const plan = await createPlan(ctx, { name: "P", priceUSD: 5, periodDays: 30, includedRuns: 0 });
    expect((await call(ctx, "POST", "/payments/agentic/commercial/subscription/purchase", "u1", { planId: plan.id, tenantId: "t1", checkoutRequestId: "run-123" }))?.status).toBe(400);
    await call(ctx, "POST", "/payments/agentic/commercial/plans/deactivate", "op1", { planId: plan.id });
    expect((await call(ctx, "POST", "/payments/agentic/commercial/subscription/purchase", "u1", { planId: plan.id, tenantId: "t1", checkoutRequestId: "sub-x" }))?.status).toBe(409);
    const live = await createPlan(ctx, { name: "L", priceUSD: 5, periodDays: 30, includedRuns: 0 });
    await call(ctx, "POST", "/payments/agentic/commercial/account", "op1", { userId: "u1", tenantId: "t1", tier: "Free" });
    expect((await call(ctx, "POST", "/payments/agentic/commercial/subscription/purchase", "u1", { planId: live.id, tenantId: "t2", checkoutRequestId: "sub-y" }))?.status).toBe(403);
  });
});

describe("subscription cancel + status", () => {
  it("cancel-at-period-end keeps access to periodEnd, then a second cancel is empty", async () => {
    const { ctx } = await setup({ monetization: true, cfpayToken: true });
    stubCfpay({ status: "fulfilled" });
    const plan = await createPlan(ctx, { name: "P", priceUSD: 5, periodDays: 30, includedRuns: 0 });
    const checkout = await bodyOf(
      await call(ctx, "POST", "/payments/agentic/commercial/subscription/checkout", "u1", { planId: plan.id, tenantId: "t1", email: "u1@example.com" }),
    );
    await call(ctx, "POST", "/payments/agentic/commercial/subscription/purchase", "u1", {
      planId: plan.id, tenantId: "t1", checkoutRequestId: checkout.checkoutRequestId,
    });
    expect((await call(ctx, "POST", "/payments/agentic/commercial/subscription/cancel", "u2", { userId: "u1" }))?.status).toBe(403);
    const canceled = await bodyOf(await call(ctx, "POST", "/payments/agentic/commercial/subscription/cancel", "u1", {}));
    expect(canceled.canceled).toHaveLength(1);
    expect(canceled.canceled[0].status).toBe("canceled");
    expect(canceled.accessThroughMs).toBe(canceled.canceled[0].periodEndMs);
    const again = await bodyOf(await call(ctx, "POST", "/payments/agentic/commercial/subscription/cancel", "u1", {}));
    expect(again.canceled).toEqual([]);
    const status = await bodyOf(await call(ctx, "GET", "/payments/agentic/commercial/subscription?userId=u1", "u1"));
    expect(status.effectiveTier).toBe("Subscribed");
    expect(status.current.status).toBe("canceled");
    expect((ctx.audit as any).mock.calls.some(([t]: [string]) => t === "commercial.subscription.canceled")).toBe(true);
    const opCancel = await bodyOf(await call(ctx, "POST", "/payments/agentic/commercial/subscription/cancel", "op1", { userId: "u1" }));
    expect(opCancel.canceled).toEqual([]);
  });

  it("status read auth: anonymous 401, other user 403, operator 200", async () => {
    const { ctx } = await setup();
    expect((await call(ctx, "GET", "/payments/agentic/commercial/subscription?userId=u1", null))?.status).toBe(401);
    expect((await call(ctx, "GET", "/payments/agentic/commercial/subscription?userId=u1", "u2"))?.status).toBe(403);
    expect((await call(ctx, "GET", "/payments/agentic/commercial/subscription?userId=u1", "op1"))?.status).toBe(200);
  });
});

describe("submit route effective tier", () => {
  it("a lapsed subscription passes Free (not stored Subscribed) to the payment workflow", async () => {
    const { ctx, captured } = await setup();
    await call(ctx, "POST", "/payments/agentic/commercial/account", "op1", { userId: "u1", tenantId: "t1", tier: "Subscribed" });
    // The operator route grants tierSource "operator" — rewrite the
    // grant to a subscription grant via the adapters, then let it
    // lapse: direct adapter writes keep this test honest about the
    // stored row (no route can produce this state on its own).
    const mock = (ctx.env as any).AGENT_DB;
    const subs = new D1SubscriptionAdapter(createD1SubscriptionDb(mock));
    const store = new D1CommercialAdapter(createD1CommercialDb(mock));
    await store.upsertAccount({ userId: "u1", tenantId: "t1", tier: "Subscribed", tierSource: "subscription", creditsUSD: 0, includedRuns: 0 });
    await subs.createSubscription({
      id: "s-old", userId: "u1", tenantId: "t1", planId: "pro", provider: "cfpay",
      providerPaymentRef: "sub-old", periodStartMs: 1000, periodEndMs: 2000,
    });
    const res = await call(ctx, "POST", "/payments/agentic/commercial/submit", "u1", {
      family: "goal",
      tenantId: "t1",
      email: "u1@example.com",
      screenerCommand: { jobId: "job-1", type: "run-screen", source: "test", trigger: "manual", userLogin: "u1", shards: [{ shardId: "goal" }] },
    });
    expect(res?.status).toBe(200);
    expect((await bodyOf(res)).status).toBe("payment_started");
    expect(captured().account.tier).toBe("Free");
  });
});
