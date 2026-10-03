/**
 * Options agent pipeline for the E*TRADE agent:
 *   OptionsDataAgent -> StrategyRiskAgent -> RecommendationAgent
 * Each stage is independently usable; the pipeline only wires them together.
 */

import type { DynamicOptionsScreener } from "../optionsScreener";
import { OptionsDataAgent, type OptionsDataSnapshot } from "./optionsDataAgent";
import { StrategyRiskAgent, type StrategyScreenFilter, type StrategyRiskReport } from "./strategyRiskAgent";
import { RecommendationAgent, type BestTradePick, type RankedStrategy, type RiskProfile } from "./recommendationAgent";
import type { StrategyRecommendationResult, StrategyRequest } from "./strategyEngine";

export * from "./optionsDataAgent";
export * from "./strategyRiskAgent";
export * from "./recommendationAgent";

export interface PipelineOptions {
  strategyFilter?: StrategyScreenFilter;
  riskProfile?: RiskProfile;
  alternatives?: number;
}

export interface PipelineResult {
  snapshot: OptionsDataSnapshot;
  strategies: StrategyRecommendationResult;
  screenedOut: Array<{ id: string; reason: string }>;
  ranked: RankedStrategy[];
  riskReports: StrategyRiskReport[];
  bestTrade: BestTradePick;
}

export class OptionsAgentPipeline {
  readonly data: OptionsDataAgent;
  readonly risk = new StrategyRiskAgent();
  readonly recommender = new RecommendationAgent();

  constructor(screener: DynamicOptionsScreener) {
    this.data = new OptionsDataAgent(screener);
  }

  async run(request: StrategyRequest, options: PipelineOptions = {}): Promise<PipelineResult> {
    const snapshot = await this.data.loadSnapshot(request);
    const strategies = this.risk.buildStrategies(snapshot.contracts, request);
    const { matched, rejected } = this.risk.screenStrategies(strategies.candidates, options.strategyFilter);
    const profile = options.riskProfile ?? "balanced";
    const ranked = this.recommender.rank(matched, request, profile);
    const limit = request.candidateLimit ?? ranked.length;
    const bestTrade = this.recommender.pickBestTrade(matched, request, profile, options.alternatives ?? 3);
    return {
      snapshot,
      strategies,
      screenedOut: rejected,
      ranked: ranked.slice(0, limit),
      riskReports: ranked.slice(0, limit).map((r) => this.risk.riskReport(r.candidate, request)),
      bestTrade,
    };
  }
}
