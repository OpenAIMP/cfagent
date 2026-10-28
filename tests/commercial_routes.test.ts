/**
 * Issue #2015/#2020 — commercial store endpoints + the dedicated
 * paid-submission route, tested through handleAgenticPaymentsRoutes.
 *
 * The canonical-instance hop is faked the way the ledger client
 * tests fake it: env.SEARCH_AGENT.get returns a stub whose fetch
 * invokes the same handler with a canonical ctx (Map-backed repos).
 * That exercises the real endpoint code through the real client.
 */
import { describe, expect, it, vi } from "vitest";
import {
  handleAgenticPaymentsRoutes,
  type AgenticPaymentsRouteContext,
} from "../src/agents/routes/agenticPayments";
import type { DatabaseORM } from "../src/orm";
import type {
  CommercialAccountRecord,
  CreditRedemptionRecord,
  TenantSettingsRecord,
  TransactionRecord,
} from "../src/types";

function makeRepo<T extends Record<string, unknown>>(key: keyof T) {
  const map = new Map<string, T>();
  return {
    map,
    findOne: (where: Record<string, unknown>) => {
      for (const row of map.values()) {
        if (Object.entries(where).every(([k, v]) => row[k] === v)) return row;
      }
      return null;
    },
    findById: (id: string) => map.get(id) ?? null,
    findMany: (opts: { where?: Record<string, unknown> } = {}) => {
      const rows = [...map.values()];
      if (!opts.where) return rows;
      return rows.filter((row) =>
        Object.entries(opts.where as Record<string, unknown>).every(([k, v]) => row[k] === v),
      );
    },
    create: (record: T) => {
      const id = String(record[key]);
      if (map.has(id)) throw new Error("UNIQUE constraint failed");
      map.set(id, record);
      return record;
    },
    update: (id: string, patch: Partial<T>) => {
      const row = map.get(id);
      if (!row) return null;
      const next = { ...row, ...patch };
      map.set(id, next);
      return next;
    },
    upsert: (record: T) => {
      map.set(String(record[key]), record);
      return record;
    },
  };
}

function makeStoreOrm() {
  return {
    commercialAccounts: makeRepo<CommercialAccountRecord>("id"),
    tenantSettings: makeRepo<TenantSettingsRecord>("tenantId"),
    creditRedemptions: makeRepo<CreditRedemptionRecord>("creditRunId"),
    transactions: makeRepo<TransactionRecord>("id"),
    events: makeRepo<Record<string, unknown>>("id"),
  };
}

type StoreOrm = ReturnType<typeof makeStoreOrm>;

