/**
 * Client for the portfolio-risk backends (issues #34/#35/#36/#54), surfaced
 * in the UI by PortfolioRiskPanel (issue #63).
 *
 * Type-only imports from the server services keep the wire shapes
 * single-sourced — the panel can never drift from the endpoints it calls.
 */

import type { PortfolioRiskReport } from "../services/portfolioRisk";
import type { ConcentrationReport } from "../services/portfolioConcentration";
import type { SizingCandidate, SizingResult } from "../services/positionSizing";
import type { HedgeAnalysis, HedgeProposal } from "../services/hedgeProposals";
import type { RepairAnalysis, RepairProposal } from "../services/repairProposals";
import type { TradeOrderContext } from "./trading/tradeOrderContext";
import { apiFetch } from "./apiFetch";

export type { PortfolioRiskReport, ConcentrationReport, SizingCandidate, SizingResult, HedgeAnalysis, HedgeProposal };

async function postJson<T>(path: string, env: string, body?: unknown): Promise<T> {
  const resp = await apiFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-environment": env },
    body: JSON.stringify(body ?? {}),
  });
  const data = (await resp.json().catch(() => ({}))) as T & { error?: string };
  if (!resp.ok) throw new Error((data as { error?: string }).error || `Request failed (${resp.status})`);
  return data;
}

export async function fetchPortfolioRisk(env: string): Promise<PortfolioRiskReport> {
  const resp = await apiFetch("/api/etrade/portfolio-risk", { headers: { "x-environment": env } });
  const data = (await resp.json().catch(() => ({}))) as PortfolioRiskReport & { error?: string };
  if (!resp.ok) throw new Error(data.error || `Request failed (${resp.status})`);
  // Shape guard (issue #71): a 200 body that is not a report (e.g. an
  // async-job stub that was not polled) must surface as an error state,
  // never reach the renderer and crash on a missing array.
  if (!data || !Array.isArray(data.rows) || !data.totals || !Array.isArray(data.excluded) || !Array.isArray(data.partial) || !Array.isArray(data.undefinedRiskPositions)) {
    throw new Error("Unexpected portfolio-risk response shape — the report payload was incomplete.");
  }
  return data;
}

export async function fetchHedgeAnalysis(env: string): Promise<HedgeAnalysis> {
  const analysis = await postJson<HedgeAnalysis>("/api/etrade/hedge/analyze", env);
  // Shape guard (issue #71): the renderer reads .length on both arrays.
  if (!analysis || !Array.isArray(analysis.proposals) || !Array.isArray(analysis.symbolsMissingBeta)) {
    throw new Error("Unexpected hedge-analysis response shape — the payload was incomplete.");
  }
  return analysis;
}

export function fetchConcentration(env: string, candidateSymbol?: string): Promise<ConcentrationReport> {
  return postJson<ConcentrationReport>("/api/etrade/portfolio-risk/correlation", env, { candidateSymbol });
}

export function fetchSizing(env: string, candidate: SizingCandidate): Promise<SizingResult> {
  return postJson<SizingResult>("/api/etrade/portfolio-risk/size", env, { candidate });
}

// ---------------------------------------------------------------------------
// Formatting + view-model helpers (unit-tested)
// ---------------------------------------------------------------------------

