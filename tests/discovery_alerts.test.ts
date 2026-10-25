import { describe, expect, it, vi } from "vitest";

import { getDiscoveryConfig } from "../src/config/etapiConfig";
import { MockSqlStorage } from "./mock-sql";
import {
  InMemoryDiscoveryAlertStore,
  SqlDiscoveryAlertStore,
  type DiscoveryAlertRecord,
} from "../src/trading/options/discoveryAlertStore";
import type { DiscoveryDelta } from "../src/trading/options/discoveryDelta";
import type {
  DiscoverySetupExpressedItem,
  StoredDiscoverySetupRun,
} from "../src/trading/options/discoverySetupStore";
import {
  dispatchDiscoveryAlerts,
  selectDiscoveryAlertCandidates,
  type DiscoveryAlertChannelSender,
} from "../src/services/discoveryAlerts";

/**
 * Issue #18 slice 3 — Decision 2 alerts. Defaults under test:
 * NEW setups only, discoveryScore ≥ 70, STRENGTHENED never alerts
 * at launch, cap 5 per day per scope, dedupe per
 * (scope, symbol, thesis, day), and every alert carries its run
 * id + evidence line.
 */

const CFG = getDiscoveryConfig();

function setup(symbol: string, score: number, thesis: DiscoverySetupExpressedItem["thesis"] = "bullish"): DiscoverySetupExpressedItem {
  return {
    kind: "setup",
    symbol,
    thesis,
    ruleId: "trend-up",
    confidence: "HIGH",
    discoveryScore: score,
    gateBucket: "fit",
    targetPrice: 150,
    targetDate: "2026-12-18",
    firedSignals: ["TREND_UP", "LIQUIDITY_OK"],
    evidence: `${symbol} fast SMA above slow SMA`,
  };
}

function run(items: DiscoverySetupExpressedItem[], createdAt = "2026-10-22T13:00:00.000Z", id = "run-1"): StoredDiscoverySetupRun {
  return {
    id,
    createdAt,
    scopeKey: "sched:morning",
    source: "schedule",
    configHash: "abcd1234",
    counts: { considered: items.length, setups: items.length, abstentions: 0, prescreenedOut: 0, errors: 0 },
    items,
  };
}

const delta = (item: DiscoverySetupExpressedItem, kind: DiscoveryDelta["kind"]): DiscoveryDelta => ({
  symbol: item.symbol,
  thesis: item.thesis,
  kind,
  score: item.discoveryScore,
});

describe("config", () => {
  it("pins the Decision 2 defaults", () => {
    expect(CFG.alertMinScore).toBe(70);
    expect(CFG.alertDailyCap).toBe(5);
  });
});

describe("selection (Decision 2)", () => {
  it("selects NEW setups at or above the score floor, strongest first", () => {
    const a = setup("AAA", 85);
    const b = setup("BBB", 72);
    const c = setup("CCC", 91);
    const picked = selectDiscoveryAlertCandidates(run([a, b, c]), [delta(a, "NEW"), delta(b, "NEW"), delta(c, "NEW")], CFG);
    expect(picked.map((p) => p.item.symbol)).toEqual(["CCC", "AAA", "BBB"]);
  });

  it("excludes below-floor NEW setups", () => {
    const a = setup("AAA", 69);
    expect(selectDiscoveryAlertCandidates(run([a]), [delta(a, "NEW")], CFG)).toEqual([]);
  });

  it("never selects STRENGTHENED at launch, however strong (acceptance)", () => {
    const a = setup("AAA", 97);
    expect(selectDiscoveryAlertCandidates(run([a]), [delta(a, "STRENGTHENED")], CFG)).toEqual([]);
  });

  it("excludes UNCHANGED / WEAKENED / GONE and setups with no delta", () => {
    const a = setup("AAA", 90);
    const b = setup("BBB", 90);
    const c = setup("CCC", 90);
    const picked = selectDiscoveryAlertCandidates(
      run([a, b, c]),
      [delta(a, "UNCHANGED"), delta(b, "WEAKENED")],
      CFG,
    );
    expect(picked).toEqual([]);
  });
});

