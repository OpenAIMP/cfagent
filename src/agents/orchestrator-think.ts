/**
 * Issues #668 (step 3a) + #669 (step 3b) — SHADOW. INERT.
 *
 * The Think-based orchestrator. 3a delivered the static core:
 * constructed-arm model, the full MCP tool surface from real
 * instance state, sanitized step bound, session-memory grounding.
 * 3b adds the turn lifecycle: Judge routing in `beforeTurn`
 * (route → TurnConfig: assembled prompt, tool suppression for
 * auto-research turns, bound), the NLQ pre-dispatch for
 * source-tagged auto-research requests, finish side-effects in the
 * `runShadowChatTurn` driver (assistant recordMessage,
 * judge.evaluate → response.evaluated audit, VectorMemory store),
 * the async-job submit/execute path, and the shared error fallback
 * (src/agents/chatErrorFallback.ts, extracted in 3b).
 *
 * NOT exported from src/server.ts, NOT bound in wrangler, NOT routed
 * — production traffic cannot reach this class (pinned by
 * tests/orchestrator-think-core.test.ts). At cutover (step 4) a class
 * like this one replaces OrchestratorAgent under the stable
 * SEARCH_AGENT name and inherits the existing DO storage.
 *
 * Recorded limitations (see #668 / #669):
 *  - ensureTables creates only the tables this shadow touches
 *    (mas_events, mas_memory, mas_messages, mas_async_jobs). Step 4
 *    must run the FULL live DDL — the subset must not be inherited
 *    silently.
 *  - Tool suppression uses TurnConfig.activeTools: TurnConfig.tools
 *    is additive-only and cannot remove tools, so auto-research
 *    turns set activeTools to the empty set (no tool callable —
 *    identical effect to the live turn's `tools: {}`).
 *  - submitAsyncJob omits the live method's two retention DELETE
 *    sweeps (housekeeping, not turn behavior); the row shape,
 *    scheduling, and audits are identical.
 *  - executeAsyncJob mirrors the live executor's mcp.tool /
 *    task.draft / nlq.execute legs. The http.request leg dispatches
 *    through routeRequest — the routed REST surface that only
 *    exists on the live class until step 4 — so http.request jobs
 *    executed by the shadow fail with an explicit recorded error.
 */
import { Think, type TurnConfig, type TurnContext } from "@cloudflare/think";
import type { ToolSet } from "ai";
import { DatabaseORM } from "../orm";
import { VectorMemory } from "../memory/vector-memory";
import { McpSystemFacade } from "../patterns/facade";
import type { McpToolContext } from "../patterns/interfaces";
import { executeMCPTool } from "../mcp";
import { SqlScanRunStore, SqlStrategyProfileStore } from "../trading";
import type {
  AgentName,
  AgentScheduleItem,
  AsyncJobPayload,
  AsyncJobRecord,
  AsyncJobStatus,
  AsyncJobSubmission,
  Env,
  RouteDecision,
} from "../types";
import { createAgentMcpTools } from "./mcpAdapter";
import { getWorkersAIModel, resolveAiModelName } from "./model";
import { buildOrchestratorSystemPrompt, resolveShadowMaxSteps } from "./chatPrompt";
import { buildChatErrorFallback, type ChatErrorFallbackContext } from "./chatErrorFallback";
import { LLMJudge } from "./judge";
import { executeNaturalLanguageQuery, type NLQSchedulingPort } from "./nlq";
import { getUserDid } from "./did";

/** The live turn's options bag (runAgenticChatTurn), unchanged. */
export interface ShadowChatTurnOptions {
  userText: string;
  recentTurns: Array<{ role?: string; content: string }>;
  userLogin: string;
  isAutoOptionsResearchRequest: boolean;
  /** WS chat only: the originating UI tab, for options-research audit context. */
  sourceTab?: string;
}

/** The route adapter's turn shape (POST /api/chat in mcpChatNlq.ts). */
export interface ShadowChatTurnResult {
  reply: string;
  route: RouteDecision;
  model: string;
  streaming: false;
}

