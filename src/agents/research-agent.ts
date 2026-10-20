/**
 * Issue #319 — ResearchAgent: the autonomous options-research agent.
 *
 * One agent owns options research end-to-end: configuration (typed, per
 * tenant), scheduled + manual runs through the single pipeline entry,
 * run history, and §9 evaluations. State lives in this DO's SQLite
 * (research_runs / research_settings / research_evaluations).
 *
 * Publication goes through the orchestrator: runResearch() returns the
 * full report and the orchestrator stores the canonical copy via the #308
 * seam (storeReportAtGeneration) on the orchestrator's mas_reports — the
 * table the Reports tab (#318) and AI Search read. This agent never writes
 * mas_reports itself, so there is exactly one searchable copy.
 *
 * READ-ONLY boundary: this agent has no import path to any order-placement
 * function (pinned by tests/research-boundary.test.ts). Research only.
 */

import { Think } from "@cloudflare/think";
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { resolveAiModelName } from "./model";
import type { Env } from "../types";
import { DatabaseORM } from "../orm";
import {
  ResearchConfigService,
  RESEARCH_CONFIG_DEFAULTS,
  type ResearchConfig,
  type ResearchSettingsStore,
} from "../services/researchConfig";
import {
  runResearchPipeline,
  runResearchEvaluation,
  type TriggerSource,
  type ResearchReport,
  type ResearchEvaluation,
  type StoredIdeaRecord,
} from "../services/researchPipeline";
import { EtradeResearchDataProvider } from "../services/researchProviders";
import {
  DEFAULT_STALE_AFTER_MS,
  ResearchTaskLedger,
  type ResearchTask,
  type ResearchTaskEvaluation,
  type ResearchExecutionPath,
  type ResearchTaskStore,
} from "../services/researchTaskLedger";

const LATEST_KEY = "research:latest";
const RESEARCH_PDF_KEY_PREFIX = "research:pdf:";
const RESEARCH_PDF_LATEST_KEY = "research:pdf:latest";
const HISTORY_KEY = "research:history";
const MAX_HISTORY = 20;

export interface ResearchRunRequest {
  trigger: TriggerSource;
  userLogin?: string;
  /** Optional one-off config overrides for this run (still validated). */
  configOverride?: Partial<ResearchConfig>;
}

export interface ResearchRunResult {
  success: boolean;
  report: ResearchReport | null;
  error?: string;
}

export interface ResearchRunSummary {
  runId: string;
  trigger: TriggerSource;
  userLogin: string;
  createdAt: string;
  rulesVersion: string;
  ideas: number;
  watchlist: number;
  rejected: number;
  summary: string;
}

export class ResearchAgent extends Think<Env> {
  /** Think supplies durable chat turns and tool dispatch for research workflows. */
  getModel() {
    return resolveAiModelName(this.env, "researchAgent");
  }

  getSystemPrompt(): string {
    return "You are the read-only options research agent. For a research request, call run_options_research exactly once and then summarize its result faithfully. You may discover, analyze, validate, and recommend strategies, but must never place, preview, or submit trades. Use only source-backed market data; report uncertainty and do not fabricate missing fields.";
  }

  getTools(): ToolSet {
    return {
      run_options_research: tool({
        description: "Run the validated, read-only options research pipeline and persist the resulting report.",
        inputSchema: z.object({
          trigger: z.enum(["manual", "scheduled"]),
          userLogin: z.string().optional(),
        }),
        execute: async (input) => {
          const result = await this.runResearch(input);
          return JSON.stringify({ success: result.success, error: result.error, runId: result.report?.runId, ideas: result.report?.ideas.length, summary: result.report?.summary });
        },
      }),
    };
  }

  private orm: DatabaseORM | null = null;

  private getOrm(): DatabaseORM {
    if (!this.orm) {
      this.orm = new DatabaseORM({
        exec: (sql: string, params?: unknown[]) => {
          const stmt = (this.ctx.storage.sql as any).exec(sql, ...(params ?? []));
          return [...stmt];
        },
      } as any);
    }
    return this.orm;
  }

  private storageSql(): { exec: (sql: string, ...params: unknown[]) => Iterable<unknown> } {
    const storage = this.ctx.storage.sql as any;
    return {
      exec: (sql: string, ...params: unknown[]) => storage.exec(sql, ...params) as Iterable<unknown>,
    };
  }

