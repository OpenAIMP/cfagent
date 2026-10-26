// @vitest-environment node
/**
 * Issue #1740 ([AGENTIC] Hybrid RAG, sub-issue of #1736 item 4) — TDD red-first.
 *
 * The retrieval port conformance suite runs UNCHANGED against the
 * Drizzle D1 graph adapter (over a MockD1Database backed by
 * node:sqlite, same stand-in as the data-foundation slices) and the
 * in-memory graph adapter. A second adapter passing the same suite
 * is the independence proof for the port: swapping stores never
 * touches retrieval domain code.
 *
 * Pinned contracts:
 *  - Graph upserts are idempotent: replaying the same node/edge
 *    changes nothing observable (label/weight refresh only).
 *  - Tenancy is enforced at the repository boundary: no unscoped
 *    read exists; cross-tenant reads return nothing.
 *  - adjacent() answers from stored edges only; resolveSymbols()
 *    answers from stored symbol nodes only.
 *  - Hybrid fusion: dense hits first (score order), then graph
 *    rows grouped by seed order, relation order
 *    in_sector < peer_of < related_event, deduped by node, capped.
 *  - Graph failure degrades to embeddings-only (degraded: true),
 *    never fails the retrieval.
 *  - Empty graph is parity: hybrid output equals the dense leg
 *    alone (graph: [], degraded: false).
 *  - No graph writer accepts a session or credential row; port
 *    modules never import a store client; domain modules never
 *    import drizzle-orm.
 */
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  createD1MarketGraphDb,
  D1MarketGraphAdapter,
  ensureMarketGraphSchema,
} from "../src/retrieval/d1MarketGraphAdapter";
import { InMemoryMarketGraphAdapter } from "../src/retrieval/inMemoryMarketGraphAdapter";
import { InMemoryVectorSearchAdapter } from "../src/retrieval/inMemoryVectorSearchAdapter";
import {
  extractSymbolCandidates,
  hybridRetrieve,
} from "../src/retrieval/hybridRetrieval";
import type {
  MarketEdge,
  MarketGraphStore,
  MarketNode,
  VectorSearchPort,
} from "../src/retrieval/retrievalPorts";

/** Minimal D1Database stand-in over node:sqlite (test-only, same as slices 0–3). */
class MockD1Database {
  readonly sqlite = new DatabaseSync(":memory:");
  prepare(sql: string) {
    const db = this.sqlite;
    return {
      bind(...params: unknown[]) {
        return {
          async run() {
            const info = db.prepare(sql).run(...(params as any[]));
            return {
              success: true,
              meta: {
                changes: info.changes,
                last_row_id: info.lastInsertRowid,
              },
              results: [],
            };
          },
          async all() {
            return { results: db.prepare(sql).all(...(params as any[])) };
          },
          async first() {
            return db.prepare(sql).get(...(params as any[])) ?? null;
          },
          async raw() {
            return db
              .prepare(sql)
              .all(...(params as any[]))
              .map((row: any) => Object.values(row));
          },
        };
      },
    };
  }
  async batch(statements: any[]) {
    const results: any[] = [];
    this.sqlite.exec("BEGIN");
    try {
      for (const stmt of statements) {
        results.push(await stmt.run());
      }
      this.sqlite.exec("COMMIT");
    } catch (err) {
      this.sqlite.exec("ROLLBACK");
      throw err;
    }
    return results;
  }
}

const TENANT = "primary";
const OTHER = "other-tenant";

function node(
  nodeType: MarketNode["nodeType"],
  nodeKey: string,
  label: string,
): MarketNode {
  return { tenantId: TENANT, nodeType, nodeKey, label };
}

function edge(
  fromType: MarketEdge["fromType"],
  fromKey: string,
  relation: MarketEdge["relation"],
  toType: MarketEdge["toType"],
  toKey: string,
): MarketEdge {
  return {
    tenantId: TENANT,
    fromType,
    fromKey,
    relation,
    toType,
    toKey,
    weight: relation === "peer_of" ? 0.5 : 1,
    provenance: "test",
  };
}

