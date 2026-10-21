/**
 * ScreenerAgent (issue #261) — the dedicated screening agent.
 *
 * Owns ALL stock screening: manual triggers and the scheduled tick run
 * through this agent, one backend, one frontend. Listing stocks adds no
 * value — the job is to SCREEN (filter to what matters).
 *
 * Market data is E*TRADE-only. If E*TRADE is unavailable the screen fails
 * honestly ("E*TRADE unavailable") — no Nasdaq fallback, no zero-filled
 * substitute rows. (Nasdaq/curated implementations are kept in the repo,
 * unwired, per #261.)
 *
 * State is persisted via ctx.storage (Durable Object storage).
 */

import { Agent } from "agents";
import type { Env } from "../types";
import { DatabaseORM } from "../orm";
import { ETradeService } from "../services/etrade";
import { DynamicMarketScreener } from "../trading";
import {
  acquireUniverse,
  screenUniverse,
  selectStandouts,
  buildAllStocks,
  attachFactorGrades,
  attachTechnicals,
  toOpportunityStock,
  type ScannedStock,
  type OpportunityStock,
  type PartialQuoteQualification,
} from "../trading";
import { fetchTechnicalsBatch } from "../trading";
import {
  UNIVERSES,
  shardableUniverses,
  resolveUniverse,
  type UniverseId,
} from "../trading";
import type { NasdaqStockListing } from "../services/nasdaqListings";
import {
  DEFAULT_STALE_AFTER_MS,
  ScreenerTaskLedger,
  evaluateScreenerOutcome,
  type ScreenerTask,
  type ScreenerTaskEvaluation,
  type ScreenerTaskStore,
} from "../services/screenerTaskLedger";
import { DEFAULT_SCREENER_CONFIG } from "../trading";
import type { StockScreenerFilter } from "../types";

export interface ScreenerRunRequest {
  /** Who triggered the screen. */
  trigger: "manual" | "scheduled";
  /** Manual: user filters (search/limit/price-range/trend). Scheduled: { sector }. */
  filters?: StockScreenerFilter;
  /** Scheduled: sector label (issue #421: "ALL" when none was selected). */
  sector?: string;
  /** Universe to screen (default "TECH"). "ALL" auto-shards (see runSharded). */
  universe?: UniverseId;
  /** Scheduled: max standout opportunities (default 5). */
  maxItems?: number;
  /** Optional explicit symbol universe (overrides universe selector). */
  symbols?: NasdaqStockListing[];
  /** Cap on symbols quoted via E*TRADE (default: universe default). */
  maxSymbols?: number;
  /** User login for E*TRADE auth scoping. */
  userLogin?: string;
  /** E*TRADE environment selected by the signed-in user. */
  environment?: "TEST" | "PROD";
}

export interface ScreenerRunResult {
  timestamp: string;
  trigger: "manual" | "scheduled";
  /** Universe screened (issue #270). */
  universe: UniverseId;
  sector: string;
  success: boolean;
  totalScanned: number;
  /** Symbols selected for this run before E*TRADE quote failures. */
  expectedCount?: number;
  matchedCount: number;
  /** Standout opportunities (the screening result — what matters). */
  opportunities: OpportunityStock[];
  /** Full scanned set with provenance (for the results table). */
  allStocks: ScannedStock[];
  discoveryMessage: string;
  /**
   * Issue #462: set when the screen ran on an incomplete quote set. The
   * result is a qualified partial report — never a complete screen, never
   * a failure. Zero quotes still fails honestly (success:false + error).
   */
  partial?: PartialQuoteQualification;
  /** Issue #728: per-symbol rejection reasons for the Slack breakdown. */
  rejections?: { symbol: string; reason: string }[];
  /** Per-run PDF key populated by persistRun after the PDF is stored. */
  pdfKey?: string;
  /** Issue #822: explicit PDF generation status. 'failed' means generatePdfAsset
   *  threw or returned null — the publisher must NOT fall back to a stale PDF. */
  pdfStatus?: "generated" | "failed" | "skipped";
  /** When pdfStatus is 'failed', the error that caused it. */
  pdfError?: string;
  error?: string;
  /** Duplicate scheduled delivery was suppressed by the shared per-user DO. */
  skippedDuplicate?: boolean;
  /** Issue #607: durable task record id for this run (screener task ledger). */
  taskId?: string;
  /** Issue #706: learnings applied at run start. */
  appliedLearnings?: string[];
}

