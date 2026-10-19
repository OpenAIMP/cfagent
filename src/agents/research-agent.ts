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

import { Agent } from "agents";
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

const LATEST_KEY = "research:latest";
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

export class ResearchAgent extends Agent<Env> {
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

  /** Typed config read (amendment 1: the single config owner). */
  async getConfig(): Promise<ResearchConfig> {
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

  async getHistory(): Promise<ResearchRunSummary[]> {
    try {
      return (await this.ctx.storage.get<ResearchRunSummary[]>(HISTORY_KEY)) ?? [];
    } catch {
      return [];
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
      return evaluation;
    } catch {
      return null;
    }
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
