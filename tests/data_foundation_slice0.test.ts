// @vitest-environment node
/**
 * Issue #1548 ([AGENTIC] Slice 0, data foundation layer, sub-issue of
 * the #1546 AgentDB program) — halt mirror, TDD red-first.
 *
 * The port/dialect suite runs UNCHANGED against the Drizzle D1
 * adapter (over a MockD1Database backed by node:sqlite — no
 * Cloudflare credentials, no live D1 calls) and the in-memory
 * adapter. A behavior that passes on one adapter and fails on the
 * other is a layer defect, not an application bug.
 *
 * Pinned contracts:
 *  - HaltRead is tenant-scoped and fail-closed (read error → halted).
 *  - Halt-SET mirrors D1-first, halt-CLEAR writes the DO first, so a
 *    partial failure leaves the tick-facing read path halted; a
 *    mirror failure is never silent (it throws to the caller).
 *  - The one-time seed writes current mas_settings state exactly
 *    once and never touches the DO.
 *  - Migration 0001 owns the agent_governance DDL; the Drizzle
 *    schema maps it (column parity pinned here).
 *  - Port modules never import a D1 client or write SQL; domain
 *    modules never import drizzle-orm (structural grep pins).
 */
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import {
  createD1GovernanceDb,
  D1GovernanceAdapter,
  ensureGovernanceSchema,
} from "../src/data/d1GovernanceAdapter";
import { InMemoryGovernanceAdapter } from "../src/data/inMemoryGovernanceAdapter";
import {
  MIGRATION_0001_AGENT_GOVERNANCE,
  applyMigrations,
} from "../src/data/migrationRunner";
import { agentGovernance } from "../src/data/drizzleSchema";
import {
  setGovernedHalt,
  seedGovernanceHalt,
  type DoSql,
} from "../src/data/governedHalt";
import type {
  GovernanceHaltRow,
  GovernanceStore,
} from "../src/data/governancePorts";

