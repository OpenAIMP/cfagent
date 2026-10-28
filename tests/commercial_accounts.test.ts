/**
 * Issue #2015/#2020 — minimal commercial account store operations.
 * Pure ORM ops tested against Map-backed Repository fakes (no DO,
 * no SQLite); the route tests cover the HTTP layer and the
 * canonical-instance client hop.
 */
import { describe, expect, it } from "vitest";
import {
  adjustCommercialCredits,
  canAccessAccount,
  consumeCredits,
  consumeIncludedRun,
  findUnredeemedCredit,
  getTenantAdsEnabled,
  isStoreOperator,
  redeemCredit,
  setTenantAdsEnabled,
  toCommercialAccount,
  upsertCommercialAccount,
} from "../src/services/commercialAccounts";
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

function makeOrm(overrides: Partial<Record<string, unknown>> = {}): DatabaseORM {
  return {
    commercialAccounts: makeRepo<CommercialAccountRecord>("id"),
    tenantSettings: makeRepo<TenantSettingsRecord>("tenantId"),
    creditRedemptions: makeRepo<CreditRedemptionRecord>("creditRunId"),
    transactions: makeRepo<TransactionRecord>("id"),
    events: makeRepo<Record<string, unknown>>("id"),
    ...overrides,
  } as unknown as DatabaseORM;
}

const opEnv = (operators: string) => ({ COMMERCIAL_STORE_OPERATORS: operators }) as never;

describe("commercial account records (#2015)", () => {
  it("upserts and reads back a record; rejects bad tiers and negatives", () => {
    const orm = makeOrm();
    const record = upsertCommercialAccount(orm, {
      userId: "u1",
      tenantId: "t1",
      tier: "Subscribed",
      creditsUSD: 5,
      includedRuns: 3,
    });
    expect(record.tier).toBe("Subscribed");
    expect(orm.commercialAccounts.findOne({ id: "u1" })).toEqual(record);
    expect(() =>
      upsertCommercialAccount(orm, { userId: "u2", tenantId: "t1", tier: "Premium" }),
    ).toThrow(/Invalid tier/);
    expect(() =>
      upsertCommercialAccount(orm, { userId: "u2", tenantId: "t1", tier: "Free", creditsUSD: -1 }),
    ).toThrow(/creditsUSD/);
    expect(() => upsertCommercialAccount(orm, { userId: "", tenantId: "t1", tier: "Free" })).toThrow(
      /userId and tenantId/,
    );
  });

  it("adjusts credits with a zero floor and consumes coverage", () => {
    const orm = makeOrm();
    upsertCommercialAccount(orm, { userId: "u1", tenantId: "t1", tier: "PayPerUse", creditsUSD: 10, includedRuns: 2 });
    expect(adjustCommercialCredits(orm, "u1", 5).creditsUSD).toBe(15);
    expect(() => adjustCommercialCredits(orm, "u1", -20)).toThrow(/below zero/);
    expect(consumeIncludedRun(orm, "u1").includedRuns).toBe(1);
    expect(consumeCredits(orm, "u1", 0.1).creditsUSD).toBe(14.9);
    expect(() => consumeCredits(orm, "u1", 100)).toThrow(/Insufficient credits/);
    expect(() => adjustCommercialCredits(orm, "ghost", 1)).toThrow(/No commercial account/);
    expect(() => consumeIncludedRun(orm, "ghost")).toThrow(/No commercial account/);
  });

  it("maps a record to the gate account, or a Free default", () => {
    const orm = makeOrm();
    const record = upsertCommercialAccount(orm, { userId: "u1", tenantId: "t1", tier: "Subscribed", creditsUSD: 2, includedRuns: 4 });
    const account = toCommercialAccount("u1", record, "u1@example.com", "t1");
    expect(account).toEqual({
      userId: "u1",
      email: "u1@example.com",
      tenantId: "t1",
      tier: "Subscribed",
      creditsUSD: 2,
      includedRunsRemaining: 4,
    });
    expect(toCommercialAccount("u9", null, "u9@example.com", "t9")).toEqual({
      userId: "u9",
      email: "u9@example.com",
      tenantId: "t9",
      tier: "Free",
      creditsUSD: 0,
      includedRunsRemaining: 0,
    });
  });
});

describe("tenant settings (#2022)", () => {
  it("defaults to ads enabled; set persists", () => {
    const orm = makeOrm();
    expect(getTenantAdsEnabled(orm, "t1")).toBe(true);
    setTenantAdsEnabled(orm, "t1", false);
    expect(getTenantAdsEnabled(orm, "t1")).toBe(false);
    setTenantAdsEnabled(orm, "t1", true);
    expect(getTenantAdsEnabled(orm, "t1")).toBe(true);
  });
});