  private ensureTables(): void {
    const sql = this.storageSql();
    sql.exec(`CREATE TABLE IF NOT EXISTS research_settings (
      key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS research_runs (
      run_id TEXT PRIMARY KEY, trigger TEXT NOT NULL, user_login TEXT NOT NULL,
      created_at TEXT NOT NULL, rules_version TEXT NOT NULL, status TEXT NOT NULL,
      ideas_count INTEGER NOT NULL, report_json TEXT NOT NULL
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS research_evaluations (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL, evaluated_at TEXT NOT NULL,
      evaluation_json TEXT NOT NULL
    )`);
    // Issue #577: durable task ledger store (key/value, same idiom as
    // research_settings — table is created in code, no wrangler migration).
    sql.exec(`CREATE TABLE IF NOT EXISTS research_task_store (
      key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL
    )`);
  }

  /** mas_settings-idiom store over this agent's research_settings table. */
  private settingsStore(): ResearchSettingsStore {
    const sql = this.storageSql();
    return {
      get: (key: string): string | null => {
        try {
          const rows = Array.from(
            sql.exec("SELECT value FROM research_settings WHERE key = ?", key)
          ) as Array<{ value?: unknown }>;
          const v = rows[0]?.value;
          return typeof v === "string" ? v : null;
        } catch {
          return null;
        }
      },
      set: (key: string, value: string): void => {
        const now = new Date().toISOString();
        // DELETE+INSERT (not INSERT OR REPLACE) keeps MockSqlStorage compatible.
        sql.exec("DELETE FROM research_settings WHERE key = ?", key);
        sql.exec(
          "INSERT INTO research_settings (key, value, updated_at) VALUES (?, ?, ?)",
          key,
          value,
          now
        );
      },
    };
  }

  private configService(): ResearchConfigService {
    this.ensureTables();
    return new ResearchConfigService(this.settingsStore());
  }

  /** Issue #577: ledger store over this agent's research_task_store table. */
  private taskStore(): ResearchTaskStore {
    const sql = this.storageSql();
    return {
      get: (key: string): string | null => {
        try {
          const rows = Array.from(
            sql.exec("SELECT value FROM research_task_store WHERE key = ?", key)
          ) as Array<{ value?: unknown }>;
          const v = rows[0]?.value;
          return typeof v === "string" ? v : null;
        } catch {
          return null;
        }
      },
      set: (key: string, value: string): void => {
        const now = new Date().toISOString();
        // DELETE+INSERT (not INSERT OR REPLACE) keeps MockSqlStorage compatible.
        sql.exec("DELETE FROM research_task_store WHERE key = ?", key);
        sql.exec(
          "INSERT INTO research_task_store (key, value, updated_at) VALUES (?, ?, ?)",
          key,
          value,
          now
        );
      },
      delete: (key: string): void => {
        sql.exec("DELETE FROM research_task_store WHERE key = ?", key);
      },
      list: (prefix: string): Array<{ key: string; value: string }> => {
        try {
          const rows = Array.from(
            sql.exec(
              "SELECT key, value FROM research_task_store WHERE key LIKE ?",
              `${prefix}%`
            )
          ) as Array<{ key?: unknown; value?: unknown }>;
          return rows
            .filter((r) => typeof r.key === "string" && typeof r.value === "string")
            .map((r) => ({ key: r.key as string, value: r.value as string }));
        } catch {
          return [];
        }
      },
    };
  }

  private taskLedger(): ResearchTaskLedger {
    this.ensureTables();
    return new ResearchTaskLedger(this.taskStore());
  }

  /**
   * Issue #577 — durable task record for a delegated research run.
   * The orchestrator creates + begins a task before dispatch and
   * completes/fails it afterwards; the record lives with the work.
   */
  async createResearchTask(input: {
    trigger: "manual" | "scheduled";
    userLogin: string;
    idempotencyKey: string;
  }): Promise<{ task: ResearchTask; created: boolean }> {
    return this.taskLedger().create(input);
  }

  /** Claim + start a queued task (the coordinator begins the work). */
  async beginResearchTask(id: string): Promise<ResearchTask> {
    const ledger = this.taskLedger();
    ledger.claim(id);
    return ledger.start(id);
  }

  /** Issue #624: refresh a task's heartbeat during a long run. */
  async heartbeatResearchTask(id: string): Promise<ResearchTask> {
    return this.taskLedger().heartbeat(id);
  }

