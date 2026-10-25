/**
 * Options Back-End Service & Agent Pipeline
 * Comprehensive barrel export for all options trading, quantitative analysis,
 * risk assessment, omnichannel orchestration, and LLM intelligence services.
 */

import type { DynamicOptionsScreener } from "../optionsScreener";
import { OptionsDataAgent, type OptionsDataSnapshot } from "./optionsDataAgent";
import { StrategyRiskAgent, type StrategyScreenFilter, type StrategyRiskReport } from "./strategyRiskAgent";
import { RecommendationAgent, type BestTradePick, type RankedStrategy, type RiskProfile } from "./recommendationAgent";
import type { StrategyRecommendationResult, StrategyRequest } from "./strategyEngine";
import { RecommendationService } from "../../services/recommendationKernel";

export * from "./optionsDataAgent";
export * from "./strategyRiskAgent";
export * from "./recommendationAgent";
export * from "./strategyEngine";
export * from "./unifiedOptionsService";
export * from "./opportunityScanner";
export * from "./llmComparison";
export * from "./llmIdeas";
export * from "./strategies/catalog";
export * from "./strategies/directionTags";
export * from "./strategies/registry";
export * from "./strategies/template";
export * from "./strategies/ledger";
export * from "./strategies/types";

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

/**
 * Consolidation C4 (#1329): the D1 pipeline is now a delegating
 * adapter over the Recommendation Kernel's panel configuration — it
 * owns no engine of its own. run() maps the kernel result back to
 * PipelineResult so the /compare endpoint, scheduled discovery, and
 * discoveryService keep their exact response shape: snapshot verbatim
 * from the kernel snapshot, strategies IS the engine build result
 * the kernel wrapped (full built set, scoreWeights included — the
 * /compare pool counts generated, not gate-survived), ranked /
 * riskReports / bestTrade computed via the same agents over the
 * kernel-passed candidates. The class is retained in C4 (not deleted)
 * so those call sites migrate without a flag day; retirement of the
 * adapter itself is #1256 remainder.
 */
export class OptionsAgentPipeline {
  readonly data: OptionsDataAgent;
  readonly risk = new StrategyRiskAgent();
  readonly recommender = new RecommendationAgent();

  constructor(screener: DynamicOptionsScreener) {
    this.data = new OptionsDataAgent(screener);
  }

  async run(request: StrategyRequest, options: PipelineOptions = {}): Promise<PipelineResult> {
    const panel = await new RecommendationService().discoverPanel({
      dataAgent: {
        loadSnapshot: async (params: unknown) => {
          const s = await this.data.loadSnapshot(params as StrategyRequest);
          return {
            symbol: s.symbol,
            contracts: s.contracts,
            dataSource: s.dataSource,
            screen: s.screen,
            rejections: s.rejections,
            validationError: s.validationError,
          };
        },
      },
      riskAgent: this.risk,
      recommender: this.recommender,
      request,
      strategyFilter: options.strategyFilter,
      riskProfile: options.riskProfile,
      alternatives: options.alternatives,
    });
    const buildResult = panel.legacy?.buildResult;
    if (!buildResult) {
      throw new Error("OptionsAgentPipeline: kernel panel run produced no engine build result.");
    }
    const snapshot: OptionsDataSnapshot = {
      symbol: panel.snapshot.symbol,
      contracts: panel.snapshot.contracts ?? [],
      dataSource: panel.snapshot.dataSource,
      screen: panel.snapshot.screen as OptionsDataSnapshot["screen"],
      rejections: panel.snapshot.rejections as OptionsDataSnapshot["rejections"],
      validationError: panel.snapshot.validationError,
    };
    return {
      snapshot,
      strategies: buildResult as unknown as StrategyRecommendationResult,
      screenedOut: panel.screenedOut,
      ranked: panel.ranked,
      riskReports: panel.riskReports as StrategyRiskReport[],
      bestTrade: panel.bestTrade as BestTradePick,
    };
  }
}
