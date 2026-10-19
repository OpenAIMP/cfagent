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
} from "../trading";
import { fetchTechnicalsBatch } from "../trading";
import {
  UNIVERSES,
  shardableUniverses,
  resolveUniverse,
  type UniverseId,
} from "../trading";
import type { NasdaqStockListing } from "../services/nasdaqListings";
import { DEFAULT_SCREENER_CONFIG } from "../trading";
import type { StockScreenerFilter } from "../types";

export interface ScreenerRunRequest {
  /** Who triggered the screen. */
  trigger: "manual" | "scheduled";
  /** Manual: user filters (search/limit/price-range/trend). Scheduled: { sector }. */
  filters?: StockScreenerFilter;
  /** Scheduled: sector label (default "Technology"). */
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
  /** Per-run PDF key populated by persistRun after the PDF is stored. */
  pdfKey?: string;
  error?: string;
}

const LATEST_KEY = "screener:latest";
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

  private userLogin(): string {
    return "default_trader";
  }

  /**
   * Run a screen. E*TRADE-only market data — throws honestly when
   * E*TRADE is unavailable (no fallback substitution).
   */
  async runScreen(req: ScreenerRunRequest): Promise<ScreenerRunResult> {
    const timestamp = new Date().toISOString();
    const cfg = DEFAULT_SCREENER_CONFIG;
    const sector = req.sector || req.filters?.sector || cfg.acquisition.defaultSector;
    const screener = new DynamicMarketScreener();
    const userLogin = req.userLogin || this.userLogin();
    const universe: UniverseId = req.universe ?? "TECH";

    try {
      const etrade = new ETradeService(
        this.getOrm(),
        this.env,
        userLogin
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
      // E*TRADE-only acquisition (#261). Symbols come from the listings
      // directory (not market data); quotes come from E*TRADE or nothing.
      const acquired = await acquireUniverse({
        mode: "etrade-only",
        symbols,
        maxSymbols: req.maxSymbols ?? universeDef.defaultMaxSymbols,
        liveDeps: { fetchETradeQuote: (sym) => etrade.fetchQuoteRemote(sym) },
      });
      const expectedCount = Math.min(
        symbols?.length ?? universeDef.defaultMaxSymbols,
        req.maxSymbols ?? universeDef.defaultMaxSymbols,
      );

      const screenResult = screenUniverse(screener, acquired, {
        ...(req.filters ?? {}),
        sector,
      });

      // Issue #269: Yahoo history complement — real RSI/MACD/gaps.
      // E*TRADE stays the primary quote source; Yahoo fills only the
      // history-shaped hole. Per-symbol failures → honest nulls.
      const technicalsBySymbol = await fetchTechnicalsBatch(
        acquired.quotes.map((q) => q.symbol)
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
      };

      await this.persistRun(result);
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
        expectedCount: 0,
        matchedCount: 0,
        opportunities: [],
        allStocks: [],
        discoveryMessage: "",
        error: message,
      };
      await this.persistRun(result);
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
   */
  async getLatestPdf(): Promise<{ bytes: Uint8Array; fileName: string } | null> {
    const stored = await this.ctx.storage.get<{ base64: string; fileName: string }>(PDF_LATEST_KEY);
    if (!stored) return null;
    const bin = atob(stored.base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { bytes, fileName: stored.fileName };
  }

  /**
   * Get a specific run's PDF by its storage key (issue #297).
   */
  async getPdfByKey(pdfKey: string): Promise<{ bytes: Uint8Array; fileName: string } | null> {
    const stored = await this.ctx.storage.get<{ base64: string; fileName: string }>(pdfKey);
    if (!stored) return null;
    const bin = atob(stored.base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { bytes, fileName: stored.fileName };
  }

  /**
   * Get the latest options PDF (issue #361).
   */
  async getLatestOptionsPdf(): Promise<{ bytes: Uint8Array; fileName: string } | null> {
    const stored = await this.ctx.storage.get<{ base64: string; fileName: string }>(OPTIONS_PDF_LATEST_KEY);
    if (!stored) return null;
    const bin = atob(stored.base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { bytes, fileName: stored.fileName };
  }

  /**
   * Get a specific options run's PDF by its storage key (issue #361).
   */
  async getOptionsPdfByKey(pdfKey: string): Promise<{ bytes: Uint8Array; fileName: string } | null> {
    const stored = await this.ctx.storage.get<{ base64: string; fileName: string }>(pdfKey);
    if (!stored) return null;
    const bin = atob(stored.base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { bytes, fileName: stored.fileName };
  }

  /**
   * Store an options PDF (issue #361). Called from scheduledTasks after generation.
   */
  async storeOptionsPdf(base64: string, fileName: string): Promise<string> {
    const pdfData = { base64, fileName };
    const perRunKey = `${OPTIONS_PDF_KEY_PREFIX}${fileName}`;
    await this.ctx.storage.put(perRunKey, pdfData);
    await this.ctx.storage.put(OPTIONS_PDF_LATEST_KEY, pdfData);
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
    try {
      const { generateScreenerPdf, screenerPdfFileName } = await import(
        "../trading"
      );
      const pdfBytes = await generateScreenerPdf(result);
      let base64 = "";
      const chunk = 8192;
      for (let i = 0; i < pdfBytes.length; i += chunk) {
        base64 += String.fromCharCode(...pdfBytes.subarray(i, i + chunk));
      }
      const fileName = screenerPdfFileName(result);
      const pdfData = {
        base64: btoa(base64),
        fileName,
      };
      // Store with per-run unique key
      const perRunKey = `${PDF_KEY_PREFIX}${fileName}`;
      await this.ctx.storage.put(perRunKey, pdfData);
      // Also update the "latest" pointer for backward compatibility
      await this.ctx.storage.put(PDF_LATEST_KEY, pdfData);
      // Store the key on the result for the UI to fetch the specific PDF
      result.pdfKey = perRunKey;
    } catch (err) {
      console.warn("[ScreenerAgent] PDF generation failed:", err);
    }
  }
}