interface PendingTurn extends ShadowChatTurnOptions {
  requestId: string;
  route?: RouteDecision;
}

export class OrchestratorThinkAgent extends Think<Env> {
  private pendingTurn: PendingTurn | undefined;

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
   * Per-turn assembly happens in beforeTurn (#669). */
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
   * independent). Vector recall is query-dependent and is assembled
   * per turn in beforeTurn via assembleGrounding. */
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

  /**
   * Issue #669: Judge routing inside Think's lifecycle — the live
   * runAgenticChatTurn's pre-model stages, in order: route decision
   * (synthetic for source-tagged auto-research, else LLMJudge),
   * route.decided audit, auto-research NLQ pre-dispatch, grounding,
   * prompt assembly. The returned TurnConfig carries the assembled
   * instructions (replacing the context-block assembly wholesale —
   * the memory grounding is inside it via assembleGrounding, not
   * doubled), the sanitized step bound, and tool suppression for
   * auto-research turns.
   *
   * Turn inputs come from the driver's stash; a framework-driven
   * turn without a stash derives them from ctx.messages.
   * Continuation turns keep the assembled config (no re-routing, no
   * duplicate route.decided audit).
   */
  async beforeTurn(ctx: TurnContext): Promise<TurnConfig | void> {
    if (ctx.continuation) return;
    const turn = this.pendingTurn ?? this.deriveTurn(ctx);
    this.pendingTurn = turn;
    const { userText, recentTurns, isAutoOptionsResearchRequest, sourceTab } = turn;

    const judge = new LLMJudge(this.env);
    const route: RouteDecision = isAutoOptionsResearchRequest
      ? {
          agent: "trading",
          confidence: 1,
          reason: "Source-tagged Auto Options Research request; executing its options NLQ workflow directly",
          needsConfirmation: false,
        }
      : await judge.route(userText, recentTurns);
    turn.route = route;
    this.audit("route.decided", "judge", {
      route: route.agent,
      confidence: route.confidence,
      reason: route.reason,
      needsConfirmation: route.needsConfirmation,
    });

    let optionsResearchContext = "";
    if (isAutoOptionsResearchRequest) {
      try {
        const job = await this.submitAsyncJob({
          capability: "nlq.execute",
          payload: { query: userText, userLogin: turn.userLogin },
        });
        optionsResearchContext = [
          "AUTO_OPTIONS_RESEARCH_JOB_SUBMITTED:",
          JSON.stringify({
            query: userText,
            ...job,
          }),
        ].join("\n");
        this.audit("options_research.chat_query_executed", "nlq", {
          query: userText,
          sourceTab: sourceTab,
          jobId: job.jobId,
          status: job.status,
        });
      } catch (error) {
        optionsResearchContext = [
          "AUTO_OPTIONS_RESEARCH_EXECUTION_ERROR:",
          error instanceof Error ? error.message : "The Auto Options Research workflow failed.",
        ].join("\n");
        this.audit("options_research.chat_query_failed", "nlq", {
          query: userText,
          sourceTab: sourceTab,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const { memoryContext, vectorContext } = await this.assembleGrounding(userText);

    return {
      instructions: buildOrchestratorSystemPrompt({
        route,
        memoryContext,
        vectorContext,
        optionsResearchContext,
        isAutoOptionsResearchRequest,
      }),
      maxSteps: this.maxSteps,
      ...(isAutoOptionsResearchRequest ? { activeTools: [] as string[] } : {}),
    };
  }

  /**
   * Issue #669: the runTurn driver — the shadow's analogue of the
   * live onChatMessage glue + route adapter. Records the user
   * message, runs one Think turn in wait mode, applies the live
   * onFinish side-effects, and returns the adapter's turn shape.
   * A failing turn produces the shared deterministic fallback,
   * recorded as the assistant message (the live error path).
   */
  async runShadowChatTurn(opts: ShadowChatTurnOptions): Promise<ShadowChatTurnResult> {
    const turn: PendingTurn = { ...opts, requestId: crypto.randomUUID() };
    this.pendingTurn = turn;
    const model = resolveAiModelName(this.env);

    if (opts.userText) {
      this.recordMessage("user", opts.userText, "orchestrator");
    }

    try {
      const result = await this.runTurn({ input: opts.userText });
      const text = result.message ? this.extractSessionText(result.message) : "";
      const route = turn.route ?? this.unroutedFallback();
      if (text) {
        await this.finishTurnSideEffects(turn, route, text);
      }
      return { reply: text, route, model, streaming: false };
    } catch (err) {
      const fallbackText = await buildChatErrorFallback(
        this.chatErrorFallbackContext(),
        err,
        opts.userText,
        opts.userLogin
      );
      this.recordMessage("assistant", fallbackText, "orchestrator");
      return {
        reply: fallbackText,
        route: turn.route ?? this.unroutedFallback(),
        model,
        streaming: false,
      };
    } finally {
      if (this.pendingTurn === turn) this.pendingTurn = undefined;
    }
  }

  /** The live onFinish body: assistant audit record, judge quality
   * evaluation → response.evaluated audit, VectorMemory store.
   * All best-effort in the same places the live turn is. */
  private async finishTurnSideEffects(
    turn: PendingTurn,
    route: RouteDecision,
    text: string
  ): Promise<void> {
    this.recordMessage("assistant", text, route.agent);
    const judge = new LLMJudge(this.env);
    const quality = await judge.evaluate({ question: turn.userText, answer: text, agent: route.agent });
    this.audit("response.evaluated", "judge", {
      score: quality.score,
      grounded: quality.grounded,
      safe: quality.safe,
      issues: quality.issues,
    });
    try {
      const vectorizeBinding = (this.env as unknown as { VECTOR_MEMORY?: unknown }).VECTOR_MEMORY;
      if (this.env.AI && vectorizeBinding) {
        const vm = new VectorMemory(this.env.AI, vectorizeBinding as never, undefined);
        await vm.remember({
          jobId: turn.requestId,
          operation: `chat:${route.agent}`,
          summary: `Q: ${turn.userText.slice(0, 300)}\nA: ${text.slice(0, 500)}`,
          success: quality.safe !== false && quality.grounded !== false,
          timestamp: new Date().toISOString(),
        });
      }
    } catch (err) {
      console.warn(
        "[VectorMemory] remember failed:",
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  private unroutedFallback(): RouteDecision {
    return {
      agent: "general",
      confidence: 0,
      reason: "Turn completed before a route was decided.",
      needsConfirmation: false,
    };
  }

  /** Derive turn inputs from the assembled model messages when no
   * driver stash exists (framework-driven turns). */
  private deriveTurn(ctx: TurnContext): PendingTurn {
    const texts = ctx.messages.map((m) => ({
      role: typeof m.role === "string" ? m.role : undefined,
      content: this.extractModelText(m),
    }));
    const lastUser = [...texts].reverse().find((m) => m.role === "user");
    return {
      userText: lastUser?.content ?? "",
      recentTurns: texts.slice(-6),
      userLogin: this.sessionKey(),
      isAutoOptionsResearchRequest: false,
      requestId: crypto.randomUUID(),
    };
  }

  private extractModelText(message: { content?: unknown }): string {
    const content = message?.content;
    if (typeof content === "string") return content.trim();
    if (Array.isArray(content)) {
      return content
        .filter(
          (p): p is { type: string; text: string } =>
            !!p && typeof p === "object" && (p as { type?: string }).type === "text" &&
            typeof (p as { text?: unknown }).text === "string"
        )
        .map((p) => p.text)
        .join("")
        .trim();
    }
    return "";
  }

  private extractSessionText(message: { parts?: unknown; content?: unknown }): string {
    if (Array.isArray(message.parts)) {
      return message.parts
        .filter(
          (p): p is { type: string; text: string } =>
            !!p && typeof p === "object" && (p as { type?: string }).type === "text" &&
            typeof (p as { text?: unknown }).text === "string"
        )
        .map((p) => p.text)
        .join("");
    }
    return typeof message.content === "string" ? message.content : "";
  }

  private recordMessage(role: "user" | "assistant" | "system", content: string, agent: AgentName | "orchestrator") {
    try {
      const sql = this.ensureTables();
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      sql.exec(
        "INSERT INTO mas_messages (id, session_id, role, content, agent, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        id,
        this.sessionKey(),
        role,
        content.slice(0, 30000),
        agent,
        now
      );
    } catch {
      // Don't fail execution if record insertion fails
    }
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

  // --- Async jobs (issue #669: the shadow's execution path) ---

  /** Mirror of the live submitAsyncJob: same payload guard, row
   * shape, scheduling, and async_job.queued audit. The live method's
   * two retention DELETE sweeps are omitted (housekeeping, not turn
   * behavior — recorded in the header). */
  private async submitAsyncJob(
    job: AsyncJobSubmission
  ): Promise<{ jobId: string; status: "queued"; statusUrl: string }> {
    const sql = this.ensureTables();
    const payloadJson = JSON.stringify(job.payload);
    if (new TextEncoder().encode(payloadJson).byteLength > 17_000_000) {
      throw new Error("Async job payload exceeds the 17 MB serialized storage limit.");
    }
    const jobId = crypto.randomUUID();
    const now = new Date().toISOString();
    const displayName = job.capability === "http.request"
      ? `${job.payload.method} ${job.payload.pathAndQuery.split("?")[0]}`
      : job.capability === "mcp.tool"
        ? `MCP: ${job.payload.toolName}`
        : job.capability === "nlq.execute"
          ? `NLQ: ${job.payload.query.slice(0, 100)}`
          : `Task: ${job.payload.title}`;
    sql.exec(
      `INSERT INTO mas_async_jobs
        (job_id, session_id, capability, display_name, status, payload_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'queued', ?, ?, ?)`,
      jobId,
      this.sessionKey(),
      job.capability,
      displayName,
      payloadJson,
      now,
      now
    );

    try {
      await this.schedule(0, "executeAsyncJob", { jobId } satisfies AsyncJobPayload, {
        idempotent: true,
        retry: { maxAttempts: 1 },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sql.exec(
        "UPDATE mas_async_jobs SET status = 'failed', error = ?, updated_at = ?, completed_at = ? WHERE job_id = ? AND status = 'queued'",
        `Could not schedule async work: ${message}`,
        new Date().toISOString(),
        new Date().toISOString(),
        jobId
      );
      throw error;
    }

    this.audit("async_job.queued", "orchestrator", { jobId, capability: job.capability });
    return { jobId, status: "queued", statusUrl: `/api/jobs/${jobId}` };
  }

  /** Mirror of the live executeAsyncJob for the capabilities that
   * do not need the routed REST surface; http.request fails
   * explicitly until step 4 (see header). */
  async executeAsyncJob({ jobId }: AsyncJobPayload): Promise<void> {
    const sql = this.ensureTables();
    const now = new Date().toISOString();
    const claimed = sql.exec(
      `UPDATE mas_async_jobs SET status = 'running', started_at = ?, updated_at = ?
       WHERE job_id = ? AND session_id = ? AND status = 'queued'`,
      now,
      now,
      jobId,
      this.sessionKey()
    );
    if (claimed.rowsWritten !== 1) return;

    const rows = Array.from(sql.exec(
      "SELECT capability, payload_json FROM mas_async_jobs WHERE job_id = ? AND session_id = ?",
      jobId,
      this.sessionKey()
    )) as Array<{ capability: string; payload_json: string }>;
    const job = rows[0];
    if (!job) throw new Error(`Async job ${jobId} disappeared after it was claimed.`);

    try {
      const payload = JSON.parse(job.payload_json) as Record<string, unknown>;
      let result: unknown;
      let responseStatus: number | undefined;

      if (job.capability === "http.request") {
        throw new Error(
          "http.request jobs dispatch through routeRequest, the routed REST surface that arrives at cutover (step 4); the shadow cannot execute them."
        );
      } else if (job.capability === "mcp.tool") {
        const toolName = String(payload.toolName || "");
        const args = (payload.arguments || {}) as Record<string, unknown>;
        result = await executeMCPTool(toolName, args, {
          env: this.env,
          orm: this.getOrm(),
          sessionId: this.sessionKey(),
          audit: (type, agent, detail) => this.audit(type, agent, detail),
        });
      } else if (job.capability === "task.draft") {
        result = {
          taskId: `task_${crypto.randomUUID().slice(0, 8)}`,
          status: "draft",
          requiresConfirmation: true,
          ...payload,
          message: "Task draft created. Awaiting human confirmation.",
        };
      } else if (job.capability === "nlq.execute") {
        const query = String(payload.query || "").trim();
        if (!query) throw new Error("NLQ job requires a non-empty query.");
        result = await executeNaturalLanguageQuery(
          this.getOrm(),
          this.sessionKey(),
          query,
          this.env,
          typeof payload.userLogin === "string" ? payload.userLogin : this.sessionKey(),
          getUserDid(this.sessionKey()),
          { scanRunStore: new SqlScanRunStore(this.ctx.storage.sql), profileStore: new SqlStrategyProfileStore(this.ctx.storage.sql), schedulingPort: this.nlqSchedulingPort() }
        );
      } else {
        throw new Error(`Unsupported async capability: ${job.capability}`);
      }

      const serializedResult = JSON.stringify(result);
      if (new TextEncoder().encode(serializedResult).byteLength > 12_000_000) {
        throw new Error("Async job result exceeds the 12 MB serialized result limit.");
      }
      const completedAt = new Date().toISOString();
      sql.exec(
        `UPDATE mas_async_jobs SET status = 'completed', result_json = ?, response_status = ?,
         updated_at = ?, completed_at = ? WHERE job_id = ? AND status = 'running'`,
        serializedResult,
        responseStatus ?? null,
        completedAt,
        completedAt,
        jobId
      );
      this.audit("async_job.completed", "orchestrator", { jobId, capability: job.capability });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const completedAt = new Date().toISOString();
      sql.exec(
        `UPDATE mas_async_jobs SET status = 'failed', error = ?, updated_at = ?, completed_at = ?
         WHERE job_id = ? AND status = 'running'`,
        message,
        completedAt,
        completedAt,
        jobId
      );
      this.audit("async_job.failed", "orchestrator", { jobId, capability: job.capability, error: message });
      console.error(`[OrchestratorThinkAgent] Async job ${jobId} failed:`, error);
    }
  }

  private nlqSchedulingPort(): NLQSchedulingPort {
    return {
      schedule: async (when, callback, payload, options) =>
        (await this.schedule(when, callback as keyof this, payload, options)) as AgentScheduleItem,
      scheduleEvery: async (intervalSeconds, callback, payload) =>
        (await this.scheduleEvery(intervalSeconds, callback as keyof this, payload)) as AgentScheduleItem,
      cancelSchedule: async (id) => await this.cancelSchedule(id),
      listSchedules: async () => (await this.listSchedules()) as AgentScheduleItem[],
    };
  }

  /** The this-bound context for the shared error fallback — the
   * same construction the live class passes (issue #669). */
  private chatErrorFallbackContext(): ChatErrorFallbackContext {
    return {
      env: this.env,
      orm: this.getOrm(),
      sessionId: this.sessionKey(),
      audit: (type, payload) => this.audit(type, "orchestrator", payload),
      scanRunStore: new SqlScanRunStore(this.ctx.storage.sql),
      profileStore: new SqlStrategyProfileStore(this.ctx.storage.sql),
      schedulingPort: this.nlqSchedulingPort(),
    };
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
      CREATE TABLE IF NOT EXISTS mas_messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        agent TEXT NOT NULL,
        created_at TEXT NOT NULL
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

  /** Real instance-state tool context (issue #668 R3), with the
   * submitJob execution path added in #669. */
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
      submitJob: (job) => this.submitAsyncJob(job),
      getJob: (jobId: string) => this.getAsyncJob(jobId),
      listJobs: () =>
        this.listAsyncJobs().map(({ result: _result, ...job }) => job),
      audit: (type: string, agent: AgentName, payload: Record<string, unknown>) =>
        this.audit(type, agent, payload),
    };
  }
}
