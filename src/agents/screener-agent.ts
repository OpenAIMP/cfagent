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
import { DynamicMarketScreener } from "../trading/screener";
import {
  acquireUniverse,
  screenUniverse,
  selectStandouts,
  buildAllStocks,
  toOpportunityStock,
  type ScannedStock,
  type OpportunityStock,
} from "../trading/screenerPipeline";
import type { NasdaqStockListing } from "../services/nasdaqListings";
import type { StockScreenerFilter } from "../types";

export interface ScreenerRunRequest {
  /** Who triggered the screen. */
  trigger: "manual" | "scheduled";
  /** Manual: user filters (search/limit/price-range/trend). Scheduled: { sector }. */
  filters?: StockScreenerFilter;
  /** Scheduled: sector label (default "Technology"). */
  sector?: string;
  /** Scheduled: max standout opportunities (default 5). */
  maxItems?: number;
  /** Optional explicit symbol universe (default: tech-keyword discovery). */
  symbols?: NasdaqStockListing[];
  /** Cap on symbols quoted via E*TRADE (default 50). */
  maxSymbols?: number;
  /** User login for E*TRADE auth scoping. */
  userLogin?: string;
}

export interface ScreenerRunResult {
  timestamp: string;
  trigger: "manual" | "scheduled";
  sector: string;
  success: boolean;
  totalScanned: number;
  matchedCount: number;
  /** Standout opportunities (the screening result — what matters). */
  opportunities: OpportunityStock[];
  /** Full scanned set with provenance (for the results table). */
  allStocks: ScannedStock[];
  discoveryMessage: string;
  error?: string;
}

const LATEST_KEY = "screener:latest";
const HISTORY_KEY = "screener:history";
const HISTORY_LIMIT = 20;

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
    const sector = req.sector || req.filters?.sector || "Technology";
    const screener = new DynamicMarketScreener();
    const userLogin = req.userLogin || this.userLogin();

    try {
      const etrade = new ETradeService(
        this.getOrm(),
        this.env,
        userLogin
      );

      // E*TRADE-only acquisition (#261). Symbols come from the listings
      // directory (not market data); quotes come from E*TRADE or nothing.
      const acquired = await acquireUniverse({
        mode: "etrade-only",
        symbols: req.symbols,
        maxSymbols: req.maxSymbols ?? 50,
        liveDeps: { fetchETradeQuote: (sym) => etrade.fetchQuoteRemote(sym) },
      });

      const screenResult = screenUniverse(screener, acquired, {
        ...(req.filters ?? {}),
        sector,
      });

      const opportunities = selectStandouts(
        screenResult.stocks,
        req.maxItems ?? 5
      ).map(toOpportunityStock);
      const allStocks = buildAllStocks(acquired.quotes, screenResult.stocks);

      const result: ScreenerRunResult = {
        timestamp,
        trigger: req.trigger,
        sector,
        success: true,
        totalScanned: screenResult.totalScanned,
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
        sector,
        success: false,
        totalScanned: 0,
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

  private async persistRun(result: ScreenerRunResult): Promise<void> {
    await this.ctx.storage.put(LATEST_KEY, result);
    const history =
      (await this.ctx.storage.get<ScreenerRunResult[]>(HISTORY_KEY)) ?? [];
    await this.ctx.storage.put(
      HISTORY_KEY,
      [result, ...history].slice(0, HISTORY_LIMIT)
    );
  }
}
