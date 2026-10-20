/**
 * Issue #668 (Think migration step 3a) — SHADOW CORE. INERT.
 *
 * The Think-based orchestrator, static core only: constructed-arm
 * model, the full MCP tool surface from real instance state,
 * sanitized step bound, and session-memory grounding via a Think
 * context block. Judge routing, the turn driver, finish
 * side-effects, and the async-job submit path are step 3b (#669).
 *
 * NOT exported from src/server.ts, NOT bound in wrangler, NOT routed
 * — production traffic cannot reach this class (pinned by
 * tests/orchestrator-think-core.test.ts). At cutover (step 4) a class
 * like this one replaces OrchestratorAgent under the stable
 * SEARCH_AGENT name and inherits the existing DO storage.
 *
 * Recorded 3a limitations (see #668):
 *  - The tool context omits submitJob: adapted tools execute
 *    directly instead of queueing until 3b gives the shadow an
 *    execution path. getJob/listJobs are real reads.
 *  - ensureTables creates only the tables this core touches
 *    (mas_events, mas_memory, mas_async_jobs). Step 4 must run the
 *    FULL live DDL — the subset must not be inherited silently.
 *  - getSystemPrompt is the fallback prompt (neutral route, no
 *    grounding); per-turn assembly is 3b's beforeTurn work.
 */
import { Think } from "@cloudflare/think";
import type { ToolSet } from "ai";
import { DatabaseORM } from "../orm";
import { VectorMemory } from "../memory/vector-memory";
import { McpSystemFacade } from "../patterns/facade";
import type { McpToolContext } from "../patterns/interfaces";
import type { AgentName, AsyncJobRecord, AsyncJobStatus, Env } from "../types";
import { createAgentMcpTools } from "./mcpAdapter";
import { getWorkersAIModel } from "./model";
import { buildOrchestratorSystemPrompt, resolveShadowMaxSteps } from "./chatPrompt";

