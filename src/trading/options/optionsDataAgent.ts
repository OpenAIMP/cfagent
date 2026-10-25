/**
 * Capability 1 — Options Data / Screener Agent
 *
 * Owns option-chain acquisition and single-contract screening. It never builds
 * strategies or ranks anything; it only produces clean, freshness-tagged
 * contracts for the downstream agents.
 *
 * Data provenance (issue #65): the live path serves broker chains ONLY —
 * when the live screen returns zero contracts, the snapshot is empty and
 * the screen's fetch errors say why. Generated ("calibrated") chains are
 * served exclusively when a request explicitly asks for
 * dataMode "calibrated-demo" AND the dev/demo gate is enabled
 * (src/config/demoMode.ts); demo snapshots are stamped
 * dataSource "calibrated-demo" end-to-end. Production remains real-time.
 */

import type {
  OptionScreenerFilter,
  OptionScreenRejection,
  OptionScreenResult,
  ScreenedOptionContractItem,
} from "../../types";
import { DynamicOptionsScreener, createSubrequestBudget, type SubrequestBudget } from "../optionsScreener";
import { DEFAULT_SUBREQUEST_BUDGET } from "../../config/etapiConfig";
import type { StrategyRequest } from "./strategyEngine";
import { buildCalibratedOptionChains } from "./calibratedOptionChains";
import { isDemoCalibratedChainsEnabled } from "../../config/demoMode";

export interface OptionsDataSnapshot {
  symbol: string;
  contracts: ScreenedOptionContractItem[];
  /** Provenance of the contracts in this snapshot (issue #65). */
  dataSource: "live" | "calibrated-demo";
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
  "symbol" | "minDte" | "maxDte" | "minVolume" | "minOpenInterest" | "maxSpreadPct" | "maxQuoteAgeSeconds" | "contractLimit" | "dataMode"
> & Pick<OptionScreenerFilter, "expirationDteBands"> & {
    /**
     * Issue #1204: shared per-scan subrequest budget. Callers that
     * snapshot many symbols inside one invocation (the opportunity
     * scanner) pass ONE budget so chain fetches stop at the budget
     * instead of tripping the Worker subrequest cap mid-scan. Omit
     * for a fresh per-call budget.
     */
    fetchBudget?: SubrequestBudget;
  };

const DEMO_DISABLED_ERROR =
  "Calibrated demo mode is not enabled in this deployment. Production serves live broker data only; generated chains require the dev/demo gate (demo.calibratedChains / CFAGENT_DEMO_CALIBRATED_CHAINS).";

export class OptionsDataAgent {
  readonly id = "options-data-agent";
  readonly capability = "Options data & single-contract screener";

  constructor(private readonly screener: DynamicOptionsScreener) {}

  /**
   * Issue #1204: mint a fresh subrequest budget at this agent's
   * configured limit. The optional chain covers screener test doubles
   * that carry no config; production screeners always do.
   */
  createFetchBudget(): SubrequestBudget {
    return createSubrequestBudget(this.screener.config?.subrequestBudget ?? DEFAULT_SUBREQUEST_BUDGET);
  }

  screen(filter: OptionScreenerFilter): Promise<OptionScreenResult> {
    return this.screener.screenOptions(filter);
  }

  async loadSnapshot(params: SnapshotParams): Promise<OptionsDataSnapshot> {
    const symbol = params.symbol.toUpperCase().trim();
    const filter: OptionScreenerFilter = {
      underlyingSymbols: [symbol],
      contractType: "BOTH",
      minDte: params.minDte,
      maxDte: params.maxDte,
      expirationDteBands: params.expirationDteBands,
      minVolume: params.minVolume,
      minOpenInterest: params.minOpenInterest,
      maxSpreadPct: params.maxSpreadPct,
      maxQuoteAgeSeconds: params.maxQuoteAgeSeconds,
      limit: params.contractLimit,
    };

    if (params.dataMode === "calibrated-demo") {
      return this.loadDemoSnapshot(symbol, filter, params);
    }

    // Live path — broker chains only, never a generated fallback (issue #65).
    const result = await this.screener.screenOptions(filter, params.fetchBudget);
    return this.toSnapshot(symbol, result, "live");
  }

  /** Explicit demo path: generated chains, gated and stamped (issue #65). */
  private loadDemoSnapshot(symbol: string, filter: OptionScreenerFilter, params: SnapshotParams): OptionsDataSnapshot {
    if (!isDemoCalibratedChainsEnabled()) {
      return {
        symbol,
        contracts: [],
        dataSource: "calibrated-demo",
        screen: { underlyingsScanned: 0, contractsEvaluated: 0, contractsMatched: 0 },
        rejections: [],
        validationError: DEMO_DISABLED_ERROR,
      };
    }
    const fallbackChains = buildCalibratedOptionChains([symbol], params.minDte ?? 0, params.maxDte ?? 90);
    const chainItems = fallbackChains.map((c) => ({ symbol: c.symbol, chain: c }));
    const result = this.screener.evaluateChains(chainItems, filter, 1, {
      warnings: ["Calibrated demo chains — generated data for development/demo, not live market data."],
    });
    return this.toSnapshot(symbol, result, "calibrated-demo");
  }

  private toSnapshot(symbol: string, result: OptionScreenResult, dataSource: OptionsDataSnapshot["dataSource"]): OptionsDataSnapshot {
    return {
      symbol,
      contracts: result.contracts,
      dataSource,
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
