/**
 * Issue #2022 (Goal 4) — cfpay revenue report.
 *
 * The aggregator is pure: ledger rows are authoritative for money,
 * audit payloads joined on run id attribute family and coverage,
 * with explicit "unknown" buckets where an audit row is missing.
 * The endpoint test calls handleAgenticPaymentsRoutes with a fake
 * ORM, mirroring the ads route tests' fake pattern.
 */
import { describe, expect, it, vi } from "vitest";
import {
  aggregateCfpayRevenue,
  buildCfpayChargeTransaction,
  buildCfpayCreditTransaction,
} from "../src/services/cfpayLedger";
import {
  handleAgenticPaymentsRoutes,
  type AgenticPaymentsRouteContext,
} from "../src/agents/routes/agenticPayments";

const charge = (run: string, price: number) =>
  buildCfpayChargeTransaction({ runRequestId: run, userId: "u1", family: "goal", priceUSD: price });
const credit = (run: string, price: number) =>
  buildCfpayCreditTransaction({ runRequestId: run, userId: "u1", family: "goal", priceUSD: price });

describe("aggregateCfpayRevenue (#2022)", () => {
  it("totals come from the ledger; family comes from the audit join", () => {
    const report = aggregateCfpayRevenue(
      [charge("run-1", 0.1), charge("run-2", 0.05)],
      [credit("run-1", 0.1)],
      [
        { runRequestId: "run-1", family: "goal" },
        { runRequestId: "run-2", family: "options" },
      ],
      [{ runRequestId: "run-3", paidVia: "subscription_included" }],
      [{ runRequestId: "run-1", family: "goal" }],
    );
    expect(report.charges).toEqual({ count: 2, totalUSD: 0.15 });
    expect(report.credits).toEqual({ count: 1, totalUSD: 0.1 });
    expect(report.netUSD).toBe(0.05);
    expect(report.byFamily["goal"]).toEqual({
      charges: 1,
      chargeTotalUSD: 0.1,
      credits: 1,
      creditTotalUSD: 0.1,
    });
    expect(report.byFamily["options"]).toEqual({
      charges: 1,
      chargeTotalUSD: 0.05,
      credits: 0,
      creditTotalUSD: 0,
    });
    expect(report.coveredByPaidVia).toEqual({ subscription_included: 1 });
    expect(report.chargesWithoutFamily).toBe(0);
    expect(report.coveredWithoutPaidVia).toBe(0);
  });

  it("missing audit rows land in unknown buckets without moving totals", () => {
    const report = aggregateCfpayRevenue(
      [charge("run-9", 0.1)],
      [credit("run-8", 0.1)],
      [],
      [{ runRequestId: "run-7" }],
      [],
    );
    expect(report.charges).toEqual({ count: 1, totalUSD: 0.1 });
    expect(report.credits).toEqual({ count: 1, totalUSD: 0.1 });
    expect(report.netUSD).toBe(0);
    expect(report.byFamily["unknown"]).toEqual({
      charges: 1,
      chargeTotalUSD: 0.1,
      credits: 1,
      creditTotalUSD: 0.1,
    });
    expect(report.chargesWithoutFamily).toBe(1);
    expect(report.creditsWithoutFamily).toBe(1);
    expect(report.coveredByPaidVia).toEqual({ unknown: 1 });
    expect(report.coveredWithoutPaidVia).toBe(1);
  });

  it("empty ledgers report zeros, not nulls", () => {
    const report = aggregateCfpayRevenue([], [], [], [], []);
    expect(report.charges).toEqual({ count: 0, totalUSD: 0 });
    expect(report.netUSD).toBe(0);
    expect(report.byFamily).toEqual({});
    expect(report.coveredByPaidVia).toEqual({});
  });
});

describe("cfpay revenue endpoint (#2022)", () => {
  it("aggregates ledger rows with audit-joined attribution", async () => {
    const txRows = [
      charge("run-1", 0.1),
      charge("run-2", 0.05),
      credit("run-1", 0.1),
      // A non-cfpay row must never leak into the report.
      { ...charge("run-3", 1), sessionId: "payments-agent:x" },
    ];
    const eventRows = [
      { type: "payment.confirmed", payload: JSON.stringify({ runRequestId: "run-1", family: "goal" }) },
      { type: "payment.confirmed", payload: JSON.stringify({ runRequestId: "run-2", family: "options" }) },
      { type: "payment.covered", payload: { runRequestId: "run-4", paidVia: "credits" } },
      { type: "payment.failure_credit_issued", payload: JSON.stringify({ runRequestId: "run-1", family: "goal" }) },
    ];
    const ctx = {
      getOrm: () => ({
        transactions: { findMany: vi.fn(() => txRows) },
        events: {
          findMany: vi.fn((opts: { where?: { type?: string } }) =>
            eventRows.filter((e) => e.type === opts.where?.type),
          ),
        },
      }),
      audit: vi.fn(),
    } as unknown as AgenticPaymentsRouteContext;
    const res = await handleAgenticPaymentsRoutes(
      new Request("https://agent.internal/payments/agentic/ledger/cfpay-revenue", { method: "GET" }),
      new URL("https://agent.internal/payments/agentic/ledger/cfpay-revenue"),
      "/payments/agentic/ledger/cfpay-revenue",
      "sess-1",
      ctx,
    );
    expect(res?.status).toBe(200);
    const body = (await res?.json()) as ReturnType<typeof aggregateCfpayRevenue>;
    expect(body.charges).toEqual({ count: 2, totalUSD: 0.15 });
    expect(body.credits).toEqual({ count: 1, totalUSD: 0.1 });
    expect(body.byFamily["goal"]?.charges).toBe(1);
    expect(body.byFamily["options"]?.charges).toBe(1);
    expect(body.coveredByPaidVia).toEqual({ credits: 1 });
    expect(body.chargesWithoutFamily).toBe(0);
  });
});
