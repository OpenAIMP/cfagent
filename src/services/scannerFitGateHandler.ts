/**
 * Consolidation C5 (#1361) + #1257 rankers: OpportunityScanner's fit
 * gate as a kernel gate-chain handler — not a private gate.
 *
 * The gate logic itself is the scanner's own pure evaluateFitGate
 * (src/trading/options/opportunityScanner.ts); this handler is the
 * chain adapter, in the same pattern as StrategyRiskFitHandler's
 * injected screenFn: the caller supplies a pickFn that builds the
 * scanner's BestTradePick view for a kernel candidate (e.g. from the
 * recommender's pick for that candidate). Bucket mapping: fit → no
 * cap; borderline → cap watchlist (the pick exists but failed
 * criteria, so it surfaces with reasons instead of qualifying);
 * no_fit → cap rejected. No pick to gate passes through with no cap,
 * exactly like the panel fit handler's non-wrapped pass-through.
 * Caps only demote (the kernel takes the most restrictive tier across
 * handlers), so this handler can never promote a candidate another
 * handler rejected.
 */
import type { GateEvaluation, GateHandler, KernelCandidate, KernelGateContext } from "./recommendationKernel";
import { evaluateFitGate, type FitGateParams } from "../trading";
import type { BestTradePick } from "../trading";

export class OpportunityScannerFitHandler implements GateHandler {
  readonly id = "opportunity-scanner-fit";
  constructor(
    private readonly opts: {
      pickFn: (candidate: KernelCandidate) => BestTradePick | null;
      gate: FitGateParams;
    },
  ) {}

  evaluate(candidate: KernelCandidate, _ctx: KernelGateContext): GateEvaluation {
    const pick = this.opts.pickFn(candidate);
    if (!pick) return { reasons: [] };
    const { bucket, reasons } = evaluateFitGate(pick, this.opts.gate);
    if (bucket === "fit") return { reasons };
    if (bucket === "borderline") return { cap: "watchlist", reasons };
    return { cap: "rejected", reasons };
  }
}
