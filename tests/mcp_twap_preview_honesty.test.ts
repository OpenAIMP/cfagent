/**
 * Issue #135 — MCP execute_durable_twap counted order previews as fills.
 *
 * The command ran each TWAP slice through the broker's previewOrder and
 * reported every preview as an execution: the fiber service returned
 * totalFilled / slicesFilled with completed:true, and the command audited
 * "twap.executed". A preview places no order and fills nothing.
 *
 * These tests pin the honest contract:
 * - the fiber service counts PREIEWS (totalPreviewed / slicesPreviewed)
 *   and returns the per-slice preview results;
 * - the MCP command returns status "previewed" with executed:false,
 *   per-slice preview drafts, and audits "twap.previewed";
 * - a failing preview propagates as an error — no completion, no audit —
 *   and the fiber record is marked failed;
 * - the tool description states up front that no orders are placed.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";
import { ETradeDurableFiberService } from "../src/services/durableFibers";
import { DurableTWAPOrderCommand } from "../src/mcps/openaimp/cloudflareAgentCommands";
import { ETradeService } from "../src/services/etrade";

// #922 ([#913 S4]): these pins are about preview honesty, not live
// pricing, so they run in the sandbox env where the simulated quote path
// still drafts. A real ORM is required for the env to reach the service:
// ETradeService only reads its env argument when the first argument is
// an ORM (with orm undefined the env is dropped and PROD/live is the
// default) — where a MARKET preview for a curated-only symbol now fails
// explicit instead of drafting off a static price.
const stubContext = (auditLog: any[]) => {
  const orm = new DatabaseORM(new MockSqlStorage());
  orm.initializeSchema("test-session");
  return {
    env: { ETRADE_ENVIRONMENT: "sandbox" },
    orm,
    sessionId: "test-session",
    audit: (type: string, agent: any, payload: Record<string, unknown>) =>
      auditLog.push({ type, agent, payload }),
  } as any;
};

const fakePreview = (sliceNum: number, sliceQty: number) =>
  Promise.resolve({
    orderId: `ord_slice${sliceNum}`,
    status: "previewed",
    quantity: sliceQty,
    estimatedPrice: 100,
    estimatedTotal: 100 * sliceQty,
  });

afterEach(() => {
  vi.restoreAllMocks();
});

describe("previewDurableTWAP — previews counted as previews (service)", () => {
  it("returns previewed quantities and the per-slice previews, never fill semantics", async () => {
    const svc = new ETradeDurableFiberService(undefined, undefined, "test-session");
    const result = await svc.previewDurableTWAP(
      { symbol: "NVDA", action: "BUY", totalQuantity: 10, slices: 3, intervalSeconds: 0 },
      fakePreview
    );

    expect(result.completed).toBe(true); // the preview PLAN ran — no order placed
    expect(result.totalPreviewed).toBe(10);
    expect(result.slicesPreviewed).toBe(3);
    expect(result).not.toHaveProperty("totalFilled");
    expect(result).not.toHaveProperty("slicesFilled");
    // Remainder lands in the last slice: 3 / 3 / 4.
    expect(result.previews.map((p) => p.quantity)).toEqual([3, 3, 4]);
    expect(result.previews.map((p) => p.preview.orderId)).toEqual([
      "ord_slice1",
      "ord_slice2",
      "ord_slice3",
    ]);
    expect(result.previews.every((p) => p.preview.status === "previewed")).toBe(true);
    expect(result.fiberId).toMatch(/^fib_/);
  });

  it("checkpoint stash records previewedQty, not filled quantities", async () => {
    const svc = new ETradeDurableFiberService(undefined, undefined, "test-session");
    const result = await svc.previewDurableTWAP(
      { symbol: "AAPL", action: "SELL", totalQuantity: 4, slices: 2, intervalSeconds: 0 },
      fakePreview
    );
    const record = svc.getFiberStatus(result.fiberId);
    expect(record?.name).toBe("twap_preview_AAPL_SELL");
    expect(record?.status).toBe("completed");
    expect(record?.stashedData.previewedQty).toBe(4);
    expect(record?.stashedData).not.toHaveProperty("filledQty");
  });

  it("a failing slice preview propagates and marks the fiber failed — no completion is reported", async () => {
    const svc = new ETradeDurableFiberService(undefined, undefined, "test-session");
    await expect(
      svc.previewDurableTWAP(
        { symbol: "NVDA", action: "BUY", totalQuantity: 6, slices: 2, intervalSeconds: 0 },
        async () => {
          throw new Error("preview backend down");
        }
      )
    ).rejects.toThrow("preview backend down");

    const fibers = svc.listFibers();
    expect(fibers).toHaveLength(1);
    expect(fibers[0].status).toBe("failed");
    expect(fibers[0].error).toContain("preview backend down");
  });
});

describe("execute_durable_twap — honest TWAP previewer (MCP command)", () => {
  it("returns per-slice preview drafts labelled as previews, with executed:false", async () => {
    const auditLog: any[] = [];
    const cmd = new DurableTWAPOrderCommand();
    const result: any = await cmd.execute(
      { symbol: "NVDA", action: "BUY", totalQuantity: 10, slices: 2 },
      stubContext(auditLog)
    );

    expect(result.status).toBe("previewed");
    expect(result.executed).toBe(false);
    expect(result.planCompleted).toBe(true);
    expect(result.totalPreviewed).toBe(10);
    expect(result.slicesPreviewed).toBe(2);
    expect(result).not.toHaveProperty("totalFilled");
    expect(result).not.toHaveProperty("slicesFilled");
    expect(JSON.stringify(result)).not.toContain("totalFilled");
    expect(result.note).toContain("No orders were placed");
    expect(result.note).toContain("human-in-the-loop");

    expect(result.previews).toHaveLength(2);
    for (const preview of result.previews) {
      expect(preview.status).toBe("previewed");
      expect(preview.orderId).toMatch(/^ord_/);
      expect(preview.quantity).toBe(5);
      expect(typeof preview.estimatedTotal).toBe("number");
    }
    expect(result.fiberId).toMatch(/^fib_/);
  });

  it("audits twap.previewed with executed:false — never an execution event", async () => {
    const auditLog: any[] = [];
    const cmd = new DurableTWAPOrderCommand();
    await cmd.execute(
      { symbol: "NVDA", action: "SELL", totalQuantity: 3, slices: 1 },
      stubContext(auditLog)
    );

    expect(auditLog).toHaveLength(1);
    expect(auditLog[0].type).toBe("twap.previewed");
    expect(auditLog[0].payload.executed).toBe(false);
    expect(auditLog[0].payload.totalPreviewed).toBe(3);
    expect(auditLog[0].payload).not.toHaveProperty("totalFilled");
  });

  it("a preview failure surfaces as an error and writes no audit event", async () => {
    vi.spyOn(ETradeService.prototype, "previewOrder").mockImplementation(() => {
      throw new Error("preview backend down");
    });
    const auditLog: any[] = [];
    const cmd = new DurableTWAPOrderCommand();

    await expect(
      cmd.execute({ symbol: "NVDA", action: "BUY", totalQuantity: 4, slices: 2 }, stubContext(auditLog))
    ).rejects.toThrow("preview backend down");
    expect(auditLog).toHaveLength(0);
  });

  it("tool description + schema disclose that nothing is executed", () => {
    const cmd = new DurableTWAPOrderCommand();
    expect(cmd.description).toContain("does NOT place orders");
    expect(cmd.description).toContain("nothing fills");
    expect(cmd.description).toContain("human-in-the-loop");
    expect(cmd.description).not.toContain("Execute a durable TWAP order across slices");
    expect(JSON.stringify(cmd.jsonSchema)).toContain("nothing is executed");
  });

  it("source pin: fill semantics and the execution audit are gone", () => {
    const cmdSrc = readFileSync("src/mcps/openaimp/cloudflareAgentCommands.ts", "utf-8");
    const svcSrc = readFileSync("src/services/durableFibers.ts", "utf-8");
    for (const src of [cmdSrc, svcSrc]) {
      expect(src).not.toContain("totalFilled");
      expect(src).not.toContain("slicesFilled");
      expect(src).not.toContain("twap.executed");
      expect(src).not.toContain("executeDurableTWAP");
    }
    expect(svcSrc).not.toContain("filledQty");
  });
});