describe("failure-credit redemption (#2019)", () => {
  function creditRow(run: string, createdAt: string): TransactionRecord {
    return {
      id: `cfpay_${run}`,
      sessionId: `screener-payment:${run}`,
      action: "credit",
      amount: 0.1,
      currency: "USD",
      customer: "u1",
      gateway: "stripe",
      status: "completed",
      proposerDid: "did:agent:openaimp:orchestrator",
      proofSignature: "none (replacement-run credit, no payment)",
      createdAt,
      updatedAt: createdAt,
    } as unknown as TransactionRecord;
  }

  function ormWithCredit(redeemed: boolean) {
    const orm = makeOrm();
    (orm.transactions as unknown as { map: Map<string, TransactionRecord> }).map.set(
      "cfpay_run-9",
      creditRow("run-9", "2026-10-28T00:00:00Z"),
    );
    (orm.transactions as unknown as { map: Map<string, TransactionRecord> }).map.set(
      "cfpay_run-8",
      creditRow("run-8", "2026-10-27T00:00:00Z"),
    );
    (orm.events as unknown as { map: Map<string, Record<string, unknown>> }).map.set("e1", {
      id: "e1",
      type: "payment.failure_credit_issued",
      payload: JSON.stringify({ runRequestId: "run-9", family: "goal" }),
    });
    (orm.events as unknown as { map: Map<string, Record<string, unknown>> }).map.set("e2", {
      id: "e2",
      type: "payment.failure_credit_issued",
      payload: JSON.stringify({ runRequestId: "run-8", family: "goal" }),
    });
    if (redeemed) {
      (orm.creditRedemptions as unknown as { map: Map<string, CreditRedemptionRecord> }).map.set("run-8", {
        creditRunId: "run-8",
        redeemedByRunId: "run-x",
        redeemedAt: "2026-10-28T00:00:00Z",
      });
    }
    return orm;
  }

  it("finds the oldest unredeemed credit for the family", () => {
    const orm = ormWithCredit(false);
    // run-8 is older, so FIFO picks it first.
    expect(findUnredeemedCredit(orm, "u1", "goal")).toEqual({ creditRunId: "run-8", amountUSD: 0.1 });
    expect(findUnredeemedCredit(orm, "u1", "options")).toBeNull();
    expect(findUnredeemedCredit(orm, "u2", "goal")).toBeNull();
  });

  it("skips redeemed credits and credits without a family payload", () => {
    const orm = ormWithCredit(true);
    expect(findUnredeemedCredit(orm, "u1", "goal")).toEqual({ creditRunId: "run-9", amountUSD: 0.1 });
    const noFamily = makeOrm();
    (noFamily.transactions as unknown as { map: Map<string, TransactionRecord> }).map.set(
      "cfpay_run-7",
      creditRow("run-7", "2026-10-28T00:00:00Z"),
    );
    expect(findUnredeemedCredit(noFamily, "u1", "goal")).toBeNull();
  });

  it("redeems once; a second redemption throws", () => {
    const orm = makeOrm();
    const redemption = redeemCredit(orm, "run-9", "run-10");
    expect(redemption.creditRunId).toBe("run-9");
    expect(() => redeemCredit(orm, "run-9", "run-11")).toThrow(/already redeemed/);
  });
});

describe("store access rules (#2015)", () => {
  it("operator allowlist is fail-closed when empty", () => {
    expect(isStoreOperator(opEnv("op1, op2"), "op1")).toBe(true);
    expect(isStoreOperator(opEnv("op1, op2"), "op2")).toBe(true);
    expect(isStoreOperator(opEnv("op1, op2"), "u1")).toBe(false);
    expect(isStoreOperator(opEnv(""), "op1")).toBe(false);
    expect(isStoreOperator({} as never, "op1")).toBe(false);
    expect(isStoreOperator(opEnv("op1"), null)).toBe(false);
  });

  it("self or operator may access; others may not", () => {
    const env = opEnv("op1");
    expect(canAccessAccount(env, "u1", "u1")).toBe(true);
    expect(canAccessAccount(env, "op1", "u1")).toBe(true);
    expect(canAccessAccount(env, "u2", "u1")).toBe(false);
    expect(canAccessAccount(env, null, "u1")).toBe(false);
  });
});