const LATEST_KEY = "screener:latest";
/** Issue #624: minimum interval between task heartbeat writes during a run. */
const SCREENER_HEARTBEAT_MIN_MS = 60_000;
const HISTORY_KEY = "screener:history";
// Issue #297: Per-run PDF storage (not a single shared key).
// Each run gets its own key to prevent franken-PDFs.
const PDF_KEY_PREFIX = "screener:pdf:";
const PDF_LATEST_KEY = "screener:latest.pdf";
// Issue #361: Options PDF storage (mirrors stock pattern).
const OPTIONS_PDF_KEY_PREFIX = "options:pdf:";
const OPTIONS_PDF_LATEST_KEY = "options:latest.pdf";

export class ScreenerAgent extends Agent<Env> {
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

  async claimScheduledExecution(jobKey: string, environment?: string): Promise<boolean> {
    const slot = new Date().toISOString().slice(0, 16);
    const key = `screening:scheduled:last-slot:${environment || "PROD"}:${jobKey}`;
    const storage = this.ctx.storage as any;
    if (typeof storage.transaction === "function") {
      return storage.transaction(async (txn: any) => {
        const current = await txn.get(key) as { slot: string } | undefined;
        if (current?.slot === slot) return false;
        await txn.put(key, { environment, jobKey, slot });
        return true;
      });
    }
    const current = await storage.get(key) as { slot?: string } | undefined;
    if (current?.slot === slot) return false;
    await storage.put(key, { environment, jobKey, slot });
    return true;
  }

  private userLogin(): string {
    return "default_trader";
  }

  /**
   * Issue #607: task-ledger store over this agent's Durable Object storage.
   * Ledger keys live under screener:task: / screener:idem: — alongside
   * the run blobs, in the same per-account Durable Object.
   */
  private taskStore(): ScreenerTaskStore {
    const storage = this.ctx.storage as any;
    return {
      get: async (key: string): Promise<string | null> => {
        try {
          const v = await storage.get(`screener:${key}`);
          return typeof v === "string" ? v : null;
        } catch {
          return null;
        }
      },
      set: async (key: string, value: string): Promise<void> => {
        await storage.put(`screener:${key}`, value);
      },
      delete: async (key: string): Promise<void> => {
        await storage.delete(`screener:${key}`);
      },
      list: async (
        prefix: string
      ): Promise<Array<{ key: string; value: string }>> => {
        try {
          const map = (await storage.list({ prefix: `screener:${prefix}` })) as Map<
            string,
            unknown
          >;
          return [...map.entries()]
            .filter(([, v]) => typeof v === "string")
            .map(([key, value]) => ({ key, value: value as string }));
        } catch {
          return [];
        }
      },
    };
  }

  private taskLedger(): ScreenerTaskLedger {
    return new ScreenerTaskLedger(this.taskStore());
  }

  /**
   * Issue #607 — durable task record for a screener run. runScreen
   * creates + begins a task before screening and resolves it on every
   * exit path; the record lives with the work in this DO.
   */
  async createScreenerTask(input: {
    trigger: "manual" | "scheduled";
    universe: string;
    sector: string;
    userLogin?: string;
    idempotencyKey: string;
  }): Promise<{ task: ScreenerTask; created: boolean }> {
    return this.taskLedger().create(input);
  }

  /** Claim + start a queued task (the run begins). */
  async beginScreenerTask(id: string): Promise<ScreenerTask> {
    const ledger = this.taskLedger();
    await ledger.claim(id);
    return ledger.start(id);
  }