  async completeResearchTask(
    id: string,
    outcome: {
      path: ResearchExecutionPath;
      reportRunId: string;
      evaluation: ResearchTaskEvaluation;
    }
  ): Promise<ResearchTask> {
    return this.taskLedger().complete(id, outcome);
  }

  /** Fail a task; escalate=true leaves it in `escalated` for a human. */
  async failResearchTask(
    id: string,
    error: string,
    escalate: boolean
  ): Promise<ResearchTask> {
    const ledger = this.taskLedger();
    const failed = ledger.fail(id, error);
    return escalate ? ledger.escalate(id, "research run failed; awaiting human review") : failed;
  }

  async getResearchTask(id: string): Promise<ResearchTask | null> {
    return this.taskLedger().get(id);
  }

  async listResearchTasks(limit = 50): Promise<ResearchTask[]> {
    return this.taskLedger().list(limit);
  }

  /** Issue #615 (R4): active research tasks whose heartbeat aged out. */
  async findStaleResearchTasks(
    staleAfterMs: number = DEFAULT_STALE_AFTER_MS
  ): Promise<ResearchTask[]> {
    return this.taskLedger().findStale(staleAfterMs);
  }

  /** Issue #615 (R4): close stale research tasks as failed → escalated. */
  async sweepStaleResearchTasks(
    staleAfterMs: number = DEFAULT_STALE_AFTER_MS
  ): Promise<ResearchTask[]> {
    return this.taskLedger().sweepStale(staleAfterMs);
  }

  /** Issue #635: delete terminal task records past the retention tiers. */
  async pruneExpiredResearchTasks(): Promise<string[]> {
    return this.taskLedger().pruneExpired();
  }

  /** Typed config read (amendment 1: the single config owner). */
  async getResearchConfig(): Promise<ResearchConfig> {
    return this.configService().load();
  }

  /** Typed config write; invalid patches are rejected atomically. */
  async saveConfig(
    patch: Partial<ResearchConfig>
  ): Promise<{ config: ResearchConfig; errors: string[] }> {
    return this.configService().save(patch);
  }

