/**
 * Cross-symbol opportunity scanner: runs the options agent pipeline over many
 * underlyings (a watchlist, an explicit list, or a stock-screen universe) and
 * ranks each symbol's best trade against the others.
 */

import { OptionsDataAgent } from "./optionsDataAgent";
import { StrategyRiskAgent, type StrategyScreenFilter } from "./strategyRiskAgent";
import { RecommendationAgent, type BestTradePick, type RiskProfile } from "./recommendationAgent";
import type { StrategyRequest } from "./strategyEngine";
import { MAX_SCAN_SYMBOLS as DEFAULT_MAX_SCAN_SYMBOLS, type DynamicOptionsScreener } from "../optionsScreener";
import { getOpportunityScannerConfig } from "../../config/etapiConfig";

const baseOppConfig = getOpportunityScannerConfig();
export const MAX_SCAN_SYMBOLS = baseOppConfig.maxScanSymbols;
const CONCURRENCY = baseOppConfig.concurrency;

export type ScanRequestTemplate = Omit<StrategyRequest, "symbol" | "targetPrice"> & {
  /**
   * A target price the user stated for one specific symbol (issue #19).
   * Scoped by design: it applies only to `symbol` when one is attached;
   * every other scanned symbol — and every symbol when no symbol is
   * attached — gets a thesis-derived target instead. A target stated in a
   * single-name question must never leak onto the other names in a scan.
   */
  statedTarget?: { price: number; symbol?: string };
};

export interface OpportunityRow {
  symbol: string;
  underlyingPrice: number;
  targetPrice: number;
  /** Where this row's target came from: the user's stated target for this
   *  symbol ("stated") or the thesis factor on spot ("thesis"). */
  targetSource: "stated" | "thesis";
  pick: BestTradePick;
  score: number;
}

export interface OpportunityScanResult {
  scanned: number;
  withTrades: number;
  opportunities: OpportunityRow[];
  skipped: Array<{ symbol: string; reason: string }>;
  truncatedSymbols: number;
  /** Plain-language disclosures about scan-level assumptions (e.g. how a
   *  stated target was scoped). Empty when there is nothing to disclose. */
  assumptions: string[];
}

const TARGET_FACTOR: Record<StrategyRequest["thesis"], number> = baseOppConfig.targetFactors;

/**
 * Resolve the target price for one symbol in a scan (issue #19). A stated
 * target applies only to the symbol it was stated for; every other symbol
 * uses the thesis factor on its own spot price. Pure and exported for
 * direct unit testing.
 */
export function resolveScanTarget(
  template: ScanRequestTemplate,
  symbol: string,
  spotPrice: number,
): { targetPrice: number; source: "stated" | "thesis" } {
  const stated = template.statedTarget;
  if (stated?.symbol && stated.symbol.trim().toUpperCase() === symbol.toUpperCase()) {
    return { targetPrice: stated.price, source: "stated" };
  }
  return { targetPrice: Number((spotPrice * TARGET_FACTOR[template.thesis]).toFixed(2)), source: "thesis" };
}

/** Disclosure lines for a scan whose request carried a stated target. */
function scanTargetAssumptions(template: ScanRequestTemplate): string[] {
  const stated = template.statedTarget;
  if (!stated) return [];
  if (stated.symbol) {
    return [
      `Stated target $${stated.price.toFixed(2)} applied to ${stated.symbol.trim().toUpperCase()} only; every other symbol uses a thesis-derived target (spot × ${TARGET_FACTOR[template.thesis]} for ${template.thesis}).`,
    ];
  }
  return [
    `A target of $${stated.price.toFixed(2)} was stated without a symbol, so it was not applied to any scanned name; thesis-derived targets were used for all symbols.`,
  ];
}

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
    const assumptions = scanTargetAssumptions(template);
    // The stated target is scan-level scoping metadata, not a request field:
    // strip it so per-symbol StrategyRequests stay exactly StrategyRequest-shaped.
    const { statedTarget: _statedTarget, ...requestTemplate } = template;

    const rows = await mapLimit(batch, CONCURRENCY, async (symbol): Promise<OpportunityRow | null> => {
      try {
        const snapshot = await this.data.loadSnapshot({ ...requestTemplate, symbol });
        const price = snapshot.contracts[0]?.underlyingPrice;
        if (!price) {
          skipped.push({
            symbol,
            reason: snapshot.validationError || snapshot.screen.fetchErrors?.[0]?.reason || "No eligible option contracts",
          });
          return null;
        }
        const { targetPrice, source: targetSource } = resolveScanTarget(template, symbol, price);
        const request: StrategyRequest = {
          ...requestTemplate,
          symbol,
          targetPrice,
        };
        const built = this.risk.buildStrategies(snapshot.contracts, request);
        const { matched } = this.risk.screenStrategies(built.candidates, options.strategyFilter);
        const pick = this.recommender.pickBestTrade(matched, request, profile, 2);
        if (!pick.best) {
          skipped.push({ symbol, reason: pick.rationale[0] || "No qualifying strategy" });
          return null;
        }
        return { symbol, underlyingPrice: price, targetPrice, targetSource, pick, score: pick.best.compositeScore };
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
      assumptions,
    };
  }
}