  /** Issue #624: refresh a task's heartbeat during a long run. */
  async heartbeatScreenerTask(id: string): Promise<ScreenerTask> {
    return this.taskLedger().heartbeat(id);
  }

  async completeScreenerTask(
    id: string,
    outcome: {
      runTimestamp: string;
      totalScanned: number;
      matchedCount: number;
      opportunitiesCount: number;
      partial: boolean;
      evaluation: ScreenerTaskEvaluation;
    }
  ): Promise<ScreenerTask> {
    return this.taskLedger().complete(id, outcome);
  }

  /** Fail a task; escalate=true leaves it in `escalated` for a human. */
  async failScreenerTask(
    id: string,
    error: string,
    escalate: boolean
  ): Promise<ScreenerTask> {
    const ledger = this.taskLedger();
    const failed = await ledger.fail(id, error);
    return escalate
      ? ledger.escalate(id, "screener run failed; awaiting human review")
      : failed;
  }

  /** Close a task that will not run (e.g. a suppressed duplicate). */
  async cancelScreenerTask(id: string, note?: string): Promise<ScreenerTask> {
    return this.taskLedger().cancel(id, note);
  }

  async getScreenerTask(id: string): Promise<ScreenerTask | null> {
    return this.taskLedger().get(id);
  }

  async listScreenerTasks(limit = 50): Promise<ScreenerTask[]> {
    return this.taskLedger().list(limit);
  }

  /** Issue #615 (R4): active screener tasks whose heartbeat aged out. */
  async findStaleScreenerTasks(
    staleAfterMs: number = DEFAULT_STALE_AFTER_MS
  ): Promise<ScreenerTask[]> {
    return this.taskLedger().findStale(staleAfterMs);
  }

  /** Issue #615 (R4): close stale screener tasks as failed → escalated. */
  async sweepStaleScreenerTasks(
    staleAfterMs: number = DEFAULT_STALE_AFTER_MS
  ): Promise<ScreenerTask[]> {
    return this.taskLedger().sweepStale(staleAfterMs);
  }

  /** Issue #635: delete terminal task records past the retention tiers. */
  async pruneExpiredScreenerTasks(): Promise<string[]> {
    return this.taskLedger().pruneExpired();
  }

  /**
   * Run a screen. E*TRADE-only market data — throws honestly when
   * E*TRADE is unavailable (no fallback substitution).
   */
  async runScreen(req: ScreenerRunRequest): Promise<ScreenerRunResult> {
    const timestamp = new Date().toISOString();
    const cfg = DEFAULT_SCREENER_CONFIG;
    // Issue #828: prevent concurrent runs for same user/universe.
    // Multiple clicks were spawning parallel runs that exhausted the
    // Cloudflare subrequest budget and spammed Slack with partials.
    const lockKey = `screen_lock:${this.userLogin()}:${req.universe || "nasdaq100"}`;
    const existingLock = await this.ctx.storage.get<string>(lockKey);
    if (existingLock) {
      const lockAge = Date.now() - parseInt(existingLock, 10);
      // Stale lock (>5 min) — assume the previous run died, take over.
      if (lockAge < 5 * 60 * 1000) {
        throw new Error(`Screen already running for ${req.universe || "nasdaq100"} (started ${Math.round(lockAge / 1000)}s ago). Please wait for it to complete.`);
      }
      console.warn(`[ScreenerAgent] Stale lock detected (${Math.round(lockAge / 1000)}s old), taking over.`);
    }
    await this.ctx.storage.put(lockKey, Date.now().toString());
    try {
      return await this.runScreenInner(req, timestamp, cfg);
    } finally {
      // Always release the lock, even on failure.
      await this.ctx.storage.delete(lockKey);
    }
  }

