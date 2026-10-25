/**
 * Discovery (issue #14) — expression (spec §6, stage 5): turn an
 * inferred view into a StrategyRequest, run it through the options
 * pipeline, and judge the result with the fit gate plus a
 * best-per-type roll-up.
 *
 * The request builder follows the profile-derivation honesty rules
 * (#533) exactly: the target is `spot × (1 + k × EM)` where EM is the
 * expected move implied by the name's own chain (the scanner's
 * estimator) and k is the inference's EM multiple; the horizon is the
 * EM window's own expiry. A name whose chain yields no EM abstains —
 * the legacy fixed-percentage fallback is deliberately NOT consulted
 * here either. Risk caps are caller-supplied (a schedule's or
 * profile's), never defaulted, and a constructed request that fails
 * validation abstains rather than being patched into compliance.
 *
 * The fit gate reuses the scanner's evaluator (#24) with the
 * discovery composite floor (50, per spec) laid over the scanner
 * gate's other settled criteria — one gate implementation, two
 * calibrations.
 */

import type {
  EtapiDiscoveryConfig,
  EtapiOpportunityScannerConfig,
} from "../../config/etapiConfig";
import type { NameCharacterization } from "./discoverySignals";
import type { InferredThesis } from "./discoveryInference";
import {
  evaluateFitGate,
  type ExpectedMoveEstimate,
  type FitGateBucket,
  type FitGateParams,
} from "./opportunityScanner";
import type { PipelineResult } from "./index";
import type { RankedStrategy } from "./recommendationAgent";
import type { StrategyRequest } from "./strategyEngine";
import { validateStrategyRequest } from "./strategyRiskAgent";

/** Risk caps for a discovery expression — always the caller's. */
export interface DiscoveryRiskCaps {
  maxPlannedLoss: number;
  minRewardRisk: number;
  eventPolicy?: "warn" | "exclude";
}

export type DiscoveryRequestBuild =
  | { built: true; request: StrategyRequest }
  | { built: false; reason: string };

export function buildDiscoveryRequest(args: {
  characterization: NameCharacterization;
  inference: InferredThesis;
  /** The chain's expected-move estimate (scanner estimator over the
   *  same snapshot the caller characterized), or null. */
  expectedMove: ExpectedMoveEstimate | null;
  caps: DiscoveryRiskCaps;
}): DiscoveryRequestBuild {
  const { characterization: c, inference, expectedMove: em, caps } = args;

  if (c.spot === null) {
    return { built: false, reason: `no live quote for ${c.symbol}` };
  }
  if (em === null) {
    return {
      built: false,
      reason: `no expected move can be derived for ${c.symbol} — no usable IV in the live chain`,
    };
  }

  const targetPrice = Number((c.spot * (1 + inference.targetEmMultiple * em.pct)).toFixed(2));
  if (!(targetPrice > 0)) {
    return { built: false, reason: `derived target is not positive for ${c.symbol}` };
  }

  const request: StrategyRequest = {
    symbol: c.symbol,
    thesis: inference.thesis,
    targetPrice,
    // The view's horizon is the EM window's own expiry.
    targetDate: em.windowExpiry,
    expectedIvDirection: inference.expectedIvDirection,
    maxPlannedLoss: caps.maxPlannedLoss,
    minRewardRisk: caps.minRewardRisk,
    allowedStrategies: ["all"],
    minDte: inference.dteWindow.minDte,
    maxDte: inference.dteWindow.maxDte,
    ...(caps.eventPolicy ? { eventPolicy: caps.eventPolicy } : {}),
  };
  const validationError = validateStrategyRequest(request);
  if (validationError) {
    return { built: false, reason: validationError };
  }
  return { built: true, request };
}

/** The discovery fit gate: the scanner gate's criteria with the
 *  discovery composite floor laid over its minimum. */
export function resolveDiscoveryFitGate(
  scannerConfig: EtapiOpportunityScannerConfig,
  discoveryConfig: EtapiDiscoveryConfig,
): FitGateParams {
  return { ...scannerConfig.fitGate, minCompositeScore: discoveryConfig.compositeFloor };
}

/** The best candidate of one strategy type (the #22 roll-up shape,
 *  computed over the pipeline's ranked set). */
export interface DiscoveryTypeRollup {
  type: string;
  candidateId: string;
  label: string;
  compositeScore: number;
  expirationDate: string;
}

export function rollupBestPerType(ranked: readonly RankedStrategy[]): DiscoveryTypeRollup[] {
  const best = new Map<string, RankedStrategy>();
  for (const r of ranked) {
    const type = r.candidate.type;
    const current = best.get(type);
    if (!current || r.compositeScore > current.compositeScore) {
      best.set(type, r);
    }
  }
  return [...best.values()]
    .map((r) => ({
      type: r.candidate.type,
      candidateId: r.candidate.id,
      label: r.candidate.label,
      compositeScore: r.compositeScore,
      expirationDate: r.candidate.expirationDate,
    }))
    .sort(
      (a, b) =>
        b.compositeScore - a.compositeScore || (a.type < b.type ? -1 : a.type > b.type ? 1 : 0),
    );
}

export interface DiscoveryExpression {
  request: StrategyRequest;
  pick: PipelineResult["bestTrade"];
  gate: { bucket: FitGateBucket; reasons: string[] };
  rollup: DiscoveryTypeRollup[];
  rankedCount: number;
}

/** Strategy Profile biasing (issue #18): the profile contributes
 *  the strategy types it allows; `points` (discovery config) is
 *  added to those types' composites FOR PICK SELECTION ONLY.
 *  Biasing can change which candidate is picked — it can never
 *  change a recorded score, the roll-up, which signals fired, or
 *  the inference, and it never manufactures a pick from a
 *  no-trade pipeline result. */
export interface DiscoveryProfileBias {
  preferredTypes: readonly string[];
  points: number;
}

/** Run one setup through the pipeline and judge it. The pipeline is
 *  injected as its run signature so tests (and later, the discovery
 *  service) can supply the real OptionsAgentPipeline or a fixture. */
export async function expressDiscoverySetup(
  pipeline: { run(request: StrategyRequest): Promise<PipelineResult> },
  request: StrategyRequest,
  gate: FitGateParams,
  bias?: DiscoveryProfileBias,
): Promise<DiscoveryExpression> {
  const result = await pipeline.run(request);
  let pick = result.bestTrade;
  if (bias && pick.best && result.ranked.length > 0) {
    const preferred = new Set(bias.preferredTypes);
    const biasedScore = (r: RankedStrategy) =>
      r.compositeScore + (preferred.has(r.candidate.type) ? bias.points : 0);
    const winner = result.ranked.reduce((a, b) => (biasedScore(b) > biasedScore(a) ? b : a));
    if (winner !== pick.best) {
      pick = { ...pick, best: winner };
    }
  }
  return {
    request,
    pick,
    gate: evaluateFitGate(pick, gate),
    rollup: rollupBestPerType(result.ranked),
    rankedCount: result.ranked.length,
  };
}