async function seedGraph(store: MarketGraphStore): Promise<void> {
  await store.upsertNodes([
    node("symbol", "NVDA", "NVIDIA Corporation"),
    node("symbol", "AMD", "Advanced Micro Devices"),
    node("symbol", "JPM", "JPMorgan Chase & Co."),
    node("sector", "Semiconductors", "Semiconductors"),
    node("sector", "Financial", "Financial"),
    node("event", "evt-earnings-nvda", "NVDA earnings"),
  ]);
  await store.upsertEdges([
    edge("symbol", "NVDA", "in_sector", "sector", "Semiconductors"),
    edge("symbol", "AMD", "in_sector", "sector", "Semiconductors"),
    edge("symbol", "JPM", "in_sector", "sector", "Financial"),
    edge("symbol", "NVDA", "peer_of", "symbol", "AMD"),
    edge("symbol", "AMD", "peer_of", "symbol", "NVDA"),
    edge("symbol", "NVDA", "related_event", "event", "evt-earnings-nvda"),
  ]);
}

function makeVector(): {
  port: VectorSearchPort;
  seed: (records: Array<{ id: string; text: string; metadata?: Record<string, unknown> }>) => void;
} {
  const adapter = new InMemoryVectorSearchAdapter();
  return {
    port: adapter,
    seed: (records) => adapter.seed(records),
  };
}

describe("market graph port conformance (D1 + in-memory, same suite)", () => {
  const factories: Array<{
    name: string;
    make: () => Promise<MarketGraphStore>;
  }> = [
    {
      name: "d1",
      make: async () => {
        const mock = new MockD1Database();
        const db = createD1MarketGraphDb(mock as any);
        await ensureMarketGraphSchema(db);
        return new D1MarketGraphAdapter(db);
      },
    },
    {
      name: "in-memory",
      make: async () => new InMemoryMarketGraphAdapter(),
    },
  ];

  for (const factory of factories) {
    describe(`adapter: ${factory.name}`, () => {
      it("upserts nodes/edges idempotently and answers adjacent()", async () => {
        const store = await factory.make();
        await seedGraph(store);
        await seedGraph(store);
        const rows = await store.adjacent(TENANT, ["NVDA"]);
        const keys = rows.map((r) => `${r.viaRelation}:${r.node.nodeKey}`).sort();
        expect(keys).toEqual([
          "in_sector:Semiconductors",
          "peer_of:AMD",
          "related_event:evt-earnings-nvda",
        ]);
      });

      it("filters adjacent() by relation", async () => {
        const store = await factory.make();
        await seedGraph(store);
        const rows = await store.adjacent(TENANT, ["NVDA"], {
          relations: ["peer_of"],
        });
        expect(rows.map((r) => r.node.nodeKey)).toEqual(["AMD"]);
      });

      it("resolveSymbols() answers from stored symbol nodes only", async () => {
        const store = await factory.make();
        await seedGraph(store);
        expect(await store.resolveSymbols(TENANT, ["NVDA", "NOPE", "JPM"])).toEqual([
          "NVDA",
          "JPM",
        ]);
        expect(await store.resolveSymbols(TENANT, ["Semiconductors"])).toEqual([]);
      });

      it("enforces tenancy: cross-tenant reads return nothing", async () => {
        const store = await factory.make();
        await seedGraph(store);
        expect(await store.adjacent(OTHER, ["NVDA"])).toEqual([]);
        expect(await store.resolveSymbols(OTHER, ["NVDA"])).toEqual([]);
        // A writer row carrying another tenant is stored under that
        // tenant only; the primary tenant still sees nothing of it.
        await store.upsertNodes([
          { tenantId: OTHER, nodeType: "symbol", nodeKey: "NVDA", label: "x" },
        ]);
        expect(await store.adjacent(TENANT, ["NVDA"])).toHaveLength(3);
      });

      it("hybrid fusion orders, dedups, and caps graph rows", async () => {
        const store = await factory.make();
        await seedGraph(store);
        const { port, seed } = makeVector();
        seed([
          { id: "r1", text: "NVDA beat earnings expectations", metadata: {} },
          { id: "r2", text: "AMD ships new chips", metadata: {} },
        ]);
        const result = await hybridRetrieve(
          { vector: port, graph: store },
          { query: "NVDA outlook", tenantId: TENANT, topK: 10, graphTopK: 2 },
        );
        expect(result.degraded).toBe(false);
        expect(result.dense.map((d) => d.id)).toEqual(["r1", "r2"]);
        // Seeds: NVDA (query) then AMD (hit text). Cap 2 keeps the
        // first two NVDA adjacents in relation order.
        expect(result.graph.map((g) => g.node.nodeKey)).toEqual([
          "Semiconductors",
          "AMD",
        ]);
        expect(result.graph[0].viaRelation).toBe("in_sector");
        expect(result.graph[1].viaRelation).toBe("peer_of");
      });

      it("graph failure degrades to embeddings-only, never throws", async () => {
        const { port, seed } = makeVector();
        seed([{ id: "r1", text: "NVDA outlook note", metadata: {} }]);
        const failingGraph = {
          adjacent: async () => {
            throw new Error("D1 down");
          },
          resolveSymbols: async () => {
            throw new Error("D1 down");
          },
          upsertNodes: async () => {},
          upsertEdges: async () => {},
        };
        const result = await hybridRetrieve(
          { vector: port, graph: failingGraph },
          { query: "NVDA", tenantId: TENANT },
        );
        expect(result.degraded).toBe(true);
        expect(result.graph).toEqual([]);
        expect(result.dense.map((d) => d.id)).toEqual(["r1"]);
      });

      it("empty graph is parity: hybrid output equals the dense leg alone", async () => {
        const store = await factory.make();
        const { port, seed } = makeVector();
        seed([{ id: "r1", text: "NVDA outlook note", metadata: {} }]);
        const result = await hybridRetrieve(
          { vector: port, graph: store },
          { query: "NVDA", tenantId: TENANT },
        );
        expect(result).toEqual({
          dense: result.dense,
          graph: [],
          degraded: false,
        });
        expect(result.dense.map((d) => d.id)).toEqual(["r1"]);
      });

      it("null graph behaves like an empty graph (no throw, no rows)", async () => {
        const { port, seed } = makeVector();
        seed([{ id: "r1", text: "NVDA outlook note", metadata: {} }]);
        const result = await hybridRetrieve(
          { vector: port, graph: null },
          { query: "NVDA", tenantId: TENANT },
        );
        expect(result.graph).toEqual([]);
        expect(result.degraded).toBe(false);
      });
    });
  }
});

