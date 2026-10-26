// @vitest-environment node
/**
 * Issue #1701 ([AGENTIC] Slice 6, retention enforcement,
 * sub-issue of the #1546 AgentDB program) — TDD red-first.
 *
 * The port/dialect suite runs UNCHANGED against the Drizzle D1
 * adapter (over a MockD1Database backed by node:sqlite) and the
 * in-memory adapter. Pinned contracts:
 *  - The purge touches ONLY agent_shard_jobs, the one
 *    declared-BOUNDED AgentDB table (storageRetention.ts);
 *    KEEP tables (chains, schedules, audit, reports,
 *    governance) are unreachable from the purge path, and no
 *    session/credential material is anywhere near it.
 *  - Age phase: rows with created_at_ms strictly older than
 *    now - 30d, oldest first, batch-capped, per-run capped.
 *    All versions of a job share createdAtMs (first
 *    projection time), so an expired job purges whole.
 *  - Cap phase: after the age phase, a tenant holding more
 *    than 500 shard-job rows is trimmed oldest-first to 500,
 *    mirroring the mas_async_jobs 500-row terminal cap.
 *  - Repeated purge is a no-op; window <= 0 skips everything.
 *  - Route decision order 401 → 405 → 403 (unwired) →
 *    403 (non-admin) → 200 report / 500 failure; unbound
 *    store is answered 503 by the server wiring, not here.
 *  - Governed job: halted → skipped without purging; a store
 *    failure is logged and returned, never thrown into a
 *    firing path.
 *  - Port modules never import a store client; domain modules
 *    never import drizzle-orm or reference env.AGENT_DB.
 */
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { API_ENDPOINT_CATALOG } from "../src/client/iaaaEndpointCatalog";
import {
  createD1ShardJobDb,
  D1ShardJobAdapter,
  ensureShardJobSchema,
} from "../src/data/d1ShardJobAdapter";
import { InMemoryShardJobAdapter } from "../src/data/inMemoryShardJobAdapter";
import type { ShardJobRow } from "../src/data/shardJobPorts";
import {
  RETENTION_PURGE_TABLES,
  RETENTION_SHARD_JOB_CAP_ROWS,
  RETENTION_SHARD_JOB_WINDOW_DAYS,
  type RetentionPurgeStore,
} from "../src/data/retentionPorts";
import {
  RETENTION_PURGE_JOB,
  runRetentionPurge,
  runRetentionPurgeJob,
} from "../src/data/retentionPurge";
import { handleRetentionPurgeRoute } from "../src/data/retentionRoute";
import {
  createRetentionPurgeStore,
  runRetentionPurgeForTenant,
} from "../src/data/createRetentionPorts";

const HERE = dirname(fileURLToPath(import.meta.url));
const src = (p: string) => readFileSync(join(HERE, "..", "src", p), "utf8");

/** Minimal D1Database stand-in over node:sqlite (test-only, same as slices 0–2). */
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

async function makeD1PurgeStore(): Promise<RetentionPurgeStore> {
  const mock = new MockD1Database();
  const db = createD1ShardJobDb(mock as any);
  await ensureShardJobSchema(db);
  return new D1ShardJobAdapter(db);
}

function makeMemoryPurgeStore(): RetentionPurgeStore {
  return new InMemoryShardJobAdapter();
}

function jobRow(over: Partial<ShardJobRow> & { jobKey: string }): ShardJobRow {
  return {
    tenantId: "primary",
    workspaceId: "ws",
    chainId: "chain-1",
    version: 1,
    status: "completed",
    stage: "serve",
    capabilityId: "cap.serve",
    detail: "done",
    resultJson: "{}",
    createdAtMs: 1_000_000,
    updatedAtMs: 1_000_000,
    provenanceWriter: "test",
    provenanceSourceDo: "ScheduledAgent",
    provenanceSourceVersion: "1",
    ...over,
  };
}

async function seed(store: RetentionPurgeStore, rows: ShardJobRow[]) {
  const writer = store as unknown as {
    recordJob: (r: ShardJobRow) => Promise<void>;
  };
  for (const row of rows) await writer.recordJob(row);
}

async function countFor(
  store: RetentionPurgeStore,
  tenantId: string,
): Promise<number> {
  return store.countShardJobs(tenantId);
}

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;

