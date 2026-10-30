import { describe, expect, it, vi } from "vitest";
import {
  ensureAsyncJobGraphColumns,
  executeAsyncJob,
  submitAsyncJob,
  type AsyncJobsContext,
} from "../src/agents/orchestrator/asyncJobs";
import { DatabaseORM } from "../src/orm";
import {
  createMemoryMembershipStore,
  type MembershipStore,
} from "../src/security/authorization";
import { MockSqlStorage } from "./mock-sql";

// In-memory mas_async_jobs fake, same pattern as the async_job_graph /
// feed-chain harnesses: enough SQL fidelity for the real submit +
// execute path — INSERT/SELECT projection, status-guarded claim
// UPDATE, completion/failure UPDATEs applied to the rows.
class FakeJobSql {
  columns: string[] = [];
  rows: Array<Record<string, unknown>> = [];

  exec(query: string, ...args: unknown[]): { rowsWritten: number } & Iterable<Record<string, unknown>> {
    const q = query.trim().replace(/\s+/g, " ");
    const done = (rows: Array<Record<string, unknown>> = [], rowsWritten = 0) =>
      Object.assign([...rows], { rowsWritten });
    if (/^CREATE TABLE/i.test(q)) {
      this.columns = [
        "job_id", "session_id", "capability", "display_name", "status",
        "payload_json", "result_json", "response_status", "error",
        "created_at", "updated_at", "started_at", "completed_at",
      ];
      return done();
    }
    if (/^PRAGMA table_info/i.test(q)) {
      return Object.assign(this.columns.map((name) => ({ name })), { rowsWritten: 0 });
    }
    const alter = q.match(/^ALTER TABLE mas_async_jobs ADD COLUMN (\w+)/i);
    if (alter) {
      if (!this.columns.includes(alter[1])) this.columns.push(alter[1]);
      return done();
    }
    if (/^CREATE INDEX/i.test(q)) return done();
    if (/^DELETE FROM mas_async_jobs/i.test(q)) return done([], 0);
    if (/^INSERT INTO mas_async_jobs/i.test(q)) {
      const cols = q.match(/\(([^)]+)\)/)![1].split(",").map((c) => c.trim());
      const valuesPart = q.match(/VALUES \(([^)]+)\)/i)![1].split(",").map((c) => c.trim());
      const row: Record<string, unknown> = {};
      let argIndex = 0;
      cols.forEach((col, i) => {
        const token = valuesPart[i];
        row[col] = token === "?" ? (args[argIndex++] ?? null) : token.replace(/^'|'$/g, "");
      });
      this.rows.push(row);
      return done([], 1);
    }
    if (/^UPDATE mas_async_jobs/i.test(q)) {
      const setPart = q.match(/SET (.+?) WHERE/i)![1];
      const assignments = setPart.split(",").map((s) => s.trim());
      let argIndex = 0;
      const updates: Record<string, unknown> = {};
      for (const assignment of assignments) {
        const m = assignment.match(/^(\w+) = (.+)$/)!;
        const [, col, rhs] = m;
        updates[col] = rhs === "?" ? args[argIndex++] : rhs.replace(/^'|'$/g, "");
      }
      const jobId = args[argIndex];
      const row = this.rows.find((r) => r.job_id === jobId);
      if (!row) return done([], 0);
      if (/WHERE .*status = 'queued'/i.test(q) && row.status !== "queued") return done([], 0);
      Object.assign(row, updates);
      return done([], 1);
    }
    if (/^SELECT/i.test(q)) {
      const listMatch = q.match(/SELECT (.+?) FROM mas_async_jobs/i);
      if (!listMatch) return done();
      const cols = listMatch[1].split(",").map((c) => c.trim());
      let rows = [...this.rows];
      if (/WHERE job_id = \?/i.test(q)) rows = rows.filter((r) => r.job_id === args[0]);
      if (/ORDER BY created_at DESC/i.test(q)) {
        rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
      }
      const projected = rows.map((row) => {
        const out: Record<string, unknown> = {};
        for (const col of cols) out[col] = row[col] ?? null;
        return out;
      });
      return done(projected);
    }
    throw new Error(`FakeJobSql: unsupported query: ${q.slice(0, 100)}`);
  }
}

function makeExecutorCtx(
  sql: FakeJobSql,
  opts: { sessionKey?: string; store?: MembershipStore } = {},
): { ctx: AsyncJobsContext; audit: ReturnType<typeof vi.fn>; routeRequest: ReturnType<typeof vi.fn> } {
  const storage = sql as unknown as AsyncJobsContext["agentCtx"]["storage"]["sql"];
  const orm = new DatabaseORM(new MockSqlStorage() as any);
  const audit = vi.fn();
  const routeRequest = vi.fn(async () => new Response("{}"));
  const ctx = {
    env: { SERVICE_USER_LOGIN: "svc-background" },
    agentCtx: { storage: { sql: storage } },
    ensureTables: () => {
      sql.exec("CREATE TABLE IF NOT EXISTS mas_async_jobs (job_id TEXT PRIMARY KEY)");
      ensureAsyncJobGraphColumns(storage);
      return storage;
    },
    sessionKey: () => opts.sessionKey ?? "session-1",
    schedule: vi.fn(async () => ({})),
    audit,
    getOrm: () => orm,
    routeRequest,
    nlqSchedulingPort: () => ({}),
    nlqStockScreenPort: () => ({}),
    followupReportPort: () => ({
      getStockPdf: async () => null,
      getOptionsPdf: async () => null,
    }),
    followupDeliveryPort: () => ({
      deliver: async () => ({ ok: true }),
      notify: async () => ({ ok: true }),
    }),
    serviceMembershipStore: opts.store ?? createMemoryMembershipStore(),
  } as unknown as AsyncJobsContext;
  return { ctx, audit, routeRequest };
}

