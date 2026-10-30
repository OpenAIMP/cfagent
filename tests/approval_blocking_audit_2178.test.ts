/**
 * Issue #2178 (Q7 S2) — trade family, live path: the #1262 approval
 * engine. TDD: written before the implementation.
 *
 * Contract: when an audit sink is provided, approvePreviewedOrder
 * audits the approval decision BEFORE executing and the execution
 * result AFTER success. A throwing decision sink blocks execution
 * entirely; a throwing result sink turns the outcome into a throw
 * naming the unrecorded execution (never a success report for an
 * unaudited execution). With no sink, behavior is unchanged.
 */
import { describe, it, expect } from "vitest";

import {
  approvePreviewedOrder,
  type ApprovalExecutor,
  type ApprovalTradeStore,
} from "../src/trading/channels/approval";

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

function store() {
  const rows = new Map<string, any>([[trade().id, trade()]]);
  const trades: ApprovalTradeStore = {
    findById: (id: string) => rows.get(id) ?? null,
    findMany: () => [...rows.values()],
    update: (id: string, patch: Record<string, unknown>) => {
      const row = rows.get(id);
      if (row) Object.assign(row, patch);
      return row;
    },
  };
  return trades;
}

function executor() {
  const executeOrderCalls: any[][] = [];
  const base: ApprovalExecutor = {
    executeOrder: (...args: any[]) => {
      executeOrderCalls.push(args);
      return { success: true, executionId: "et_exec_1" };
    },
    placeOrderRemote: async (...args: any[]) => ({ success: true, executionId: "et_remote_1" }),
  };
  return { base, executeOrderCalls };
}

function baseArgs(overrides: Record<string, unknown> = {}) {
  const { base, executeOrderCalls } = executor();
  return {
    args: {
      trades: store(),
      executor: base,
      principal: { userLogin: "alice", tier: "trade" } as any,
      authorizerDid: "did:web:alice",
      userLogin: "alice",
      orderId: "ord_1",
      timestamp: "2026-10-29T00:00:00.000Z",
      ...overrides,
    },
    executeOrderCalls,
  };
}

describe("approvePreviewedOrder blocking audit (#2178 S2)", () => {
  it("audits decision before execution and result after success", async () => {
    const sequence: string[] = [];
    const seen: Array<{ type: string }> = [];
    const { args, executeOrderCalls } = baseArgs({
      audit: (record: { type: string }) => {
        seen.push(record);
        sequence.push(record.type);
      },
    });
    const origExecute = args.executor.executeOrder;
    (args.executor as any).executeOrder = (...a: any[]) => {
      sequence.push("executeOrder");
      return (origExecute as any)(...a);
    };
    const outcome: any = await approvePreviewedOrder(args as any);
    expect(outcome.kind).toBe("executed");
    expect(seen.map((r) => r.type)).toEqual([
      "trade.approval_decision",
      "trade.order_executed",
    ]);
    expect(sequence).toEqual([
      "trade.approval_decision",
      "executeOrder",
      "trade.order_executed",
    ]);
    expect(executeOrderCalls).toHaveLength(1);
  });

  it("a throwing decision sink blocks execution entirely", async () => {
    const { args, executeOrderCalls } = baseArgs({
      audit: () => {
        throw new Error("audit store unavailable");
      },
    });
    await expect(approvePreviewedOrder(args as any)).rejects.toThrowError(
      "audit store unavailable",
    );
    expect(executeOrderCalls).toHaveLength(0);
  });

  it("a throwing result sink never reports success for an unaudited execution", async () => {
    const { args, executeOrderCalls } = baseArgs({
      audit: (record: { type: string }) => {
        if (record.type === "trade.order_executed") {
          throw new Error("audit store unavailable");
        }
      },
    });
    // Execution itself ran (it cannot be undone) — but the caller must
    // see a throw naming the unrecorded execution, not an executed outcome.
    await expect(approvePreviewedOrder(args as any)).rejects.toThrowError(
      /ord_1.*audit/i,
    );
    expect(executeOrderCalls).toHaveLength(1);
  });

  it("with no sink, behavior is unchanged", async () => {
    const { args } = baseArgs();
    const outcome: any = await approvePreviewedOrder(args as any);
    expect(outcome.kind).toBe("executed");
    expect(outcome.execId).toBe("et_exec_1");
  });
});