function setup() {
  const storeOrm = makeStoreOrm();
  const canonicalEnv = {
    SERVICE_USER_LOGIN: "svc",
    COMMERCIAL_STORE_OPERATORS: "op1",
  };
  const canonicalCtx = {
    env: canonicalEnv,
    getOrm: () => storeOrm,
    audit: vi.fn(),
  } as unknown as AgenticPaymentsRouteContext;
  const canonicalFetch = async (req: Request) => {
    const url = new URL(req.url);
    return handleAgenticPaymentsRoutes(req, url, url.pathname, "sess-canonical", canonicalCtx);
  };
  const binding = {
    create: vi.fn(async ({ id }: { id: string }) => ({ id })),
    get: vi.fn(async () => ({ status: async () => ({ status: "completed" }) })),
  };
  const callerEnv = {
    SERVICE_USER_LOGIN: "svc",
    COMMERCIAL_STORE_OPERATORS: "op1",
    SEARCH_AGENT: { idFromName: () => "canonical", get: () => ({ fetch: canonicalFetch }) },
    PAYMENT_WORKFLOW: binding,
  };
  const callerCtx = {
    env: callerEnv,
    getOrm: () => ({}) as DatabaseORM,
    audit: vi.fn(),
  } as unknown as AgenticPaymentsRouteContext;
  return { storeOrm, canonicalEnv, canonicalCtx, callerEnv, callerCtx, binding };
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

const screenerCommand = {
  jobId: "job-1",
  type: "run-screen",
  source: "test",
  trigger: "manual",
  userLogin: "u1",
  shards: [],
  role: "parent",
};

describe("commercial store endpoints (#2015)", () => {
  it("operator upserts; self reads; others are refused; bad tiers are 400", async () => {
    const { canonicalCtx } = setup();
    const created = await call(canonicalCtx, "POST", "/payments/agentic/commercial/account", "op1", {
      userId: "u1",
      tenantId: "t1",
      tier: "Subscribed",
      creditsUSD: 5,
      includedRuns: 2,
    });
    expect(created?.status).toBe(200);
    expect(((await created?.json()) as { record: { tier: string } }).record.tier).toBe("Subscribed");
    const forbidden = await call(canonicalCtx, "POST", "/payments/agentic/commercial/account", "u1", {
      userId: "u1",
      tenantId: "t1",
      tier: "Free",
    });
    expect(forbidden?.status).toBe(403);
    const badTier = await call(canonicalCtx, "POST", "/payments/agentic/commercial/account", "op1", {
      userId: "u1",
      tenantId: "t1",
      tier: "Premium",
    });
    expect(badTier?.status).toBe(400);
    const self = await call(canonicalCtx, "GET", "/payments/agentic/commercial/account?userId=u1", "u1");
    expect(self?.status).toBe(200);
    const other = await call(canonicalCtx, "GET", "/payments/agentic/commercial/account?userId=u1", "u2");
    expect(other?.status).toBe(403);
    const service = await call(canonicalCtx, "GET", "/payments/agentic/commercial/account?userId=u1", "svc");
    expect(service?.status).toBe(200);
    const anon = await call(canonicalCtx, "GET", "/payments/agentic/commercial/account?userId=u1", null);
    expect(anon?.status).toBe(401);
  });

  it("credits adjust with a floor; consume is service-only", async () => {
    const { canonicalCtx } = setup();
    await call(canonicalCtx, "POST", "/payments/agentic/commercial/account", "op1", {
      userId: "u1",
      tenantId: "t1",
      tier: "PayPerUse",
      creditsUSD: 10,
      includedRuns: 1,
    });
    const adjusted = await call(canonicalCtx, "POST", "/payments/agentic/commercial/account/credits", "op1", {
      userId: "u1",
      deltaUSD: -3,
    });
    expect(((await adjusted?.json()) as { record: { creditsUSD: number } }).record.creditsUSD).toBe(7);
    const below = await call(canonicalCtx, "POST", "/payments/agentic/commercial/account/credits", "op1", {
      userId: "u1",
      deltaUSD: -100,
    });
    expect(below?.status).toBe(400);
    const consumed = await call(canonicalCtx, "POST", "/payments/agentic/commercial/account/consume", "svc", {
      userId: "u1",
      kind: "included",
    });
    expect(((await consumed?.json()) as { record: { includedRuns: number } }).record.includedRuns).toBe(0);
    const userConsume = await call(canonicalCtx, "POST", "/payments/agentic/commercial/account/consume", "u1", {
      userId: "u1",
      kind: "included",
    });
    expect(userConsume?.status).toBe(403);
    const insufficient = await call(canonicalCtx, "POST", "/payments/agentic/commercial/account/consume", "svc", {
      userId: "u1",
      kind: "credits",
      amountUSD: 100,
    });
    expect(insufficient?.status).toBe(400);
  });

  it("tenant settings are operator/service-only; redeem is service-only with 409 on replay", async () => {
    const { canonicalCtx, storeOrm } = setup();
    const def = await call(canonicalCtx, "GET", "/payments/agentic/commercial/tenant-settings?tenantId=t1", "svc");
    expect(((await def?.json()) as { adsEnabled: boolean }).adsEnabled).toBe(true);
    const userRead = await call(canonicalCtx, "GET", "/payments/agentic/commercial/tenant-settings?tenantId=t1", "u1");
    expect(userRead?.status).toBe(403);
    const set = await call(canonicalCtx, "POST", "/payments/agentic/commercial/tenant-settings", "op1", {
      tenantId: "t1",
      adsEnabled: false,
    });
    expect(set?.status).toBe(200);
    (storeOrm.transactions as unknown as { map: Map<string, TransactionRecord> }).map.set("cfpay_run-9", {
      id: "cfpay_run-9",
      sessionId: "screener-payment:run-9",
      action: "credit",
      amount: 0.1,
      currency: "USD",
      customer: "u1",
      gateway: "stripe",
      status: "completed",
      proposerDid: "did:agent:openaimp:orchestrator",
      proofSignature: "none",
      createdAt: "2026-10-28T00:00:00Z",
      updatedAt: "2026-10-28T00:00:00Z",
    } as unknown as TransactionRecord);
    const redeemed = await call(canonicalCtx, "POST", "/payments/agentic/commercial/redeem-credit", "svc", {
      creditRunId: "run-9",
      redeemedByRunId: "run-10",
    });
    expect(redeemed?.status).toBe(200);
    const replay = await call(canonicalCtx, "POST", "/payments/agentic/commercial/redeem-credit", "svc", {
      creditRunId: "run-9",
      redeemedByRunId: "run-11",
    });
    expect(replay?.status).toBe(409);
    const userRedeem = await call(canonicalCtx, "POST", "/payments/agentic/commercial/redeem-credit", "u1", {
      creditRunId: "run-9",
      redeemedByRunId: "run-12",
    });
    expect(userRedeem?.status).toBe(403);
  });
});

describe("dedicated paid-submission route (#2015)", () => {
  const submitBody = {
    family: "goal",
    tenantId: "t1",
    email: "u1@example.com",
    screenerCommand,
  };

  it("rejects anonymous, invalid, recurring, and tenant-mismatched submissions", async () => {
    const { callerCtx, canonicalCtx } = setup();
    const anon = await call(callerCtx, "POST", "/payments/agentic/commercial/submit", null, submitBody);
    expect(anon?.status).toBe(401);
    const badFamily = await call(callerCtx, "POST", "/payments/agentic/commercial/submit", "u1", {
      ...submitBody,
      family: "crypto",
    });
    expect(badFamily?.status).toBe(400);
    const recurring = await call(callerCtx, "POST", "/payments/agentic/commercial/submit", "u1", {
      ...submitBody,
      scheduleKind: "recurring",
    });
    expect(recurring?.status).toBe(400);
    const noJob = await call(callerCtx, "POST", "/payments/agentic/commercial/submit", "u1", {
      ...submitBody,
      screenerCommand: { type: "run-screen" },
    });
    expect(noJob?.status).toBe(400);
    await call(canonicalCtx, "POST", "/payments/agentic/commercial/account", "op1", {
      userId: "u1",
      tenantId: "t2",
      tier: "Free",
    });
    const mismatch = await call(callerCtx, "POST", "/payments/agentic/commercial/submit", "u1", submitBody);
    expect(mismatch?.status).toBe(403);
  });

  it("starts the payment workflow for a new run with the stored account", async () => {
    const { callerCtx, canonicalCtx, binding } = setup();
    await call(canonicalCtx, "POST", "/payments/agentic/commercial/account", "op1", {
      userId: "u1",
      tenantId: "t1",
      tier: "Subscribed",
      creditsUSD: 0,
      includedRuns: 3,
    });
    const res = await call(callerCtx, "POST", "/payments/agentic/commercial/submit", "u1", submitBody);
    expect(res?.status).toBe(200);
    const body = (await res?.json()) as { status: string; workflowId: string; runRequestId: string };
    expect(body.status).toBe("payment_started");
    expect(body.runRequestId.startsWith("run-")).toBe(true);
    expect(binding.create).toHaveBeenCalledOnce();
    const createArg = (binding.create as unknown as { mock: { calls: Array<Array<{ id: string; params: { account: { tier: string } } }>> } }).mock.calls[0][0];
    expect(createArg.id).toBe(body.runRequestId);
    expect(createArg.params.account.tier).toBe("Subscribed");
  });

  it("fails closed when the store or the binding is unavailable", async () => {
    const { callerCtx } = setup();
    const noStoreEnv = {
      ...(callerCtx.env as Record<string, unknown>),
      SEARCH_AGENT: undefined,
    };
    const noStoreCtx = { ...callerCtx, env: noStoreEnv } as unknown as AgenticPaymentsRouteContext;
    const noStore = await call(noStoreCtx, "POST", "/payments/agentic/commercial/submit", "u1", submitBody);
    expect(noStore?.status).toBe(503);
    const noBindingCtx = {
      ...callerCtx,
      env: { ...(callerCtx.env as Record<string, unknown>), PAYMENT_WORKFLOW: undefined },
    } as unknown as AgenticPaymentsRouteContext;
    const noBinding = await call(noBindingCtx, "POST", "/payments/agentic/commercial/submit", "u1", submitBody);
    expect(noBinding?.status).toBe(503);
  });

  it("does not burn a credit when the screener port is unavailable", async () => {
    const { callerCtx, canonicalCtx, storeOrm } = setup();
    (storeOrm.transactions as unknown as { map: Map<string, TransactionRecord> }).map.set("cfpay_run-9", {
      id: "cfpay_run-9",
      sessionId: "screener-payment:run-9",
      action: "credit",
      amount: 0.1,
      currency: "USD",
      customer: "u1",
      gateway: "stripe",
      status: "completed",
      proposerDid: "did:agent:openaimp:orchestrator",
      proofSignature: "none",
      createdAt: "2026-10-28T00:00:00Z",
      updatedAt: "2026-10-28T00:00:00Z",
    } as unknown as TransactionRecord);
    (storeOrm.events as unknown as { map: Map<string, Record<string, unknown>> }).map.set("e1", {
      id: "e1",
      type: "payment.failure_credit_issued",
      payload: JSON.stringify({ runRequestId: "run-9", family: "goal" }),
    });
    const res = await call(callerCtx, "POST", "/payments/agentic/commercial/submit", "u1", submitBody);
    expect(res?.status).toBe(503);
    const still = await call(canonicalCtx, "GET", "/payments/agentic/commercial/unredeemed-credit?userId=u1&family=goal", "svc");
    expect(((await still?.json()) as { credit: { creditRunId: string } | null }).credit?.creditRunId).toBe("run-9");
  });

  it("reports submission status through the binding", async () => {
    const { callerCtx } = setup();
    const res = await call(callerCtx, "GET", "/payments/agentic/commercial/submission-status?workflowId=run-1", "u1");
    expect(res?.status).toBe(200);
    expect(((await res?.json()) as { status: string }).status).toBe("completed");
    const anon = await call(callerCtx, "GET", "/payments/agentic/commercial/submission-status?workflowId=run-1", null);
    expect(anon?.status).toBe(401);
  });
});
