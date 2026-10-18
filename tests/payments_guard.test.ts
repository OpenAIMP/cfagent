/**
 * Issue #161: BudgetGuard enforcement must be real and persistent, and
 * facilitator verification must be fail-closed.
 *
 * Pinned here:
 * - BudgetGuard.check() is pure (a check never records spend).
 * - Daily caps and idempotency survive a "restart" via serialize/restore.
 * - PaymentsAgent persists guard state in DO storage across calls.
 * - verifyWithFacilitator rejects simulated/malformed proofs and fails
 *   closed on facilitator rejection or transport errors.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("agents", () => {
  return {
    routeAgentRequest: async () => null,
    Agent: class MockAgent {
      ctx: any;
      env: any;
      constructor(ctx: any, env: any) {
        this.ctx = ctx;
        this.env = env;
      }
    },
  };
});

import { BudgetGuard } from "../src/payments/budget-guard";
import { PaymentsAgent } from "../src/agents/payments-agent";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const ALLOWLIST = ["search.query", "payments.draft"];

function makeCtx() {
  const store = new Map<string, unknown>();
  return {
    storage: {
      get: async (k: string) => (store.has(k) ? store.get(k) : undefined),
      put: async (k: string, v: unknown) => void store.set(k, v),
      delete: async (k: string) => void store.delete(k),
    },
    _store: store,
  };
}

const ENV: any = { CF_WALLET_FACILITATOR: "https://facilitator.test" };

// ---------------------------------------------------------------------------
// BudgetGuard semantics
// ---------------------------------------------------------------------------

describe("BudgetGuard check/record semantics (#161)", () => {
  it("check() is pure: repeated checks do not consume budget", () => {
    const guard = new BudgetGuard({ allowlist: ALLOWLIST, dailyCapCents: 1000, perCallCapCents: 1000 });
    const req = { agentId: "a1", operation: "search.query", amountCents: 900, idempotencyKey: "k-pure" };
    expect(guard.check(req)).toEqual({ allowed: true });
    // A pure check records nothing, so the same spend is still allowed...
    // (idempotency keys are only consumed by record()).
    expect(guard.spentToday("a1")).toBe(0);
    guard.record(req);
    expect(guard.spentToday("a1")).toBe(900);
  });

  it("daily cap is enforced after record()", () => {
    const guard = new BudgetGuard({ allowlist: ALLOWLIST, dailyCapCents: 1000, perCallCapCents: 1000 });
    const r1 = { agentId: "a1", operation: "search.query", amountCents: 600, idempotencyKey: "k-1" };
    expect(guard.check(r1).allowed).toBe(true);
    guard.record(r1);
    const r2 = { agentId: "a1", operation: "search.query", amountCents: 500, idempotencyKey: "k-2" };
    expect(guard.check(r2)).toEqual({
      allowed: false,
      reason: expect.stringContaining("daily cap exceeded"),
    });
  });

  it("duplicate idempotency keys are rejected after record()", () => {
    const guard = new BudgetGuard({ allowlist: ALLOWLIST });
    const req = { agentId: "a1", operation: "search.query", amountCents: 10, idempotencyKey: "k-dup" };
    expect(guard.check(req).allowed).toBe(true);
    guard.record(req);
    expect(guard.check(req)).toEqual({ allowed: false, reason: "duplicate idempotency key" });
  });

  it("non-allowlisted operations are denied", () => {
    const guard = new BudgetGuard({ allowlist: ALLOWLIST });
    expect(guard.check({ agentId: "a1", operation: "payments.bribe", amountCents: 1, idempotencyKey: "k-x" }))
      .toEqual({ allowed: false, reason: expect.stringContaining("not allowlisted") });
  });

  it("per-call cap is enforced", () => {
    const guard = new BudgetGuard({ allowlist: ALLOWLIST, perCallCapCents: 100 });
    expect(guard.check({ agentId: "a1", operation: "search.query", amountCents: 101, idempotencyKey: "k-x" }))
      .toEqual({ allowed: false, reason: expect.stringContaining("per-call cap exceeded") });
  });

  it("spend and idempotency keys survive serialize/restore (DO restart)", () => {
    const guard = new BudgetGuard({ allowlist: ALLOWLIST, dailyCapCents: 1000, perCallCapCents: 1000 });
    const r1 = { agentId: "a1", operation: "search.query", amountCents: 800, idempotencyKey: "k-r1" };
    guard.record(r1);
    const snapshot = guard.serialize();

    // "Restart": a brand-new instance restored from storage.
    const restored = BudgetGuard.restore({ allowlist: ALLOWLIST, dailyCapCents: 1000, perCallCapCents: 1000 }, snapshot);
    expect(restored.spentToday("a1")).toBe(800);
    // The recorded idempotency key is still rejected.
    expect(restored.check(r1)).toEqual({ allowed: false, reason: "duplicate idempotency key" });
    // And the daily cap still applies.
    expect(restored.check({ agentId: "a1", operation: "search.query", amountCents: 300, idempotencyKey: "k-r2" }).allowed)
      .toBe(false);
  });

  it("restore drops spend from previous days", () => {
    const guard = new BudgetGuard({ allowlist: ALLOWLIST });
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const restored = BudgetGuard.restore({ allowlist: ALLOWLIST }, {
      dailySpend: [["a1", yesterday, 99999]],
      seenKeys: [],
    });
    expect(restored.spentToday("a1")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// PaymentsAgent: persistence + fail-closed verification
// ---------------------------------------------------------------------------

describe("PaymentsAgent guard persistence (#161)", () => {
  it("budgetCheck() never consumes budget: repeated near-cap checks stay allowed", async () => {
    const ctx = makeCtx();
    const agent = new (PaymentsAgent as any)(ctx, ENV);
    // Default caps: 5000/day, 1000/call. Six 1000 checks total 6000 — if
    // checks recorded spend, the 6th would breach the daily cap.
    for (let i = 0; i < 6; i++) {
      const verdict = await agent.budgetCheck({ operation: "search.query", amountCents: 1000 });
      expect(verdict.allowed).toBe(true);
    }
  });

  it("processPaidRequest persists spend: second payment breaching the daily cap is denied", async () => {
    vi.stubGlobal("fetch", async () =>
      Response.json({ isValid: true })
    );
    const ctx = makeCtx();
    const agent = new (PaymentsAgent as any)(ctx, ENV);
    const proof = btoa(JSON.stringify({ signature: "0xabc", payer: "0x123" }));

    // Raise the per-call cap via a fresh agent is not possible; use amounts
    // within the default 1000/call cap and a tight sequence instead:
    // default daily cap 5000, per-call 1000.
    for (let i = 0; i < 5; i++) {
      await agent.processPaidRequest({
        agentId: "a1",
        operation: "search.query",
        amountCents: 1000,
        idempotencyKey: `pay-ok-${i}`,
        paymentProof: proof,
      });
    }
    // 5000/5000 spent — the next 1 cent must be denied by the persisted guard.
    await expect(
      agent.processPaidRequest({
        agentId: "a1",
        operation: "search.query",
        amountCents: 1,
        idempotencyKey: "pay-over",
        paymentProof: proof,
      })
    ).rejects.toThrow(/daily cap exceeded/);
  });

  it("processPaidRequest rejects a replayed idempotency key", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ isValid: true }));
    const ctx = makeCtx();
    const agent = new (PaymentsAgent as any)(ctx, ENV);
    const proof = btoa(JSON.stringify({ signature: "0xabc", payer: "0x123" }));
    const base = { agentId: "a1", operation: "search.query", amountCents: 10, idempotencyKey: "pay-replay", paymentProof: proof };
    await agent.processPaidRequest(base);
    await expect(agent.processPaidRequest(base)).rejects.toThrow(/duplicate idempotency key/);
  });
});

describe("PaymentsAgent facilitator verification (#161)", () => {
  const validProof = () => btoa(JSON.stringify({ signature: "0xsig", payer: "0xpayer", nonce: "n1" }));

  it("rejects simulated proofs without calling the facilitator", async () => {
    const fetchMock = vi.fn(async () => Response.json({ isValid: true }));
    vi.stubGlobal("fetch", fetchMock);
    const ctx = makeCtx();
    const agent = new (PaymentsAgent as any)(ctx, ENV);
    const simulated = btoa(JSON.stringify({ signature: "simulated", payer: "0xpayer", simulated: true }));
    await expect(
      agent.processPaidRequest({
        agentId: "a1", operation: "search.query", amountCents: 10,
        idempotencyKey: "pay-sim", paymentProof: simulated,
      })
    ).rejects.toThrow(/facilitator rejected/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects malformed proofs", async () => {
    const fetchMock = vi.fn(async () => Response.json({ isValid: true }));
    vi.stubGlobal("fetch", fetchMock);
    const ctx = makeCtx();
    const agent = new (PaymentsAgent as any)(ctx, ENV);
    for (const bad of ["", "not-json-at-all", btoa(JSON.stringify({ nope: true }))]) {
      await expect(
        agent.processPaidRequest({
          agentId: "a1", operation: "search.query", amountCents: 10,
          idempotencyKey: `pay-bad-${bad.length}`, paymentProof: bad,
        })
      ).rejects.toThrow(/facilitator rejected/);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts a proof the facilitator approves", async () => {
    vi.stubGlobal("fetch", async (url: any, init: any) => {
      expect(String(url)).toContain("/verify");
      const body = JSON.parse(init.body);
      expect(body.paymentPayload.payer).toBe("0xpayer");
      return Response.json({ isValid: true });
    });
    const ctx = makeCtx();
    const agent = new (PaymentsAgent as any)(ctx, ENV);
    const record = await agent.processPaidRequest({
      agentId: "a1", operation: "search.query", amountCents: 10,
      idempotencyKey: "pay-good", paymentProof: validProof(),
    });
    expect(record.status).toBe("verified");
    expect(record.idempotencyKey).toBe("pay-good");
  });

  it("fails closed when the facilitator rejects", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ isValid: false }));
    const ctx = makeCtx();
    const agent = new (PaymentsAgent as any)(ctx, ENV);
    await expect(
      agent.processPaidRequest({
        agentId: "a1", operation: "search.query", amountCents: 10,
        idempotencyKey: "pay-denied", paymentProof: validProof(),
      })
    ).rejects.toThrow(/facilitator rejected/);
  });

  it("fails closed on facilitator transport errors", async () => {
    vi.stubGlobal("fetch", async () => { throw new Error("boom"); });
    const ctx = makeCtx();
    const agent = new (PaymentsAgent as any)(ctx, ENV);
    await expect(
      agent.processPaidRequest({
        agentId: "a1", operation: "search.query", amountCents: 10,
        idempotencyKey: "pay-err", paymentProof: validProof(),
      })
    ).rejects.toThrow(/facilitator rejected/);
  });
});
