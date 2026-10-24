/**
 * ScreenerAgent (issue #261) — the dedicated screening agent.
 *
 * Owns ALL stock screening: manual triggers and the scheduled tick run
 * through this agent, one backend, one frontend. Listing stocks adds no
 * value — the job is to SCREEN (filter to what matters).
 *
 * Market data is provider-scoped (issue #1007): the default provider
 * is E*TRADE; a run may instead name the Yahoo Finance data-source
 * adapter (provider "yahoo", the FOSS surface). A provider changes
 * data provenance only — semantics, scoring, result shape and
 * persistence are identical. If the named provider is unavailable the
 * screen fails honestly (e.g. "E*TRADE unavailable" / "Yahoo Finance
 * unavailable") — no cross-provider fallback, no zero-filled
 * substitute rows.
 *
 * State is persisted via ctx.storage (Durable Object storage).
 */

import { Agent } from "agents";
import type { Env } from "../types";
import { getServiceUserLogin } from "../security/serviceIdentity";
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
  yahooDepsFromProvider,
  type StockScreenProvider,
  type UniverseId,
} from "../trading";
import { YahooFinanceProvider } from "../services/fossResearch";
import {
  bindETradeScreenerDeps,
  bootstrapDataProviders,
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
import {
  DynamicOptionsScreener,
  type ScreeningProviderAssetClass,
} from "../trading";
import type { OptionScreenerFilter } from "../types";
import type { ScenarioDefinition } from "../services/goalScenarioEngine";
import type { GoalDrivenScreenResult } from "../services/goalDrivenScreen";

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
  /**
   * Issue #1007: data provider for this run (default "etrade"). The
   * Yahoo provider quotes through the Yahoo data-source adapter; it
   * never touches E*TRADE and never falls back to it.
   */
  provider?: StockScreenProvider;
  /**
   * Issue #1007: test seam — an injected Yahoo quote fetcher for
   * provider "yahoo" runs (mirrors the pipeline's yahooDeps). Absent
   * in production, where YahooFinanceProvider is constructed here.
   */
  yahooDeps?: import("../trading").YahooScreenerDeps;
}

export interface ScreenerRunResult {
  timestamp: string;
  trigger: "manual" | "scheduled";
  /** Issue #1007: the data provider that produced this run. */
  provider: StockScreenProvider;
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
  /** Summary of criteria applied during screening. */
  filterSummary?: string;
  /**
   * Issue #462: set when the screen ran on an incomplete quote set. The
   * result is a qualified partial report — never a complete screen, never
   * a failure. Zero quotes still fails honestly (success:false + error).
   */
  partial?: PartialQuoteQualification;
  /** Issue #728: per-symbol rejection reasons for the Slack breakdown. */
  rejections?: { symbol: string; reason: string }[];
  /**
   * Issue #1184 (#1173 R2): technicals coverage for this run — how
   * many quoted symbols the Yahoo history leg actually produced
   * MACD / gap values for. Recorded so a technicals outage is data
   * (the 2026-10-23 run showed blank MACD/Gap on every row with no
   * signal anywhere that history coverage was zero).
   */
  technicalsCoverage?: { symbols: number; withMacd: number; withGap: number };
  /** Per-run PDF key populated by persistRun after the PDF is stored. */
  pdfKey?: string;
  /** Issue #822: explicit PDF generation status. 'failed' means generatePdfAsset
   *  threw or returned null — the publisher must NOT fall back to a stale PDF. */
  pdfStatus?: "generated" | "failed" | "skipped";
  /** When pdfStatus is 'failed', the error that caused it. */
  pdfError?: string;
  /** Per-run XLSX key populated by persistRun after the XLSX report is stored. */
  xlsxKey?: string;
  xlsxStatus?: "generated" | "failed" | "skipped";
  xlsxError?: string;
  /** Issue #816: quote pipeline trace summary for the UI. */
  quoteTrace?: {
    traceId: string;
    symbolCount: number;
    batchCount: number;
    quotesReceived: number;
    quotesFailed: number;
    failuresByCategory: Record<string, number>;
    batches: Array<{
      batchIndex: number;
      symbolCount: number;
      httpStatus: number | null;
      quotesReceived: number;
      failures: Array<{ symbol: string; category: string; detail: string }>;
      durationMs: number;
    }>;
  };
  error?: string;
  /** Duplicate scheduled delivery was suppressed by the shared per-user DO. */
  skippedDuplicate?: boolean;
  /** Issue #607: durable task record id for this run (screener task ledger). */
  taskId?: string;
  /** Issue #1157 (E2): the data-provider platform run id for
   *  E*TRADE-provider runs — minted at run start, carried in every
   *  capture the run's quote fetches write, and stamped here so the
   *  result and its captures share one identity. Absent for
   *  non-E*TRADE providers (their platform cutover is a later slice). */
  runId?: string;
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
// XLSX report storage
const XLSX_KEY_PREFIX = "screener:xlsx:";
const XLSX_LATEST_KEY = "screener:latest.xlsx";
// Issue #361: Options PDF storage (mirrors stock pattern). Since #1023
// (single PDF path) per-run options PDFs are generated + stored by
// ReportAssetAgent and addressed by its key; this constant remains only
// as the read key for getLatestOptionsPdf's legacy local lookup.
const OPTIONS_PDF_LATEST_KEY = "options:latest.pdf";
/** Issue #1195 (#1173 R3b): options XLSX storage keys. */
const OPTIONS_XLSX_KEY_PREFIX = "options:xlsx:";
const OPTIONS_XLSX_LATEST_KEY = "options:latest.xlsx";

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

