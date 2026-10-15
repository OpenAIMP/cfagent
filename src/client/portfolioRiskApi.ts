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
import type { OptionsTradeContext } from "./options/OptionsResearchPanel";

export type { PortfolioRiskReport, ConcentrationReport, SizingCandidate, SizingResult, HedgeAnalysis, HedgeProposal };

async function postJson<T>(path: string, env: string, body?: unknown): Promise<T> {
  const resp = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-environment": env },
    body: JSON.stringify(body ?? {}),
  });
  const data = (await resp.json().catch(() => ({}))) as T & { error?: string };
  if (!resp.ok) throw new Error((data as { error?: string }).error || `Request failed (${resp.status})`);
  return data;
}

export async function fetchPortfolioRisk(env: string): Promise<PortfolioRiskReport> {
  const resp = await fetch("/api/etrade/portfolio-risk", { headers: { "x-environment": env } });
  const data = (await resp.json().catch(() => ({}))) as PortfolioRiskReport & { error?: string };
  if (!resp.ok) throw new Error(data.error || `Request failed (${resp.status})`);
  return data;
}

export function fetchHedgeAnalysis(env: string): Promise<HedgeAnalysis> {
  return postJson<HedgeAnalysis>("/api/etrade/hedge/analyze", env);
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
 * Converts a hedge DRAFT into the order-ticket context the hub's existing
 * HITL flow consumes (handleOptionsTrade). The panel never previews or
 * executes anything itself — this hand-off is the only bridge, and the
 * human still reviews and approves in the order ticket.
 */
export function hedgeProposalToTradeContext(proposal: HedgeProposal, spyPrice: number | null): OptionsTradeContext {
  const move = `β-weighted Δ ${fmtSignedUsd(proposal.preHedgeBetaWeightedDeltaDollars)} → ${fmtSignedUsd(proposal.postHedgeBetaWeightedDeltaDollars)}`;
  if (proposal.instrument === "SPY_SHARES") {
    return {
      symbol: "SPY",
      action: proposal.side,
      quantity: proposal.quantity,
      underlyingPrice: spyPrice ?? undefined,
      label: `Hedge draft — ${proposal.side} ${proposal.quantity} SPY shares (${move})`,
      legs: [`${proposal.side} ${proposal.quantity} SPY shares @ ~${fmtUsd(spyPrice, 2)}`],
    };
  }
  return {
    symbol: "SPY",
    action: proposal.side,
    quantity: proposal.quantity,
    underlyingPrice: spyPrice ?? undefined,
    label: `Hedge draft — ${proposal.side} ${proposal.quantity} SPY ${proposal.strike} PUT ${proposal.expirationDate} (${move})`,
    legs: [
      `${proposal.side} ${proposal.quantity} SPY ${proposal.strike} PUT exp ${proposal.expirationDate} — est. cost ${fmtUsd(Math.abs(proposal.estimatedCost), 2)}`,
    ],
  };
}
