// @vitest-environment node
/**
 * Issue #1651 ([AGENTIC] Slice 1, chains + schedules projection,
 * sub-issue of the #1546 AgentDB program) — TDD red-first.
 *
 * The port/dialect suite runs UNCHANGED against the Drizzle D1
 * adapter (over a MockD1Database backed by node:sqlite) and the
 * in-memory adapter. Pinned contracts:
 *  - Migration 0002 owns the agent_chains and
 *    agent_synthesized_schedules DDL; the Drizzle schema maps it.
 *  - Every row carries tenant/workspace/chain/version/timestamps
 *    and provenance (writer, source DO, source version).
 *  - Upserts keyed by (tenant_id, chain_id, version) / record id
 *    are idempotent: replaying the same version is a no-op.
 *  - Tenancy is enforced at the repository boundary: no unscoped
 *    read exists; cross-tenant reads return nothing.
 *  - A projection failure never fails the transition: the
 *    projection helper records it and returns, never throws; the
 *    reconciliation function then converges DO state to the
 *    projection.
 *  - No projection writer accepts a session or credential row;
 *    port modules never import a store client; domain modules
 *    never import drizzle-orm.
 */
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import {
  createD1ChainScheduleDb,
  D1ChainScheduleAdapter,
  ensureChainScheduleSchema,
} from "../src/data/d1ChainScheduleAdapter";
import { InMemoryChainScheduleAdapter } from "../src/data/inMemoryChainScheduleAdapter";
import {
  MIGRATION_0002_AGENT_CHAINS_SCHEDULES,
  applyMigrations,
} from "../src/data/migrationRunner";
import {
  agentChains,
  agentSynthesizedSchedules,
} from "../src/data/drizzleSchema";
import type {
  ChainRow,
  ChainScheduleStore,
  ScheduleRow,
} from "../src/data/chainSchedulePorts";
import {
  chainRowFromRecord,
  projectTransition,
  reconcileChainSchedules,
  scheduleRowFromRecord,
  type DoScheduleRecord,
} from "../src/data/chainScheduleProjection";
import {
  handleChainStatusRoute,
  handleReconcileChainsRoute,
} from "../src/data/chainStatusRoute";

/** Minimal D1Database stand-in over node:sqlite (test-only, same as slice 0). */
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

async function makeD1Store(): Promise<ChainScheduleStore> {
  const mock = new MockD1Database();
  const db = createD1ChainScheduleDb(mock as any);
  await ensureChainScheduleSchema(db);
  return new D1ChainScheduleAdapter(db);
}

function chainRow(overrides: Partial<ChainRow> & { chainId: string }): ChainRow {
  return {
    tenantId: "primary",
    workspaceId: "primary",
    version: 1,
    status: "pending",
    goal: "test goal",
    stepsJson: "[]",
    createdAtMs: 1000,
    updatedAtMs: 1000,
    provenanceWriter: "test",
    provenanceSourceDo: "ScheduledAgent",
    provenanceSourceVersion: "1",
    ...overrides,
  };
}

function scheduleRow(
  overrides: Partial<ScheduleRow> & { scheduleId: string },
): ScheduleRow {
  return {
    tenantId: "primary",
    workspaceId: "primary",
    chainId: overrides.scheduleId,
    version: 1,
    status: "pending",
    kind: "one-shot",
    cron: null,
    createdAtMs: 1000,
    updatedAtMs: 1000,
    provenanceWriter: "test",
    provenanceSourceDo: "ScheduledAgent",
    provenanceSourceVersion: "1",
    ...overrides,
  };
}

function doRecord(
  overrides: Partial<DoScheduleRecord> & { id: string },
): DoScheduleRecord {
  return {
    goal: "test goal",
    kind: "one-shot",
    steps: [{ capabilityId: "feed-dataprovider", stage: "feed", args: {} }],
    cron: null,
    status: "pending",
    createdAt: new Date(1000).toISOString(),
    ...overrides,
  };
}