async function provisionPlatformMember(store: MembershipStore): Promise<void> {
  await store.put({
    membershipId: "m-service-platform",
    internalUserId: "service:svc-background",
    tenantId: "primary",
    roleBindings: [{ role: "member", scope: "platform", grantedBy: "test" }],
    createdBy: "test",
    createdAtMs: 1_700_000_000_000 - 2_000,
  });
}

describe("executeAsyncJob dispatch enforcement (#2331 slice 2)", () => {
  it("denies a service-login job while the service user is unprovisioned", async () => {
    const sql = new FakeJobSql();
    const { ctx, audit } = makeExecutorCtx(sql);
    const submitted = await submitAsyncJob(ctx, {
      capability: "task.draft",
      payload: { title: "unprovisioned service work", userLogin: "svc-background" },
    } as any);
    await executeAsyncJob(ctx, { jobId: submitted.jobId });
    const row = sql.rows.find((r) => r.job_id === submitted.jobId);
    expect(row?.status).toBe("failed");
    expect(String(row?.error)).toMatch(/SERVICE_NOT_PROVISIONED/);
    expect(audit.mock.calls.some(([type]) => type === "async_job.dispatch_denied")).toBe(true);
    const denial = audit.mock.calls.find(([type]) => type === "async_job.dispatch_denied")!;
    expect(denial[2]).toMatchObject({ reason: "SERVICE_NOT_PROVISIONED" });
    expect(audit.mock.calls.some(([type]) => type === "async_job.failed")).toBe(true);
  });

  it("runs a service-login job once the platform tier is provisioned", async () => {
    const sql = new FakeJobSql();
    const store = createMemoryMembershipStore();
    await provisionPlatformMember(store);
    const { ctx } = makeExecutorCtx(sql, { store });
    const submitted = await submitAsyncJob(ctx, {
      capability: "task.draft",
      payload: { title: "provisioned service work", userLogin: "svc-background" },
    } as any);
    await executeAsyncJob(ctx, { jobId: submitted.jobId });
    const row = sql.rows.find((r) => r.job_id === submitted.jobId);
    expect(row?.status).toBe("completed");
  });

  it("runs an owner-login job unchanged", async () => {
    const sql = new FakeJobSql();
    const { ctx } = makeExecutorCtx(sql);
    const submitted = await submitAsyncJob(ctx, {
      capability: "task.draft",
      payload: { title: "owner work", userLogin: "alice" },
    } as any);
    await executeAsyncJob(ctx, { jobId: submitted.jobId });
    const row = sql.rows.find((r) => r.job_id === submitted.jobId);
    expect(row?.status).toBe("completed");
  });

  it("denies a job with no identity whose instance is the shared address", async () => {
    const sql = new FakeJobSql();
    const { ctx, audit } = makeExecutorCtx(sql, { sessionKey: "default_trader" });
    const submitted = await submitAsyncJob(ctx, {
      capability: "task.draft",
      payload: { title: "address, not identity" },
    } as any);
    await executeAsyncJob(ctx, { jobId: submitted.jobId });
    const row = sql.rows.find((r) => r.job_id === submitted.jobId);
    expect(row?.status).toBe("failed");
    expect(String(row?.error)).toMatch(/SHARED_ADDRESS/);
    expect(audit.mock.calls.some(([type]) => type === "async_job.dispatch_denied")).toBe(true);
  });

  it("denies a service actingLogin stamp while unprovisioned", async () => {
    const sql = new FakeJobSql();
    const { ctx } = makeExecutorCtx(sql);
    const submitted = await submitAsyncJob(ctx, {
      capability: "mcp.tool",
      payload: { toolName: "list_scheduled_goals", arguments: {}, actingLogin: "svc-background" },
    } as any);
    await executeAsyncJob(ctx, { jobId: submitted.jobId });
    const row = sql.rows.find((r) => r.job_id === submitted.jobId);
    expect(row?.status).toBe("failed");
    expect(String(row?.error)).toMatch(/SERVICE_NOT_PROVISIONED/);
  });

  it("denies a service http.request job before it reaches routeRequest", async () => {
    const sql = new FakeJobSql();
    const { ctx, routeRequest } = makeExecutorCtx(sql);
    const submitted = await submitAsyncJob(ctx, {
      capability: "http.request",
      payload: {
        pathAndQuery: "/api/internal",
        method: "GET",
        headers: { "x-user-login": "svc-background" },
      },
    } as any);
    await executeAsyncJob(ctx, { jobId: submitted.jobId });
    const row = sql.rows.find((r) => r.job_id === submitted.jobId);
    expect(row?.status).toBe("failed");
    expect(String(row?.error)).toMatch(/SERVICE_NOT_PROVISIONED/);
    expect(routeRequest).not.toHaveBeenCalled();
  });
});
