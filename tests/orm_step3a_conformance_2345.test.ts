/**
 * #2345 (#1976 step 3a) — ORM ports conformance.
 *
 * One contract suite per port, run over EVERY adapter the
 * composition roots can serve: the DO-SQLite adapters (over a
 * node:sqlite-backed SqlStorage double with real semantics)
 * and the in-memory adapters; the marketplace ports
 * additionally run over the D1 adapter (MockD1Database, the
 * step-1/2 pattern). The contract pinned here is ADR 0022 D-E
 * as implemented in step 3a:
 *
 *   create  = insert-or-throw (a duplicate primary key is an
 *             error, never a silent replace);
 *   update  = the re-read row, or null when the row is absent
 *             (the DO/D1 adapters verify applied fields against
 *             the re-read row and throw on divergence);
 *   delete  = true ONLY when a row was actually removed
 *             (corrects the legacy unconditional-true);
 *   upsert  = insert-or-update by primary key.
 *
 * Plus the specialized port operations (message/event/memory
 * retention selectors, transaction replace, the completed
 * canonical-report contract, the read-only settings port), the
 * marketplace counter operations and cross-residency revenue
 * equality, migration 0021's registration + DDL↔Drizzle
 * parity, the buildMarketplacePorts residency selection, and
 * the R-7 composition pin (composition never initializes
 * schema; the unbound-but-exported agent classes gain no
 * initializeSchema).
 */
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getTableConfig } from "drizzle-orm/sqlite-core";

import { DatabaseORM, verifyStoredAuditChain } from "../src/orm";
import { createOrmPorts, type OrmPorts } from "../src/data/createOrmPorts";
import { createMarketplacePorts } from "../src/data/createMarketplacePorts";
import { createInMemoryMarketplacePorts } from "../src/data/inMemoryMarketplaceAdapter";
import {
  createD1MarketplaceDb,
  createD1MarketplacePorts,
  ensureD1Marketplace,
} from "../src/data/d1MarketplaceAdapter";
import { buildMarketplacePorts } from "../src/data/buildMarketplacePorts";
import {
  computeMarketplaceRevenueSummary,
  marketplaceSeedData,
  type MarketplacePorts,
} from "../src/data/marketplacePorts";
import {
  InMemoryEventLogAdapter,
  InMemoryMemoryAdapter,
  InMemoryMessageAdapter,
  InMemoryRepository,
  InMemorySettingsReadAdapter,
  InMemoryTransactionLedgerAdapter,
  InMemoryCanonicalReportAdapter,
} from "../src/data/inMemoryOrmAdapters";
import {
  agentAds,
  agentCategories,
  agentExternalAds,
  agentReferrals,
} from "../src/data/drizzleSchema";
import {
  ALL_MIGRATIONS,
  MIGRATION_0021_MARKETPLACE,
} from "../src/data/migrationRunner";
import type { RepositoryPort } from "../src/data/repositoryPorts";

/** SqlStorage-shaped executor over node:sqlite (real semantics). */
class SqliteTestStorage {
  readonly sqlite = new DatabaseSync(":memory:");
  exec(query: string, ...params: unknown[]): unknown[] {
    const stmt = this.sqlite.prepare(query);
    if (/^\s*(SELECT|PRAGMA)/i.test(query)) {
      return stmt.all(...(params as never[])) as unknown[];
    }
    stmt.run(...(params as never[]));
    return [];
  }
}

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
              meta: { changes: info.changes, last_row_id: info.lastInsertRowid },
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

function freshDoPorts(): { ports: OrmPorts; orm: DatabaseORM; storage: SqliteTestStorage } {
  const storage = new SqliteTestStorage();
  const orm = new DatabaseORM(storage as never);
  orm.initializeSchema("sess-conf");
  return { ports: createOrmPorts(storage as never), orm, storage };
}

// ---------------------------------------------------------------------------
// Generic sync repository contract (DO-SQLite + in-memory)
// ---------------------------------------------------------------------------

interface RepoCase {
  name: string;
  /** snake_case column for the DO core's raw orderBy contract. */
  orderColumn: string;
  doPort: (ports: OrmPorts) => RepositoryPort<any>;
  memory: () => RepositoryPort<any>;
  sample: (id: string) => Record<string, any>;
  patch: Record<string, any>;
  patchField: string;
  patchValue: unknown;
}

