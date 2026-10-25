import type { ScreenedOptionContractItem } from "../../../types";
import type { OptionThesis, StrategyCandidate, StrategyLeg, StrategyRequest } from "../strategyEngine";

export type StrategyCategory =
  | "single"
  | "stock"
  | "vertical"
  | "volatility"
  | "butterfly"
  | "condor"
  | "time"
  | "ratio"
  | "multi"
  | "synthetic"
  | "arbitrage";

export interface ChainView {
  expiration: string;
  dte: number;
  calls: Map<number, ScreenedOptionContractItem>;
  puts: Map<number, ScreenedOptionContractItem>;
}

export interface StrategyContext {
  /** Generators read only the request's DTE ceiling (template expiry
   *  windows). Both request shapes satisfy this — StrategyRequest and
   *  the view-less NoViewStrategyRequest (issue #534) — so the engine
   *  never fabricates a viewed request to satisfy generation. */
  request: Pick<StrategyRequest, "maxDte">;
  symbol: string;
  underlying: number;
  chains: ChainView[];
  stockShares: number;
}

export interface GenerationResult {
  sets: StrategyLeg[][];
  /** Number of valid combinations dropped because the per-strategy cap was reached. */
  truncated: number;
  skipReason?: string;
}

/** Strategy pattern: every option strategy is a pluggable definition that knows how to propose leg sets. */
export interface StrategyDefinition {
  id: string;
  label: string;
  category: StrategyCategory;
  description: string;
  aliases: string[];
  theses: OptionThesis[];
  usesStock: boolean;
  multiExpiry: boolean;
  /** Largest strategy-specific DTE floor (single/near or far leg) that
   *  must be present in the acquired chain for this definition to run. */
  requiredMaxDte?: number;
  /** Discovery horizon required by this strategy's chain-generation rules. */
  dataHorizonDte?: number;
  generate(context: StrategyContext, maxCombinations: number): GenerationResult;
}

/** Chain-of-responsibility link: returns a rejection reason or null to pass the candidate on. */
export interface AcceptanceRule {
  id: string;
  evaluate(candidate: StrategyCandidate, request: StrategyRequest): string | null;
}

export type EvaluationStatus = "accepted" | "rejected" | "skipped";

export interface StrategyEvaluation {
  id: string;
  label: string;
  category: StrategyCategory;
  status: EvaluationStatus;
  generated: number;
  accepted: number;
  summary: string;
  reasons: Array<{ reason: string; count: number }>;
}

export interface NameLedgerEntry {
  name: string;
  resolvesTo: string[];
  status: EvaluationStatus | "unresolved";
  note: string;
}

/** Observer: receives lifecycle events while the engine evaluates every registered strategy. */
export interface EvaluationObserver {
  onSkipped(def: StrategyDefinition, reason: string): void;
  onGenerated(def: StrategyDefinition, count: number, truncated: number, skipReason?: string): void;
  onRejected(def: StrategyDefinition, reason: string): void;
  /** Observers need only the accepted candidate's score (the ledger's
   *  best-score tally) — narrowed so no-view candidates (issue #534),
   *  which have no target fields, report through the same observer. */
  onAccepted(def: StrategyDefinition, candidate: Pick<StrategyCandidate, "score">): void;
}
