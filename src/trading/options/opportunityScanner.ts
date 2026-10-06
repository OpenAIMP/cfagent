/**
 * Cross-symbol opportunity scanner: runs the options agent pipeline over many
 * underlyings (a watchlist, an explicit list, or a stock-screen universe) and
 * ranks each symbol's best trade against the others.
 */

import { OptionsDataAgent } from "./optionsDataAgent";
import { StrategyRiskAgent, type StrategyScreenFilter } from "./strategyRiskAgent";
import { RecommendationAgent, type BestTradePick, type RiskProfile } from "./recommendationAgent";
import type { StrategyRequest } from "./strategyEngine";
import { MAX_SCAN_SYMBOLS, type DynamicOptionsScreener } from "../optionsScreener";

export { MAX_SCAN_SYMBOLS };
const CONCURRENCY = 3;

export type ScanRequestTemplate = Omit<StrategyRequest, "symbol" | "targetPrice"> & { targetPrice?: number };

export interface OpportunityRow {
  symbol: string;
  underlyingPrice: number;
  targetPrice: number;
  pick: BestTradePick;
  score: number;
}

export interface OpportunityScanResult {
  scanned: number;
  withTrades: number;
  opportunities: OpportunityRow[];
  skipped: Array<{ symbol: string; reason: string }>;
  truncatedSymbols: number;
}

const TARGET_FACTOR: Record<StrategyRequest["thesis"], number> = { bullish: 1.05, bearish: 0.95, large_move: 1.1, range_bound: 1 };

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }));
  return out;
}

export class OpportunityScanner {
  private readonly data: OptionsDataAgent;
  private readonly risk = new StrategyRiskAgent();
  private readonly recommender = new RecommendationAgent();

  constructor(screener: DynamicOptionsScreener) {
    this.data = new OptionsDataAgent(screener);
  }

  async scan(
    symbols: string[],
    template: ScanRequestTemplate,
    options: { riskProfile?: RiskProfile; strategyFilter?: StrategyScreenFilter; limit?: number } = {}
  ): Promise<OpportunityScanResult> {
    const unique = [...new Set(symbols.map((s) => s.trim().toUpperCase()).filter(Boolean))];
    const batch = unique.slice(0, MAX_SCAN_SYMBOLS);
    const profile = options.riskProfile ?? "balanced";
    const skipped: OpportunityScanResult["skipped"] = [];

    const rows = await mapLimit(batch, CONCURRENCY, async (symbol): Promise<OpportunityRow | null> => {
      try {
        const snapshot = await this.data.loadSnapshot({ ...template, symbol });
        const price = snapshot.contracts[0]?.underlyingPrice;
        if (!price) {
          skipped.push({
            symbol,
            reason: snapshot.validationError || snapshot.screen.fetchErrors?.[0]?.reason || "No eligible option contracts",
          });
          return null;
        }
        const request: StrategyRequest = {
          ...template,
          symbol,
          targetPrice: template.targetPrice ?? Number((price * TARGET_FACTOR[template.thesis]).toFixed(2)),
        };
        const built = this.risk.buildStrategies(snapshot.contracts, request);
        const { matched } = this.risk.screenStrategies(built.candidates, options.strategyFilter);
        const pick = this.recommender.pickBestTrade(matched, request, profile, 2);
        if (!pick.best) {
          skipped.push({ symbol, reason: pick.rationale[0] || "No qualifying strategy" });
          return null;
        }
        return { symbol, underlyingPrice: price, targetPrice: request.targetPrice, pick, score: pick.best.compositeScore };
      } catch (err) {
        skipped.push({ symbol, reason: err instanceof Error ? err.message : "Scan failed" });
        return null;
      }
    });

    const opportunities = rows.filter((r): r is OpportunityRow => r !== null).sort((a, b) => b.score - a.score || a.symbol.localeCompare(b.symbol));
    return {
      scanned: batch.length,
      withTrades: opportunities.length,
      opportunities: opportunities.slice(0, options.limit ?? 10),
      skipped,
      truncatedSymbols: Math.max(0, unique.length - batch.length),
    };
  }
}