const repoCases: RepoCase[] = [
  {
    name: "watchlists",
    doPort: (p) => p.watchlists,
    memory: () => new InMemoryRepository("mas_watchlists"),
    sample: (id) => ({ id, name: "WL", userLogin: "alice", symbolsJson: "[\"AAPL\"]", itemsJson: "[]", source: "user", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }),
    patch: { name: "WL2" },
    orderColumn: "name",
    patchField: "name",
    patchValue: "WL2",
  },
  {
    name: "trades",
    doPort: (p) => p.trades,
    memory: () => new InMemoryRepository("mas_trades"),
    sample: (id) => ({ id, sessionId: "s1", symbol: "AAPL", action: "buy", orderType: "market", quantity: 3, price: 10, totalValue: 30, status: "open", proposerDid: "did:ex:proposer", authorizerDid: "did:ex:authorizer", proofSignature: "sig", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }),
    patch: { status: "closed" },
    orderColumn: "status",
    patchField: "status",
    patchValue: "closed",
  },
  {
    name: "webhookReplay",
    doPort: (p) => p.webhookReplay,
    memory: () => new InMemoryRepository("webhook_replay_nonces", "nonce"),
    sample: (id) => ({ nonce: id, source: "stripe", createdAt: "2026-01-01T00:00:00.000Z", expiresAt: "2026-01-02T00:00:00.000Z" }),
    patch: { source: "paddle" },
    orderColumn: "source",
    patchField: "source",
    patchValue: "paddle",
  },
  {
    name: "optionsChainCache",
    doPort: (p) => p.optionsChainCache,
    memory: () => new InMemoryRepository("options_chain_cache"),
    sample: (id) => ({ id, symbol: "AAPL", expirationsJson: "[]", chainsJson: "{}", fetchedAt: "2026-01-01T00:00:00.000Z", expiresAt: "2026-01-02T00:00:00.000Z", contractCount: 1 }),
    patch: { chainsJson: "{\"v\":2}" },
    orderColumn: "chains_json",
    patchField: "chainsJson",
    patchValue: "{\"v\":2}",
  },
];

for (const c of repoCases) {
  for (const residency of ["do-sqlite", "in-memory"] as const) {
    describe(`repository contract: ${c.name} (${residency})`, () => {
      const make = () =>
        residency === "do-sqlite" ? c.doPort(freshDoPorts().ports) : c.memory();

      it("create returns the record and findById round-trips it", () => {
        const repo = make();
        const rec = c.sample("r1");
        expect(repo.create(rec)).toEqual(rec);
        expect(repo.findById("r1")).toMatchObject({ [c.patchField]: rec[c.patchField] });
        expect(repo.count()).toBe(1);
      });

      it("create on a duplicate primary key throws (D-E.1)", () => {
        const repo = make();
        repo.create(c.sample("r1"));
        expect(() => repo.create(c.sample("r1"))).toThrow();
      });

      it("update returns the re-read row; update of a missing row is null (D-E.2)", () => {
        const repo = make();
        repo.create(c.sample("r1"));
        const updated = repo.update("r1", c.patch);
        expect(updated?.[c.patchField]).toEqual(c.patchValue);
        expect(repo.update("missing", c.patch)).toBeNull();
      });

      it("delete is true only when a row was removed (D-E.2)", () => {
        const repo = make();
        repo.create(c.sample("r1"));
        expect(repo.delete("r1")).toBe(true);
        expect(repo.findById("r1")).toBeNull();
        expect(repo.delete("r1")).toBe(false);
      });

      it("upsert inserts then updates by primary key", () => {
        const repo = make();
        repo.upsert(c.sample("r1"));
        expect(repo.count()).toBe(1);
        repo.upsert({ ...c.sample("r1"), ...c.patch });
        expect(repo.count()).toBe(1);
        expect(repo.findById("r1")?.[c.patchField]).toEqual(c.patchValue);
      });

      it("findMany honours where/orderBy/limit", () => {
        const repo = make();
        repo.create({ ...c.sample("r1"), [c.patchField]: "b" });
        repo.create({ ...c.sample("r2"), [c.patchField]: "a" });
        const orderBy =
          residency === "do-sqlite" ? `${c.orderColumn} ASC` : `${c.patchField} ASC`;
        const ordered = repo.findMany({ orderBy });
        expect(ordered.map((r) => r.id ?? r.nonce)).toEqual(["r2", "r1"]);
        expect(repo.findMany({ limit: 1 })).toHaveLength(1);
      });
    });
  }
}