export class OrchestratorThinkAgent extends Think<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Issue #668 R2: sanitized clamp (non-numeric MAS_MAX_STEPS -> 6),
    // a deliberate shadow-only difference flagged for step-4 review.
    this.maxSteps = resolveShadowMaxSteps(env);
  }

  /** Constructed model arm (step-2 pin): identical provider
   * construction to the live loop. */
  getModel() {
    return getWorkersAIModel(this.env);
  }

  /** Fallback prompt only — neutral route, no per-turn context.
   * Real per-turn assembly lands in step 3b (beforeTurn). */
  getSystemPrompt(): string {
    return buildOrchestratorSystemPrompt({
      route: { agent: "search", confidence: 0, reason: "Shadow core fallback prompt." },
      memoryContext: "",
      vectorContext: "",
      optionsResearchContext: "",
      isAutoOptionsResearchRequest: false,
    });
  }

  /** Session-memory grounding as a Think context block (query-
   * independent). Vector recall is query-dependent and lands with
   * the turn lifecycle in step 3b. */
  configureContext() {
    return [
      {
        label: "session-memory",
        description: "Active persistent memory (SQLite session facts)",
        provider: {
          get: async () => (await this.assembleGrounding("")).memoryContext,
        },
      },
    ];
  }

  getTools(): ToolSet {
    return createAgentMcpTools(this.toolContext());
  }

  /** The live turn's grounding assembly, verbatim queries and format:
   * top-8 mas_memory facts plus best-effort VectorMemory recall. */
  async assembleGrounding(
    userText: string
  ): Promise<{ memoryContext: string; vectorContext: string }> {
    const sql = this.ensureTables();
    const activeMemories = Array.from(
      sql.exec("SELECT key, value FROM mas_memory ORDER BY updated_at DESC LIMIT 8")
    ) as Array<{ key: string; value: string }>;
    const memoryContext =
      activeMemories.length > 0
        ? `\nActive Persistent Memory (SQLite Session Facts):\n` +
          activeMemories.map((m) => `- ${m.key}: "${m.value}"`).join("\n")
        : "";

    let vectorContext = "";
    const vectorizeBinding = (this.env as unknown as { VECTOR_MEMORY?: unknown }).VECTOR_MEMORY;
    if (userText && userText.trim().length > 0 && this.env.AI && vectorizeBinding) {
      try {
        const vm = new VectorMemory(
          this.env.AI,
          vectorizeBinding as never,
          undefined
        );
        const chunks = await vm.recallForPlan(userText);
        if (chunks.length > 0) {
          vectorContext = `\nRelevant past outcomes (vector memory, most similar first):\n${VectorMemory.brief(chunks)}`;
        }
      } catch (err) {
        console.warn(
          "[VectorMemory] recall failed:",
          err instanceof Error ? err.message : String(err)
        );
      }
    }
    return { memoryContext, vectorContext };
  }

  // --- Instance-state helpers (mirrors of the live class's idiom) ---

  private sessionKey(): string {
    return this.ctx.id.toString();
  }

  private ensureTables() {
    const sql = this.ctx.storage.sql;
    sql.exec(`
      CREATE TABLE IF NOT EXISTS mas_events (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        type TEXT NOT NULL,
        agent TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `);
    sql.exec(`
      CREATE TABLE IF NOT EXISTS mas_memory (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    sql.exec(`
      CREATE TABLE IF NOT EXISTS mas_async_jobs (
        job_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        capability TEXT NOT NULL,
        display_name TEXT NOT NULL,
        status TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        result_json TEXT,
        response_status INTEGER,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT
      )
    `);
    return sql;
  }

  private getOrm(): DatabaseORM {
    this.ensureTables();
    const orm = new DatabaseORM(this.ctx.storage.sql);
    orm.initializeSchema(this.sessionKey());
    return orm;
  }

  private recordAudit(
    type: string,
    agent: string,
    payload: Record<string, unknown>
  ): { id: string; type: string; agent: string; payload: Record<string, unknown>; created_at: string } {
    const sql = this.ensureTables();
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    sql.exec(
      "INSERT INTO mas_events (id, session_id, type, agent, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      id,
      this.sessionKey(),
      type,
      agent,
      JSON.stringify(payload),
      now
    );
    return { id, type, agent, payload, created_at: now };
  }

  private audit(
    type: string,
    agent: AgentName | "judge" | "nlq" | "orchestrator",
    payload: Record<string, unknown>
  ) {
    try {
      this.recordAudit(type, agent, payload);
    } catch {
      // Don't fail execution if audit insertion fails
    }
  }

  private getAsyncJob(jobId: string): AsyncJobRecord | undefined {
    const sql = this.ensureTables();
    const rows = Array.from(
      sql.exec(
        `SELECT job_id, session_id, capability, display_name, status, result_json, response_status,
              error, created_at, updated_at, started_at, completed_at
       FROM mas_async_jobs WHERE job_id = ? AND session_id = ?`,
        jobId,
        this.sessionKey()
      )
    ) as Array<Record<string, unknown>>;
    const row = rows[0];
    if (!row) return undefined;
    if (
      row.status === "running" &&
      typeof row.started_at === "string" &&
      Date.now() - Date.parse(row.started_at) > 2 * 60 * 60 * 1000
    ) {
      const completedAt = new Date().toISOString();
      sql.exec(
        `UPDATE mas_async_jobs SET status = 'failed',
         error = 'Execution stopped before a result was recorded; the outcome may be unknown. Verify external side effects before submitting again.',
         updated_at = ?, completed_at = ? WHERE job_id = ? AND status = 'running'`,
        completedAt,
        completedAt,
        jobId
      );
      return this.getAsyncJob(jobId);
    }
    let result: unknown;
    if (typeof row.result_json === "string") {
      try {
        result = JSON.parse(row.result_json);
      } catch (error) {
        throw new Error(
          `Stored result for async job ${jobId} is invalid JSON: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    return {
      jobId: String(row.job_id),
      sessionId: String(row.session_id),
      capability: String(row.capability),
      label: String(row.display_name),
      status: row.status as AsyncJobStatus,
      result,
      responseStatus: typeof row.response_status === "number" ? row.response_status : undefined,
      error: typeof row.error === "string" ? row.error : undefined,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      startedAt: typeof row.started_at === "string" ? row.started_at : undefined,
      completedAt: typeof row.completed_at === "string" ? row.completed_at : undefined,
    };
  }

  private listAsyncJobs(limit = 50): AsyncJobRecord[] {
    const rows = Array.from(
      this.ensureTables().exec(
        `SELECT job_id, session_id, capability, display_name, status, error, created_at, updated_at, started_at, completed_at
       FROM mas_async_jobs WHERE session_id = ?
       ORDER BY created_at DESC LIMIT ?`,
        this.sessionKey(),
        Math.max(1, Math.min(100, Math.floor(limit)))
      )
    ) as Array<Record<string, unknown>>;
    return rows.map((row) => {
      if (row.status === "running") {
        const updated = this.getAsyncJob(String(row.job_id));
        if (updated?.status === "failed") return updated;
      }
      return {
        jobId: String(row.job_id),
        sessionId: String(row.session_id),
        capability: String(row.capability),
        label: String(row.display_name),
        status: row.status as AsyncJobStatus,
        error: typeof row.error === "string" ? row.error : undefined,
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
        startedAt: typeof row.started_at === "string" ? row.started_at : undefined,
        completedAt: typeof row.completed_at === "string" ? row.completed_at : undefined,
      };
    });
  }

  /** Real instance-state tool context (issue #668 R3). submitJob is
   * deliberately omitted in 3a — see the header note. */
  private toolContext(): McpToolContext {
    const orm = this.getOrm();
    const sessionId = this.sessionKey();
    const facade = new McpSystemFacade(this.env, orm, sessionId);
    return {
      env: this.env,
      orm,
      sessionId,
      requestId: crypto.randomUUID(),
      facade,
      getJob: (jobId: string) => this.getAsyncJob(jobId),
      listJobs: () =>
        this.listAsyncJobs().map(({ result: _result, ...job }) => job),
      audit: (type: string, agent: AgentName, payload: Record<string, unknown>) =>
        this.audit(type, agent, payload),
    };
  }
}