describe("retention purge (port/dialect suite, both adapters)", () => {
  const factories: Array<[string, () => Promise<RetentionPurgeStore>]> = [
    ["d1", makeD1PurgeStore],
    ["memory", async () => makeMemoryPurgeStore()],
  ];

  for (const [name, make] of factories) {
    describe(name, () => {
      it("purges rows strictly older than 30d, keeps fresh rows and the cutoff row", async () => {
        const store = await make();
        await seed(store, [
          jobRow({ jobKey: "old", createdAtMs: NOW - 31 * DAY, updatedAtMs: NOW - 31 * DAY }),
          jobRow({ jobKey: "fresh", createdAtMs: NOW - 29 * DAY, updatedAtMs: NOW - 29 * DAY }),
          jobRow({ jobKey: "cutoff", createdAtMs: NOW - 30 * DAY, updatedAtMs: NOW - 30 * DAY }),
        ]);
        const report = await runRetentionPurge(store, "primary", { nowMs: NOW });
        expect(report.table).toBe("agent_shard_jobs");
        expect(report.agedPruned).toBe(1);
        expect(report.pruned).toBe(1);
        expect(report.capped).toBe(false);
        expect(report.skipped).toBe(false);
        expect(await countFor(store, "primary")).toBe(2);
        const aged = await store.listAgedShardJobKeys("primary", NOW - 30 * DAY, 10);
        expect(aged).toEqual([]);
      });

      it("purges a whole job at once: versions share createdAtMs", async () => {
        const store = await make();
        await seed(store, [
          jobRow({ jobKey: "old-job", version: 1, createdAtMs: NOW - 40 * DAY, updatedAtMs: NOW - 40 * DAY }),
          jobRow({ jobKey: "old-job", version: 2, createdAtMs: NOW - 40 * DAY, updatedAtMs: NOW - 35 * DAY }),
          jobRow({ jobKey: "live-job", version: 1, createdAtMs: NOW - 5 * DAY, updatedAtMs: NOW - 40 * DAY }),
        ]);
        const report = await runRetentionPurge(store, "primary", { nowMs: NOW });
        expect(report.agedPruned).toBe(2);
        expect(await countFor(store, "primary")).toBe(1);
      });

      it("never touches another tenant's rows (cross-tenant negative)", async () => {
        const store = await make();
        await seed(store, [
          jobRow({ jobKey: "old-a", createdAtMs: NOW - 40 * DAY, updatedAtMs: NOW - 40 * DAY }),
          jobRow({ tenantId: "other", jobKey: "old-b", createdAtMs: NOW - 40 * DAY, updatedAtMs: NOW - 40 * DAY }),
        ]);
        await runRetentionPurge(store, "primary", { nowMs: NOW });
        expect(await countFor(store, "primary")).toBe(0);
        expect(await countFor(store, "other")).toBe(1);
      });

      it("trims beyond the 500-row tenant cap oldest-first, after the age phase", async () => {
        const store = await make();
        const rows: ShardJobRow[] = [];
        for (let i = 0; i < RETENTION_SHARD_JOB_CAP_ROWS + 5; i++) {
          rows.push(
            jobRow({
              jobKey: `job-${i}`,
              createdAtMs: NOW - 1000 - i,
              updatedAtMs: NOW - 1000 - i,
            }),
          );
        }
        await seed(store, rows);
        const report = await runRetentionPurge(store, "primary", { nowMs: NOW });
        expect(report.agedPruned).toBe(0);
        expect(report.capPruned).toBe(5);
        expect(await countFor(store, "primary")).toBe(
          RETENTION_SHARD_JOB_CAP_ROWS,
        );
        // job-i ages with i (createdAtMs NOW-1000-i): the five
        // oldest are job-504..job-500, so job-499 is oldest left.
        const oldest = await store.listOldestShardJobKeys("primary", 1);
        expect(oldest[0].jobKey).toBe("job-499");
      });

      it("is idempotent: a second run prunes nothing", async () => {
        const store = await make();
        await seed(store, [
          jobRow({ jobKey: "old", createdAtMs: NOW - 40 * DAY, updatedAtMs: NOW - 40 * DAY }),
        ]);
        await runRetentionPurge(store, "primary", { nowMs: NOW });
        const second = await runRetentionPurge(store, "primary", { nowMs: NOW });
        expect(second.pruned).toBe(0);
        expect(second.capped).toBe(false);
      });

      it("honors small batches across rounds and the per-run cap", async () => {
        const store = await make();
        const rows: ShardJobRow[] = [];
        for (let i = 0; i < 5; i++) {
          rows.push(
            jobRow({ jobKey: `old-${i}`, createdAtMs: NOW - 40 * DAY, updatedAtMs: NOW - 40 * DAY }),
          );
        }
        await seed(store, rows);
        const capped = await runRetentionPurge(store, "primary", {
          nowMs: NOW,
          batchSize: 2,
          maxPerRun: 3,
        });
        expect(capped.pruned).toBe(3);
        expect(capped.capped).toBe(true);
        const rest = await runRetentionPurge(store, "primary", {
          nowMs: NOW,
          batchSize: 2,
        });
        expect(rest.pruned).toBe(2);
        expect(await countFor(store, "primary")).toBe(0);
      });

      it("skips everything when the window is disabled", async () => {
        const store = await make();
        await seed(store, [
          jobRow({ jobKey: "old", createdAtMs: NOW - 40 * DAY, updatedAtMs: NOW - 40 * DAY }),
        ]);
        const report = await runRetentionPurge(store, "primary", {
          nowMs: NOW,
          windowDays: 0,
        });
        expect(report.skipped).toBe(true);
        expect(report.pruned).toBe(0);
        expect(await countFor(store, "primary")).toBe(1);
      });
    });
  }
});

