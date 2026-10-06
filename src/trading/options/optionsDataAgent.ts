/**
 * Capability 1 — Options Data / Screener Agent
 *
 * Owns option-chain acquisition and single-contract screening. It never builds
 * strategies or ranks anything; it only produces clean, freshness-tagged
 * contracts for the downstream agents.
 */

import type {
  OptionScreenerFilter,
  OptionScreenRejection,
  OptionScreenResult,
  ScreenedOptionContractItem,
} from "../../types";
import { DynamicOptionsScreener } from "../optionsScreener";
import type { StrategyRequest } from "./strategyEngine";

export interface OptionsDataSnapshot {
  symbol: string;
  contracts: ScreenedOptionContractItem[];
  screen: {
    scannedAt?: string;
    underlyingsScanned: number;
    contractsEvaluated: number;
    contractsMatched: number;
    quoteQuality?: OptionScreenResult["quoteQuality"];
    fetchErrors?: OptionScreenResult["fetchErrors"];
    warnings?: OptionScreenResult["warnings"];
  };
  rejections: OptionScreenRejection[];
  validationError?: string;
}

export type SnapshotParams = Pick<
  StrategyRequest,
  "symbol" | "minDte" | "maxDte" | "minVolume" | "minOpenInterest" | "maxSpreadPct" | "maxQuoteAgeSeconds" | "contractLimit"
>;

export class OptionsDataAgent {
  readonly id = "options-data-agent";
  readonly capability = "Options data & single-contract screener";

  constructor(private readonly screener: DynamicOptionsScreener) {}

  screen(filter: OptionScreenerFilter): Promise<OptionScreenResult> {
    return this.screener.screenOptions(filter);
  }

  async loadSnapshot(params: SnapshotParams): Promise<OptionsDataSnapshot> {
    const symbol = params.symbol.toUpperCase().trim();
    const result = await this.screener.screenOptions({
      underlyingSymbols: [symbol],
      contractType: "BOTH",
      minDte: params.minDte,
      maxDte: params.maxDte,
      minVolume: params.minVolume,
      minOpenInterest: params.minOpenInterest,
      maxSpreadPct: params.maxSpreadPct,
      maxQuoteAgeSeconds: params.maxQuoteAgeSeconds,
      limit: params.contractLimit,
    });
    return {
      symbol,
      contracts: result.contracts,
      screen: {
        scannedAt: result.scannedAt,
        underlyingsScanned: result.totalUnderlyingsScanned,
        contractsEvaluated: result.totalContractsEvaluated,
        contractsMatched: result.matchedCount,
        quoteQuality: result.quoteQuality,
        fetchErrors: result.fetchErrors,
        warnings: result.warnings,
      },
      rejections: (result.rejections || []).slice(0, 50),
      validationError: result.validationError,
    };
  }
}