describe("chain/schedule port / dialect suite (#1651)", () => {
  const factories: Array<{
    name: string;
    make: () => Promise<ChainScheduleStore>;
  }> = [
    { name: "d1", make: makeD1Store },
    {
      name: "in-memory",
      make: async () => new InMemoryChainScheduleAdapter(),
    },
  ];

  for (const factory of factories) {
    describe(`adapter: ${factory.name}`, () => {
      it("no rows → latest reads are null", async () => {
        const store = await factory.make();
        expect(await store.latestChain("primary", "chain-1")).toBeNull();
        expect(await store.latestSchedule("primary", "chain-1")).toBeNull();
      });

      it("latest version wins regardless of insert order", async () => {
        const store = await factory.make();
        await store.recordChain(
          chainRow({ chainId: "c1", version: 2, status: "approved" }),
        );
        await store.recordChain(
          chainRow({ chainId: "c1", version: 1, status: "pending" }),
        );
        const latest = await store.latestChain("primary", "c1");
        expect(latest?.status).toBe("approved");
        expect(latest?.version).toBe(2);
      });

      it("replaying the same (tenant, chain, version) is a no-op", async () => {
        const store = await factory.make();
        await store.recordChain(
          chainRow({ chainId: "c1", version: 1, status: "pending" }),
        );
        await store.recordChain(
          chainRow({ chainId: "c1", version: 1, status: "approved" }),
        );
        const latest = await store.latestChain("primary", "c1");
        expect(latest?.status).toBe("pending");
        await store.recordSchedule(
          scheduleRow({ scheduleId: "c1", version: 1, status: "pending" }),
        );
        await store.recordSchedule(
          scheduleRow({ scheduleId: "c1", version: 1, status: "killed" }),
        );
        expect((await store.latestSchedule("primary", "c1"))?.status).toBe(
          "pending",
        );
      });

      it("tenant isolation: one tenant's rows are invisible to another", async () => {
        const store = await factory.make();
        await store.recordChain(
          chainRow({ chainId: "c1", tenantId: "tenant-a", status: "approved" }),
        );
        await store.recordSchedule(
          scheduleRow({ scheduleId: "c1", tenantId: "tenant-a" }),
        );
        expect(await store.latestChain("tenant-b", "c1")).toBeNull();
        expect(await store.latestSchedule("tenant-b", "c1")).toBeNull();
        expect(await store.latestChain("primary", "c1")).toBeNull();
      });

      it("chain and schedule rows are independent projections", async () => {
        const store = await factory.make();
        await store.recordChain(
          chainRow({ chainId: "c1", version: 1, status: "approved" }),
        );
        expect(await store.latestSchedule("primary", "c1")).toBeNull();
      });
    });
  }
});

