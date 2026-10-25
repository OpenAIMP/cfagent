/**
 * Issue #1262 Phases 2–5 — shared channel approval engine.
 *
 * The ledger preview→approve→execute flow (and its cancel sibling) used
 * to exist in three near-verbatim copies (email / Slack / voice). The
 * engine in src/trading/channels/approval.ts is the single copy: tier
 * gates from Phase 1, draft lookup (by id, or the most recent previewed
 * draft), executeOrder with the placeOrderRemote fallback + ledger
 * update, and DID stamping. Channel services keep only rendering.
 *
 * Behaviour pins (must not drift from the pre-extraction services):
 *  - executeOrder success performs NO extra ledger write (the platform
 *    persists itself); only the placeOrderRemote fallback writes the
 *    executed/rejected status + authorizerDid + orderRef.
 *  - A missing draft and a non-previewed draft are distinct outcomes;
 *    services render their own pre-existing copy for each.
 *  - Slack interaction approve never falls back to the latest previewed
 *    draft (it approves exactly the button's order id).
 *  - Slack event cancel updates by id unconditionally (no existence
 *    check); email/voice cancel only touches a previewed draft.
 */
import { describe, it, expect, vi } from "vitest";

import {
  approvePreviewedOrder,
  cancelPreviewedOrder,
  type ApprovalExecutor,
  type ApprovalTradeStore,
} from "../src/trading/channels/approval";
import type { ChannelPrincipal } from "../src/trading/channels/intake";

function trade(overrides: Record<string, unknown> = {}) {
  return {
    id: "ord_1",
    symbol: "NVDA",
    action: "BUY",
    quantity: 10,
    price: 130,
    orderType: "LIMIT",
    totalValue: 1300,
    status: "previewed",
    createdAt: "2026-10-24T00:00:00.000Z",
    updatedAt: "2026-10-24T00:00:00.000Z",
    ...overrides,
  };
}

function store(initial: Record<string, unknown>[] = []) {
  const rows = new Map<string, any>(initial.map((t: any) => [t.id, { ...t }]));
  const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
  const trades: ApprovalTradeStore = {
    findById: (id: string) => rows.get(id) ?? null,
    findMany: ({ where }: any) => {
      const list = [...rows.values()].filter((t) => t.status === where.status);
      list.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      return list.slice(0, 1);
    },
    update: (id: string, patch: Record<string, unknown>) => {
      updates.push({ id, patch });
      const row = rows.get(id);
      if (row) Object.assign(row, patch);
      return row;
    },
  };
  return { trades, rows, updates };
}

function executor(overrides: Partial<ApprovalExecutor> = {}): ApprovalExecutor & {
  executeOrderCalls: any[][];
  placeOrderRemoteCalls: any[][];
} {
  const executeOrderCalls: any[][] = [];
  const placeOrderRemoteCalls: any[][] = [];
  const base: ApprovalExecutor = {
    executeOrder: (...args: any[]) => {
      executeOrderCalls.push(args);
      return { success: true, executionId: "et_exec_1" };
    },
    placeOrderRemote: async (...args: any[]) => {
      placeOrderRemoteCalls.push(args);
      return { success: true, executionId: "et_remote_1" };
    },
  };
  // Overrides still record their calls (the fallback tests override
  // executeOrder to throw and placeOrderRemote to return fixtures).
  if (overrides.executeOrder) {
    const fn = overrides.executeOrder;
    base.executeOrder = (...args: any[]) => {
      executeOrderCalls.push(args);
      return fn(...args);
    };
  }
  if (overrides.placeOrderRemote) {
    const fn = overrides.placeOrderRemote;
    base.placeOrderRemote = async (...args: any[]) => {
      placeOrderRemoteCalls.push(args);
      return fn(...args);
    };
  }
  return { ...base, executeOrderCalls, placeOrderRemoteCalls };
}

const tradePrincipal: ChannelPrincipal = {
  userLogin: "boss-login",
  authorizerDid: "did:user:email:boss@example.com",
  tier: "trade",
};
const readPrincipal: ChannelPrincipal = {
  userLogin: "reader-login",
  authorizerDid: "did:user:email:reader@example.com",
  tier: "read",
};
const previewPrincipal: ChannelPrincipal = {
  userLogin: "preview-login",
  authorizerDid: "did:user:slack:U123",
  tier: "preview",
};

