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
  request: StrategyRequest;
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
  onAccepted(def: StrategyDefinition, candidate: StrategyCandidate): void;
}
