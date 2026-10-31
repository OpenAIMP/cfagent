/**
 * Issue #2341 (Agent Mesh S5, programme #2225 G1 batch A): typed
 * outbound doors from the orchestrator chat turn to ScheduledAgent
 * and PaymentsAgent.
 *
 * Pins, at the binding seam (fake DO namespaces — the door itself is
 * never mocked away):
 * - dispatch reaches the right instance ("default" for both agents,
 *   the instance production callers use) with the acting identity
 *   intact;
 * - no acting identity (absent, blank, or the retired "default"
 *   literal) fails closed BEFORE any stub is resolved or called;
 * - the budget check is evaluated against the ledger's orchestrator
 *   spend bucket (AGENTIC_SPEND_AGENT_ID) and a guard denial
 *   propagates with its reason;
 * - a trigger returns ScheduledAgent's real tick outcome (a
 *   budget-denied tick surfaces as errors, never as success);
 * - the four turn commands are registered in McpToolFactory and each
 *   declares exactly one scope (#1744);
 * - the turn adapter stamps the acting identity into the queued job
 *   payload server-side, and the async-job executor threads it back
 *   into the tool context — the full queue -> executor -> door path.
 */
import { describe, expect, it, vi } from "vitest";
import {
  MeshDoorError,
  listScheduledGoalsViaDoor,
  triggerScheduledGoalViaDoor,
  checkPaymentBudgetViaDoor,
  getPaymentsOverviewViaDoor,
} from "../src/agents/orchestrator/meshDoors";
import {
  ListScheduledGoalsCommand,
  TriggerScheduledGoalCommand,
  CheckPaymentBudgetCommand,
  GetPaymentsOverviewCommand,
} from "../src/mcps/openaimp/meshDoorCommands";
import { McpToolFactory } from "../src/mcps/openaimp/commands";
import { MCP_TOOL_SCOPES } from "../src/mcps/openaimp/mcpPermissionPorts";
import { McpAgentToolAdapter } from "../src/agents/mcpAdapter";
import {
  submitAsyncJob,
  executeAsyncJob,
  ensureAsyncJobGraphColumns,
  type AsyncJobsContext,
} from "../src/agents/orchestrator/asyncJobs";
import { AGENTIC_SPEND_AGENT_ID, type PaymentRecord } from "../src/payments/ledger";
import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";
import type { ScheduledGoal, ScheduleTick } from "../src/schedule";
import type { McpToolContext } from "../src/patterns/interfaces";

// ---------------------------------------------------------------------------
// Binding-seam fakes
// ---------------------------------------------------------------------------

const GOALS: ScheduledGoal[] = [
  {
    id: "opportunity-hunt",
    name: "Opportunity hunt",
    cron: "0 */6 * * *",
    operation: "search.opportunity_hunt",
    budgetCents: 1000,
    enabled: true,
  },
  {
    id: "daily-qa-sweep",
    name: "Daily QA sweep",
    cron: "0 6 * * *",
    operation: "qa.run_sweep",
    budgetCents: 500,
    enabled: true,
    lastRun: "2026-10-29T06:00:00.000Z",
  },
];

const OK_TICK: ScheduleTick = {
  timestamp: "2026-10-29T16:00:00.000Z",
  goalsEvaluated: 1,
  jobsCreated: 1,
  jobsSkipped: 0,
  errors: [],
};

const DENIED_TICK: ScheduleTick = {
  timestamp: "2026-10-29T16:00:00.000Z",
  goalsEvaluated: 1,
  jobsCreated: 0,
  jobsSkipped: 1,
  errors: ["opportunity-hunt: budget check rejected: daily cap exceeded"],
};

function makeScheduledStub(tick: ScheduleTick = OK_TICK) {
  return {
    calls: [] as Array<{ method: string; args: unknown[] }>,
    async listGoals(): Promise<ScheduledGoal[]> {
      this.calls.push({ method: "listGoals", args: [] });
      return GOALS.map((g) => ({ ...g }));
    },
    async triggerGoal(id: string): Promise<ScheduleTick> {
      this.calls.push({ method: "triggerGoal", args: [id] });
      return tick;
    },
  };
}

