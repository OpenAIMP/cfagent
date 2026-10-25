import { describe, expect, it } from "vitest";

import { getDiscoveryConfig } from "../src/config/etapiConfig";
import { MockSqlStorage } from "./mock-sql";
import {
  DISCOVERY_MODEL_VERSION,
  InMemoryDiscoverySetupStore,
  SqlDiscoverySetupStore,
  validateDiscoveryRunCounts,
  type DiscoverySetupItem,
  type DiscoverySetupRunInput,
} from "../src/trading/options/discoverySetupStore";
import { classifyDiscoveryDeltas } from "../src/trading/options/discoveryDelta";

/**
 * Issue #14 slice 4 — the Discovery run store and delta
 * classification.
 *
 * The store follows the house run-store pattern (interface + SQL +
 * in-memory implementations, #103 visibility, retention enforced on
 * the write path). Deltas compare a run's expressed setups against
 * the previous comparable run's, keyed by (symbol, thesis): a thesis
 * flip is the old setup GONE plus a NEW one, never a mutation.
 */

function setup(symbol: string, thesis: string, score: number, confidence: "LOW" | "MEDIUM" | "HIGH"): DiscoverySetupItem {
  return {
    kind: "setup",
    symbol,
    thesis: thesis as never,
    ruleId: "trend-up",
    confidence,
    discoveryScore: score,
    gateBucket: "fit",
    targetPrice: 100,
    targetDate: "2026-11-20",
    firedSignals: ["TREND_UP", "LIQUIDITY_OK"],
    evidence: `${symbol} IV rank n/a (insufficient history); trend fixture`,
  };
}

function abstention(symbol: string, reason = "no setup"): DiscoverySetupItem {
  return { kind: "abstention", symbol, stage: "inference", reason, nearMissSignals: [] };
}

function runInput(overrides: Partial<DiscoverySetupRunInput> = {}): DiscoverySetupRunInput {
  const items = overrides.items ?? [setup("AAA", "bullish", 62, "MEDIUM")];
  return {
    createdAt: "2026-10-22T12:00:00.000Z",
    scopeKey: "schedule:morning-scan",
    source: "schedule",
    configHash: "cfg-abc",
    counts: {
      considered: items.length,
      setups: items.filter((i) => i.kind === "setup").length,
      abstentions: items.filter((i) => i.kind === "abstention").length,
      prescreenedOut: 0,
      errors: 0,
    },
    items,
    ...overrides,
  };
}

describe("validateDiscoveryRunCounts", () => {
  it("accepts reconciled counts (acceptance (e): considered = setups + abstentions + prescreened + errors)", () => {
    const items = [setup("AAA", "bullish", 62, "MEDIUM"), abstention("BBB")];
    expect(
      validateDiscoveryRunCounts(
        { considered: 6, setups: 1, abstentions: 1, prescreenedOut: 3, errors: 1 },
        items,
      ),
    ).toBeNull();
  });

  it("rejects counts that do not sum to considered", () => {
    const err = validateDiscoveryRunCounts(
      { considered: 6, setups: 1, abstentions: 1, prescreenedOut: 3, errors: 0 },
      [setup("AAA", "bullish", 62, "MEDIUM"), abstention("BBB")],
    );
    expect(err).toContain("reconcile");
  });

  it("rejects counts that disagree with the items", () => {
    const err = validateDiscoveryRunCounts(
      { considered: 2, setups: 2, abstentions: 0, prescreenedOut: 0, errors: 0 },
      [setup("AAA", "bullish", 62, "MEDIUM"), abstention("BBB")],
    );
    expect(err).toContain("items");
  });
});

describe("discovery setup stores", () => {
  it("round-trips a run through the in-memory store with provenance stamped", async () => {
    const store = new InMemoryDiscoverySetupStore({ idFactory: () => "run-1" });
    const saved = await store.save(runInput());
    expect(saved.id).toBe("run-1");
    expect(saved.modelVersion).toBe(DISCOVERY_MODEL_VERSION);
    expect(DISCOVERY_MODEL_VERSION).toBe("discovery-v1");
    const got = await store.get("run-1");
    expect(got?.items).toHaveLength(1);
    expect(got?.configHash).toBe("cfg-abc");
  });

  it("round-trips a run through the SQL store (MockSqlStorage)", async () => {
    const store = new SqlDiscoverySetupStore(new MockSqlStorage(), { idFactory: () => "run-sql-1" });
    await store.save(runInput());
    const got = await store.get("run-sql-1");
    expect(got?.scopeKey).toBe("schedule:morning-scan");
    expect(got?.items[0]).toMatchObject({ kind: "setup", symbol: "AAA", discoveryScore: 62 });
  });

  it("lists newest-first and filters by scope", async () => {
    let n = 0;
    const store = new InMemoryDiscoverySetupStore({ idFactory: () => `run-${++n}` });
    await store.save(runInput({ createdAt: "2026-10-20T12:00:00.000Z" }));
    await store.save(runInput({ createdAt: "2026-10-22T12:00:00.000Z", scopeKey: "nlq:adhoc" }));
    await store.save(runInput({ createdAt: "2026-10-21T12:00:00.000Z" }));
    const all = await store.list();
    expect(all.map((r) => r.id)).toEqual(["run-2", "run-3", "run-1"]);
    const scoped = await store.list({ scopeKey: "schedule:morning-scan" });
    expect(scoped.map((r) => r.id)).toEqual(["run-3", "run-1"]);
  });

  it("latestForScope returns the newest run of that scope only", async () => {
    let n = 0;
    const store = new InMemoryDiscoverySetupStore({ idFactory: () => `run-${++n}` });
    await store.save(runInput({ createdAt: "2026-10-20T12:00:00.000Z" }));
    await store.save(runInput({ createdAt: "2026-10-22T12:00:00.000Z", scopeKey: "nlq:adhoc" }));
    await store.save(runInput({ createdAt: "2026-10-21T12:00:00.000Z" }));
    expect((await store.latestForScope("schedule:morning-scan"))?.id).toBe("run-3");
    expect(await store.latestForScope("schedule:never-ran")).toBeNull();
  });

  it("enforces the #103 visibility rule like the sibling stores", async () => {
    const store = new InMemoryDiscoverySetupStore({ idFactory: () => "run-v" });
    await store.save(runInput({ userLogin: "venus" }));
    expect(await store.get("run-v", { userLogin: "venus" })).not.toBeNull();
    expect(await store.get("run-v", { userLogin: "someone-else" })).toBeNull();
    expect(await store.get("run-v")).toBeNull();
    expect(await store.list({ userLogin: "someone-else" })).toHaveLength(0);
  });

  it("prunes runs beyond the retention window on save", async () => {
    let n = 0;
    const store = new InMemoryDiscoverySetupStore({
      idFactory: () => `run-${++n}`,
      retentionDays: 365,
    });
    await store.save(runInput({ createdAt: "2025-01-01T00:00:00.000Z" }));
    await store.save(runInput({ createdAt: "2026-10-22T12:00:00.000Z" }));
    const remaining = await store.list({ limit: 50 });
    expect(remaining.map((r) => r.id)).toEqual(["run-2"]);
  });

  it("rejects a run whose counts do not reconcile", async () => {
    const store = new InMemoryDiscoverySetupStore({ idFactory: () => "run-bad" });
    await expect(
      store.save(
        runInput({
          counts: { considered: 99, setups: 1, abstentions: 0, prescreenedOut: 0, errors: 0 },
        }),
      ),
    ).rejects.toThrow(/reconcile|items/);
  });
});