  private static OWNER_STORAGE_KEY = "screener:owner-login";

  /**
   * Issue #1185: record this instance's owner at entry — the login the
   * orchestrator threaded from the validated session header (or the
   * schedule's stored owner) when dispatching work to this instance.
   */
  private async recordOwner(userLogin: string): Promise<void> {
    if (userLogin) {
      await this.ctx.storage.put(ScreenerAgent.OWNER_STORAGE_KEY, userLogin);
    }
  }

  /**
   * Issue #1185: this instance's owner login — the owner recorded at
   * entry; before any entry, the instance name itself encodes it
   * (`screener:<login>`; the bare shared instance belongs to the
   * configured service identity). Fail closed when none exists: there
   * is no synthetic shared identity to attribute runs or reports to.
   */
  private async userLogin(): Promise<string> {
    const recorded = await this.ctx.storage.get<string>(ScreenerAgent.OWNER_STORAGE_KEY);
    if (recorded) return recorded;
    const name = this.name ?? "";
    if (name.startsWith("screener:")) return name.slice("screener:".length);
    if (name === "default") {
      const serviceLogin = getServiceUserLogin(this.env);
      if (serviceLogin) return serviceLogin;
    }
    throw new Error("ScreenerAgent has no owner identity recorded for this instance (issue #1185: no default identity).");
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
   * Run a screen through the one pipeline. Market data comes from the
   * run's provider (E*TRADE by default, or the Yahoo adapter) — a
   * provider failure surfaces honestly (no fallback substitution).
   */
  async runScreen(req: ScreenerRunRequest): Promise<ScreenerRunResult> {
    const timestamp = new Date().toISOString();
    const cfg = DEFAULT_SCREENER_CONFIG;
    // Issue #828: prevent concurrent runs for same user/universe.
    // Multiple clicks were spawning parallel runs that exhausted the
    // Cloudflare subrequest budget and spammed Slack with partials.
    // Issue #1185: the run's owner is the request's threaded login;
    // record it at entry so later reads on this instance resolve to
    // the same owner. Without one, the recorded/derived owner applies.
    if (req.userLogin) await this.recordOwner(req.userLogin);
    const lockKey = `screen_lock:${await this.userLogin()}:${req.universe || "nasdaq100"}`;
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
    const userLogin = req.userLogin || (await this.userLogin());
    const universe: UniverseId = req.universe ?? "TECH";
    // Issue #1007: the run's data provider (default E*TRADE). Recorded
    // on every result — success, duplicate and failure alike — so the
    // canonical report provenance always names its provider.
    const provider: StockScreenProvider = req.provider ?? "etrade";
    let expectedCount = 0;

    // Issue #607: durable task record for this run (mandate §6; design
    // in docs/agents/agentic-architecture.md §5/§7). Scheduled runs key
    // on their minute slot — the same identity claimScheduledExecution
    // dedups on — so duplicate deliveries share one record; manual
    // runs key on their own timestamp. Ledger failures never break a
    // screen: warn and continue untracked.
    let taskId: string | null = null;
    // Issue #1157 (E2): the platform run id for E*TRADE-provider
    // runs — minted when the run's quote deps are bound (below),
    // stamped on the result (success and failure alike).
    let platformRunId: string | undefined;
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
          provider,
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
      // Issue #1007: the E*TRADE service is constructed only for
      // E*TRADE-provider runs. A Yahoo-provider run never touches the
      // broker (no credentials read, no token lookup) and never falls
      // back to it.
      const etrade = provider === "etrade"
        ? new ETradeService(
            this.getOrm(),
            this.env,
            userLogin,
            req.environment
          )
        : null;

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
      // Issue #816: create a QuoteTrace to capture the pipeline details for the UI.
      const { QuoteTrace } = await import("../trading");
      const quoteTrace = new QuoteTrace();
      quoteTrace.setNasdaqSymbols(selectedSymbols.map(s => typeof s === 'string' ? s : s.symbol));
      // Issue #1157 (E2): E*TRADE-provider runs acquire through the
      // data-provider platform: bootstrap this DO's platform store
      // (seed + enable etrade), mint the run id, and bind the live
      // deps to the adapter (batch via getQuotesBatch, per-symbol
      // via getQuote — the QuoteTrace rides along unchanged). The
      // pipeline consumes the same LiveScreenerDeps signatures as
      // the direct bindings they replace; non-E*TRADE modes are
      // untouched. (The deps type is taken from the binding helper's
      // return — the #290 boundary keeps trading-internal type paths
      // out of this module; only the barrel is imported.)
      let platformLiveDeps: ReturnType<typeof bindETradeScreenerDeps> | undefined;
      if (etrade) {
        bootstrapDataProviders(this.ctx.storage.sql);
        platformRunId = crypto.randomUUID();
        platformLiveDeps = bindETradeScreenerDeps(
          etrade,
          {
            sql: this.ctx.storage.sql,
            blobStorage: this.ctx.storage,
            env: this.env,
          },
          { runId: platformRunId, userLogin },
          quoteTrace
        );
      }
      // Provider-scoped acquisition (#261, #1007). Symbols come from
      // the listings directory (membership, not market data) for both
      // providers; quotes come from the named provider or nothing.
      const acquired = provider === "yahoo"
        ? await acquireUniverse({
            mode: "yahoo",
            symbols: selectedSymbols,
            maxSymbols: selectedSymbols.length,
            yahooDeps:
              req.yahooDeps ??
              yahooDepsFromProvider(new YahooFinanceProvider(this.env)),
          })
        : await acquireUniverse({
            mode: "etrade-only",
            symbols: selectedSymbols,
            maxSymbols: selectedSymbols.length,
            liveDeps: platformLiveDeps!,
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
      // Issue #1184 (#1173 R2): record technicals coverage on the
      // result — symbols quoted vs symbols with real MACD / gap
      // values. Zero coverage after a throttle storm is now visible
      // in the run record instead of silently blank columns.
      const technicalsCoverage = {
        symbols: acquired.quotes.length,
        withMacd: [...technicalsBySymbol.values()].filter((t) => t.macdLine != null).length,
        withGap: [...technicalsBySymbol.values()].filter((t) => t.gapPercent != null).length,
      };

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
        provider,
        universe,
        sector,
        success: true,
        totalScanned: screenResult.totalScanned,
        expectedCount,
        matchedCount: screenResult.matchedCount,
        opportunities,
        allStocks,
        discoveryMessage: acquired.discovery.message,
        technicalsCoverage,
        filterSummary: screenResult.filterSummary,
        ...(acquired.partial ? { partial: acquired.partial } : {}),
        // Issue #728: rejection reasons for the Slack breakdown.
        ...(screenResult.ledger?.rejections?.length
          ? { rejections: screenResult.ledger.rejections }
          : {}),
      };
      if (taskId) result.taskId = taskId;
      // Issue #1157 (E2): stamp the platform run id (E*TRADE runs).
      if (platformRunId) result.runId = platformRunId;
      // Issue #706: record which learnings were applied.
      if (appliedLearnings.length > 0) result.appliedLearnings = appliedLearnings;
      // Issue #816: attach the quote pipeline trace summary for the UI.
      const traceSummary = quoteTrace.complete();
      result.quoteTrace = {
        traceId: traceSummary.traceId,
        symbolCount: traceSummary.uniqueSymbolCount,
        batchCount: traceSummary.batchesTotal,
        quotesReceived: traceSummary.quotesReceived,
        quotesFailed: traceSummary.quotesFailed,
        failuresByCategory: traceSummary.failuresByCategory as Record<string, number>,
        batches: [], // Detailed batch info available in logs via traceId
      };

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
        provider,
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
        ...(platformRunId ? { runId: platformRunId } : {}),
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
  /**
   * Consolidation C1 (issue #1201, epic #1151 R1): run a goal-driven
   * screen (epic #1096 Phase 3 semantics) as a production citizen of
   * this agent — the Phase 0 registry over production engines,
   * executed under this DO's screener task ledger (the same ledger
   * store runScreen uses). The composition lives in
   * services/screeningRuntime.ts (runProductionGoalScreen); this
   * method only binds the DO-owned pieces: the ledger and the
   * E*TRADE client behind the options leg. A duplicate delivery
   * returns the existing ledger record without re-executing.
   */
  async runGoalScreen(req: {
    scenario: ScenarioDefinition;
    trigger: "manual" | "scheduled";
    idempotencyKey: string;
    userLogin?: string;
    environment?: "TEST" | "PROD";
    assetClasses?: ScreeningProviderAssetClass[];
    symbols?: string[];
    baseStockFilter?: StockScreenerFilter;
    baseOptionsFilter?: OptionScreenerFilter;
  }): Promise<{ task: ScreenerTask; executed: boolean; result?: GoalDrivenScreenResult }> {
    const userLogin = req.userLogin || (await this.userLogin());
    const etrade = new ETradeService(
      this.getOrm(),
      this.env,
      userLogin,
      req.environment
    );
    const { runProductionGoalScreen } = await import("../services/screeningRuntime");
    return runProductionGoalScreen({
      ledger: this.taskLedger(),
      optionsScreener: new DynamicOptionsScreener(etrade.client),
      scenario: req.scenario,
      trigger: req.trigger,
      idempotencyKey: req.idempotencyKey,
      userLogin,
      assetClasses: req.assetClasses,
      symbols: req.symbols,
      baseStockFilter: req.baseStockFilter,
      baseOptionsFilter: req.baseOptionsFilter,
    });
  }

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
    const local = await getReportPdf(this.env, this.ctx.storage, PDF_LATEST_KEY);
    if (local) return local;
    const { getPdfAsset } = await import("./report-asset-agent");
    return await getPdfAsset(this.env, await this.userLogin(), PDF_LATEST_KEY);
  }

  /**
   * Get a specific run's PDF by its storage key (issue #297).
   */
  async getPdfByKey(pdfKey: string): Promise<{ bytes: Uint8Array; fileName: string } | null> {
    const { getReportPdf } = await import("../services/reportBlobStore");
    const local = await getReportPdf(this.env, this.ctx.storage, pdfKey);
    if (local) return local;
    const { getPdfAsset } = await import("./report-asset-agent");
    return await getPdfAsset(this.env, await this.userLogin(), pdfKey);
  }

  /**
   * Latest report XLSX — generated at run time, served by GET /api/screener/report.xlsx.
   */
  async getLatestXlsx(): Promise<{ bytes: Uint8Array; fileName: string } | null> {
    const { getReportPdf } = await import("../services/reportBlobStore");
    return await getReportPdf(this.env, this.ctx.storage, XLSX_LATEST_KEY);
  }

  /**
   * Get a specific run's XLSX report by its storage key.
   */
  async getXlsxByKey(xlsxKey: string): Promise<{ bytes: Uint8Array; fileName: string } | null> {
    const { getReportPdf } = await import("../services/reportBlobStore");
    return await getReportPdf(this.env, this.ctx.storage, xlsxKey);
  }

  /**
   * Get the latest options PDF (issue #361).
   */
  async getLatestOptionsPdf(): Promise<{ bytes: Uint8Array; fileName: string } | null> {
    const { getReportPdf } = await import("../services/reportBlobStore");
    const local = await getReportPdf(this.env, this.ctx.storage, OPTIONS_PDF_LATEST_KEY);
    if (local) return local;
    const { getPdfAsset } = await import("./report-asset-agent");
    return await getPdfAsset(this.env, await this.userLogin(), OPTIONS_PDF_LATEST_KEY);
  }

  /**
   * Get a specific options run's PDF by its storage key (issue #361).
   */
  async getOptionsPdfByKey(pdfKey: string): Promise<{ bytes: Uint8Array; fileName: string } | null> {
    const { getReportPdf } = await import("../services/reportBlobStore");
    const local = await getReportPdf(this.env, this.ctx.storage, pdfKey);
    if (local) return local;
    const { getPdfAsset } = await import("./report-asset-agent");
    return await getPdfAsset(this.env, await this.userLogin(), pdfKey);
  }

  /**
   * Issue #1195 (#1173 R3b): generate an options run's XLSX report
   * and store it under a per-run key (+ the latest pointer), the
   * options twin of the stock XLSX block in persistRun. Throws on
   * failure — callers record xlsxStatus "failed" with the error,
   * mirroring the stock convention.
   */
  async generateAndStoreOptionsXlsx(
    result: import("../types").OptionScreenResult,
  ): Promise<{ key: string; fileName: string }> {
    const { generateOptionsXlsx, optionsXlsxFileName } = await import("../trading");
    const { putReportPdf } = await import("../services/reportBlobStore");
    const bytes = generateOptionsXlsx(result);
    const fileName = optionsXlsxFileName(result);
    const key = `${OPTIONS_XLSX_KEY_PREFIX}${crypto.randomUUID().slice(0, 8)}`;
    await putReportPdf(this.env, this.ctx.storage as any, key, fileName, bytes);
    await putReportPdf(this.env, this.ctx.storage as any, OPTIONS_XLSX_LATEST_KEY, fileName, bytes);
    return { key, fileName };
  }

  /** Get a specific options run's XLSX report by its storage key (#1195). */
  async getOptionsXlsxByKey(xlsxKey: string): Promise<{ bytes: Uint8Array; fileName: string } | null> {
    const { getReportPdf } = await import("../services/reportBlobStore");
    return await getReportPdf(this.env, this.ctx.storage, xlsxKey);
  }

  /** Get the latest options XLSX report (#1195). */
  async getLatestOptionsXlsx(): Promise<{ bytes: Uint8Array; fileName: string } | null> {
    const { getReportPdf } = await import("../services/reportBlobStore");
    return await getReportPdf(this.env, this.ctx.storage, OPTIONS_XLSX_LATEST_KEY);
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
    // Issue #914: Use the unified report pipeline (shared by stock + options,
    // manual + scheduled).
    const { runReportPipeline } = await import("../services/unifiedReportPipeline");
    const { putReportPdf, getReportPdf } = await import("../services/reportBlobStore");
    const pipelineResult = await runReportPipeline(
      this.env,
      this.ctx.storage as any,
      {
        type: "screener",
        trigger: result.trigger === "manual" ? "manual" : "scheduled",
        result,
        userLogin: await this.userLogin(),
        title: `Market screen — ${String((result as any).universe ?? (result as any).sector ?? "ALL")}`,
        summary: result.success
          ? `Scanned ${result.totalScanned} symbols, ${result.matchedCount} matched.`
          : `Screen failed: ${(result as any).error ?? "unknown error"}.`,
        timestamp: result.timestamp,
      }
    );
    if (pipelineResult.pdfStatus === "generated") {
      // Keep the "latest" pointer for backward compatibility.
      let stored = await getReportPdf(this.env, this.ctx.storage as any, pipelineResult.pdfKey);
      if (!stored) {
        const { getPdfAsset } = await import("./report-asset-agent");
        stored = await getPdfAsset(this.env, await this.userLogin(), pipelineResult.pdfKey);
      }
      if (stored) {
        await putReportPdf(this.env, this.ctx.storage as any, pipelineResult.pdfKey, stored.fileName, stored.bytes);
        await putReportPdf(this.env, this.ctx.storage as any, PDF_LATEST_KEY, stored.fileName, stored.bytes);
      }
      result.pdfKey = pipelineResult.pdfKey;
      result.pdfStatus = "generated";
    } else {
      // Issue #1023 (S4): NO direct-generator fallback — the unified
      // pipeline is the only PDF path (#914/#680). Issue #822: do NOT
      // swallow. Record the failure explicitly so the publisher knows
      // not to fall back to a stale PDF.
      result.pdfStatus = "failed";
      result.pdfError = pipelineResult.pdfError;
      console.error("[ScreenerAgent] PDF generation failed:", result.pdfError);
    }

    // XLSX Multi-tab report generation (Screened Stocks + Formulas & Methodology)
    try {
      const { generateScreenerXlsx, screenerXlsxFileName } = await import("../trading");
      const xlsxBytes = generateScreenerXlsx(result);
      const xlsxFileName = screenerXlsxFileName(result);
      const xlsxKey = `${XLSX_KEY_PREFIX}${crypto.randomUUID().slice(0, 8)}`;
      await putReportPdf(this.env, this.ctx.storage as any, xlsxKey, xlsxFileName, xlsxBytes);
      await putReportPdf(this.env, this.ctx.storage as any, XLSX_LATEST_KEY, xlsxFileName, xlsxBytes);
      result.xlsxKey = xlsxKey;
      result.xlsxStatus = "generated";
    } catch (xlsxErr) {
      result.xlsxStatus = "failed";
      result.xlsxError = xlsxErr instanceof Error ? xlsxErr.message : String(xlsxErr);
      console.error("[ScreenerAgent] XLSX generation failed:", result.xlsxError);
    }
    // Issue #783: no report-store write happens here. The #732 block that
    // persisted a second copy into this DO's own report table is removed:
    // nothing read that copy. The canonical report copy for a run is
    // stored exactly once by OrchestratorAgent at generation time (the
    // store every report surface reads — Reports tab, routes, AI Search);
    // this method keeps only the delivery cache above (latest/history in
    // DO storage + the per-run PDFs).
  }
}
