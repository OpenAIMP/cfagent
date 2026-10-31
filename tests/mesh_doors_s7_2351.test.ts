/**
 * Issue #2351 (Agent Mesh S7, programme #2225 G1 batch C): typed
 * outbound doors from the orchestrator chat turn to BrowserAgent
 * and SlackAgent.
 *
 * Pins, at the binding seam (fake DO namespaces — the door itself
 * is never mocked away):
 * - dispatch reaches the A2A-parity fixed instances ("browser" /
 *   "slack" — both classes are stateless/env-driven, so the bare
 *   A2A name is the instance) with the transaction/draft built
 *   field-by-field by the door;
 * - the webhookUrl policy (survey §2.8, decided here following the
 *   #2223 A2A precedent for these same agents): a caller-supplied
 *   webhookUrl is NEVER forwarded — the door stub's option types
 *   declare no webhookUrl field, the command schemas declare
 *   none, and options the stub receives carry no webhookUrl key
 *   even when the caller supplied one. Delivery targets come from
 *   env configuration only (the service falls back to env
 *   SLACK_WEBHOOK_URL);
 * - agent results propagate verbatim, including degraded ones: a
 *   placeholder-labelled scrape (screenshotKind "placeholder") and
 *   a not-delivered snap (success: false) come back exactly as the
 *   agent produced them — never dressed up as real captures or
 *   successful deliveries;
 * - no acting identity (absent, blank, or the retired "default"
 *   literal) fails closed BEFORE any stub is resolved or called;
 * - the five turn commands are registered in McpToolFactory and
 *   each declares exactly one scope (#1744);
 * - the queued async-job path carries the acting identity into a
 *   batch-C command exactly as batches A/B established (#2341).
 */
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  MeshDoorError,
  sendTransactionSnapViaDoor,
  capturePageSnapshotViaDoor,
  scrapePageTablesViaDoor,
  sendPreTradeApprovalTicketViaDoor,
  dispatchTransactionSnapViaDoor,
  type TransactionSnapDoorInput,
  type PreTradeApprovalDraftDoorInput,
} from "../src/agents/orchestrator/meshDoors";
import {
  BrowserSnapTransactionCommand,
  BrowserCapturePageCommand,
  BrowserScrapeTablesCommand,
  SlackSendPreTradeApprovalCommand,
  SlackDispatchTransactionSnapCommand,
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
import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";
import type { McpToolContext } from "../src/patterns/interfaces";

// ---------------------------------------------------------------------------
// Binding-seam fakes
// ---------------------------------------------------------------------------

const TX: TransactionSnapDoorInput = {
  transactionId: "tx-9001",
  symbol: "AAPL",
  action: "BUY",
  quantity: 10,
  price: 231.5,
  orderType: "MARKET",
  status: "executed",
  totalValue: 2315,
  environment: "live",
  timestamp: "2026-10-29T12:00:00.000Z",
};

const SNAP_RESULT = {
  success: true,
  transactionId: "tx-9001",
  symbol: "AAPL",
  channel: "C123",
  timestamp: "2026-10-29T12:00:01.000Z",
};

const CAPTURE_RESULT = {
  success: true,
  url: "https://example.com/quote/AAPL",
  timestamp: "2026-10-29T12:00:02.000Z",
};

/** A degraded scrape: no Browser Rendering capture was available,
 *  so the screenshot is the service's labelled placeholder (#120). */
const SCRAPE_PLACEHOLDER_RESULT = {
  success: true,
  url: "https://example.com/quote/AAPL",
  title: "AAPL quote",
  tables: [["Symbol", "Last"], ["AAPL", "231.50"]],
  screenshotBase64: "iVBORw0KGgoAAAANSUhEUg==",
  screenshotKind: "placeholder" as const,
  timestamp: "2026-10-29T12:00:03.000Z",
};

/** An honest not-delivered snap: nothing is configured to deliver to. */
const SNAP_NOT_DELIVERED_RESULT = {
  success: false,
  error:
    "Not delivered: no Slack webhook URL or bot token is configured (set SLACK_WEBHOOK_URL or SLACK_BOT_TOKEN); nothing was sent to Slack.",
  timestamp: "2026-10-29T12:00:04.000Z",
};

const DRAFT: PreTradeApprovalDraftDoorInput = {
  orderId: "ord-3003",
  symbol: "AAPL",
  action: "BUY",
  quantity: 5,
  orderType: "LIMIT",
  limitPrice: 230,
  estimatedTotal: 1150,
};

const TICKET_RESULT = {
  success: true,
  payload: { text: "ACTION REQUIRED: Authorize E*TRADE Order Preview: BUY 5 AAPL" },
  orderId: "ord-3003",
};

function makeBrowserStub() {
  return {
    calls: [] as Array<{ method: string; args: unknown[] }>,
    async sendTransactionSnapToSlack(tx: unknown, options: unknown) {
      this.calls.push({ method: "sendTransactionSnapToSlack", args: [tx, options] });
      return JSON.parse(JSON.stringify(SNAP_RESULT));
    },
    async capturePageSnapshot(url: string, options: unknown) {
      this.calls.push({ method: "capturePageSnapshot", args: [url, options] });
      return JSON.parse(JSON.stringify(CAPTURE_RESULT));
    },
    async scrapeTables(url: string) {
      this.calls.push({ method: "scrapeTables", args: [url] });
      return JSON.parse(JSON.stringify(SCRAPE_PLACEHOLDER_RESULT));
    },
  };
}

function makeSlackStub() {
  return {
    calls: [] as Array<{ method: string; args: unknown[] }>,
    async sendPreTradeApprovalTicket(draft: unknown, options: unknown) {
      this.calls.push({ method: "sendPreTradeApprovalTicket", args: [draft, options] });
      return JSON.parse(JSON.stringify(TICKET_RESULT));
    },
    async dispatchTransactionSnap(tx: unknown, options: unknown) {
      this.calls.push({ method: "dispatchTransactionSnap", args: [tx, options] });
      return JSON.parse(JSON.stringify(SNAP_RESULT));
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
  const browserSeen: string[] = [];
  const slackSeen: string[] = [];
  const browser = makeBrowserStub();
  const slack = makeSlackStub();
  const env = {
    BROWSER_AGENT: fakeNamespace(browser, browserSeen),
    SLACK_AGENT: fakeNamespace(slack, slackSeen),
  } as any;
  return { env, browser, slack, browserSeen, slackSeen };
}

// ---------------------------------------------------------------------------
// Door dispatch: BrowserAgent
// ---------------------------------------------------------------------------

describe("mesh doors: BrowserAgent door (#2351)", () => {
  it("sends a transaction snap through the fixed 'browser' instance, transaction built field-by-field", async () => {
    const { env, browser, browserSeen } = makeDoorEnv();
    const result = await sendTransactionSnapViaDoor(env, "alice", {
      transaction: TX,
      channel: "C123",
      caption: "AAPL fill",
    });
    expect(browserSeen).toEqual(["browser"]);
    expect(browser.calls).toHaveLength(1);
    const [tx, options] = browser.calls[0].args as [Record<string, unknown>, Record<string, unknown>];
    expect(tx).toEqual(TX);
    expect(options).toEqual({ channel: "C123", caption: "AAPL fill" });
    expect(result).toEqual(SNAP_RESULT);
  });

  it("captures a page snapshot with caption/channel options and returns the result verbatim", async () => {
    const { env, browser, browserSeen } = makeDoorEnv();
    const result = await capturePageSnapshotViaDoor(env, "alice", {
      url: "https://example.com/quote/AAPL",
      caption: "quote page",
    });
    expect(browserSeen).toEqual(["browser"]);
    expect(browser.calls[0].args[0]).toBe("https://example.com/quote/AAPL");
    expect(browser.calls[0].args[1]).toEqual({ caption: "quote page" });
    expect(result).toEqual(CAPTURE_RESULT);
  });

  it("propagates a degraded placeholder scrape verbatim — the placeholder label is never stripped", async () => {
    const { env } = makeDoorEnv();
    const result = await scrapePageTablesViaDoor(env, "alice", "https://example.com/quote/AAPL");
    expect(result).toEqual(SCRAPE_PLACEHOLDER_RESULT);
    expect(result.screenshotKind).toBe("placeholder");
  });

  it("propagates a not-delivered snap result verbatim (success: false is the agent's honest outcome)", async () => {
    const { env, browser } = makeDoorEnv();
    browser.sendTransactionSnapToSlack = async (tx: unknown, options: unknown) => {
      browser.calls.push({ method: "sendTransactionSnapToSlack", args: [tx, options] });
      return JSON.parse(JSON.stringify(SNAP_NOT_DELIVERED_RESULT));
    };
    const result = await sendTransactionSnapViaDoor(env, "alice", { transaction: TX });
    expect(result).toEqual(SNAP_NOT_DELIVERED_RESULT);
    expect(result.success).toBe(false);
  });

  it("an unbound BROWSER_AGENT namespace fails honestly (door_unavailable)", async () => {
    const err = await scrapePageTablesViaDoor({} as any, "alice", "https://example.com").catch((e) => e);
    expect(err).toBeInstanceOf(MeshDoorError);
    expect(err.code).toBe("door_unavailable");
  });
});

// ---------------------------------------------------------------------------
// Door dispatch: SlackAgent
// ---------------------------------------------------------------------------

describe("mesh doors: SlackAgent door (#2351)", () => {
  it("dispatches a pre-trade approval ticket through the fixed 'slack' instance, draft built field-by-field", async () => {
    const { env, slack, slackSeen } = makeDoorEnv();
    const result = await sendPreTradeApprovalTicketViaDoor(env, "alice", {
      draft: DRAFT,
      channel: "C123",
      threadTs: "1729700000.000100",
    });
    expect(slackSeen).toEqual(["slack"]);
    const [draft, options] = slack.calls[0].args as [Record<string, unknown>, Record<string, unknown>];
    expect(draft).toEqual(DRAFT);
    expect(options).toEqual({ channel: "C123", threadTs: "1729700000.000100" });
    // The ticket is the service's own result — posting the HITL gate
    // is all this door does; it approves and executes nothing.
    expect(result).toEqual(TICKET_RESULT);
    expect(result.orderId).toBe("ord-3003");
  });

  it("dispatches a transaction snap through SlackAgent verbatim", async () => {
    const { env, slack, slackSeen } = makeDoorEnv();
    const result = await dispatchTransactionSnapViaDoor(env, "alice", {
      transaction: TX,
      caption: "fill receipt",
    });
    expect(slackSeen).toEqual(["slack"]);
    expect(slack.calls[0].args[1]).toEqual({ caption: "fill receipt" });
    expect(result).toEqual(SNAP_RESULT);
  });

  it("an unbound SLACK_AGENT namespace fails honestly (door_unavailable)", async () => {
    const err = await dispatchTransactionSnapViaDoor({} as any, "alice", { transaction: TX }).catch((e) => e);
    expect(err).toBeInstanceOf(MeshDoorError);
    expect(err.code).toBe("door_unavailable");
  });
});

// ---------------------------------------------------------------------------
// The webhookUrl policy: caller URLs are never forwarded
// ---------------------------------------------------------------------------

describe("mesh doors batch C: the webhookUrl policy (#2351)", () => {
  it("a webhookUrl smuggled into door inputs never reaches either stub", async () => {
    const { env, browser, slack } = makeDoorEnv();
    const evil = "https://hooks.example.invalid/attacker";
    await sendTransactionSnapViaDoor(env, "alice", {
      transaction: TX,
      channel: "C123",
      webhookUrl: evil,
    } as any);
    await capturePageSnapshotViaDoor(env, "alice", { url: "https://example.com", webhookUrl: evil } as any);
    await sendPreTradeApprovalTicketViaDoor(env, "alice", { draft: DRAFT, webhookUrl: evil } as any);
    await dispatchTransactionSnapViaDoor(env, "alice", { transaction: TX, webhookUrl: evil } as any);
    for (const call of [...browser.calls, ...slack.calls]) {
      const options = call.args[call.args.length - 1] as Record<string, unknown>;
      expect(options, call.method).not.toHaveProperty("webhookUrl");
      expect(JSON.stringify(call.args)).not.toContain(evil);
    }
  });

  it("the door stub option types declare no webhookUrl field", () => {
    const text = readFileSync(join(__dirname, "../src/agents/orchestrator/meshDoors.ts"), "utf8");
    for (const iface of ["interface BrowserAgentDoorStub", "interface SlackAgentDoorStub"]) {
      const start = text.indexOf(iface);
      expect(start, iface).toBeGreaterThan(-1);
      const block = text.slice(start, text.indexOf("\n}", start));
      expect(block, iface).not.toContain("webhookUrl");
    }
  });

  it("no batch-C command schema declares a webhookUrl argument", () => {
    const commands = [
      new BrowserSnapTransactionCommand(),
      new BrowserCapturePageCommand(),
      new BrowserScrapeTablesCommand(),
      new SlackSendPreTradeApprovalCommand(),
      new SlackDispatchTransactionSnapCommand(),
    ];
    for (const cmd of commands) {
      expect(JSON.stringify(cmd.jsonSchema), cmd.name).not.toContain("webhookUrl");
    }
  });
});

// ---------------------------------------------------------------------------
// Identity discipline: fail closed before dispatch
// ---------------------------------------------------------------------------

describe("mesh doors batch C: identity fails closed before dispatch (#2351)", () => {
  const BAD_IDENTITIES: Array<string | undefined> = [undefined, "", "   ", "default"];

  it("every batch-C door operation refuses a missing/blank/retired identity before resolving any stub", async () => {
    for (const bad of BAD_IDENTITIES) {
      const { env, browser, slack, browserSeen, slackSeen } = makeDoorEnv();
      const attempts: Array<() => Promise<unknown>> = [
        () => sendTransactionSnapViaDoor(env, bad, { transaction: TX }),
        () => capturePageSnapshotViaDoor(env, bad, { url: "https://example.com" }),
        () => scrapePageTablesViaDoor(env, bad, "https://example.com"),
        () => sendPreTradeApprovalTicketViaDoor(env, bad, { draft: DRAFT }),
        () => dispatchTransactionSnapViaDoor(env, bad, { transaction: TX }),
      ];
      for (const attempt of attempts) {
        const err = await attempt().catch((e) => e);
        expect(err).toBeInstanceOf(MeshDoorError);
        expect(err.code).toBe("identity_required");
      }
      expect(browserSeen).toEqual([]);
      expect(slackSeen).toEqual([]);
      expect(browser.calls).toEqual([]);
      expect(slack.calls).toEqual([]);
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

describe("mesh door commands batch C (#2351)", () => {
  it("browser_snap_transaction dispatches through the door with the turn's acting identity and audits attribution", async () => {
    const { env, browser } = makeDoorEnv();
    const ctx = makeCommandContext(env, () => "alice");
    const result = await new BrowserSnapTransactionCommand().execute(
      { transaction: TX, channel: "C123" },
      ctx,
    );
    expect(result).toEqual(SNAP_RESULT);
    expect(browser.calls.map((c) => c.method)).toEqual(["sendTransactionSnapToSlack"]);
    expect(ctx.audit).toHaveBeenCalledWith(
      "browser_snap_transaction",
      "mcp",
      expect.objectContaining({ actingLogin: "alice", transactionId: "tx-9001", success: true }),
    );
  });

  it("a webhookUrl in command input is not forwarded to the agent", async () => {
    const { env, browser, slack } = makeDoorEnv();
    const ctx = makeCommandContext(env, () => "alice");
    await new BrowserCapturePageCommand().execute(
      { url: "https://example.com", webhookUrl: "https://hooks.example.invalid/attacker" } as any,
      ctx,
    );
    await new SlackDispatchTransactionSnapCommand().execute(
      { transaction: TX, webhookUrl: "https://hooks.example.invalid/attacker" } as any,
      ctx,
    );
    for (const call of [...browser.calls, ...slack.calls]) {
      expect(JSON.stringify(call.args)).not.toContain("hooks.example.invalid");
    }
  });

  it("a command with no acting-identity carrier refuses before dispatch", async () => {
    const { env, browser } = makeDoorEnv();
    const ctx = makeCommandContext(env);
    const err = await new BrowserScrapeTablesCommand()
      .execute({ url: "https://example.com" }, ctx)
      .catch((e) => e);
    expect(err).toBeInstanceOf(MeshDoorError);
    expect(err.code).toBe("identity_required");
    expect(browser.calls).toEqual([]);
  });

  it("a command whose turn identity is the retired 'default' literal refuses", async () => {
    const { env, slack } = makeDoorEnv();
    const ctx = makeCommandContext(env, () => "default");
    const err = await new SlackSendPreTradeApprovalCommand().execute({ draft: DRAFT }, ctx).catch((e) => e);
    expect(err).toBeInstanceOf(MeshDoorError);
    expect(err.code).toBe("identity_required");
    expect(slack.calls).toEqual([]);
  });

  it("all five commands reach their door operations", async () => {
    const { env, browser, slack } = makeDoorEnv();
    const ctx = makeCommandContext(env, () => "alice");
    await new BrowserSnapTransactionCommand().execute({ transaction: TX }, ctx);
    await new BrowserCapturePageCommand().execute({ url: "https://example.com/quote/AAPL" }, ctx);
    const scrape = await new BrowserScrapeTablesCommand().execute({ url: "https://example.com/quote/AAPL" }, ctx);
    expect(scrape.screenshotKind).toBe("placeholder");
    await new SlackSendPreTradeApprovalCommand().execute({ draft: DRAFT }, ctx);
    await new SlackDispatchTransactionSnapCommand().execute({ transaction: TX }, ctx);
    expect(browser.calls.map((c) => c.method)).toEqual([
      "sendTransactionSnapToSlack",
      "capturePageSnapshot",
      "scrapeTables",
    ]);
    expect(slack.calls.map((c) => c.method)).toEqual(["sendPreTradeApprovalTicket", "dispatchTransactionSnap"]);
  });

  it("all five commands are factory-registered, each with exactly one declared scope", () => {
    const expected: Record<string, string> = {
      browser_snap_transaction: "mcp:write",
      browser_capture_page: "mcp:write",
      browser_scrape_tables: "mcp:read",
      slack_send_pre_trade_approval: "mcp:trade",
      slack_dispatch_transaction_snap: "mcp:write",
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

describe("mesh door identity carriage for batch C (#2351)", () => {
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
    const tool = McpAgentToolAdapter.adapt(new BrowserScrapeTablesCommand(), ctx);
    await (tool as any).execute({ url: "https://example.com/quote/AAPL" }, { toolCallId: "t-1", messages: [] });
    expect(submitJob).toHaveBeenCalledTimes(1);
    const job = submitJob.mock.calls[0][0];
    expect(job.capability).toBe("mcp.tool");
    expect(job.payload.toolName).toBe("browser_scrape_tables");
    expect(job.payload.actingLogin).toBe("alice");
  });
});

// A mutating in-memory mas_async_jobs fake (the async_job_graph /
// feed-chain harness pattern, as in the batch-A/B suites): enough SQL
// fidelity for the real submit + execute path — INSERT/SELECT
// projection, status-guarded claim UPDATE, completion/failure
// UPDATEs applied to the rows.
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

describe("mesh doors batch C: queued turn call executes through the door (#2351)", () => {
  it("a job stamped with the acting identity completes with the door's real (degraded-labelled) scrape", async () => {
    const sql = new FakeJobSql();
    const { env, browser, browserSeen } = makeDoorEnv();
    const ctx = makeExecutorCtx(sql, env);
    const submitted = await submitAsyncJob(ctx, {
      capability: "mcp.tool",
      payload: {
        toolName: "browser_scrape_tables",
        arguments: { url: "https://example.com/quote/AAPL" },
        actingLogin: "alice",
      },
    } as any);
    await executeAsyncJob(ctx, { jobId: submitted.jobId });
    const row = sql.rows.find((r) => r.job_id === submitted.jobId);
    expect(row?.status).toBe("completed");
    const result = JSON.parse(String(row?.result_json));
    expect(result.screenshotKind).toBe("placeholder");
    expect(browserSeen).toEqual(["browser"]);
    expect(browser.calls.map((c) => c.method)).toEqual(["scrapeTables"]);
  });

  it("a job without an acting identity fails closed and never reaches the agent", async () => {
    const sql = new FakeJobSql();
    const { env, browser, browserSeen } = makeDoorEnv();
    const ctx = makeExecutorCtx(sql, env);
    const submitted = await submitAsyncJob(ctx, {
      capability: "mcp.tool",
      payload: {
        toolName: "browser_scrape_tables",
        arguments: { url: "https://example.com/quote/AAPL" },
      },
    } as any);
    await executeAsyncJob(ctx, { jobId: submitted.jobId });
    const row = sql.rows.find((r) => r.job_id === submitted.jobId);
    expect(row?.status).toBe("failed");
    expect(String(row?.error)).toMatch(/identity/i);
    expect(browserSeen).toEqual([]);
    expect(browser.calls).toEqual([]);
  });
});