describe("approvePreviewedOrder", () => {
  it("refuses a null principal and a below-trade principal before any ledger read", async () => {
    const { trades } = store([trade()]);
    const findById = vi.spyOn(trades, "findById");
    const ex = executor();
    const nullOutcome = await approvePreviewedOrder({
      trades,
      executor: ex,
      principal: null,
      authorizerDid: "did:user:email:boss@example.com",
      userLogin: "boss-login",
      orderId: "ord_1",
      timestamp: "2026-10-24T00:00:00.000Z",
    });
    expect(nullOutcome.kind).toBe("tier_refused");
    const readOutcome = await approvePreviewedOrder({
      trades,
      executor: ex,
      principal: readPrincipal,
      authorizerDid: readPrincipal.authorizerDid,
      userLogin: "reader-login",
      orderId: "ord_1",
      timestamp: "2026-10-24T00:00:00.000Z",
    });
    expect(readOutcome.kind).toBe("tier_refused");
    expect(findById).not.toHaveBeenCalled();
    expect(ex.executeOrderCalls).toHaveLength(0);
  });

  it("an undefined principal (internal construction) is not tier-gated", async () => {
    const { trades } = store([trade()]);
    const ex = executor();
    const outcome = await approvePreviewedOrder({
      trades,
      executor: ex,
      principal: undefined,
      authorizerDid: "did:user:email:boss@example.com",
      userLogin: "boss-login",
      orderId: "ord_1",
      timestamp: "2026-10-24T00:00:00.000Z",
    });
    expect(outcome.kind).toBe("executed");
  });

  it("returns not_found for a missing draft, with and without the latest-previewed fallback", async () => {
    const { trades } = store([trade()]);
    const ex = executor();
    const byId = await approvePreviewedOrder({
      trades,
      executor: ex,
      principal: tradePrincipal,
      authorizerDid: tradePrincipal.authorizerDid,
      userLogin: "boss-login",
      orderId: "ord_missing",
      allowLatestFallback: false,
      timestamp: "2026-10-24T00:00:00.000Z",
    });
    expect(byId.kind).toBe("not_found");
    const empty = store([]);
    const noDraft = await approvePreviewedOrder({
      trades: empty.trades,
      executor: ex,
      principal: tradePrincipal,
      authorizerDid: tradePrincipal.authorizerDid,
      userLogin: "boss-login",
      timestamp: "2026-10-24T00:00:00.000Z",
    });
    expect(noDraft.kind).toBe("not_found");
    expect(ex.executeOrderCalls).toHaveLength(0);
  });

  it("returns not_previewed for a draft in another status and executes nothing", async () => {
    const { trades } = store([trade({ status: "executed" })]);
    const ex = executor();
    const outcome = await approvePreviewedOrder({
      trades,
      executor: ex,
      principal: tradePrincipal,
      authorizerDid: tradePrincipal.authorizerDid,
      userLogin: "boss-login",
      orderId: "ord_1",
      timestamp: "2026-10-24T00:00:00.000Z",
    });
    expect(outcome.kind).toBe("not_previewed");
    if (outcome.kind === "not_previewed") expect(outcome.trade.status).toBe("executed");
    expect(ex.executeOrderCalls).toHaveLength(0);
  });

  it("executes via executeOrder with the authorizer DID and writes nothing extra to the ledger", async () => {
    const { trades, updates } = store([trade()]);
    const ex = executor();
    const outcome = await approvePreviewedOrder({
      trades,
      executor: ex,
      principal: tradePrincipal,
      authorizerDid: tradePrincipal.authorizerDid,
      userLogin: "boss-login",
      orderId: "ord_1",
      timestamp: "2026-10-24T00:00:00.000Z",
    });
    expect(outcome.kind).toBe("executed");
    expect(ex.executeOrderCalls).toEqual([["ord_1", "did:user:email:boss@example.com", "approved"]]);
    expect(ex.placeOrderRemoteCalls).toHaveLength(0);
    expect(updates).toHaveLength(0);
    if (outcome.kind === "executed") expect(outcome.execId).toBe("et_exec_1");
  });

  it("falls back to the most recent previewed draft when no order id is given", async () => {
    const { trades } = store([
      trade({ id: "ord_old", createdAt: "2026-10-24T00:00:00.000Z" }),
      trade({ id: "ord_new", createdAt: "2026-10-24T01:00:00.000Z" }),
    ]);
    const ex = executor();
    const outcome = await approvePreviewedOrder({
      trades,
      executor: ex,
      principal: tradePrincipal,
      authorizerDid: tradePrincipal.authorizerDid,
      userLogin: "boss-login",
      timestamp: "2026-10-24T00:00:00.000Z",
    });
    expect(outcome.kind).toBe("executed");
    expect(ex.executeOrderCalls[0][0]).toBe("ord_new");
  });

  it("on executeOrder throw, falls back to placeOrderRemote and writes executed status + DID + orderRef", async () => {
    const { trades, updates, rows } = store([trade()]);
    const ex = executor({
      executeOrder: () => {
        throw new Error("platform unavailable");
      },
      placeOrderRemote: async () => ({ success: true, brokerOrderRef: "brk_9" }),
    });
    const outcome = await approvePreviewedOrder({
      trades,
      executor: ex,
      principal: tradePrincipal,
      authorizerDid: tradePrincipal.authorizerDid,
      userLogin: "boss-login",
      orderId: "ord_1",
      timestamp: "2026-10-24T00:00:00.000Z",
    });
    expect(outcome.kind).toBe("executed");
    if (outcome.kind === "executed") expect(outcome.execId).toBe("brk_9");
    expect(ex.placeOrderRemoteCalls).toHaveLength(1);
    expect(ex.placeOrderRemoteCalls[0][0]).toMatchObject({
      orderId: "ord_1",
      symbol: "NVDA",
      userLogin: "boss-login",
    });
    expect(updates).toEqual([
      {
        id: "ord_1",
        patch: {
          status: "executed",
          authorizerDid: "did:user:email:boss@example.com",
          orderRef: "brk_9",
          updatedAt: "2026-10-24T00:00:00.000Z",
        },
      },
    ]);
    expect(rows.get("ord_1")?.status).toBe("executed");
  });

  it("a failed fallback writes rejected status and returns failed with the broker message", async () => {
    const { trades, updates } = store([trade()]);
    const ex = executor({
      executeOrder: () => {
        throw new Error("platform unavailable");
      },
      placeOrderRemote: async () => ({ success: false, message: "insufficient funds" }),
    });
    const outcome = await approvePreviewedOrder({
      trades,
      executor: ex,
      principal: tradePrincipal,
      authorizerDid: tradePrincipal.authorizerDid,
      userLogin: "boss-login",
      orderId: "ord_1",
      timestamp: "2026-10-24T00:00:00.000Z",
    });
    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") expect(outcome.message).toBe("insufficient funds");
    expect(updates[0].patch.status).toBe("rejected");
  });

  it("a null trades store is not_found, never a throw", async () => {
    const ex = executor();
    const outcome = await approvePreviewedOrder({
      trades: null,
      executor: ex,
      principal: tradePrincipal,
      authorizerDid: tradePrincipal.authorizerDid,
      userLogin: "boss-login",
      orderId: "ord_1",
      timestamp: "2026-10-24T00:00:00.000Z",
    });
    expect(outcome.kind).toBe("not_found");
    expect(ex.executeOrderCalls).toHaveLength(0);
  });
});