describe("migration 0002 (#1651)", () => {
  it("applies once, records _migrations, second apply is a no-op", async () => {
    const mock = new MockD1Database();
    const db = createD1ChainScheduleDb(mock as any);
    await applyMigrations(db, [MIGRATION_0002_AGENT_CHAINS_SCHEDULES]);
    await applyMigrations(db, [MIGRATION_0002_AGENT_CHAINS_SCHEDULES]);
    const rows = mock.sqlite
      .prepare("SELECT version, name FROM _migrations ORDER BY version")
      .all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ version: 2 });
    for (const table of ["agent_chains", "agent_synthesized_schedules"]) {
      const found = mock.sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
        )
        .all(table);
      expect(found).toHaveLength(1);
    }
  });

  it("migration DDL and Drizzle schema agree on columns for both tables", () => {
    const pairs: Array<[string, unknown, string]> = [
      ["agent_chains", agentChains, MIGRATION_0002_AGENT_CHAINS_SCHEDULES.sql],
      [
        "agent_synthesized_schedules",
        agentSynthesizedSchedules,
        MIGRATION_0002_AGENT_CHAINS_SCHEDULES.sql,
      ],
    ];
    for (const [table, schema, sqlText] of pairs) {
      const rawColumns = getTableConfig(schema as any).columns as any;
      const schemaColumns = Array.isArray(rawColumns)
        ? rawColumns.map((c: any) => c.name as string)
        : Object.keys(rawColumns).map((s) =>
            s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`),
          );
      const block = (sqlText as string)
        .split(`CREATE TABLE IF NOT EXISTS ${table} (`)[1]
        .split("\n);")[0];
      const ddlColumns = [...block.matchAll(/^\s{2}(\w+) /gm)].map((m) => m[1]);
      expect(ddlColumns.sort()).toEqual(schemaColumns.sort());
    }
  });
});

describe("projection transitions (#1651, R5)", () => {
  it("synthesize → approve → kill advances latest rows in both tables", async () => {
    const store = new InMemoryChainScheduleAdapter();
    const base = {
      store,
      tenantId: "primary",
      workspaceId: "primary",
    };
    await projectTransition({
      ...base,
      record: doRecord({ id: "c1", status: "pending" }),
      transition: "synthesize",
      nowMs: 1000,
    });
    await projectTransition({
      ...base,
      record: doRecord({ id: "c1", status: "approved" }),
      transition: "approve",
      nowMs: 2000,
    });
    await projectTransition({
      ...base,
      record: doRecord({ id: "c1", status: "killed" }),
      transition: "kill",
      nowMs: 3000,
    });
    expect((await store.latestChain("primary", "c1"))?.status).toBe("killed");
    expect((await store.latestChain("primary", "c1"))?.version).toBe(3);
    expect((await store.latestSchedule("primary", "c1"))?.status).toBe("killed");
    expect((await store.latestSchedule("primary", "c1"))?.version).toBe(3);
  });

  it("re-projecting an already-projected transition is a no-op", async () => {
    const store = new InMemoryChainScheduleAdapter();
    const input = {
      store,
      tenantId: "primary",
      workspaceId: "primary",
      record: doRecord({ id: "c1", status: "approved" }),
      transition: "approve" as const,
      nowMs: 2000,
    };
    const first = await projectTransition(input);
    const second = await projectTransition(input);
    expect(first.projected).toBe(true);
    expect(second.projected).toBe(true);
    expect(second.skipped).toBe(true);
    expect((await store.latestChain("primary", "c1"))?.version).toBe(1);
  });

  it("a projection failure never throws and never reports projected", async () => {
    const throwing: ChainScheduleStore = {
      async recordChain() {
        throw new Error("D1 unavailable");
      },
      async recordSchedule() {
        throw new Error("D1 unavailable");
      },
      async latestChain() {
        return null;
      },
      async latestSchedule() {
        return null;
      },
    };
    const result = await projectTransition({
      store: throwing,
      tenantId: "primary",
      workspaceId: "primary",
      record: doRecord({ id: "c1" }),
      transition: "synthesize",
      nowMs: 1000,
    });
    expect(result.projected).toBe(false);
    expect(result.error).toMatch(/D1 unavailable/);
  });

  it("row mappers carry tenant, workspace, chain, version, timestamps, provenance", async () => {
    const record = doRecord({ id: "c1", status: "approved" });
    const chain = chainRowFromRecord(record, {
      tenantId: "primary",
      workspaceId: "primary",
      version: 2,
      nowMs: 2000,
      writer: "scheduled-agent:approveSynthesizedSchedule",
    });
    expect(chain).toMatchObject({
      tenantId: "primary",
      workspaceId: "primary",
      chainId: "c1",
      version: 2,
      status: "approved",
      goal: "test goal",
      provenanceWriter: "scheduled-agent:approveSynthesizedSchedule",
      provenanceSourceDo: "ScheduledAgent",
    });
    expect(chain.createdAtMs).toBe(1000);
    expect(chain.updatedAtMs).toBe(2000);
    const schedule = scheduleRowFromRecord(record, {
      tenantId: "primary",
      workspaceId: "primary",
      version: 2,
      nowMs: 2000,
      writer: "scheduled-agent:approveSynthesizedSchedule",
    });
    expect(schedule).toMatchObject({
      scheduleId: "c1",
      chainId: "c1",
      status: "approved",
      kind: "one-shot",
      cron: null,
    });
  });
});

describe("reconciliation (#1651, R5)", () => {
  it("re-projects missing rows and stale statuses; leaves current rows alone", async () => {
    const store = new InMemoryChainScheduleAdapter();
    await store.recordChain(
      chainRow({ chainId: "stale", version: 1, status: "pending" }),
    );
    await store.recordSchedule(
      scheduleRow({ scheduleId: "stale", version: 1, status: "pending" }),
    );
    await store.recordChain(
      chainRow({ chainId: "current", version: 1, status: "approved" }),
    );
    await store.recordSchedule(
      scheduleRow({ scheduleId: "current", version: 1, status: "approved" }),
    );
    const report = await reconcileChainSchedules({
      store,
      tenantId: "primary",
      workspaceId: "primary",
      nowMs: 9000,
      records: [
        doRecord({ id: "missing", status: "pending" }),
        doRecord({ id: "stale", status: "killed" }),
        doRecord({ id: "current", status: "approved" }),
      ],
    });
    expect(report).toMatchObject({
      checked: 3,
      reconciled: 2,
      alreadyCurrent: 1,
    });
    expect((await store.latestChain("primary", "missing"))?.status).toBe(
      "pending",
    );
    expect((await store.latestChain("primary", "stale"))?.status).toBe("killed");
    expect((await store.latestChain("primary", "stale"))?.version).toBe(2);
    expect((await store.latestChain("primary", "current"))?.version).toBe(1);
  });

  it("a failing record is reported, not thrown, and other records still reconcile", async () => {
    const inner = new InMemoryChainScheduleAdapter();
    const failing: ChainScheduleStore = {
      async recordChain(row) {
        if (row.chainId === "bad") throw new Error("write failed");
        return inner.recordChain(row);
      },
      async recordSchedule(row) {
        if (row.chainId === "bad") throw new Error("write failed");
        return inner.recordSchedule(row);
      },
      latestChain: (t, c) => inner.latestChain(t, c),
      latestSchedule: (t, c) => inner.latestSchedule(t, c),
    };
    const report = await reconcileChainSchedules({
      store: failing,
      tenantId: "primary",
      workspaceId: "primary",
      nowMs: 9000,
      records: [
        doRecord({ id: "bad", status: "pending" }),
        doRecord({ id: "good", status: "pending" }),
      ],
    });
    expect(report.reconciled).toBe(1);
    expect(report.errors).toHaveLength(1);
    expect((await inner.latestChain("primary", "good"))?.status).toBe("pending");
  });
});

describe("chain-status route (#1651)", () => {
  const adminSession = { githubLogin: "operator", internalUserId: "user-1" };

  it("refuses unauthenticated callers with 401 and reads nothing", async () => {
    let reads = 0;
    const res = await handleChainStatusRoute({
      session: null,
      method: "GET",
      tenantId: "primary",
      chainId: "c1",
      readStatus: async () => {
        reads += 1;
        return { chain: null, schedule: null };
      },
    });
    expect(res.status).toBe(401);
    expect(reads).toBe(0);
  });

  it("refuses non-GET methods with 405 and requires a chain id", async () => {
    const res = await handleChainStatusRoute({
      session: adminSession,
      method: "POST",
      tenantId: "primary",
      chainId: "c1",
      readStatus: async () => ({ chain: null, schedule: null }),
    });
    expect(res.status).toBe(405);
    const missing = await handleChainStatusRoute({
      session: adminSession,
      method: "GET",
      tenantId: "primary",
      chainId: "",
      readStatus: async () => ({ chain: null, schedule: null }),
    });
    expect(missing.status).toBe(400);
  });

  it("returns the tenant-scoped latest chain + schedule status, projection only", async () => {
    const store = new InMemoryChainScheduleAdapter();
    await store.recordChain(
      chainRow({ chainId: "c1", version: 2, status: "approved" }),
    );
    await store.recordSchedule(
      scheduleRow({ scheduleId: "c1", version: 2, status: "approved" }),
    );
    const res = await handleChainStatusRoute({
      session: adminSession,
      method: "GET",
      tenantId: "primary",
      chainId: "c1",
      readStatus: async ({ tenantId, chainId }) => ({
        chain: await store.latestChain(tenantId, chainId),
        schedule: await store.latestSchedule(tenantId, chainId),
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.chain).toMatchObject({ chainId: "c1", status: "approved" });
    expect(body.schedule).toMatchObject({ status: "approved" });
    expect(body.projected).toBe(true);
  });

  it("a tenant with no rows sees projected:false and no other tenant's data", async () => {
    const store = new InMemoryChainScheduleAdapter();
    await store.recordChain(
      chainRow({ chainId: "c1", tenantId: "tenant-a", status: "approved" }),
    );
    const res = await handleChainStatusRoute({
      session: adminSession,
      method: "GET",
      tenantId: "tenant-b",
      chainId: "c1",
      readStatus: async ({ tenantId, chainId }) => ({
        chain: await store.latestChain(tenantId, chainId),
        schedule: await store.latestSchedule(tenantId, chainId),
      }),
    });
    const body = (await res.json()) as any;
    expect(body.projected).toBe(false);
    expect(body.chain).toBeNull();
  });
});

describe("reconcile route (#1651)", () => {
  const adminSession = { githubLogin: "operator", internalUserId: "user-1" };

  it("refuses unauthenticated, non-admin, and non-POST callers without reconciling", async () => {
    let calls = 0;
    const deps = {
      method: "POST",
      isPlatformAdmin: false,
      tenantId: "primary",
      runReconcile: async () => {
        calls += 1;
        return { checked: 0, reconciled: 0, alreadyCurrent: 0, errors: [] };
      },
    };
    expect(
      (
        await handleReconcileChainsRoute({
          ...deps,
          session: null,
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await handleReconcileChainsRoute({
          ...deps,
          session: adminSession,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await handleReconcileChainsRoute({
          ...deps,
          session: adminSession,
          isPlatformAdmin: true,
          method: "GET",
        })
      ).status,
    ).toBe(405);
    expect(calls).toBe(0);
  });

  it("platform-admin POST runs reconciliation and returns its report", async () => {
    const res = await handleReconcileChainsRoute({
      session: adminSession,
      method: "POST",
      isPlatformAdmin: true,
      tenantId: "primary",
      runReconcile: async () => ({
        checked: 2,
        reconciled: 1,
        alreadyCurrent: 1,
        errors: [],
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ checked: 2, reconciled: 1 });
  });
});

describe("port purity (#1651, R1/R9)", () => {
  it("port and projection modules never import a store client or write SQL", () => {
    for (const file of ["chainSchedulePorts.ts", "chainScheduleProjection.ts"]) {
      const text = readFileSync(
        resolve(__dirname, "../src/data", file),
        "utf8",
      );
      expect(text).not.toMatch(/drizzle-orm/);
      expect(text).not.toMatch(/D1Database/);
      expect(text).not.toMatch(/env\.AGENT_DB/);
      expect(text).not.toMatch(/SELECT|INSERT INTO/);
    }
  });

  it("no projection writer accepts a session or credential row", () => {
    const text = readFileSync(
      resolve(__dirname, "../src/data/chainSchedulePorts.ts"),
      "utf8",
    );
    expect(text).not.toMatch(/session|credential/i);
  });

  it("domain modules never import drizzle-orm", () => {
    // scheduled-agent.ts legitimately passes its own env to the
    // composition root (the slice-0 readAgentDbHalt pattern); the
    // pin is that it never imports the ORM itself.
    for (const file of [
      "../src/agents/scheduled-agent.ts",
      "../src/agentic/jobSynthesis.ts",
      "../src/agentic/chainGovernance.ts",
    ]) {
      const text = readFileSync(resolve(__dirname, file), "utf8");
      expect(text).not.toMatch(/drizzle-orm/);
    }
    for (const file of [
      "../src/agentic/jobSynthesis.ts",
      "../src/agentic/chainGovernance.ts",
    ]) {
      const text = readFileSync(resolve(__dirname, file), "utf8");
      expect(text).not.toMatch(/env\.AGENT_DB/);
    }
  });
});