describe("classifyDiscoveryDeltas", () => {
  const THRESHOLD = getDiscoveryConfig().deltaScoreThreshold;

  it("pins the threshold in config", () => {
    expect(THRESHOLD).toBe(5);
  });

  it("classifies a two-run fixture across every delta kind (acceptance (c))", () => {
    const previous = [
      setup("AAA", "bullish", 60, "MEDIUM"),
      setup("BBB", "bearish", 70, "MEDIUM"),
      setup("CCC", "range_bound", 55, "MEDIUM"),
      setup("DDD", "bullish", 80, "HIGH"),
      setup("FFF", "bullish", 50, "LOW"),
      setup("GGG", "bullish", 66, "MEDIUM"),
    ];
    const current = [
      setup("AAA", "bullish", 72, "MEDIUM"), // +12 -> STRENGTHENED
      setup("BBB", "bearish", 68, "MEDIUM"), // -2 inside band -> UNCHANGED
      setup("CCC", "range_bound", 40, "MEDIUM"), // -15 -> WEAKENED
      setup("EEE", "large_move", 65, "MEDIUM"), // NEW
      setup("FFF", "bullish", 51, "HIGH"), // +1 but confidence up -> STRENGTHENED
      setup("GGG", "bearish", 66, "MEDIUM"), // thesis flip -> GONE(bullish) + NEW(bearish)
      abstention("DDD"), // setup vanished into an abstention -> GONE
    ];
    const deltas = classifyDiscoveryDeltas(previous, current, THRESHOLD);
    const byKey = new Map(deltas.map((d) => [`${d.symbol}:${d.thesis}`, d.kind]));
    expect(byKey.get("AAA:bullish")).toBe("STRENGTHENED");
    expect(byKey.get("BBB:bearish")).toBe("UNCHANGED");
    expect(byKey.get("CCC:range_bound")).toBe("WEAKENED");
    expect(byKey.get("DDD:bullish")).toBe("GONE");
    expect(byKey.get("EEE:large_move")).toBe("NEW");
    expect(byKey.get("FFF:bullish")).toBe("STRENGTHENED");
    expect(byKey.get("GGG:bullish")).toBe("GONE");
    expect(byKey.get("GGG:bearish")).toBe("NEW");
    expect(deltas).toHaveLength(8);
  });

  it("carries the score movement on continuing setups", () => {
    const deltas = classifyDiscoveryDeltas(
      [setup("AAA", "bullish", 60, "MEDIUM")],
      [setup("AAA", "bullish", 72, "MEDIUM")],
      THRESHOLD,
    );
    expect(deltas[0]).toMatchObject({ kind: "STRENGTHENED", prevScore: 60, score: 72 });
  });

  it("first run: everything is NEW; empty previous and current -> no deltas", () => {
    expect(classifyDiscoveryDeltas([], [setup("AAA", "bullish", 60, "MEDIUM")], THRESHOLD)).toEqual([
      expect.objectContaining({ symbol: "AAA", kind: "NEW" }),
    ]);
    expect(classifyDiscoveryDeltas([], [], THRESHOLD)).toEqual([]);
  });

  it("is deterministic in order (symbol, then thesis)", () => {
    const deltas = classifyDiscoveryDeltas(
      [],
      [setup("ZZZ", "bullish", 60, "MEDIUM"), setup("AAA", "bearish", 60, "MEDIUM"), setup("AAA", "bullish", 60, "MEDIUM")],
      THRESHOLD,
    );
    expect(deltas.map((d) => `${d.symbol}:${d.thesis}`)).toEqual(["AAA:bearish", "AAA:bullish", "ZZZ:bullish"]);
  });
});