export function fmtUsd(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return value.toLocaleString(undefined, { style: "currency", currency: "USD", minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function fmtSignedUsd(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  return `${sign}${fmtUsd(Math.abs(value), digits)}`;
}

export function fmtNumber(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return value.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/**
 * Converts a hedge DRAFT into the asset-aware order-ticket context the hub's
 * HITL flow consumes. The panel never previews or
 * executes anything itself — this hand-off is the only bridge, and the
 * human still reviews and approves in the order ticket.
 */
export function hedgeProposalToTradeContext(proposal: HedgeProposal, spyPrice: number | null): TradeOrderContext {
  const move = `β-weighted Δ ${fmtSignedUsd(proposal.preHedgeBetaWeightedDeltaDollars)} → ${fmtSignedUsd(proposal.postHedgeBetaWeightedDeltaDollars)}`;
  if (proposal.instrument === "SPY_SHARES") {
    return {
      assetClass: "equity",
      symbol: "SPY",
      action: proposal.side,
      quantity: proposal.quantity,
      underlyingPrice: spyPrice ?? undefined,
      label: `Hedge draft — ${proposal.side} ${proposal.quantity} SPY shares (${move})`,
      legs: [`${proposal.side} ${proposal.quantity} SPY shares @ ~${fmtUsd(spyPrice, 2)}`],
    };
  }
  return {
    assetClass: "options",
    symbol: "SPY",
    action: proposal.side,
    quantity: proposal.quantity,
    underlyingPrice: spyPrice ?? undefined,
    label: `Hedge draft — ${proposal.side} ${proposal.quantity} SPY ${proposal.strike} PUT ${proposal.expirationDate} (${move})`,
    legs: [
      `${proposal.side} ${proposal.quantity} SPY ${proposal.strike} PUT exp ${proposal.expirationDate} — est. cost ${fmtUsd(Math.abs(proposal.estimatedCost), 2)}`,
    ],
    optionLegs: [{
      securityType: "OPTN",
      side: proposal.side,
      quantity: 1,
      optionType: "PUT",
      strike: proposal.strike,
      expirationDate: proposal.expirationDate,
    }],
    strategyNetDebit: Math.sign(proposal.estimatedCost || 1) * Math.abs(proposal.estimatedCost) / Math.max(1, proposal.quantity),
  };
}

export type { RepairAnalysis, RepairProposal };

// ---------------------------------------------------------------------------
// Repair proposals (#355 endpoint)
// ---------------------------------------------------------------------------

export async function fetchRepairAnalysis(env: string): Promise<RepairAnalysis> {
  const analysis = await postJson<RepairAnalysis>("/api/etrade/portfolio-repair/analyze", env);
  // Shape guard (issue #71 pattern): the renderer reads .length on both arrays.
  if (!analysis || !Array.isArray(analysis.proposals) || !Array.isArray(analysis.symbolsUnavailable)) {
    throw new Error("Unexpected repair-analysis response shape — the payload was incomplete.");
  }
  return analysis;
}

/**
 * Hand a repair draft to the hub's HITL order-ticket flow. The 1×2 ratio
 * becomes two option legs; the DRAFT status and the rationale travel in the
 * label so the ticket shows what is being previewed.
 */
export function repairProposalToTradeContext(proposal: RepairProposal): TradeOrderContext {
  const cost = proposal.netDebitPerUnit <= 0
    ? `credit ${fmtUsd(Math.abs(proposal.netDebitPerUnit), 2)}`
    : `debit ${fmtUsd(proposal.netDebitPerUnit, 2)}`;
  return {
    assetClass: "options",
    symbol: proposal.symbol,
    action: "BUY",
    quantity: proposal.units,
    label: `Repair draft — 1×2 call ratio on ${proposal.symbol} (${cost}/unit, recover at ${proposal.upsideCappedAbove})`,
    legs: [
      `BUY ${proposal.units} ${proposal.symbol} ${proposal.legLong.strike} CALL exp ${proposal.legLong.expirationDate} @ ~${fmtUsd(proposal.legLong.premium, 2)}`,
      `SELL ${proposal.units * 2} ${proposal.symbol} ${proposal.legShort.strike} CALL exp ${proposal.legShort.expirationDate} @ ~${fmtUsd(proposal.legShort.premium, 2)}`,
    ],
    optionLegs: [
      {
        securityType: "OPTN",
        side: "BUY",
        quantity: proposal.units,
        optionType: "CALL",
        strike: proposal.legLong.strike,
        expirationDate: proposal.legLong.expirationDate,
      },
      {
        securityType: "OPTN",
        side: "SELL",
        quantity: proposal.units * 2,
        optionType: "CALL",
        strike: proposal.legShort.strike,
        expirationDate: proposal.legShort.expirationDate,
      },
    ],
    strategyNetDebit: proposal.netDebitPerUnit,
  };
}

// ---------------------------------------------------------------------------
// Post-trade evaluator (#34 endpoint, surfaced in the UI by issue #67)
// ---------------------------------------------------------------------------

import type { CandidateGreekContribution, PortfolioRiskTotals } from "../services/portfolioRisk";
import type { ThinkTradeValidationResult } from "../types";

export type { CandidateGreekContribution, PortfolioRiskTotals, ThinkTradeValidationResult };

export interface EvaluateResult {
  current: PortfolioRiskReport;
  postTradeTotals: PortfolioRiskTotals;
}

export function fetchEvaluate(env: string, candidate: CandidateGreekContribution): Promise<EvaluateResult> {
  return postJson<EvaluateResult>("/api/etrade/portfolio-risk/evaluate", env, { candidate });
}

/** Parses the Evaluate form into a candidate contribution; null when a required field is not numeric. */
export function buildEvaluateCandidate(form: Record<string, string>): CandidateGreekContribution | null {
  const num = (key: string): number | null => {
    const raw = (form[key] ?? "").trim();
    if (raw === "") return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  };
  const required = ["deltaShares", "deltaDollars", "gammaSharesPerDollar", "thetaDollarsPerDay", "vegaDollarsPerVolPoint", "rhoDollarsPerRatePoint", "definedMaxLoss"];
  const values: Record<string, number> = {};
  for (const key of required) {
    const v = num(key);
    if (v === null) return null;
    values[key] = v;
  }
  const betaRaw = (form.betaWeightedDeltaDollars ?? "").trim();
  return {
    deltaShares: values.deltaShares,
    deltaDollars: values.deltaDollars,
    betaWeightedDeltaDollars: betaRaw === "" ? null : Number(betaRaw),
    gammaSharesPerDollar: values.gammaSharesPerDollar,
    thetaDollarsPerDay: values.thetaDollarsPerDay,
    vegaDollarsPerVolPoint: values.vegaDollarsPerVolPoint,
    rhoDollarsPerRatePoint: values.rhoDollarsPerRatePoint,
    definedMaxLoss: values.definedMaxLoss,
  };
}

// ---------------------------------------------------------------------------
// Think-harness guardrail verdicts (#37 service, HTTP route added in #67)
// ---------------------------------------------------------------------------

export interface ThinkEvaluateInput {
  symbol: string;
  action: "BUY" | "SELL";
  quantity: number;
  orderType?: "MARKET" | "LIMIT" | "STOP";
  price?: number;
}

export function fetchThinkVerdict(env: string, input: ThinkEvaluateInput): Promise<ThinkTradeValidationResult> {
  return postJson<ThinkTradeValidationResult>("/api/etrade/think/evaluate", env, input);
}

// ---------------------------------------------------------------------------
// Prefill wiring (issue #69): pure mappings into the Evaluator form shape
// ---------------------------------------------------------------------------

import type { PositionRiskRow } from "../services/portfolioRisk";
import type { SizingResult as SizingResultType } from "../services/positionSizing";

const str = (v: number | null | undefined): string => (v === null || v === undefined || !Number.isFinite(v) ? "" : String(Math.round(v * 100) / 100));

/** A held position's Greek contribution → Evaluator form (complete: rows carry every Greek). */
export function positionRowToEvalForm(row: PositionRiskRow): Record<string, string> {
  return {
    deltaShares: str(row.deltaShares),
    deltaDollars: str(row.deltaDollars),
    betaWeightedDeltaDollars: str(row.betaWeightedDeltaDollars),
    gammaSharesPerDollar: str(row.gammaSharesPerDollar),
    thetaDollarsPerDay: str(row.thetaDollarsPerDay),
    vegaDollarsPerVolPoint: str(row.vegaDollarsPerVolPoint),
    rhoDollarsPerRatePoint: str(row.rhoDollarsPerRatePoint),
    definedMaxLoss: str(row.definedMaxLoss),
  };
}

/**
 * A sizing result → Evaluator form for the fields sizing knows (delta,
 * beta-weighted delta, defined max loss), scaled per-contract × recommended
 * contracts. Greeks sizing doesn't carry (gamma/theta/vega/rho, delta shares)
 * are left blank for the user — never invented.
 */
export function sizingToEvalForm(candidate: SizingCandidate, sizing: SizingResultType): Record<string, string> {
  const n = sizing.recommendedContracts;
  return {
    deltaShares: "",
    deltaDollars: str(candidate.perContract.deltaDollars * n),
    betaWeightedDeltaDollars: candidate.perContract.betaWeightedDeltaDollars === null ? "" : str(candidate.perContract.betaWeightedDeltaDollars * n),
    gammaSharesPerDollar: "",
    thetaDollarsPerDay: "",
    vegaDollarsPerVolPoint: "",
    rhoDollarsPerRatePoint: "",
    definedMaxLoss: candidate.perContract.definedMaxLoss === null ? "" : str(candidate.perContract.definedMaxLoss * n),
  };
}