function makePaymentsStub(verdict: { allowed: boolean; reason?: string } = { allowed: true }) {
  const record: PaymentRecord = {
    id: "pay-1",
    agentId: AGENTIC_SPEND_AGENT_ID,
    operation: "search.query",
    amountCents: 250,
    timestamp: "2026-10-29T15:00:00.000Z",
    idempotencyKey: "key-1",
    status: "verified",
  };
  return {
    calls: [] as Array<{ method: string; args: unknown[] }>,
    async budgetCheck(req: { operation: string; amountCents: number; agentId: string }) {
      this.calls.push({ method: "budgetCheck", args: [req] });
      return verdict;
    },
    async todaySpent(): Promise<number> {
      this.calls.push({ method: "todaySpent", args: [] });
      return 4321;
    },
    async listPayments(limit = 50): Promise<PaymentRecord[]> {
      this.calls.push({ method: "listPayments", args: [limit] });
      return [record];
    },
  };
}

function fakeNamespace<T>(stub: T, seen: string[]) {
  return {
    idFromName: (name: string) => {
      seen.push(name);
      return name;
    },
    get: (_id: unknown) => stub,
  };
}

function makeDoorEnv() {
  const scheduledSeen: string[] = [];
  const paymentsSeen: string[] = [];
  const scheduled = makeScheduledStub();
  const payments = makePaymentsStub();
  const env = {
    SCHEDULED_AGENT: fakeNamespace(scheduled, scheduledSeen),
    PAYMENTS_AGENT: fakeNamespace(payments, paymentsSeen),
  } as any;
  return { env, scheduled, payments, scheduledSeen, paymentsSeen };
}

// ---------------------------------------------------------------------------
// Door dispatch
// ---------------------------------------------------------------------------

describe("mesh doors: ScheduledAgent door (#2341)", () => {
  it("lists the goal catalogue from the singleton 'default' instance", async () => {
    const { env, scheduled, scheduledSeen } = makeDoorEnv();
    const result = await listScheduledGoalsViaDoor(env, "alice");
    expect(scheduledSeen).toEqual(["default"]);
    expect(scheduled.calls).toEqual([{ method: "listGoals", args: [] }]);
    expect(result.goals.map((g) => g.id)).toEqual(["opportunity-hunt", "daily-qa-sweep"]);
  });

  it("inspects a single goal by id; an unknown id is an honest typed error", async () => {
    const { env } = makeDoorEnv();
    const one = await listScheduledGoalsViaDoor(env, "alice", "daily-qa-sweep");
    expect(one.goals).toHaveLength(1);
    expect(one.goals[0].id).toBe("daily-qa-sweep");

    const err = await listScheduledGoalsViaDoor(env, "alice", "no-such-goal").catch((e) => e);
    expect(err).toBeInstanceOf(MeshDoorError);
    expect(err.code).toBe("goal_not_found");
  });

  it("trigger returns the agent's real tick outcome, including a budget-denied tick", async () => {
    const { env, scheduled } = makeDoorEnv();
    const ok = await triggerScheduledGoalViaDoor(env, "alice", "opportunity-hunt");
    expect(scheduled.calls).toEqual([{ method: "triggerGoal", args: ["opportunity-hunt"] }]);
    expect(ok.goalId).toBe("opportunity-hunt");
    expect(ok.tick.jobsCreated).toBe(1);

    const deniedEnv = {
      SCHEDULED_AGENT: fakeNamespace(makeScheduledStub(DENIED_TICK), []),
    } as any;
    const denied = await triggerScheduledGoalViaDoor(deniedEnv, "alice", "opportunity-hunt");
    expect(denied.tick.jobsCreated).toBe(0);
    expect(denied.tick.errors[0]).toMatch(/budget check rejected/);
  });

  it("an unbound namespace fails honestly (door_unavailable), never a fabricated result", async () => {
    const err = await listScheduledGoalsViaDoor({} as any, "alice").catch((e) => e);
    expect(err).toBeInstanceOf(MeshDoorError);
    expect(err.code).toBe("door_unavailable");
  });
});

