/**
 * Issue #2137: checkout UI support routes — pricing, submission
 * check-payment, goal-command — tested through
 * handleAgenticPaymentsRoutes.
 *
 * The check-payment route mirrors the assurance check-payment: it
 * re-reads cfpay checkout.status and delivers payment_verified ONLY
 * when fulfilled. cfpay's HTTP surface is mocked (JSON-RPC artifact
 * data part), so no network and no key are involved.
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import {
  handleAgenticPaymentsRoutes,
  type AgenticPaymentsRouteContext,
} from "../src/agents/routes/agenticPayments";
import type { DatabaseORM } from "../src/orm";

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

function ctxWith(env: Record<string, unknown>, binding?: Record<string, unknown>) {
  const ctx = {
    env: { ...env, ...(binding ? { PAYMENT_WORKFLOW: binding } : {}) },
    getOrm: () => ({}) as DatabaseORM,
    audit: vi.fn(),
  } as unknown as AgenticPaymentsRouteContext;
  return ctx;
}

function cfpayStatusBody(statusData: Record<string, unknown>) {
  return {
    result: {
      artifacts: [{ parts: [{ kind: "data", data: statusData }] }],
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("checkout UI pricing route (#2137)", () => {
  it("returns server-truth prices, flag state, and the gate failure policy", async () => {
    const res = await call(ctxWith({}), "GET", "/payments/agentic/commercial/pricing", "u1");
    expect(res?.status).toBe(200);
    const body = (await res?.json()) as {
      monetizationEnabled: boolean;
      prices: Record<string, number>;
      testnetOnly: boolean;
      failurePolicy: string;
    };
    expect(body.monetizationEnabled).toBe(false);
    expect(body.prices).toEqual({ stock: 0.02, goal: 0.1, options: 0.05, strategy: 0.1 });
    expect(body.testnetOnly).toBe(true);
    expect(body.failurePolicy).toContain("One charge per run-request");
    expect(body.failurePolicy).toContain("replacement-run credit");
  });

  it("reflects explicit env enablement", async () => {
    const res = await call(
      ctxWith({ MONETIZATION_ENABLED: "true" }),
      "GET",
      "/payments/agentic/commercial/pricing",
      "u1",
    );
    expect(res?.status).toBe(200);
    expect(((await res?.json()) as { monetizationEnabled: boolean }).monetizationEnabled).toBe(true);
  });

  it("requires a verified login", async () => {
    const res = await call(ctxWith({}), "GET", "/payments/agentic/commercial/pricing", null);
    expect(res?.status).toBe(401);
  });
});

describe("checkout UI check-payment route (#2137)", () => {
  const sendEvent = vi.fn(async () => {});
  const binding = {
    create: vi.fn(async ({ id }: { id: string }) => ({ id })),
    get: vi.fn(async () => ({ sendEvent })),
  };

  it("delivers payment_verified only when cfpay reports fulfilled", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => cfpayStatusBody({ status: "fulfilled" }) })),
    );
    const res = await call(
      ctxWith({ CFPAY_A2A_TOKEN: "tok" }, binding),
      "POST",
      "/payments/agentic/commercial/submission/check-payment",
      "u1",
      { runRequestId: "run-1" },
    );
    expect(res?.status).toBe(200);
    const body = (await res?.json()) as { paid: boolean; delivered: boolean; state: string };
    expect(body.paid).toBe(true);
    expect(body.delivered).toBe(true);
    expect(sendEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "payment_verified" }),
    );
  });

  it("delivers nothing for an unfulfilled checkout", async () => {
    sendEvent.mockClear();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => cfpayStatusBody({ status: "pending" }) })),
    );
    const res = await call(
      ctxWith({ CFPAY_A2A_TOKEN: "tok" }, binding),
      "POST",
      "/payments/agentic/commercial/submission/check-payment",
      "u1",
      { runRequestId: "run-1" },
    );
    expect(res?.status).toBe(200);
    const body = (await res?.json()) as { paid: boolean; state: string };
    expect(body.paid).toBe(false);
    expect(body.state).toBe("pending");
    expect(sendEvent).not.toHaveBeenCalled();
  });

  it("returns a payment URL only when cfpay provides one", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        ({ ok: true, json: async () => cfpayStatusBody({ status: "pending", checkoutUrl: "https://pay.example/c/1" }) }),
      ),
    );
    const res = await call(
      ctxWith({ CFPAY_A2A_TOKEN: "tok" }, binding),
      "POST",
      "/payments/agentic/commercial/submission/check-payment",
      "u1",
      { runRequestId: "run-1" },
    );
    expect(((await res?.json()) as { paymentUrl: string }).paymentUrl).toBe("https://pay.example/c/1");
  });

  it("fails closed without a cfpay key and validates input", async () => {
    const noKey = await call(
      ctxWith({}, binding),
      "POST",
      "/payments/agentic/commercial/submission/check-payment",
      "u1",
      { runRequestId: "run-1" },
    );
    expect(noKey?.status).toBe(503);
    const noId = await call(
      ctxWith({ CFPAY_A2A_TOKEN: "tok" }, binding),
      "POST",
      "/payments/agentic/commercial/submission/check-payment",
      "u1",
      {},
    );
    expect(noId?.status).toBe(400);
    const noLogin = await call(
      ctxWith({ CFPAY_A2A_TOKEN: "tok" }, binding),
      "POST",
      "/payments/agentic/commercial/submission/check-payment",
      null,
      { runRequestId: "run-1" },
    );
    expect(noLogin?.status).toBe(401);
  });
});

describe("checkout UI goal-command route (#2137)", () => {
  it("builds a goal screener command from kind and direction", async () => {
    const res = await call(
      ctxWith({}),
      "POST",
      "/payments/agentic/commercial/goal-command",
      "u1",
      { jobId: "job-9", goalKind: "income", direction: "range_bound", symbols: ["AAPL"] },
    );
    expect(res?.status).toBe(200);
    const body = (await res?.json()) as { screenerCommand: { jobId: string; shards: Array<{ shardId: string }>; goalScreen: { scenario: { goalKind: string } } } };
    expect(body.screenerCommand.jobId).toBe("job-9");
    expect(body.screenerCommand.shards).toEqual([{ shardId: "goal" }]);
    expect(body.screenerCommand.goalScreen.scenario.goalKind).toBe("income");
  });

  it("rejects unknown kinds, directions, and missing identity", async () => {
    const badKind = await call(
      ctxWith({}),
      "POST",
      "/payments/agentic/commercial/goal-command",
      "u1",
      { jobId: "job-9", goalKind: "nope", direction: "bullish" },
    );
    expect(badKind?.status).toBe(400);
    const badDir = await call(
      ctxWith({}),
      "POST",
      "/payments/agentic/commercial/goal-command",
      "u1",
      { jobId: "job-9", goalKind: "income", direction: "sideways" },
    );
    expect(badDir?.status).toBe(400);
    const noLogin = await call(
      ctxWith({}),
      "POST",
      "/payments/agentic/commercial/goal-command",
      null,
      { jobId: "job-9", goalKind: "income", direction: "bullish" },
    );
    expect(noLogin?.status).toBe(401);
  });
});