describe("dispatch: dedupe + daily cap (acceptance)", () => {
  function harness() {
    const store = new InMemoryDiscoveryAlertStore();
    const sent: DiscoveryAlertRecord[] = [];
    const sender: DiscoveryAlertChannelSender = {
      name: "spy",
      send: vi.fn(async (alert: DiscoveryAlertRecord) => {
        sent.push(alert);
      }),
    };
    return { store, sender, sent };
  }

  it("sends selected alerts with run linkage and evidence, and records them", async () => {
    const { store, sender, sent } = harness();
    const a = setup("AAA", 85);
    const result = await dispatchDiscoveryAlerts({ store, senders: [sender] }, run([a]), [delta(a, "NEW")], CFG);
    expect(result.sent).toHaveLength(1);
    expect(sent).toHaveLength(1);
    expect(sent[0].runId).toBe("run-1");
    expect(sent[0].evidence).toContain("fast SMA");
    expect(sent[0].day).toBe("2026-10-22");
    expect(await store.countForDay("sched:morning", "2026-10-22")).toBe(1);
  });

  it("dedupes a repeat dispatch of the same setup on the same day", async () => {
    const { store, sender, sent } = harness();
    const a = setup("AAA", 85);
    await dispatchDiscoveryAlerts({ store, senders: [sender] }, run([a], "2026-10-22T13:00:00.000Z", "run-1"), [delta(a, "NEW")], CFG);
    const second = await dispatchDiscoveryAlerts(
      { store, senders: [sender] },
      run([a], "2026-10-22T18:00:00.000Z", "run-2"),
      [delta(a, "NEW")],
      CFG,
    );
    expect(sent).toHaveLength(1);
    expect(second.sent).toHaveLength(0);
    expect(second.skipped).toEqual([{ symbol: "AAA", thesis: "bullish", reason: "dedupe" }]);
  });

  it("caps at 5 per day per scope, strongest first; other scopes and days unaffected", async () => {
    const { store, sender, sent } = harness();
    const items = ["AAA", "BBB", "CCC", "DDD", "EEE", "FFF", "GGG"].map((s, i) => setup(s, 71 + i));
    const result = await dispatchDiscoveryAlerts(
      { store, senders: [sender] },
      run(items),
      items.map((i) => delta(i, "NEW")),
      CFG,
    );
    expect(result.sent.map((a) => a.symbol)).toEqual(["GGG", "FFF", "EEE", "DDD", "CCC"]);
    expect(result.skipped).toHaveLength(2);
    expect(result.skipped.every((s) => s.reason === "daily_cap")).toBe(true);

    const otherScope = { ...run([setup("ZZZ", 88)], "2026-10-22T20:00:00.000Z", "run-9"), scopeKey: "sched:evening" };
    const other = await dispatchDiscoveryAlerts({ store, senders: [sender] }, otherScope, [delta(otherScope.items[0] as DiscoverySetupExpressedItem, "NEW")], CFG);
    expect(other.sent).toHaveLength(1);

    const nextDay = run([setup("AAA", 85)], "2026-10-23T13:00:00.000Z", "run-10");
    const nd = await dispatchDiscoveryAlerts({ store, senders: [sender] }, nextDay, [delta(nextDay.items[0] as DiscoverySetupExpressedItem, "NEW")], CFG);
    expect(nd.sent).toHaveLength(1);
    expect(sent).toHaveLength(7);
  });

  it("counts alerts already recorded earlier the same day toward the cap", async () => {
    const { store, sender } = harness();
    for (let i = 0; i < 4; i++) {
      await store.record({
        runId: "earlier",
        scopeKey: "sched:morning",
        symbol: `S${i}`,
        thesis: "bullish",
        discoveryScore: 80,
        day: "2026-10-22",
        evidence: "earlier",
        firedSignals: ["TREND_UP"],
        createdAt: "2026-10-22T09:00:00.000Z",
      });
    }
    const items = [setup("AAA", 90), setup("BBB", 89), setup("CCC", 88)];
    const result = await dispatchDiscoveryAlerts({ store, senders: [sender] }, run(items), items.map((i) => delta(i, "NEW")), CFG);
    expect(result.sent).toHaveLength(1);
    expect(result.skipped.filter((s) => s.reason === "daily_cap")).toHaveLength(2);
  });

  it("a failing channel does not block the others or the record", async () => {
    const { store, sender, sent } = harness();
    const broken: DiscoveryAlertChannelSender = {
      name: "broken",
      send: vi.fn(async () => {
        throw new Error("channel down");
      }),
    };
    const a = setup("AAA", 85);
    const result = await dispatchDiscoveryAlerts({ store, senders: [broken, sender] }, run([a]), [delta(a, "NEW")], CFG);
    expect(sent).toHaveLength(1);
    expect(result.deliveryErrors).toEqual([{ channel: "broken", symbol: "AAA", message: "channel down" }]);
    expect(await store.countForDay("sched:morning", "2026-10-22")).toBe(1);
  });
});

describe("SqlDiscoveryAlertStore", () => {
  it("round-trips records on MockSqlStorage", async () => {
    const store = new SqlDiscoveryAlertStore(new MockSqlStorage());
    expect(await store.hasAlerted("s", "AAA", "bullish", "2026-10-22")).toBe(false);
    const rec = await store.record({
      runId: "run-1",
      scopeKey: "s",
      symbol: "AAA",
      thesis: "bullish",
      discoveryScore: 85,
      day: "2026-10-22",
      evidence: "ev",
      firedSignals: ["TREND_UP"],
      createdAt: "2026-10-22T13:00:00.000Z",
    });
    expect(rec.id).toContain("disc_alert_");
    expect(await store.hasAlerted("s", "AAA", "bullish", "2026-10-22")).toBe(true);
    expect(await store.countForDay("s", "2026-10-22")).toBe(1);
    const listed = await store.list("s");
    expect(listed).toHaveLength(1);
    expect(listed[0].firedSignals).toEqual(["TREND_UP"]);
  });
});