describe("retention purge pins", () => {
  it("allowlist is exactly the declared-BOUNDED AgentDB table", () => {
    expect(RETENTION_PURGE_TABLES).toEqual(["agent_shard_jobs"]);
    expect(RETENTION_SHARD_JOB_WINDOW_DAYS).toBe(30);
    expect(RETENTION_SHARD_JOB_CAP_ROWS).toBe(500);
  });

  it("purge modules never name a KEEP table or a mas_* table", () => {
    for (const mod of [
      "data/retentionPorts.ts",
      "data/retentionPurge.ts",
      "data/retentionRoute.ts",
    ]) {
      const text = src(mod);
      for (const banned of [
        "agent_chains",
        "agent_synthesized_schedules",
        "agent_chain_audit",
        "agent_reports",
        "agent_governance",
        "mas_",
      ]) {
        expect(text, `${mod} names ${banned}`).not.toContain(banned);
      }
    }
  });

  it("port/purge/route modules import no store client and reference no binding", () => {
    for (const mod of [
      "data/retentionPorts.ts",
      "data/retentionPurge.ts",
      "data/retentionRoute.ts",
    ]) {
      const text = src(mod);
      expect(text, `${mod} imports drizzle`).not.toContain("drizzle-orm");
      expect(text, `${mod} references AGENT_DB`).not.toContain("AGENT_DB");
    }
  });

  it("storageRetention.ts declares the governance line and the shard-jobs bound", () => {
    const text = src("security/storageRetention.ts");
    expect(text).toMatch(/agent_governance.*KEEP/s);
    expect(text).toMatch(/agent_shard_jobs.*BOUNDED/s);
  });

  it("catalog carries the retention-purge route as platform-admin", () => {
    const entry = API_ENDPOINT_CATALOG.find(
      (e) => e.method === "POST" && e.path === "/api/retention/purge",
    );
    expect(entry).toBeDefined();
    expect(entry!.auth).toBe("platform-admin");
    expect(entry!.source).toBe(
      "src/server.ts branch: path === /api/retention/purge",
    );
  });

  it("job definition is the nightly mas-pass cadence, governed, not activated", () => {
    expect(RETENTION_PURGE_JOB.id).toBe("agentdb-retention-purge");
    expect(RETENTION_PURGE_JOB.cron).toBe("0 4 * * *");
  });
});