/** Minimal D1Database stand-in over node:sqlite (test-only). */
class MockD1Database {
  readonly sqlite = new DatabaseSync(":memory:");
  prepare(sql: string) {
    const db = this.sqlite;
    return {
      bind(...params: unknown[]) {
        // Real D1 methods are async; the mock matches that shape so
        // Drizzle's `.then()` chains work exactly as on D1.
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

async function makeD1Store(): Promise<{
  mock: MockD1Database;
  store: GovernanceStore;
}> {
  const mock = new MockD1Database();
  const db = createD1GovernanceDb(mock as any);
  await ensureGovernanceSchema(db);
  return { mock, store: new D1GovernanceAdapter(db) };
}

function haltRow(
  overrides: Partial<GovernanceHaltRow> & { eventId: string },
): GovernanceHaltRow {
  return {
    tenantId: "primary",
    scope: "global",
    scopeId: null,
    state: "halted",
    setBy: "tester",
    setAtMs: 1000,
    reason: "test",
    version: 1,
    provenance: "test",
    ...overrides,
  };
}

describe("governance port / dialect suite (#1548)", () => {
  const factories: Array<{
    name: string;
    make: () => Promise<GovernanceStore>;
  }> = [
    {
      name: "d1",
      make: async () => (await makeD1Store()).store,
    },
    {
      name: "in-memory",
      make: async () => new InMemoryGovernanceAdapter(),
    },
  ];

  for (const factory of factories) {
    describe(`adapter: ${factory.name}`, () => {
      it("no row → not halted", async () => {
        const store = await factory.make();
        expect(await store.isHalted("primary")).toBe(false);
      });

      it("halted row → halted; clear row → not halted", async () => {
        const store = await factory.make();
        await store.recordHalt(haltRow({ eventId: "e1", state: "halted" }));
        expect(await store.isHalted("primary")).toBe(true);
        await store.recordHalt(
          haltRow({ eventId: "e2", state: "clear", setAtMs: 2000 }),
        );
        expect(await store.isHalted("primary")).toBe(false);
      });

      it("latest row wins regardless of insert order", async () => {
        const store = await factory.make();
        await store.recordHalt(
          haltRow({ eventId: "e-late", state: "clear", setAtMs: 9000 }),
        );
        await store.recordHalt(
          haltRow({ eventId: "e-early", state: "halted", setAtMs: 1000 }),
        );
        expect(await store.isHalted("primary")).toBe(false);
      });

      it("tenant isolation: one tenant halted, another reads clear", async () => {
        const store = await factory.make();
        await store.recordHalt(
          haltRow({ eventId: "e-a", tenantId: "tenant-a", state: "halted" }),
        );
        expect(await store.isHalted("tenant-a")).toBe(true);
        expect(await store.isHalted("tenant-b")).toBe(false);
        expect(await store.isHalted("primary")).toBe(false);
      });

      it("replaying the same event id is idempotent (one row)", async () => {
        const store = await factory.make();
        const row = haltRow({ eventId: "e-replay", state: "halted" });
        await store.recordHalt(row);
        await store.recordHalt(row);
        expect(await store.isHalted("primary")).toBe(true);
        expect(await store.latestHalt("primary")).toMatchObject({
          eventId: "e-replay",
        });
      });

      it("chain scope is independent of the global scope", async () => {
        const store = await factory.make();
        await store.recordHalt(
          haltRow({
            eventId: "e-chain",
            scope: "chain",
            scopeId: "chain-1",
            state: "halted",
          }),
        );
        expect(
          await store.isHalted("primary", {
            scope: "chain",
            scopeId: "chain-1",
          }),
        ).toBe(true);
        expect(await store.isHalted("primary")).toBe(false);
      });
    });
  }

  it("D1 adapter fails closed: a read error reads as halted", async () => {
    const throwing = {
      prepare() {
        throw new Error("D1 unavailable");
      },
    };
    const db = createD1GovernanceDb(throwing as any);
    const store = new D1GovernanceAdapter(db);
    expect(await store.isHalted("primary")).toBe(true);
  });
});

describe("migration 0001 (#1548)", () => {
  it("applies once, records _migrations, second apply is a no-op", async () => {
    const mock = new MockD1Database();
    const db = createD1GovernanceDb(mock as any);
    await applyMigrations(db, [MIGRATION_0001_AGENT_GOVERNANCE]);
    await applyMigrations(db, [MIGRATION_0001_AGENT_GOVERNANCE]);
    const rows = mock.sqlite
      .prepare("SELECT version, name FROM _migrations ORDER BY version")
      .all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ version: 1 });
    const tables = mock.sqlite
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'agent_governance'",
      )
      .all();
    expect(tables).toHaveLength(1);
  });

  it("migration DDL and Drizzle schema agree on columns", () => {
    // drizzle-orm 0.45 exposes columns as an array of column
    // objects (each carrying its DB name); older shapes keyed them
    // by JS property name. Handle both so the pin survives upgrades.
    const rawColumns = getTableConfig(agentGovernance).columns as any;
    const schemaColumns = Array.isArray(rawColumns)
      ? rawColumns.map((c: any) => c.name as string)
      : Object.keys(rawColumns).map((s) =>
          s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`),
        );
    const block = MIGRATION_0001_AGENT_GOVERNANCE.sql.split(
      "CREATE TABLE IF NOT EXISTS agent_governance (",
    )[1].split(");")[0];
    const ddlColumns = [...block.matchAll(/^\s{2}(\w+) /gm)].map((m) => m[1]);
    expect(ddlColumns.sort()).toEqual(schemaColumns.sort());
  });
});

describe("safety-directed halt ordering (#1548)", () => {
  function makeDoSql(initial: string | null = null): DoSql & {
    writes: Array<{ query: string; args: unknown[] }>;
    value: string | null;
  } {
    let value = initial;
    const writes: Array<{ query: string; args: unknown[] }> = [];
    return {
      writes,
      get value() {
        return value;
      },
      exec(query: string, ...args: unknown[]) {
        writes.push({ query, args });
        if (query.startsWith("DELETE")) value = null;
        if (query.startsWith("INSERT")) value = String(args[1]);
        return [];
      },
    };
  }

  function throwingWriter(): GovernanceStore & { calls: number } {
    let calls = 0;
    const inner = new InMemoryGovernanceAdapter();
    return {
      get calls() {
        return calls;
      },
      async recordHalt() {
        calls++;
        throw new Error("mirror unavailable");
      },
      async latestHalt(...args: any[]) {
        return (inner as any).latestHalt(...args);
      },
      async isHalted(...args: any[]) {
        return (inner as any).isHalted(...args);
      },
    };
  }

  it("SET with a failing mirror: DO untouched, error surfaces", async () => {
    const doSql = makeDoSql(null);
    const writer = throwingWriter();
    await expect(
      setGovernedHalt({
        doSql,
        writer,
        tenantId: "primary",
        state: "halted",
        setBy: "tester",
        reason: "test set",
        nowMs: 5000,
      }),
    ).rejects.toThrow(/mirror unavailable/);
    expect(doSql.writes).toHaveLength(0);
    expect(writer.calls).toBe(1);
  });

  it("SET with a failing DO: mirror row present, so the tick reads halted", async () => {
    const store = new InMemoryGovernanceAdapter();
    const failingDo: DoSql = {
      exec() {
        throw new Error("DO unavailable");
      },
    };
    await expect(
      setGovernedHalt({
        doSql: failingDo,
        writer: store,
        tenantId: "primary",
        state: "halted",
        setBy: "tester",
        reason: "test set",
        nowMs: 5000,
      }),
    ).rejects.toThrow(/DO unavailable/);
    expect(await store.isHalted("primary")).toBe(true);
  });

  it("CLEAR with a failing mirror: DO cleared first, mirror still halted (safe side)", async () => {
    const store = new InMemoryGovernanceAdapter();
    await store.recordHalt(haltRow({ eventId: "e-prior", state: "halted" }));
    const doSql = makeDoSql("on");
    const writer = throwingWriter();
    // Seed the throwing writer's inner store is empty; use the real
    // store for the read assertion via a wrapper that fails writes.
    const failingWriteStore: GovernanceStore = {
      async recordHalt() {
        throw new Error("mirror unavailable");
      },
      async latestHalt(t: string, o?: any) {
        return store.latestHalt(t, o);
      },
      async isHalted(t: string, o?: any) {
        return store.isHalted(t, o);
      },
    };
    void writer;
    await expect(
      setGovernedHalt({
        doSql,
        writer: failingWriteStore,
        tenantId: "primary",
        state: "clear",
        setBy: "tester",
        reason: "test clear",
        nowMs: 6000,
      }),
    ).rejects.toThrow(/mirror unavailable/);
    expect(doSql.value).toBe("off");
    expect(await store.isHalted("primary")).toBe(true);
  });

  it("SET then CLEAR round-trips DO value and mirror state", async () => {
    const doSql = makeDoSql(null);
    const store = new InMemoryGovernanceAdapter();
    await setGovernedHalt({
      doSql,
      writer: store,
      tenantId: "primary",
      state: "halted",
      setBy: "tester",
      reason: "set",
      nowMs: 1000,
    });
    expect(doSql.value).toBe("on");
    expect(await store.isHalted("primary")).toBe(true);
    await setGovernedHalt({
      doSql,
      writer: store,
      tenantId: "primary",
      state: "clear",
      setBy: "tester",
      reason: "clear",
      nowMs: 2000,
    });
    expect(doSql.value).toBe("off");
    expect(await store.isHalted("primary")).toBe(false);
  });
});

describe("one-time halt seed (#1548)", () => {
  function makeDoSqlWithKillSwitch(value: string | null): DoSql {
    return {
      exec(query: string, ...args: unknown[]) {
        if (query.includes("mas_settings") && args[0] === "adaptation.killSwitch") {
          return value === null ? [] : [{ value }];
        }
        return [];
      },
    };
  }

  it("seeds current halted state, second run is a no-op, DO untouched", async () => {
    const store = new InMemoryGovernanceAdapter();
    const writes: unknown[][] = [];
    const doSql: DoSql = {
      exec(query: string, ...args: unknown[]) {
        if (query.startsWith("INSERT") || query.startsWith("DELETE")) {
          writes.push([query, ...args]);
        }
        if (args[0] === "adaptation.killSwitch") return [{ value: "on" }];
        return [];
      },
    };
    const first = await seedGovernanceHalt({
      doSql,
      writer: store,
      tenantId: "primary",
      setBy: "seed:cutover",
      nowMs: 7000,
    });
    expect(first).toMatchObject({ seeded: true, state: "halted" });
    expect(await store.isHalted("primary")).toBe(true);
    const second = await seedGovernanceHalt({
      doSql,
      writer: store,
      tenantId: "primary",
      setBy: "seed:cutover",
      nowMs: 8000,
    });
    expect(second).toMatchObject({ seeded: false });
    expect(writes).toHaveLength(0);
  });

  it("seeds clear when no kill switch is set", async () => {
    const store = new InMemoryGovernanceAdapter();
    const result = await seedGovernanceHalt({
      doSql: makeDoSqlWithKillSwitch(null),
      writer: store,
      tenantId: "primary",
      setBy: "seed:cutover",
      nowMs: 7000,
    });
    expect(result).toMatchObject({ seeded: true, state: "clear" });
    expect(await store.isHalted("primary")).toBe(false);
  });
});

describe("port purity (#1548, R1)", () => {
  it("port and setter modules never import drizzle-orm or a D1 client", () => {
    for (const file of ["governancePorts.ts", "governedHalt.ts"]) {
      const text = readFileSync(
        resolve(__dirname, "../src/data", file),
        "utf8",
      );
      expect(text).not.toMatch(/drizzle-orm/);
      expect(text).not.toMatch(/D1Database/);
      expect(text).not.toMatch(/env\.AGENT_DB/);
    }
  });

  it("domain modules never import drizzle-orm", () => {
    for (const file of [
      "../src/agentic/chainGovernance.ts",
      "../src/agentic/chainFiring.ts",
    ]) {
      const text = readFileSync(resolve(__dirname, file), "utf8");
      expect(text).not.toMatch(/drizzle-orm/);
    }
  });

  it("no projection writer accepts a session or credential row", () => {
    const text = readFileSync(
      resolve(__dirname, "../src/data/governancePorts.ts"),
      "utf8",
    );
    expect(text).not.toMatch(/session|credential/i);
  });
});
