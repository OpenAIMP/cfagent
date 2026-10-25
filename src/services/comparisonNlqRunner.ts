/**
 * #1257 comparison surfacing — the NLQ comparison runner.
 *
 * Mirrors the POST /trading/options/comparison route exactly (same
 * snapshot mapping, same agents, same question construction, same
 * runProductionComparison call) so a chat comparison and a panel
 * comparison over the same request are the same run, differing only
 * in surface. Follows the fitDiscoveryRunner discipline: when a
 * required dependency is absent, the run fails with an availability
 * error rather than silently answering a different question.
 *
 * - env is REQUIRED: without it the llm arm cannot generate and the
 *   hybrid arm cannot rank; a quant-only "comparison" would silently
 *   equal the quant order and misrepresent itself as three arms.
 * - ledgerSql is optional: without it the run still compares, but
 *   the outcome reports that it was not persisted to the ledger.
 * - An empty snapshot is a failure, not a no_candidates envelope:
 *   the NLQ action has no separate no-candidates rendering, and a
 *   silent empty answer would hide a data problem.
 */
import { DynamicOptionsScreener, OptionsDataAgent, RecommendationAgent, StrategyRiskAgent, type RiskProfile, type StrategyRequest, type StrategyScreenFilter } from "../trading";
import type { ComparisonLedgerSink, KernelSnapshot } from "./recommendationKernel";
import { runProductionComparison, type ProductionComparisonResult } from "./comparisonRunner";

export interface ComparisonNlqOutcome {
  ok: boolean;
  error?: string;
  result?: ProductionComparisonResult;
  ledgerPersisted: boolean;
}

export interface ComparisonNlqRunner {
  run(input: {
    request: StrategyRequest;
    riskProfile?: RiskProfile;
    strategyFilter?: StrategyScreenFilter;
  }): Promise<ComparisonNlqOutcome>;
}

export function createComparisonRunner(deps: {
  client: ConstructorParameters<typeof DynamicOptionsScreener>[0];
  env?: unknown;
  ledgerSql?: ComparisonLedgerSink | null;
}): ComparisonNlqRunner {
  return {
    async run(input): Promise<ComparisonNlqOutcome> {
      if (!deps.env) {
        return {
          ok: false,
          ledgerPersisted: false,
          error: "Three-way comparison is unavailable in this context: no environment is configured for LLM generation, so the llm and hybrid arms cannot run.",
        };
      }
      const dataAgent = new OptionsDataAgent(new DynamicOptionsScreener(deps.client));
      const s = await dataAgent.loadSnapshot(input.request);
      // Same KernelSnapshot mapping the panel route builds (see
      // RecommendationService.discoverPanel) — replicated here
      // rather than calling discoverPanel, which would waste a full
      // kernel run just for the snapshot — plus snapshot quotes,
      // so the LLM builder's price source is the snapshot even
      // where a detail carries its own bid/ask.
      const snapshot: KernelSnapshot = {
        symbol: s.symbol,
        contracts: s.contracts,
        dataSource: s.dataSource,
        chainProvenance: s.dataSource === "calibrated-demo" ? "calibrated" : "live",
        underlyingPrice: s.contracts[0]?.underlyingPrice,
        screen: s.screen,
        rejections: s.rejections,
        validationError: s.validationError,
        quotes: Object.fromEntries(
          s.contracts.map((c) => [c.symbol, {
            bid: c.bid, ask: c.ask,
            iv: c.impliedVolatility ?? null,
            volume: c.volume ?? null,
            openInterest: c.openInterest ?? null,
          }]),
        ),
      };
      if ((snapshot.contracts ?? []).length === 0) {
        return {
          ok: false,
          ledgerPersisted: false,
          error: `Comparison snapshot for ${s.symbol} has no screened contracts.`,
        };
      }
      const riskAgent = new StrategyRiskAgent();
      const recommender = new RecommendationAgent();
      const req = input.request;
      const question = `What ${req.thesis ?? "directional"} option strategies on ${req.symbol} look best for a ${req.targetDate ?? "near-term"} horizon with max planned loss ${req.maxPlannedLoss ?? "the stated limit"}?`;
      const result = await runProductionComparison({
        snapshot,
        request: req,
        question,
        riskProfile: input.riskProfile ?? "balanced",
        strategyFilter: input.strategyFilter,
        buildFn: (contracts, request) => riskAgent.buildStrategies(contracts, request as StrategyRequest),
        rankFn: (candidates, request, profile) => recommender.rank(candidates, request as unknown as StrategyRequest, profile),
        screenFn: (candidates, filter) => riskAgent.screenStrategies(candidates, filter),
        env: deps.env,
        ledgerSql: deps.ledgerSql ?? null,
      });
      return { ok: true, result, ledgerPersisted: Boolean(deps.ledgerSql) };
    },
  };
}