describe("mesh doors: PaymentsAgent door (#2341)", () => {
  it("budget check names the orchestrator spend bucket and propagates the verdict", async () => {
    const { env, payments, paymentsSeen } = makeDoorEnv();
    const result = await checkPaymentBudgetViaDoor(env, "alice", {
      operation: "search.query",
      amountCents: 250,
    });
    expect(paymentsSeen).toEqual(["default"]);
    expect(payments.calls).toEqual([
      {
        method: "budgetCheck",
        args: [{ operation: "search.query", amountCents: 250, agentId: AGENTIC_SPEND_AGENT_ID }],
      },
    ]);
    expect(result.allowed).toBe(true);
    expect(result.agentId).toBe(AGENTIC_SPEND_AGENT_ID);
    expect(result.operation).toBe("search.query");
    expect(result.amountCents).toBe(250);
  });

  it("a guard denial propagates with its reason (never converted to success)", async () => {
    const payments = makePaymentsStub({ allowed: false, reason: "daily cap exceeded: 5100 > 5000" });
    const env = { PAYMENTS_AGENT: fakeNamespace(payments, []) } as any;
    const result = await checkPaymentBudgetViaDoor(env, "alice", {
      operation: "search.query",
      amountCents: 250,
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("daily cap exceeded: 5100 > 5000");
  });

  it("overview reads todaySpent + recent payments through the agent", async () => {
    const { env, payments } = makeDoorEnv();
    const result = await getPaymentsOverviewViaDoor(env, "alice", 5);
    expect(payments.calls).toEqual([
      { method: "todaySpent", args: [] },
      { method: "listPayments", args: [5] },
    ]);
    expect(result.todaySpentCents).toBe(4321);
    expect(result.recentPayments).toHaveLength(1);
    expect(result.recentPayments[0].id).toBe("pay-1");
  });
});

// ---------------------------------------------------------------------------
// Identity discipline: fail closed before dispatch
// ---------------------------------------------------------------------------

describe("mesh doors: identity fails closed before dispatch (#2341)", () => {
  const BAD_IDENTITIES: Array<string | undefined> = [undefined, "", "   ", "default"];

  it("every door operation refuses a missing/blank/retired identity before resolving any stub", async () => {
    for (const bad of BAD_IDENTITIES) {
      const { env, scheduled, payments, scheduledSeen, paymentsSeen } = makeDoorEnv();
      const attempts: Array<() => Promise<unknown>> = [
        () => listScheduledGoalsViaDoor(env, bad),
        () => triggerScheduledGoalViaDoor(env, bad, "opportunity-hunt"),
        () => checkPaymentBudgetViaDoor(env, bad, { operation: "search.query", amountCents: 100 }),
        () => getPaymentsOverviewViaDoor(env, bad),
      ];
      for (const attempt of attempts) {
        const err = await attempt().catch((e) => e);
        expect(err).toBeInstanceOf(MeshDoorError);
        expect(err.code).toBe("identity_required");
      }
      expect(scheduledSeen).toEqual([]);
      expect(paymentsSeen).toEqual([]);
      expect(scheduled.calls).toEqual([]);
      expect(payments.calls).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// Turn commands: thin resolve-identity -> dispatch, one scope each
// ---------------------------------------------------------------------------

function makeCommandContext(env: any, actingLogin?: () => string | undefined): McpToolContext {
  return {
    env,
    orm: {} as any,
    sessionId: "session-1",
    audit: vi.fn(),
    ...(actingLogin ? { actingLogin } : {}),
  } as McpToolContext;
}

describe("mesh door commands (#2341)", () => {
  it("list_scheduled_goals dispatches through the door with the turn's acting identity", async () => {
    const { env, scheduled } = makeDoorEnv();
    const ctx = makeCommandContext(env, () => "alice");
    const result = await new ListScheduledGoalsCommand().execute({}, ctx);
    expect(result.goals).toHaveLength(2);
    expect(scheduled.calls).toEqual([{ method: "listGoals", args: [] }]);
    expect(ctx.audit).toHaveBeenCalledWith(
      "list_scheduled_goals",
      "mcp",
      expect.objectContaining({ actingLogin: "alice" }),
    );
  });

  it("a command with no acting-identity carrier refuses before dispatch", async () => {
    const { env, scheduled } = makeDoorEnv();
    const ctx = makeCommandContext(env);
    const err = await new ListScheduledGoalsCommand().execute({}, ctx).catch((e) => e);
    expect(err).toBeInstanceOf(MeshDoorError);
    expect(err.code).toBe("identity_required");
    expect(scheduled.calls).toEqual([]);
  });

  it("a command whose turn identity is the retired 'default' literal refuses", async () => {
    const { env, payments } = makeDoorEnv();
    const ctx = makeCommandContext(env, () => "default");
    const err = await new CheckPaymentBudgetCommand()
      .execute({ operation: "search.query", amountCents: 100 }, ctx)
      .catch((e) => e);
    expect(err).toBeInstanceOf(MeshDoorError);
    expect(err.code).toBe("identity_required");
    expect(payments.calls).toEqual([]);
  });

  it("trigger + budget + overview commands reach their door operations", async () => {
    const { env, scheduled, payments } = makeDoorEnv();
    const ctx = makeCommandContext(env, () => "alice");
    const tick = await new TriggerScheduledGoalCommand().execute({ goalId: "opportunity-hunt" }, ctx);
    expect(tick.tick.jobsCreated).toBe(1);
    const verdict = await new CheckPaymentBudgetCommand().execute(
      { operation: "search.query", amountCents: 250 },
      ctx,
    );
    expect(verdict.allowed).toBe(true);
    const overview = await new GetPaymentsOverviewCommand().execute({}, ctx);
    expect(overview.todaySpentCents).toBe(4321);
    expect(scheduled.calls).toHaveLength(1);
    expect(payments.calls).toHaveLength(3);
  });

  it("all four commands are factory-registered, each with exactly one declared scope", () => {
    const expected: Record<string, string> = {
      list_scheduled_goals: "mcp:read",
      trigger_scheduled_goal: "mcp:write",
      check_payment_budget: "mcp:payments",
      get_payments_overview: "mcp:payments",
    };
    for (const [name, scope] of Object.entries(expected)) {
      expect(McpToolFactory.getTool(name), name).toBeDefined();
      expect(MCP_TOOL_SCOPES[name], name).toBe(scope);
    }
  });
});

// ---------------------------------------------------------------------------
// Identity carriage: adapter stamp -> job payload -> executor -> door
// ---------------------------------------------------------------------------

describe("mesh door identity carriage through the async-job path (#2341)", () => {
  it("the turn adapter stamps the acting identity into the queued job payload", async () => {
    const submitJob = vi.fn().mockResolvedValue({
      jobId: "job-1",
      status: "queued",
      statusUrl: "/api/jobs/job-1",
    });
    const { env } = makeDoorEnv();
    const ctx = {
      ...makeCommandContext(env, () => "alice"),
      principal: { kind: "agent-turn" as const, login: null },
      submitJob,
    } as McpToolContext;
    const tool = McpAgentToolAdapter.adapt(new ListScheduledGoalsCommand(), ctx);
    await (tool as any).execute({}, { toolCallId: "t-1", messages: [] });
    expect(submitJob).toHaveBeenCalledTimes(1);
    const job = submitJob.mock.calls[0][0];
    expect(job.capability).toBe("mcp.tool");
    expect(job.payload.toolName).toBe("list_scheduled_goals");
    expect(job.payload.actingLogin).toBe("alice");
  });

  it("no identity stamp is written when the turn has no acting identity", async () => {
    const submitJob = vi.fn().mockResolvedValue({
      jobId: "job-2",
      status: "queued",
      statusUrl: "/api/jobs/job-2",
    });
    const { env } = makeDoorEnv();
    const ctx = {
      ...makeCommandContext(env),
      principal: { kind: "agent-turn" as const, login: null },
      submitJob,
    } as McpToolContext;
    const tool = McpAgentToolAdapter.adapt(new ListScheduledGoalsCommand(), ctx);
    await (tool as any).execute({}, { toolCallId: "t-2", messages: [] });
    expect(submitJob).toHaveBeenCalledTimes(1);
    expect(submitJob.mock.calls[0][0].payload).not.toHaveProperty("actingLogin");
  });
});

// A mutating in-memory mas_async_jobs fake (the async_job_graph /
// feed-chain harness pattern): enough SQL fidelity for the real
// submit + execute path — INSERT/SELECT projection, status-guarded
// claim UPDATE, completion/failure UPDATEs applied to the rows.
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
      // Remaining args are the WHERE parameters: job_id first.
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

function makeExecutorCtx(sql: FakeJobSql, env: any): AsyncJobsContext {
  const storage = sql as unknown as AsyncJobsContext["agentCtx"]["storage"]["sql"];
  const orm = new DatabaseORM(new MockSqlStorage() as any);
  return {
    env,
    agentCtx: { storage: { sql: storage } },
    ensureTables: () => {
      sql.exec("CREATE TABLE IF NOT EXISTS mas_async_jobs (job_id TEXT PRIMARY KEY)");
      ensureAsyncJobGraphColumns(storage);
      return storage;
    },
    sessionKey: () => "session-1",
    schedule: vi.fn(async () => ({})),
    audit: vi.fn(),
    getOrm: () => orm,
    routeRequest: vi.fn(async () => new Response("{}")),
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
  } as unknown as AsyncJobsContext;
}

describe("mesh doors: queued turn call executes through the door (#2341)", () => {
  it("a job stamped with the acting identity completes with the door's real result", async () => {
    const sql = new FakeJobSql();
    const { env, scheduled } = makeDoorEnv();
    const ctx = makeExecutorCtx(sql, env);
    const submitted = await submitAsyncJob(ctx, {
      capability: "mcp.tool",
      payload: { toolName: "list_scheduled_goals", arguments: {}, actingLogin: "alice" },
    } as any);
    await executeAsyncJob(ctx, { jobId: submitted.jobId });
    const row = sql.rows.find((r) => r.job_id === submitted.jobId);
    expect(row?.status).toBe("completed");
    const result = JSON.parse(String(row?.result_json));
    expect(result.goals.map((g: ScheduledGoal) => g.id)).toEqual([
      "opportunity-hunt",
      "daily-qa-sweep",
    ]);
    expect(scheduled.calls).toEqual([{ method: "listGoals", args: [] }]);
  });

  it("a job without an acting identity fails closed and never reaches the agent", async () => {
    const sql = new FakeJobSql();
    const { env, scheduled, scheduledSeen } = makeDoorEnv();
    const ctx = makeExecutorCtx(sql, env);
    const submitted = await submitAsyncJob(ctx, {
      capability: "mcp.tool",
      payload: { toolName: "list_scheduled_goals", arguments: {} },
    } as any);
    await executeAsyncJob(ctx, { jobId: submitted.jobId });
    const row = sql.rows.find((r) => r.job_id === submitted.jobId);
    expect(row?.status).toBe("failed");
    expect(String(row?.error)).toMatch(/identity/i);
    expect(scheduledSeen).toEqual([]);
    expect(scheduled.calls).toEqual([]);
  });
});