  private async runScreenInner(req: ScreenerRunRequest, timestamp: string, cfg: typeof DEFAULT_SCREENER_CONFIG): Promise<ScreenerRunResult> {
    // Issue #706: read active learnings at run start; log which ones applied.
    let appliedLearnings: string[] = [];
    try {
      const { getActiveLearnings } = await import("../services/learnings");
      const learnings = getActiveLearnings(this.sql, "screener");
      appliedLearnings = learnings.map((l) => `${l.id}: ${l.observation.slice(0, 80)}`);
      if (learnings.length > 0) {
        console.log(`[ScreenerAgent] Applied ${learnings.length} learnings:`, appliedLearnings);
      }
    } catch {}
    // Issue #421: a run's sector label states what was actually screened.
    // When no sector was selected, the screen covered every sector in the
    // universe → "ALL" (header renderers suppress it) — never the config
    // default, which made NASDAQ100 reports claim "Technology sector".
    const sector = req.sector || req.filters?.sector || "ALL";
    const screener = new DynamicMarketScreener();
    const userLogin = req.userLogin || this.userLogin();
    const universe: UniverseId = req.universe ?? "TECH";
    let expectedCount = 0;

    // Issue #607: durable task record for this run (mandate §6; design
    // in docs/agents/agentic-architecture.md §5/§7). Scheduled runs key
    // on their minute slot — the same identity claimScheduledExecution
    // dedups on — so duplicate deliveries share one record; manual
    // runs key on their own timestamp. Ledger failures never break a
    // screen: warn and continue untracked.
    let taskId: string | null = null;
    try {
      const created = await this.createScreenerTask({
        trigger: req.trigger,
        universe,
        sector,
        userLogin,
        idempotencyKey:
          req.trigger === "scheduled"
            ? `screener:scheduled:${universe}:${sector}:${timestamp.slice(0, 16)}`
            : `screener:manual:${universe}:${sector}:${timestamp}`,
      });
      taskId = created.task.id;
      if (created.task.status === "queued") {
        await this.beginScreenerTask(taskId);
      }
    } catch (err) {
      console.warn(
        `[ScreenerAgent] Screener task ledger unavailable (create/begin): ${err instanceof Error ? err.message : String(err)}`
      );
      taskId = null;
    }

    // Issue #624: phase-checkpoint heartbeats for this run's task,
    // throttled to at most one ledger write per minute, so a long run
    // never looks stale (#615) without amplifying storage writes.
    let lastHeartbeatMs = Date.now();
    const beat = async (): Promise<void> => {
      if (!taskId) return;
      const nowMs = Date.now();
      if (nowMs - lastHeartbeatMs < SCREENER_HEARTBEAT_MIN_MS) return;
      lastHeartbeatMs = nowMs;
      try {
        await this.heartbeatScreenerTask(taskId);
      } catch {
        // Ledger is best-effort; a missed heartbeat never breaks a screen.
      }
    };

    try {
      if (req.trigger === "scheduled" && !(await this.claimScheduledExecution(`stock:${universe}`, req.environment))) {
        const dupResult: ScreenerRunResult = {
          timestamp,
          trigger: req.trigger,
          universe,
          sector,
          success: false,
          totalScanned: 0,
          expectedCount: 0,
          matchedCount: 0,
          opportunities: [],
          allStocks: [],
          discoveryMessage: "Duplicate scheduled delivery suppressed for this account, environment, universe, and minute.",
          skippedDuplicate: true,
          ...(taskId ? { taskId } : {}),
        };
        // Issue #607: a suppressed duplicate closes as cancelled —
        // it never ran, so it must not read as completed or failed.
        if (taskId) {
          try {
            await this.cancelScreenerTask(
              taskId,
              "duplicate scheduled delivery suppressed"
            );
          } catch {
            // Ledger is best-effort; the suppression result stands.
          }
        }
        return dupResult;
      }
      const etrade = new ETradeService(
        this.getOrm(),
        this.env,
        userLogin,
        req.environment
      );

      // Issue #270: resolve the universe to symbols (listings directory
      // = symbol membership only, not market data). E*TRADE-only quotes.
      const universeDef = UNIVERSES[universe];
      let symbols = req.symbols;
      if (!symbols && universe !== "ALL") {
        const { fetchAllUsStockListings } = await import(
          "../services/nasdaqListings"
        );
        const listings = await fetchAllUsStockListings();
        symbols = resolveUniverse(universe, listings);
      }
      const requestedMaxSymbols = req.maxSymbols ?? universeDef.defaultMaxSymbols;
      const selectedSymbols = symbols
        ? (requestedMaxSymbols > 0 ? symbols.slice(0, requestedMaxSymbols) : symbols)
        : [];
      expectedCount = selectedSymbols.length;
      // E*TRADE-only acquisition (#261). Symbols come from the listings
      // directory (not market data); quotes come from E*TRADE or nothing.
      const acquired = await acquireUniverse({
        mode: "etrade-only",
        symbols: selectedSymbols,
        maxSymbols: selectedSymbols.length,
        liveDeps: {
          fetchETradeQuote: (sym) => etrade.fetchQuoteRemote(sym),
          // Issue #495: quote the universe in batch requests (2 calls for
          // NASDAQ100) instead of one request per symbol.
          fetchETradeQuotes: (syms) => etrade.fetchQuotesRemote(syms),
        },
      });
      await beat();
      const screenResult = screenUniverse(screener, acquired, {
        ...(req.filters ?? {}),
        sector,
      });

      // Issue #269: Yahoo history complement — real RSI/MACD/gaps.
      // E*TRADE stays the primary quote source; Yahoo fills only the
      // history-shaped hole. Per-symbol failures → honest nulls.
      const technicalsBySymbol = await fetchTechnicalsBatch(
        acquired.quotes.map((q) => q.symbol),
        undefined,
        undefined,
        () => beat()
      );

      // Issue #266: SA-style factor grades, computed percentile-relative
      // across the full scanned universe, then joined onto opportunities.
      const allStocks = attachTechnicals(
        attachFactorGrades(buildAllStocks(acquired.quotes, screenResult.stocks)),
        technicalsBySymbol
      );
      const bySymbol = new Map(allStocks.map((s) => [s.symbol, s]));
      const opportunities = selectStandouts(
        screenResult.stocks,
        req.maxItems ?? cfg.acquisition.defaultMaxItems
      ).map((s) => {
        const opp = toOpportunityStock(s);
        const graded = bySymbol.get(s.symbol);
        return graded
          ? { ...opp, factorGrades: graded.factorGrades, technicals: graded.technicals }
          : opp;
      });

      const result: ScreenerRunResult = {
        timestamp,
        trigger: req.trigger,
        universe,
        sector,
        success: true,
        totalScanned: screenResult.totalScanned,
        expectedCount,
        matchedCount: screenResult.matchedCount,
        opportunities,
        allStocks,
        discoveryMessage: acquired.discovery.message,
        ...(acquired.partial ? { partial: acquired.partial } : {}),
        // Issue #728: rejection reasons for the Slack breakdown.
        ...(screenResult.ledger?.rejections?.length
          ? { rejections: screenResult.ledger.rejections }
          : {}),
      };
      if (taskId) result.taskId = taskId;
      // Issue #706: record which learnings were applied.
      if (appliedLearnings.length > 0) result.appliedLearnings = appliedLearnings;

      await beat();
      await this.persistRun(result);
      // Issue #607: complete the task with a deterministic honesty
      // evaluation of the outcome. Best-effort — the run stands either way.
      if (taskId) {
        try {
          const evaluation = evaluateScreenerOutcome(
            {
              success: result.success,
              runTimestamp: result.timestamp,
              totalScanned: result.totalScanned,
              matchedCount: result.matchedCount,
              opportunities: result.opportunities.length,
              partial: !!result.partial,
              qualificationPresent: !!result.partial,
              error: result.error ?? null,
            },
            new Date().toISOString()
          );
          await this.completeScreenerTask(taskId, {
            runTimestamp: result.timestamp,
            totalScanned: result.totalScanned,
            matchedCount: result.matchedCount,
            opportunitiesCount: result.opportunities.length,
            partial: !!result.partial,
            evaluation,
          });
        } catch (err) {
          console.warn(
            `[ScreenerAgent] Screener task ledger unavailable (complete): ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
      return result;
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Screener failed";
      const result: ScreenerRunResult = {
        timestamp,
        trigger: req.trigger,
        universe,
        sector,
        success: false,
        totalScanned: 0,
        expectedCount,
        matchedCount: 0,
        opportunities: [],
        allStocks: [],
        discoveryMessage: "",
        error: message,
        ...(taskId ? { taskId } : {}),
      };
      await this.persistRun(result);
      // Issue #607: a failed screen escalates its task for a human
      // instead of existing only as a result blob nobody may open.
      if (taskId) {
        try {
          await this.failScreenerTask(taskId, message, true);
        } catch {
          // Ledger is best-effort; the failure result stands either way.
        }
      }
      return result;
    }
  }

  /** Latest run for the unified results UI. */
  async getLatest(): Promise<ScreenerRunResult | null> {
    return (await this.ctx.storage.get<ScreenerRunResult>(LATEST_KEY)) ?? null;
  }

  /** Recent run history, newest first (capped). */
  async getHistory(): Promise<ScreenerRunResult[]> {
    return (await this.ctx.storage.get<ScreenerRunResult[]>(HISTORY_KEY)) ?? [];
  }

  /**
   * Sharded run (issue #270): "ALL" fans out into parallel per-universe
   * screens. Each shard runs the full pipeline (E*TRADE + Yahoo + grades +
   * PDF) and persists under its own universe key. Returns one result per
   * universe, in shardableUniverses() order.
   */
  async runSharded(
    req: Omit<ScreenerRunRequest, "universe" | "symbols">
  ): Promise<ScreenerRunResult[]> {
    const shards = shardableUniverses();
    return Promise.all(
      shards.map((universe) => this.runScreen({ ...req, universe }))
    );
  }

  /**
   * Latest report PDF (issue #269, #297) — generated at run time, served by
   * GET /api/screener/report.pdf and attached to Slack/email deliveries.
   * Issue #297: Also stores per-run PDFs with unique keys to prevent
   * franken-PDFs from concurrent runs overwriting each other.
   * Issue #605: blobs live in R2 when bound, else legacy DO storage.
   */
  async getLatestPdf(): Promise<{ bytes: Uint8Array; fileName: string } | null> {
    const { getReportPdf } = await import("../services/reportBlobStore");
    return getReportPdf(this.env, this.ctx.storage, PDF_LATEST_KEY);
  }

  /**
   * Get a specific run's PDF by its storage key (issue #297).
   */
  async getPdfByKey(pdfKey: string): Promise<{ bytes: Uint8Array; fileName: string } | null> {
    const { getReportPdf } = await import("../services/reportBlobStore");
    return getReportPdf(this.env, this.ctx.storage, pdfKey);
  }

  /**
   * Get the latest options PDF (issue #361).
   */
  async getLatestOptionsPdf(): Promise<{ bytes: Uint8Array; fileName: string } | null> {
    const { getReportPdf } = await import("../services/reportBlobStore");
    return getReportPdf(this.env, this.ctx.storage, OPTIONS_PDF_LATEST_KEY);
  }

  /**
   * Get a specific options run's PDF by its storage key (issue #361).
   */
  async getOptionsPdfByKey(pdfKey: string): Promise<{ bytes: Uint8Array; fileName: string } | null> {
    const { getReportPdf } = await import("../services/reportBlobStore");
    return getReportPdf(this.env, this.ctx.storage, pdfKey);
  }

  /**
   * Store an options PDF (issue #361). Called from scheduledTasks after generation.
   */
  async storeOptionsPdf(base64: string, fileName: string): Promise<string> {
    const { putReportPdf } = await import("../services/reportBlobStore");
    const perRunKey = `${OPTIONS_PDF_KEY_PREFIX}${fileName}`;
    // storeOptionsPdf receives base64; decode once, then store via the blob store.
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    await putReportPdf(this.env, this.ctx.storage, perRunKey, fileName, bytes);
    await putReportPdf(this.env, this.ctx.storage, OPTIONS_PDF_LATEST_KEY, fileName, bytes);
    return perRunKey;
  }

  private async persistRun(result: ScreenerRunResult): Promise<void> {
    await this.ctx.storage.put(LATEST_KEY, result);
    const history =
      (await this.ctx.storage.get<ScreenerRunResult[]>(HISTORY_KEY)) ?? [];
    await this.ctx.storage.put(
      HISTORY_KEY,
      [result, ...history].slice(0, DEFAULT_SCREENER_CONFIG.acquisition.historyLimit)
    );
    // Issue #269: generate + store the report PDF for download/delivery.
    // Issue #297: Store with per-run key (not shared) to prevent franken-PDFs.
    // Issue #605: blobs go to R2 when bound, else legacy DO storage.
    // Issue #680: generation is owned by ReportAssetAgent.
    try {
      const { generatePdfAsset } = await import("./report-asset-agent");
      const asset = await generatePdfAsset(this.env, this.userLogin(), "screener", result);
      if (asset) {
        // Keep the "latest" pointer for backward compatibility.
        const { putReportPdf, getReportPdf } = await import("../services/reportBlobStore");
        const stored = await getReportPdf(this.env, this.ctx.storage as any, asset.key);
        if (stored) {
          await putReportPdf(this.env, this.ctx.storage as any, PDF_LATEST_KEY, stored.fileName, stored.bytes);
        }
        result.pdfKey = asset.key;
        result.pdfStatus = "generated";
      } else {
        // generatePdfAsset returned null — treat as failure, not silent skip.
        result.pdfStatus = "failed";
        result.pdfError = "generatePdfAsset returned null";
        console.error("[ScreenerAgent] PDF generation returned null for run", result.timestamp);
      }
    } catch (err) {
      // Issue #822: do NOT swallow. Record the failure explicitly so the
      // publisher knows not to fall back to a stale PDF.
      result.pdfStatus = "failed";
      result.pdfError = err instanceof Error ? err.message : String(err);
      console.error("[ScreenerAgent] PDF generation failed:", err instanceof Error ? err.message : String(err));
    }
    // Issue #732: persist to mas_reports so the Reports tab shows scheduled runs.
    // The tab reads from SQL, but persistRun only wrote to DO storage.
    try {
      const { persistScheduledReportSql } = await import("../services/scheduledReports");
      const orm = this.getOrm();
      const sql = {
        exec: (query: string, ...params: unknown[]) => orm.execQuery(query, ...params),
      } as any;
      persistScheduledReportSql(sql, {
        runId: `${result.universe}:${result.timestamp}`,
        title: `Market Screen — ${result.universe} · ${result.trigger === "manual" ? "Manual" : "Scheduled"}`,
        source: "screener",
        summary: `Scanned ${result.totalScanned}, ${result.matchedCount} matched.`,
        body: JSON.stringify({
          universe: result.universe,
          sector: result.sector,
          totalScanned: result.totalScanned,
          matchedCount: result.matchedCount,
          opportunities: result.opportunities,
          timestamp: result.timestamp,
        }),
        userLogin: this.userLogin(),
      });
    } catch (err) {
      // Issue #832: Store must be atomic. If mas_reports write fails,
      // fail the run loudly — don't silently continue to Deliver.
      // The Reports tab and Slack must see the same data.
      const message = err instanceof Error ? err.message : String(err);
      console.error("[ScreenerAgent] mas_reports persistence FAILED:", message);
      throw new Error(`Failed to persist report metadata: ${message}`);
    }
  }
}