describe("cancelPreviewedOrder", () => {
  it("refuses below-preview and null principals before touching the ledger", () => {
    const { trades, updates } = store([trade()]);
    const ex = executor();
    expect(
      cancelPreviewedOrder({
        trades,
        principal: readPrincipal,
        orderId: "ord_1",
        lookup: "previewed_only",
        timestamp: "2026-10-24T00:00:00.000Z",
      })
    ).toMatchObject({ kind: "tier_refused" });
    expect(
      cancelPreviewedOrder({
        trades,
        principal: null,
        orderId: "ord_1",
        lookup: "by_id",
        timestamp: "2026-10-24T00:00:00.000Z",
      })
    ).toMatchObject({ kind: "tier_refused" });
    expect(updates).toHaveLength(0);
    void ex;
  });

  it("previewed_only cancels only a previewed draft; by_id updates unconditionally", () => {
    const { trades, updates } = store([trade()]);
    const cancelled = cancelPreviewedOrder({
      trades,
      principal: previewPrincipal,
      orderId: "ord_1",
      lookup: "previewed_only",
      timestamp: "2026-10-24T00:00:00.000Z",
    });
    expect(cancelled.kind).toBe("cancelled");
    expect(updates).toEqual([
      { id: "ord_1", patch: { status: "rejected", updatedAt: "2026-10-24T00:00:00.000Z" } },
    ]);

    const executed = store([trade({ id: "ord_2", status: "executed" })]);
    const untouched = cancelPreviewedOrder({
      trades: executed.trades,
      principal: previewPrincipal,
      orderId: "ord_2",
      lookup: "previewed_only",
      timestamp: "2026-10-24T00:00:00.000Z",
    });
    expect(untouched.kind).toBe("not_previewed");
    expect(executed.updates).toHaveLength(0);

    const missing = store([]);
    const byId = cancelPreviewedOrder({
      trades: missing.trades,
      principal: previewPrincipal,
      orderId: "ord_missing",
      lookup: "by_id",
      stampAuthorizerDid: "did:user:slack:U123",
      timestamp: "2026-10-24T00:00:00.000Z",
    });
    expect(byId).toMatchObject({ kind: "cancelled", orderId: "ord_missing" });
    expect(missing.updates).toEqual([
      {
        id: "ord_missing",
        patch: {
          status: "rejected",
          updatedAt: "2026-10-24T00:00:00.000Z",
          authorizerDid: "did:user:slack:U123",
        },
      },
    ]);
  });

  it("previewed_only falls back to the latest previewed draft and reports not_found when none exists", () => {
    const { trades } = store([trade({ id: "ord_latest" })]);
    expect(
      cancelPreviewedOrder({
        trades,
        principal: previewPrincipal,
        lookup: "previewed_only",
        timestamp: "2026-10-24T00:00:00.000Z",
      })
    ).toMatchObject({ kind: "cancelled", orderId: "ord_latest" });
    const empty = store([]);
    expect(
      cancelPreviewedOrder({
        trades: empty.trades,
        principal: previewPrincipal,
        lookup: "previewed_only",
        timestamp: "2026-10-24T00:00:00.000Z",
      })
    ).toMatchObject({ kind: "not_found" });
  });
});