// ---------------------------------------------------------------------------
// Specialized DO-resident ports
// ---------------------------------------------------------------------------

describe("message port (do-sqlite + in-memory)", () => {
  const exercise = (
    messages: OrmPorts["messages"] | InMemoryMessageAdapter,
  ) => {
    messages.create({ id: "m1", sessionId: "s1", role: "user", content: "hi", agent: "orchestrator", createdAt: "2026-01-01T00:00:00.000Z" });
    messages.create({ id: "m2", sessionId: "s1", role: "assistant", content: "yo", agent: "orchestrator", createdAt: "2026-01-03T00:00:00.000Z" });
    messages.create({ id: "m3", sessionId: "s2", role: "user", content: "other", agent: "orchestrator", createdAt: "2026-01-02T00:00:00.000Z" });
    expect(messages.findMany({ where: { sessionId: "s1" }, orderBy: "created_at ASC" }).map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(messages.idsCreatedBefore("2026-01-02T12:00:00.000Z", 10)).toEqual(["m1", "m3"]);
    expect(messages.deleteBySessionId("s1")).toBe(2);
    expect(messages.count()).toBe(1);
  };
  it("do-sqlite", () => exercise(freshDoPorts().ports.messages));
  it("in-memory", () => exercise(new InMemoryMessageAdapter()));
});

describe("event log port (do-sqlite + in-memory)", () => {
  it("do-sqlite: creates chain and the stored chain verifies", () => {
    const { ports, orm } = freshDoPorts();
    const e1 = ports.events.create({ id: "e1", sessionId: "s1", type: "t.a", agent: "orchestrator", payload: "{}", createdAt: "2026-01-01T00:00:00.000Z" } as any);
    const e2 = ports.events.create({ id: "e2", sessionId: "s1", type: "t.b", agent: "orchestrator", payload: "{}", createdAt: "2026-01-02T00:00:00.000Z" } as any);
    expect((e2 as any).previousEventHash).toBe((e1 as any).eventHash);
    expect((e1 as any).eventHash).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyStoredAuditChain(orm)).toBe(true);
    expect(ports.events.idsCreatedBefore("2026-01-01T12:00:00.000Z", 10)).toEqual(["e1"]);
  });

  it("in-memory: creates chain with the same link fields", () => {
    const events = new InMemoryEventLogAdapter();
    const e1 = events.create({ id: "e1", sessionId: "s1", type: "t.a", agent: "orchestrator", payload: "{}", createdAt: "2026-01-01T00:00:00.000Z" } as any);
    const e2 = events.create({ id: "e2", sessionId: "s1", type: "t.b", agent: "orchestrator", payload: "{}", createdAt: "2026-01-02T00:00:00.000Z" } as any);
    expect((e2 as any).previousEventHash).toBe((e1 as any).eventHash);
    expect((e1 as any).eventHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("memory port (do-sqlite + in-memory)", () => {
  const exercise = (memory: OrmPorts["memory"] | InMemoryMemoryAdapter) => {
    memory.upsert({ key: "user:alice:pref", value: "dark mode", updatedAt: "2026-01-01T00:00:00.000Z" });
    memory.upsert({ key: "user:bob:pref", value: "light mode", updatedAt: "2026-01-03T00:00:00.000Z" });
    memory.upsert({ key: "user:alice:pref", value: "dark mode v2", updatedAt: "2026-01-04T00:00:00.000Z" });
    expect(memory.count()).toBe(2);
    expect(memory.search("user:alice", 50).map((r) => r.key)).toEqual(["user:alice:pref"]);
    expect(memory.listRecent(1)[0].key).toBe("user:alice:pref");
    expect(memory.keysUpdatedBefore("2026-01-02T00:00:00.000Z", 10)).toEqual([]);
    expect(memory.keysUpdatedBefore("2026-01-03T12:00:00.000Z", 10)).toEqual(["user:bob:pref"]);
    expect(memory.clear()).toBe(2);
    expect(memory.count()).toBe(0);
  };
  it("do-sqlite", () => exercise(freshDoPorts().ports.memory));
  it("in-memory", () => exercise(new InMemoryMemoryAdapter()));
});

describe("transaction ledger port (do-sqlite + in-memory)", () => {
  const exercise = (
    tx: OrmPorts["transactions"] | InMemoryTransactionLedgerAdapter,
  ) => {
    const draft = {
      id: "tx1", sessionId: "s1", action: "charge",
      amount: 200, currency: "USD", customer: "cust-1", gateway: "cfpay",
      gatewayRef: "gw-1", status: "draft", checkoutUrl: "https://pay.example/tx1",
      proposerDid: "did:ex:proposer", authorizerDid: "did:ex:authorizer",
      proofSignature: "sig", note: "n",
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    } as any;
    tx.replace(draft);
    expect(tx.findById("tx1")?.status).toBe("draft");
    tx.replace({ ...draft, status: "completed" });
    expect(tx.count()).toBe(1);
    expect(tx.findById("tx1")?.status).toBe("completed");
    expect(tx.delete("tx1")).toBe(true);
    expect(tx.delete("tx1")).toBe(false);
  };
  it("do-sqlite", () => exercise(freshDoPorts().ports.transactions));
  it("in-memory", () => exercise(new InMemoryTransactionLedgerAdapter()));
});

describe("canonical report port: the completed contract (V-5)", () => {
  const record = {
    id: "rep1", runId: "run1", generationId: "gen1", title: "Weekly",
    source: "scheduled", summary: "s", body: "body text", userLogin: "alice",
    bodyR2Key: "reports/alice/rep1.md",
    createdAt: "2026-01-01T00:00:00.000Z",
  } as any;
  it("do-sqlite round-trips userLogin + bodyR2Key with no snake_case leak", () => {
    const { ports } = freshDoPorts();
    ports.reports.create(record);
    const read = ports.reports.findById("rep1") as any;
    expect(read.userLogin).toBe("alice");
    expect(read.bodyR2Key).toBe("reports/alice/rep1.md");
    expect(read.user_login).toBeUndefined();
  });
  it("in-memory round-trips the same fields", () => {
    const reports = new InMemoryCanonicalReportAdapter();
    reports.create(record);
    const read = reports.findById("rep1") as any;
    expect(read.userLogin).toBe("alice");
    expect(read.bodyR2Key).toBe("reports/alice/rep1.md");
  });
});

describe("settings read port (read-only, G-7)", () => {
  it("do-sqlite reads mas_settings and exposes no write surface", () => {
    const { ports, storage } = freshDoPorts();
    // mas_settings is NOT one of the ORM's 13 tables: its DDL is
    // ensured by the settings owner (orchestrator ensureTables /
    // screeningFlags), which is exactly why step 3a's port is
    // read-only (G-7). Create it here with that same DDL.
    storage.sqlite.exec(
      "CREATE TABLE IF NOT EXISTS mas_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)",
    );
    storage.sqlite.exec(
      "INSERT INTO mas_settings (key, value, updated_at) VALUES ('theme', 'dark', '2026-01-01')",
    );
    expect(ports.settingsRead.get("theme")).toBe("dark");
    expect(ports.settingsRead.has("theme")).toBe(true);
    expect(ports.settingsRead.get("absent")).toBeNull();
    expect(ports.settingsRead.has("absent")).toBe(false);
    const methods = Object.getOwnPropertyNames(
      Object.getPrototypeOf(ports.settingsRead),
    )
      .filter((n) => n !== "constructor")
      .sort();
    expect(methods).toEqual(["get", "has"]);
    for (const write of ["set", "put", "update", "create", "delete", "upsert"]) {
      expect((ports.settingsRead as any)[write]).toBeUndefined();
    }
  });
  it("in-memory reads seeded values", () => {
    const port = new InMemorySettingsReadAdapter();
    port.set("theme", "dark");
    expect(port.get("theme")).toBe("dark");
    expect(port.has("theme")).toBe(true);
    expect(port.get("absent")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Marketplace ports: one async contract over DO-SQLite,
// in-memory, and D1 residencies
// ---------------------------------------------------------------------------

async function freshMarketplace(
  residency: "do-sqlite" | "in-memory" | "d1",
): Promise<{ mp: MarketplacePorts; orm?: DatabaseORM }> {
  if (residency === "do-sqlite") {
    const storage = new SqliteTestStorage();
    const orm = new DatabaseORM(storage as never);
    orm.initializeSchema("sess-conf");
    return { mp: createMarketplacePorts(storage as never), orm };
  }
  if (residency === "in-memory") {
    return { mp: createInMemoryMarketplacePorts() };
  }
  const mock = new MockD1Database();
  const db = createD1MarketplaceDb(mock as never);
  await ensureD1Marketplace(db);
  return { mp: createD1MarketplacePorts(db) };
}

const NOW = "2026-01-01T00:00:00.000Z";

for (const residency of ["do-sqlite", "in-memory", "d1"] as const) {
  describe(`marketplace contract: categories (${residency})`, () => {
    it("seeds are present; CRUD + D-E rules hold", async () => {
      const { mp } = await freshMarketplace(residency);
      expect(await mp.categories.count()).toBe(5);
      const created = await mp.categories.create({
        id: "cat_x", name: "X", slug: "x", description: "d", icon: "i",
        sortOrder: 9, isActive: true, createdAt: NOW, updatedAt: NOW,
      } as any);
      expect(created.name).toBe("X");
      expect((await mp.categories.findById("cat_x"))?.name).toBe("X");
      await expect(
        mp.categories.create({ id: "cat_x", name: "dup" } as any),
      ).rejects.toThrow();
      expect((await mp.categories.update("cat_x", { name: "X2" }))?.name).toBe("X2");
      expect(await mp.categories.update("missing", { name: "n" })).toBeNull();
      expect(await mp.categories.delete("cat_x")).toBe(true);
      expect(await mp.categories.delete("cat_x")).toBe(false);
      const active = await mp.categories.findMany({
        where: { isActive: true },
        orderBy: "sort_order ASC",
      });
      expect(active.length).toBe(5);
    });
  });

  describe(`marketplace contract: externalAds (${residency})`, () => {
    it("seeds are present; counters step atomically", async () => {
      const { mp } = await freshMarketplace(residency);
      expect(await mp.externalAds.count()).toBe(4);
      const seed = marketplaceSeedData(NOW).externalAds[0];
      const ad = await mp.externalAds.findById(seed.id);
      expect(ad?.clicks).toBe(seed.clicks);
      expect(await mp.externalAds.incrementCounter(seed.id, "clicks", 3)).toBe(seed.clicks + 3);
      expect(await mp.externalAds.incrementCounter("missing", "clicks", 1)).toBeNull();
      const before = (await mp.externalAds.findById(seed.id))!.earnings;
      const after = await mp.externalAds.incrementEarnings(seed.id, 2.5);
      expect(after).toBeCloseTo(before + 2.5);
      expect(await mp.externalAds.incrementEarnings("missing", 1)).toBeNull();
    });
  });

  describe(`marketplace contract: ads (${residency})`, () => {
    it("seeds are present; bulk impressions + click counter hold", async () => {
      const { mp } = await freshMarketplace(residency);
      expect(await mp.ads.count()).toBe(2);
      const totalBefore = (await mp.ads.findMany()).reduce((s, a) => s + a.impressions, 0);
      await mp.ads.incrementAllImpressions(1);
      const totalAfter = (await mp.ads.findMany()).reduce((s, a) => s + a.impressions, 0);
      expect(totalAfter).toBe(totalBefore + 2);
      const ad = (await mp.ads.findMany())[0];
      expect(await mp.ads.incrementCounter(ad.id, "clicks", 1)).toBe(ad.clicks + 1);
      expect(await mp.ads.delete(ad.id)).toBe(true);
      expect(await mp.ads.delete(ad.id)).toBe(false);
    });
  });

  describe(`marketplace contract: referrals (${residency})`, () => {
    it("CRUD + counters hold; userLogin round-trips", async () => {
      const { mp } = await freshMarketplace(residency);
      expect(await mp.referrals.count()).toBe(0);
      await mp.referrals.create({
        id: "ref_1", userLogin: "alice", title: "T", url: "https://u",
        category: "C", rewardText: "R", clicks: 0, signups: 0, createdAt: NOW,
      } as any);
      expect((await mp.referrals.findById("ref_1"))?.userLogin).toBe("alice");
      expect(await mp.referrals.incrementCounter("ref_1", "clicks", 1)).toBe(1);
      expect(await mp.referrals.incrementCounter("ref_1", "signups", 2)).toBe(2);
      expect(await mp.referrals.incrementCounter("missing", "clicks", 1)).toBeNull();
      expect(await mp.referrals.delete("ref_1")).toBe(true);
      expect(await mp.referrals.delete("ref_1")).toBe(false);
    });
  });
}

describe("marketplace revenue: identical across residencies", () => {
  it("the computed summary matches the facade's sync summary and each residency agrees", async () => {
    const summaries: Record<string, unknown> = {};
    for (const residency of ["do-sqlite", "in-memory", "d1"] as const) {
      const { mp, orm } = await freshMarketplace(residency);
      const txSource =
        residency === "do-sqlite"
          ? orm!.transactions
          : {
              findMany: () => [
                { status: "completed", action: "charge", amount: 200 },
                { status: "authorized", action: "charge", amount: 100 },
                { status: "draft", action: "charge", amount: 999 },
              ] as any[],
            };
      if (residency === "do-sqlite") {
        const txBase = {
          sessionId: "s1", currency: "USD", customer: "cust-1", gateway: "cfpay",
          gatewayRef: "gw", checkoutUrl: "https://pay.example",
          proposerDid: "did:ex:proposer", authorizerDid: "did:ex:authorizer",
          proofSignature: "sig", note: "n", createdAt: NOW, updatedAt: NOW,
        };
        orm!.transactions.create({ ...txBase, id: "tx_seed", action: "charge", amount: 200, status: "completed" } as any);
        orm!.transactions.create({ ...txBase, id: "tx_seed2", action: "charge", amount: 100, status: "authorized" } as any);
        orm!.transactions.create({ ...txBase, id: "tx_seed3", action: "charge", amount: 999, status: "draft" } as any);
        summaries["facade-sync"] = orm!.getRevenueSummary();
      }
      summaries[residency] = await computeMarketplaceRevenueSummary(mp, txSource as any);
    }
    // Seed-derived expectations: adNetwork 62.81; marketplace
    // 2×$20 + 52×$0.50 = 66; fees 2.5% × 300 = 7.5; payouts 0.
    const expected = {
      grossRevenue: 62.81 + 66 + 7.5,
      adNetworkRevenue: 62.81,
      marketplaceRevenue: 66,
      paymentPlatformFees: 7.5,
      referralPayouts: 0,
      netRevenue: 62.81 + 66 + 7.5,
      totalImpressions: 387,
      totalAdClicks: 28,
      averageRPM: (62.81 / 387) * 1000,
    };
    for (const key of Object.keys(summaries)) {
      const s = summaries[key] as any;
      for (const [field, value] of Object.entries(expected)) {
        expect(s[field], `${key}.${field}`).toBeCloseTo(value as number);
      }
    }
  });

  it("D1 ensure seeds exactly the canonical 5/4/2 rows, once", async () => {
    const mock = new MockD1Database();
    const db = createD1MarketplaceDb(mock as never);
    await ensureD1Marketplace(db);
    await ensureD1Marketplace(db); // idempotent: seed-if-empty
    const mp = createD1MarketplacePorts(db);
    expect(await mp.categories.count()).toBe(5);
    expect(await mp.externalAds.count()).toBe(4);
    expect(await mp.ads.count()).toBe(2);
    const seeds = marketplaceSeedData(NOW);
    expect((await mp.categories.findById(seeds.categories[0].id))?.name).toBe(
      seeds.categories[0].name,
    );
  });
});

describe("buildMarketplacePorts residency selection", () => {
  it("unbound AGENT_DB serves the instance's own DO tables", async () => {
    const storage = new SqliteTestStorage();
    const orm = new DatabaseORM(storage as never);
    orm.initializeSchema("sess-sel");
    const mp = await buildMarketplacePorts({} as any, storage as never);
    await mp.categories.create({ id: "cat_sel", name: "Sel", slug: "sel", description: "d", icon: "i", isActive: true, sortOrder: 9, createdAt: NOW, updatedAt: NOW } as any);
    // Visible through the facade's own repository: same table.
    expect(orm.categories.findById("cat_sel")?.name).toBe("Sel");
  });

  it("bound AGENT_DB serves the shared D1 tables, not the instance's", async () => {
    const storage = new SqliteTestStorage();
    const orm = new DatabaseORM(storage as never);
    orm.initializeSchema("sess-sel");
    const mock = new MockD1Database();
    const mp = await buildMarketplacePorts({ AGENT_DB: mock } as any, storage as never);
    await mp.categories.create({ id: "cat_sel", name: "Sel", slug: "sel", description: "d", icon: "i", isActive: true, sortOrder: 9, createdAt: NOW, updatedAt: NOW } as any);
    expect(await mp.categories.count()).toBe(6); // 5 seeds + 1
    // NOT visible in the instance's own table.
    expect(orm.categories.findById("cat_sel")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Migration 0021: registration + DDL↔Drizzle parity
// ---------------------------------------------------------------------------

describe("migration 0021 (marketplace to D1)", () => {
  it("is registered exactly once and all versions are unique", () => {
    const versions = ALL_MIGRATIONS.map((m) => m.version);
    expect(new Set(versions).size).toBe(versions.length);
    expect(versions.filter((v) => v === 21)).toHaveLength(1);
    expect(MIGRATION_0021_MARKETPLACE.version).toBe(21);
  });

  const parityCases = [
    { table: "agent_categories", drizzle: agentCategories },
    { table: "agent_external_ads", drizzle: agentExternalAds },
    { table: "agent_ads", drizzle: agentAds },
    { table: "agent_referrals", drizzle: agentReferrals },
  ] as const;
  for (const c of parityCases) {
    it(`DDL and the Drizzle schema agree on columns: ${c.table}`, () => {
      const rawColumns = getTableConfig(c.drizzle as any).columns as any;
      const schemaColumns = (
        Array.isArray(rawColumns)
          ? rawColumns.map((col: any) => col.name as string)
          : Object.keys(rawColumns).map((s) =>
              s.replace(/[A-Z]/g, (ch) => `_${ch.toLowerCase()}`),
            )
      ).sort();
      const block = MIGRATION_0021_MARKETPLACE.sql
        .split(`CREATE TABLE IF NOT EXISTS ${c.table} (`)[1]
        .split(");")[0];
      const ddlColumns = [...block.matchAll(/^\s{2}(\w+) /gm)]
        .map((m) => m[1])
        .filter((name) => name !== "PRIMARY")
        .sort();
      expect(ddlColumns).toEqual(schemaColumns);
    });
  }
});

// ---------------------------------------------------------------------------
// R-7: composition roots never initialize schema; unbound-but-exported
// agent classes gain no schema initialization
// ---------------------------------------------------------------------------

describe("R-7 composition pin", () => {
  it("constructing the facade and both composition roots executes zero CREATE TABLE statements", () => {
    const storage = new SqliteTestStorage();
    let creates = 0;
    const counting = {
      exec(query: string, ...params: unknown[]) {
        if (/^\s*CREATE TABLE/i.test(query)) creates += 1;
        return (storage.exec as any)(query, ...params);
      },
    };
    new DatabaseORM(counting as never);
    createOrmPorts(counting as never);
    createMarketplacePorts(counting as never);
    expect(creates).toBe(0);
    // Control: initializeSchema DOES create — the counter works.
    new DatabaseORM(counting as never).initializeSchema("sess-r7");
    expect(creates).toBeGreaterThan(0);
  });

  it("the unbound-but-exported classes carry no initializeSchema; the one bound initializer is unchanged", () => {
    const slack = readFileSync("src/agents/slackAgent.ts", "utf8");
    const research = readFileSync("src/agents/research-agent.ts", "utf8");
    const screener = readFileSync("src/agents/screener-agent.ts", "utf8");
    const trading = readFileSync("src/agents/trading-agent.ts", "utf8");
    expect(slack).not.toContain("initializeSchema");
    expect(research).not.toContain("initializeSchema");
    expect(screener).not.toContain("initializeSchema");
    expect(trading).toContain("initializeSchema");
  });
});
