// @vitest-environment node
/**
 * Issue #1740 ([AGENTIC] Hybrid RAG) — TDD red-first.
 *
 * Graph population derives nodes + edges from existing market
 * data (the curated stock universe: symbol, companyName, sector).
 * Derived relations:
 *  - symbol —in_sector→ sector (weight 1)
 *  - symbol —peer_of→ symbol for same-sector symbols, both
 *    directions (weight 0.5; peer_of is symmetric)
 *  - symbol —related_event→ event for explicitly supplied events
 *    (weight 1; the curated universe supplies no events, so the
 *    built-in population seeds none — event population from
 *    report rows is a recorded follow-up, not smuggled in here)
 * Population is idempotent: a second run upserts the same rows
 * and changes nothing observable.
 */
import { describe, it, expect } from "vitest";
import { InMemoryMarketGraphAdapter } from "../src/retrieval/inMemoryMarketGraphAdapter";
import {
  deriveMarketGraphInput,
  populateFromCuratedUniverse,
  populateMarketGraph,
} from "../src/retrieval/marketGraphPopulation";

const SECURITIES = [
  { symbol: "NVDA", companyName: "NVIDIA Corporation", sector: "Semiconductors" },
  { symbol: "AMD", companyName: "Advanced Micro Devices", sector: "Semiconductors" },
  { symbol: "JPM", companyName: "JPMorgan Chase & Co.", sector: "Financial" },
];

describe("market graph population (#1740)", () => {
  it("derives symbol/sector nodes, in_sector edges, and symmetric peer edges", () => {
    const input = deriveMarketGraphInput(SECURITIES);
    const nodeKeys = input.nodes
      .map((n) => `${n.nodeType}:${n.nodeKey}`)
      .sort();
    expect(nodeKeys).toEqual([
      "sector:Financial",
      "sector:Semiconductors",
      "symbol:AMD",
      "symbol:JPM",
      "symbol:NVDA",
    ]);
    const edgeKeys = input.edges
      .map((e) => `${e.fromKey} -${e.relation}-> ${e.toKey}`)
      .sort();
    expect(edgeKeys).toEqual([
      "AMD -in_sector-> Semiconductors",
      "AMD -peer_of-> NVDA",
      "JPM -in_sector-> Financial",
      "NVDA -in_sector-> Semiconductors",
      "NVDA -peer_of-> AMD",
    ]);
    // JPM is alone in Financial: no peer edges for it.
    expect(edgeKeys.filter((k) => k.startsWith("JPM -peer_of"))).toEqual([]);
  });

  it("derives related_event edges only for explicitly supplied events", () => {
    const input = deriveMarketGraphInput(SECURITIES, [
      { eventKey: "evt-1", label: "NVDA earnings", symbols: ["NVDA", "AMD"] },
    ]);
    const eventEdges = input.edges.filter((e) => e.relation === "related_event");
    expect(eventEdges.map((e) => `${e.fromKey}->${e.toKey}`).sort()).toEqual([
      "AMD->evt-1",
      "NVDA->evt-1",
    ]);
    expect(
      input.nodes.find((n) => n.nodeType === "event" && n.nodeKey === "evt-1"),
    ).toMatchObject({ label: "NVDA earnings" });
  });

  it("populateMarketGraph is idempotent and tenant-scoped", async () => {
    const store = new InMemoryMarketGraphAdapter();
    const first = await populateMarketGraph(
      store,
      "primary",
      deriveMarketGraphInput(SECURITIES),
      1000,
    );
    const second = await populateMarketGraph(
      store,
      "primary",
      deriveMarketGraphInput(SECURITIES),
      2000,
    );
    expect(first).toEqual({ nodes: 5, edges: 5 });
    expect(second).toEqual(first);
    // NVDA: in_sector + peer_of (no event edges: none supplied).
    expect(await store.adjacent("primary", ["NVDA"])).toHaveLength(2);
    expect(await store.adjacent("other", ["NVDA"])).toEqual([]);
  });

  it("populateFromCuratedUniverse seeds the real universe (161 symbols)", async () => {
    const store = new InMemoryMarketGraphAdapter();
    const report = await populateFromCuratedUniverse(store, "primary", 1000);
    expect(report.symbols).toBe(161);
    expect(report.nodes).toBeGreaterThan(161);
    expect(report.edges).toBeGreaterThan(161);
    // Spot check: a known symbol resolves and has sector + peers.
    expect(await store.resolveSymbols("primary", ["NVDA", "JPM"])).toEqual([
      "NVDA",
      "JPM",
    ]);
    const nvdaRows = await store.adjacent("primary", ["NVDA"]);
    expect(nvdaRows.some((r) => r.viaRelation === "in_sector")).toBe(true);
    expect(nvdaRows.some((r) => r.viaRelation === "peer_of")).toBe(true);
  });
});