  /**
   * THE pipeline entry for this agent. Runs the full OODA research loop
   * and persists the run record. Publication (canonical store) is the
   * orchestrator's job — see runResearchAndPublish.
   */
  async runResearch(req: ResearchRunRequest): Promise<ResearchRunResult> {
    const userLogin = req.userLogin || "default";
    try {
      this.ensureTables();
      const service = this.configService();
      let config = service.load();
      if (req.configOverride) {
        const merged = service.save(req.configOverride);
        if (merged.errors.length > 0) {
          return {
            success: false,
            report: null,
            error: `Invalid config override: ${merged.errors.join("; ")}`,
          };
        }
        config = merged.config;
      }
      const provider = new EtradeResearchDataProvider(this.env, userLogin);
      const report = await runResearchPipeline(
        { provider },
        config,
        { trigger: req.trigger, userLogin }
      );
      await this.persistRun(report);
      return { success: true, report };
    } catch (err) {
      return {
        success: false,
        report: null,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async getLatest(): Promise<ResearchReport | null> {
    try {
      return (await this.ctx.storage.get<ResearchReport>(LATEST_KEY)) ?? null;
    } catch {
      return null;
    }
  }

  /**
   * #335: store the run's PDF (delivery artifact, rendered from the canonical
   * stored report). Per-run key + latest pointer, mirroring the screener PDF
   * pattern (#361). #605: blobs go to R2 when bound, else legacy DO storage.
   * Best-effort — never throws.
   */
  async storeResearchPdf(
    fileName: string,
    bytes: Uint8Array
  ): Promise<string | null> {
    try {
      const { putReportPdf } = await import("../services/reportBlobStore");
      const perRunKey = `${RESEARCH_PDF_KEY_PREFIX}${fileName}`;
      await putReportPdf(this.env, this.ctx.storage, perRunKey, fileName, bytes);
      await putReportPdf(this.env, this.ctx.storage, RESEARCH_PDF_LATEST_KEY, fileName, bytes);
      return perRunKey;
    } catch (err) {
      console.warn("[ResearchAgent] PDF store failed:", err);
      return null;
    }
  }

  /**
   * #335: fetch a stored research PDF by key (or "latest").
   * #605: reads from R2 when bound, else legacy DO storage.
   */
  async getResearchPdfByKey(
    pdfKey: string
  ): Promise<{ bytes: Uint8Array; fileName: string } | null> {
    try {
      const { getReportPdf } = await import("../services/reportBlobStore");
      const key = pdfKey === "latest" ? RESEARCH_PDF_LATEST_KEY : pdfKey;
      return await getReportPdf(this.env, this.ctx.storage, key);
    } catch {
      return null;
    }
  }

  /**
   * #336: pre-entry refresh. Re-fetch live quotes for the shortlisted ideas
   * and flag any that moved materially or went stale since the run. Returns
   * one flag per affected idea; empty means "no change". Best-effort — never
   * throws; a provider failure yields no flags, not a failed delivery.
   */
  async refreshIdeaQuotes(
    report: ResearchReport,
    userLogin?: string
  ): Promise<
    Array<{ symbol: string; status: "moved" | "stale"; detail: string }>
  > {
    const flags: Array<{
      symbol: string;
      status: "moved" | "stale";
      detail: string;
    }> = [];
    try {
      const provider = new EtradeResearchDataProvider(
        this.env,
        userLogin || report.userLogin || "default"
      );
      for (const idea of (report.ideas ?? []).slice(0, 5)) {
        let quote: { price?: number | null } | null = null;
        try {
          quote = await provider.getQuote(idea.symbol);
        } catch {
          quote = null;
        }
        if (!quote || quote.price == null || !Number.isFinite(quote.price)) {
          flags.push({
            symbol: idea.symbol,
            status: "stale",
            detail: "No live quote at delivery time — entry price unverified.",
          });
          continue;
        }
        const entry = idea.entrySpot;
        if (entry > 0) {
          const movePct = ((quote.price - entry) / entry) * 100;
          if (Math.abs(movePct) >= 2) {
            flags.push({
              symbol: idea.symbol,
              status: "moved",
              detail: `Underlying moved ${movePct >= 0 ? "+" : ""}${movePct.toFixed(2)}% since entry reference $${entry.toFixed(2)} (now $${quote.price.toFixed(2)}).`,
            });
          }
        }
      }
    } catch (err) {
      console.warn("[ResearchAgent] Pre-entry refresh failed:", err);
    }
    return flags;
  }

  async getHistory(): Promise<ResearchRunSummary[]> {
    try {
      return (await this.ctx.storage.get<ResearchRunSummary[]>(HISTORY_KEY)) ?? [];
    } catch {
      return [];
    }
  }

  /**
   * Issue #340: the track record — every published run's ideas joined
   * to their latest §9 evaluations. Read-only over the stored rows;
   * never throws (an empty record on any failure).
   */
  async getTrackRecord(): Promise<import("../services/researchTrackRecord").TrackRecord> {
    const { buildTrackRecord } = await import("../services/researchTrackRecord");
    try {
      this.ensureTables();
      const sql = this.storageSql();
      const runRows = Array.from(
        sql.exec("SELECT report_json FROM research_runs ORDER BY created_at DESC")
      ) as Array<{ report_json?: unknown }>;
      const evalRows = Array.from(
        sql.exec("SELECT evaluation_json FROM research_evaluations ORDER BY evaluated_at ASC")
      ) as Array<{ evaluation_json?: unknown }>;
      const parse = (v: unknown): unknown => {
        if (typeof v !== "string") return null;
        try {
          return JSON.parse(v);
        } catch {
          return null;
        }
      };
      return buildTrackRecord(
        runRows.map((r) => parse(r.report_json)),
        evalRows.map((r) => parse(r.evaluation_json))
      );
    } catch {
      return buildTrackRecord([], []);
    }
  }

  /**
   * §9 evaluation pass: compare a published run's ideas against later
   * prices. Reads the stored run; writes an evaluation row; never mutates
   * the original report.
   */
  async evaluateRun(runId: string, userLogin?: string): Promise<ResearchEvaluation | null> {
    try {
      this.ensureTables();
      const sql = this.storageSql();
      const rows = Array.from(
        sql.exec("SELECT report_json FROM research_runs WHERE run_id = ?", runId)
      ) as Array<{ report_json?: unknown }>;
      const raw = rows[0]?.report_json;
      if (typeof raw !== "string") return null;
      const report = JSON.parse(raw) as ResearchReport;
      const ideas: StoredIdeaRecord[] = report.ideas.map((idea) => ({
        runId: report.runId,
        symbol: idea.symbol,
        structure: idea.structure,
        legs: idea.legs,
        economics: idea.economics,
        thesis: idea.thesis,
        invalidation: idea.invalidation,
        entrySpot: idea.entrySpot,
        quoteTimestamp: idea.quoteTimestamp,
        rulesVersion: report.rulesVersion,
        createdAt: report.createdAt,
        outlook: (idea as { outlook?: StoredIdeaRecord["outlook"] }).outlook,
      }));
      const provider = new EtradeResearchDataProvider(this.env, userLogin || "default");
      const config = this.configService().load();
      const evaluation = await runResearchEvaluation(
        { provider },
        ideas,
        runId,
        config
      );
      const id = `eval_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      sql.exec(
        "INSERT INTO research_evaluations (id, run_id, evaluated_at, evaluation_json) VALUES (?, ?, ?, ?)",
        id,
        runId,
        evaluation.evaluatedAt,
        JSON.stringify(evaluation)
      );
      // #584 EP-009: meter the evaluation — attributed to tenant + task.
      try {
        const { recordUsageEvent } = await import(
          "../services/scheduledReports"
        );
        recordUsageEvent(this.storageSql(), {
          userLogin: userLogin || "default",
          runId,
          category: "research_evaluation",
          detail: { ideas: evaluation.ideas.length },
        });
      } catch {
        // Metering is advisory.
      }
      return evaluation;
    } catch {
      return null;
    }
  }

  /**
   * #583 docx §9: evaluate runs due for follow-up — runs older than
   * `minAgeMs` with no evaluation row yet (oldest first, capped).
   * Best-effort: per-run failures are recorded as nulls, never thrown.
   */
  async evaluateDueRuns(
    userLogin?: string,
    minAgeMs = 24 * 3600 * 1000,
    nowMs = Date.now(),
    limit = 5
  ): Promise<{ evaluated: string[]; failed: string[] }> {
    const evaluated: string[] = [];
    const failed: string[] = [];
    try {
      this.ensureTables();
      const sql = this.storageSql();
      const runs = Array.from(
        sql.exec("SELECT run_id, created_at FROM research_runs")
      ) as Array<{ run_id?: unknown; created_at?: unknown }>;
      const evalRows = Array.from(
        sql.exec("SELECT run_id FROM research_evaluations")
      ) as Array<{ run_id?: unknown }>;
      const evaluatedIds = new Set(
        evalRows
          .map((r) => r.run_id)
          .filter((id): id is string => typeof id === "string")
      );
      const { selectRunsDueForEvaluation } = await import(
        "../services/researchPipeline"
      );
      const due = selectRunsDueForEvaluation(
        runs
          .filter(
            (r): r is { run_id: string; created_at: string } =>
              typeof r.run_id === "string" && typeof r.created_at === "string"
          )
          .map((r) => ({ runId: r.run_id, createdAt: r.created_at })),
        evaluatedIds,
        nowMs,
        minAgeMs,
        limit
      );
      for (const runId of due) {
        const res = await this.evaluateRun(runId, userLogin);
        (res ? evaluated : failed).push(runId);
      }
    } catch {
      // Best-effort: a scheduling pass must never break the tick.
    }
    return { evaluated, failed };
  }

  private async persistRun(report: ResearchReport): Promise<void> {
    try {
      await this.ctx.storage.put(LATEST_KEY, report);
      const history = await this.getHistory();
      history.unshift({
        runId: report.runId,
        trigger: report.trigger,
        userLogin: report.userLogin,
        createdAt: report.createdAt,
        rulesVersion: report.rulesVersion,
        ideas: report.ideas.length,
        watchlist: report.watchlist.length,
        rejected: report.rejected.length,
        summary: report.summary,
      });
      await this.ctx.storage.put(HISTORY_KEY, history.slice(0, MAX_HISTORY));

      const sql = this.storageSql();
      const reportJson = JSON.stringify(report);
      sql.exec("DELETE FROM research_runs WHERE run_id = ?", report.runId);
      sql.exec(
        `INSERT INTO research_runs
           (run_id, trigger, user_login, created_at, rules_version, status, ideas_count, report_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        report.runId,
        report.trigger,
        report.userLogin,
        report.createdAt,
        report.rulesVersion,
        report.ideas.length > 0 ? "published" : "no_qualifying",
        report.ideas.length,
        reportJson
      );
    } catch {
      // Non-critical: a persistence failure must not fail the run itself.
    }
  }
}

/** Re-exported for the boundary test's module inventory. */
export const RESEARCH_AGENT_TABLES = [
  "research_settings",
  "research_runs",
  "research_evaluations",
] as const;

export const RESEARCH_DEFAULTS = RESEARCH_CONFIG_DEFAULTS;