describe("retention purge route decisions", () => {
  const report = {
    table: "agent_shard_jobs" as const,
    tenantId: "primary",
    cutoffMs: NOW - 30 * DAY,
    agedPruned: 2,
    capPruned: 0,
    pruned: 2,
    capped: false,
    skipped: false,
  };
  it("401 without a session, 405 on non-POST", async () => {
    const unauth = await handleRetentionPurgeRoute({
      session: null,
      method: "POST",
      isPlatformAdmin: false,
      tenantId: "primary",
      runPurge: async () => report,
    });
    expect(unauth.status).toBe(401);
    const wrongMethod = await handleRetentionPurgeRoute({
      session: { internalUserId: "u1" },
      method: "GET",
      isPlatformAdmin: true,
      tenantId: "primary",
      runPurge: async () => report,
    });
    expect(wrongMethod.status).toBe(405);
  });

  it("403 for unwired and non-admin sessions, with no data", async () => {
    const unwired = await handleRetentionPurgeRoute({
      session: {},
      method: "POST",
      isPlatformAdmin: false,
      tenantId: "primary",
      runPurge: async () => report,
    });
    expect(unwired.status).toBe(403);
    expect(await unwired.text()).not.toContain("agedPruned");
    const nonAdmin = await handleRetentionPurgeRoute({
      session: { internalUserId: "u1" },
      method: "POST",
      isPlatformAdmin: false,
      tenantId: "primary",
      runPurge: async () => report,
    });
    expect(nonAdmin.status).toBe(403);
  });

  it("200 with the report for an admin, 500 when the purge throws", async () => {
    const ok = await handleRetentionPurgeRoute({
      session: { internalUserId: "u1" },
      method: "POST",
      isPlatformAdmin: true,
      tenantId: "primary",
      runPurge: async () => report,
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ pruned: 2, capped: false });
    const failed = await handleRetentionPurgeRoute({
      session: { internalUserId: "u1" },
      method: "POST",
      isPlatformAdmin: true,
      tenantId: "primary",
      runPurge: async () => {
        throw new Error("store down");
      },
    });
    expect(failed.status).toBe(500);
  });
});

describe("governed retention job", () => {
  it("skips without purging when halted", async () => {
    const store = await makeMemoryPurgeStore();
    await seed(store, [
      jobRow({ jobKey: "old", createdAtMs: NOW - 40 * DAY, updatedAtMs: NOW - 40 * DAY }),
    ]);
    const result = await runRetentionPurgeJob({
      store,
      tenantId: "primary",
      halted: true,
      options: { nowMs: NOW },
    });
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe("halted");
    expect(await countFor(store, "primary")).toBe(1);
  });

  it("purges when not halted, and never throws on store failure", async () => {
    const store = await makeMemoryPurgeStore();
    await seed(store, [
      jobRow({ jobKey: "old", createdAtMs: NOW - 40 * DAY, updatedAtMs: NOW - 40 * DAY }),
    ]);
    const ran = await runRetentionPurgeJob({
      store,
      tenantId: "primary",
      halted: false,
      options: { nowMs: NOW },
    });
    expect(ran.skipped).toBe(false);
    expect(ran.report?.pruned).toBe(1);
    const failing: RetentionPurgeStore = {
      listAgedShardJobKeys: async () => {
        throw new Error("store down");
      },
      listOldestShardJobKeys: async () => [],
      countShardJobs: async () => 0,
      deleteShardJobs: async () => {},
    };
    const failed = await runRetentionPurgeJob({
      store: failing,
      tenantId: "primary",
      halted: false,
      options: { nowMs: NOW },
    });
    expect(failed.error).toBe("store down");
    expect(failed.report).toBeUndefined();
  });
});

describe("retention composition root", () => {
  it("returns null when AgentDB is unbound, never throws", async () => {
    expect(createRetentionPurgeStore({})).toBeNull();
    expect(
      await runRetentionPurgeForTenant({}, "primary", { nowMs: NOW }),
    ).toBeNull();
  });

  it("purges through a bound store", async () => {
    const mock = new MockD1Database();
    const env = { AGENT_DB: mock };
    const adapter = createRetentionPurgeStore(env)!;
    await ensureShardJobSchema(
      createD1ShardJobDb(mock as any),
    );
    await adapter.recordJob(
      jobRow({ jobKey: "old", createdAtMs: NOW - 40 * DAY, updatedAtMs: NOW - 40 * DAY }),
    );
    const report = await runRetentionPurgeForTenant(env, "primary", {
      nowMs: NOW,
    });
    expect(report?.pruned).toBe(1);
  });
});
