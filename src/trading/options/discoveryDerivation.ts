/**
 * Profile-derived discovery targets (issue #533) — the derivation
 * builder. Pure: snapshot + profile + resolved scanner config in,
 * either a constructed StrategyRequest with its full derivation
 * record, or an abstention with the reason.
 *
 * A derived target is NOT a user view. The target is
 * `spot × (1 + k × EM)` where spot is the underlying price carried by
 * the symbol's own live chain, EM is the chain's expected move to the
 * most-ATM contract's expiry inside the profile's DTE window (the
 * scanner's estimator, issue #25 — same selection, same formula), and
 * k is the resolved scanner config's EM multiple for the profile's
 * thesis. The derivation record stamps every input (spot, IV, window,
 * multiple, profile version) so the number can always be audited.
 *
 * Honesty rules, in evaluation order — each failure ABSTAINS the
 * symbol with the reason recorded, and nothing is ever patched into
 * compliance:
 *  1. The snapshot failed to load (validation error, or an empty
 *     chain with recorded fetch errors).
 *  2. The chain carries no live quote (no positive underlying price).
 *  3. No usable IV in the chain — no expected move can be derived.
 *     The scanner's legacy targetFactors fallback is deliberately NOT
 *     consulted: an EM-derived model does not silently become a
 *     fixed-percentage model.
 *  4. The profile carries no thesis — direction would be invented.
 *  5. The computed target is not positive.
 *  6. The profile does not set maxPlannedLoss / minRewardRisk — the
 *     user's risk caps have no honest default (decision D3 on #533).
 *  7. The constructed request fails validateStrategyRequest — a
 *     derivation bug or a profile-field conflict; never patched.
 */

import type { OptionsDataSnapshot } from "./optionsDataAgent";
import { estimateExpectedMove } from "./opportunityScanner";
import { toProfileRef, type StrategyProfile } from "./strategyProfile";
import type { DiscoveryTargetDerivation } from "./discoveryRunStore";
import type { OptionThesis, StrategyRequest } from "./strategyEngine";
import { validateStrategyRequest } from "./strategyRiskAgent";

export type DiscoveryDerivationResult =
  | { derived: true; request: StrategyRequest; derivation: DiscoveryTargetDerivation }
  | {
      derived: false;
      reason: string;
      /** The derivation, when spot/EM/thesis/target were all computed
       *  before the abstention (partial derivation is shown, never
       *  hidden). */
      derivation?: DiscoveryTargetDerivation;
    };

export function deriveDiscoveryRequest(args: {
  symbol: string;
  snapshot: OptionsDataSnapshot;
  profile: StrategyProfile;
  /** The resolved scanner config's EM multiples (getOpportunityScannerConfig().targetEmMultiples). */
  emMultiples: Record<OptionThesis, number>;
  now: Date;
}): DiscoveryDerivationResult {
  const { snapshot, profile } = args;
  const symbol = args.symbol.toUpperCase().trim();

  // 1 — the chain must have loaded.
  if (snapshot.validationError) {
    return { derived: false, reason: snapshot.validationError };
  }
  if (snapshot.contracts.length === 0) {
    const fetchReasons = (snapshot.screen.fetchErrors ?? [])
      .filter((e) => e.symbol === symbol)
      .map((e) => e.reason);
    if (fetchReasons.length > 0) {
      return { derived: false, reason: fetchReasons.join("; ") };
    }
    // An empty chain with no recorded error still has no quote to
    // derive from (step 2's reason covers it).
    return { derived: false, reason: `no live quote for ${symbol}` };
  }

  // 2 — spot is the chain's own underlying price (the same source the
  // IV collector and the scanner read), first positive value carried.
  let spot: number | undefined;
  for (const contract of snapshot.contracts) {
    const price = (contract as { underlyingPrice?: unknown }).underlyingPrice;
    if (typeof price === "number" && Number.isFinite(price) && price > 0) {
      spot = price;
      break;
    }
  }
  if (spot === undefined) {
    return { derived: false, reason: `no live quote for ${symbol}` };
  }

  // 3 — expected move from the chain itself (scanner estimator).
  const em = estimateExpectedMove(snapshot.contracts, spot, args.now);
  if (em === null) {
    return {
      derived: false,
      reason: `no usable IV in the live chain for ${symbol} — no expected move can be derived`,
    };
  }

  // 4 — direction comes from the profile's thesis, nowhere else.
  const thesis = profile.thesis;
  if (thesis === undefined) {
    return { derived: false, reason: "profile carries no thesis" };
  }

  // 5 — the target, scanner formula and rounding.
  const emMultiple = args.emMultiples[thesis];
  const targetPrice = Number((spot * (1 + emMultiple * em.pct)).toFixed(2));
  const derivation: DiscoveryTargetDerivation = {
    source: "profile-derived",
    spot,
    spotSource: "chain",
    atmIv: em.atmIv,
    expectedMovePct: em.pct,
    windowExpiry: em.windowExpiry,
    windowDays: em.windowDays,
    emMultiple,
    thesis,
    targetPrice,
    profileRef: toProfileRef(profile),
  };
  if (!(targetPrice > 0)) {
    return { derived: false, reason: "derived target is not positive", derivation };
  }

  // 6 — the risk caps are required; they are never defaulted (D3).
  if (profile.maxPlannedLoss === undefined || profile.minRewardRisk === undefined) {
    return {
      derived: false,
      reason: "profile does not set maxPlannedLoss/minRewardRisk",
      derivation,
    };
  }

  // 7 — construct exactly, then validate; a failure abstains.
  const request: StrategyRequest = {
    symbol,
    thesis,
    targetPrice,
    // The view's horizon is the EM window's own expiry.
    targetDate: em.windowExpiry,
    expectedIvDirection: profile.expectedIvDirection ?? "unchanged",
    maxPlannedLoss: profile.maxPlannedLoss,
    minRewardRisk: profile.minRewardRisk,
    ...(profile.allowedStrategies
      ? { allowedStrategies: profile.allowedStrategies }
      : { allowedStrategies: ["all" as const] }),
    ...(profile.optimizationBias !== undefined ? { optimizationBias: profile.optimizationBias } : {}),
    ...(profile.minDte !== undefined ? { minDte: profile.minDte } : {}),
    ...(profile.maxDte !== undefined ? { maxDte: profile.maxDte } : {}),
    ...(profile.eventPolicy ? { eventPolicy: profile.eventPolicy } : {}),
  };
  const validationError = validateStrategyRequest(request);
  if (validationError) {
    return { derived: false, reason: validationError, derivation };
  }

  return { derived: true, request, derivation };
}