describe("symbol extraction", () => {
  it("extracts uppercase ticker-like tokens in order, deduped", () => {
    expect(extractSymbolCandidates("NVDA and amd, plus BRK.B and hello")).toEqual([
      "NVDA",
      "BRK.B",
    ]);
  });

  it("ignores lowercase words and long tokens", () => {
    expect(extractSymbolCandidates("outlook for the quarter")).toEqual([]);
    expect(extractSymbolCandidates("TOOLONGTOKEN here")).toEqual([]);
  });
});

describe("port hygiene (no store client in port, no drizzle in domain)", () => {
  // Strip doc comments: the boundary is documented in prose, but
  // no CODE may reference a store client, a binding, or drizzle.
  const code = (rel: string) =>
    readFileSync(resolve(__dirname, "..", "src", rel), "utf8").replace(
      /\/\*[\s\S]*?\*\//g,
      "",
    );

  it("retrievalPorts.ts code references no store client or binding", () => {
    const text = code("retrieval/retrievalPorts.ts");
    expect(text).not.toMatch(/D1Database|VECTOR_MEMORY|drizzle-orm/);
    expect(text).not.toMatch(/^import /m);
  });

  it("hybrid retrieval code imports no drizzle-orm", () => {
    expect(code("retrieval/hybridRetrieval.ts")).not.toMatch(/drizzle-orm/);
  });

  it("no graph writer accepts session or credential material", () => {
    const text = code("retrieval/retrievalPorts.ts");
    expect(text).not.toMatch(/password|secret|credential|sessionToken/i);
  });
});
