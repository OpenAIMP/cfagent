/**
 * Portfolio concentration & diversification assessment (issue #35, gap G2).
 *
 * Consumes the G1 aggregation (#34) and the correlation service to answer:
 * "does this candidate duplicate exposure the book already carries?" —
 * the question cross-name ranking could not see when every name was
 * treated as independent.
 *
 * Rules (all thresholds in CONCENTRATION_POLICY, nowhere else):
 *  - A candidate with MEASURED correlation ≥ 0.70 to a materially-sized
 *    held position is flagged, naming that position.
 *  - A candidate joining a sector that already dominates the book's delta
 *    exposure (≥ 40%) is flagged, naming the sector's held positions.
 *  - Proxy (same-sector, unmeasured) relatedness to a dominant sector is
 *    flagged as a proxy — never upgraded to a measured claim.
 *  - Unknown correlation is reported as unknown in the assessment status;
 *    it is never treated as zero and never blocks a flag from other tiers.
 */

import type { PortfolioRiskReport } from "./portfolioRisk";
import { sectorOf, type CorrelationEstimate } from "./correlationService";

export const CONCENTRATION_POLICY = {
  highCorrelation: 0.7,
  materialSharePct: 5,
  dominantSectorSharePct: 40,
  maxSymbols: 25,
} as const;

export type CorrelationEstimator = (a: string, b: string) => Promise<CorrelationEstimate>;

export interface SectorShare {
  sector: string;
  /** Share of total absolute delta dollars, %. */
  sharePct: number;
  symbols: string[];
}

export interface PairwiseCorrelation {
  a: string;
  b: string;
  value: number | null;
  source: CorrelationEstimate["source"];
  observations: number;
  sector?: string;
}

export interface ConcentrationFlag {
  kind: "high-correlation" | "sector-concentration" | "proxy-sector-match";
  message: string;
  positions: string[];
  correlation?: number | null;
  /** Provenance of the correlation claim, when the flag makes one. Sector
   *  flags rest on bookkeeping shares, not estimates, and omit it. */
  source?: CorrelationEstimate["source"];
  sector?: string;
}

export interface CandidateConcentrationAssessment {
  symbol: string;
  sector: string | null;
  correlations: Array<{ heldSymbol: string; value: number | null; source: CorrelationEstimate["source"]; observations: number }>;
  flags: ConcentrationFlag[];
  /** "assessed" when every candidate correlation is measured or proxied;
   *  "partial-unknown" when at least one is unknown. */
  status: "assessed" | "partial-unknown";
}

export interface ConcentrationReport {
  asOf: string;
  sectorShares: SectorShare[];
  heldCorrelations: PairwiseCorrelation[];
  candidateAssessment: CandidateConcentrationAssessment | null;
}

export async function assessPortfolioConcentration(
  report: PortfolioRiskReport,
  estimate: CorrelationEstimator,
  candidateSymbol?: string,
): Promise<ConcentrationReport> {
  const rows = report.rows.filter((r) => r.deltaDollars !== null);
  const totalAbsDelta = rows.reduce((sum, r) => sum + Math.abs(r.deltaDollars ?? 0), 0);
  const shareOf = (symbol: string): number => {
    if (totalAbsDelta <= 0) return 0;
    const mine = rows.filter((r) => r.symbol === symbol).reduce((sum, r) => sum + Math.abs(r.deltaDollars ?? 0), 0);
    return (mine / totalAbsDelta) * 100;
  };

  // Sector shares of current delta exposure.
  const bySector = new Map<string, { abs: number; symbols: Set<string> }>();
  for (const row of rows) {
    const sector = sectorOf(row.symbol) ?? "Unknown";
    const entry = bySector.get(sector) ?? { abs: 0, symbols: new Set<string>() };
    entry.abs += Math.abs(row.deltaDollars ?? 0);
    entry.symbols.add(row.symbol);
    bySector.set(sector, entry);
  }
  const sectorShares: SectorShare[] = [...bySector.entries()]
    .map(([sector, e]) => ({
      sector,
      sharePct: totalAbsDelta > 0 ? Math.round((e.abs / totalAbsDelta) * 1000) / 10 : 0,
      symbols: [...e.symbols].sort(),
    }))
    .sort((a, b) => b.sharePct - a.sharePct);

  // Pairwise correlations among held names.
  const heldSymbols = [...new Set(rows.map((r) => r.symbol))].slice(0, CONCENTRATION_POLICY.maxSymbols);
  const heldCorrelations: PairwiseCorrelation[] = [];
  for (let i = 0; i < heldSymbols.length; i++) {
    for (let j = i + 1; j < heldSymbols.length; j++) {
      const est = await estimate(heldSymbols[i], heldSymbols[j]);
      heldCorrelations.push({ a: heldSymbols[i], b: heldSymbols[j], value: est.value, source: est.source, observations: est.observations, sector: est.sector });
    }
  }

  // Candidate assessment.
  let candidateAssessment: CandidateConcentrationAssessment | null = null;
  if (candidateSymbol) {
    const symbol = candidateSymbol.toUpperCase();
    const sector = sectorOf(symbol);
    const correlations: CandidateConcentrationAssessment["correlations"] = [];
    const flags: ConcentrationFlag[] = [];
    let sawUnknown = false;

    for (const held of heldSymbols) {
      if (held === symbol) continue;
      const est = await estimate(symbol, held);
      correlations.push({ heldSymbol: held, value: est.value, source: est.source, observations: est.observations });
      if (est.source === "unknown") sawUnknown = true;

      if (est.source === "measured" && est.value !== null && est.value >= CONCENTRATION_POLICY.highCorrelation && shareOf(held) >= CONCENTRATION_POLICY.materialSharePct) {
        flags.push({
          kind: "high-correlation",
          message: `${symbol} has measured correlation ${est.value} with held position ${held} (${shareOf(held).toFixed(1)}% of book delta) — adding it materially duplicates existing exposure.`,
          positions: [held],
          correlation: est.value,
          source: "measured",
        });
      }
    }

    if (sector) {
      const sectorShare = sectorShares.find((s) => s.sector === sector);
      if (sectorShare && sectorShare.sharePct >= CONCENTRATION_POLICY.dominantSectorSharePct) {
        flags.push({
          kind: "sector-concentration",
          message: `${symbol} is in ${sector}, which already carries ${sectorShare.sharePct}% of the book's delta exposure (${sectorShare.symbols.join(", ")}).`,
          positions: sectorShare.symbols,
          sector,
        });
        const proxyMatches = correlations.filter((c) => c.source === "proxy-sector");
        for (const match of proxyMatches) {
          flags.push({
            kind: "proxy-sector-match",
            message: `${symbol} is sector-proxy related to held ${match.heldSymbol} (${sector}) — correlation itself is unmeasured; flagged on sector grounds only.`,
            positions: [match.heldSymbol],
            correlation: null,
            source: "proxy-sector",
            sector,
          });
        }
      }
    }

    candidateAssessment = {
      symbol,
      sector,
      correlations,
      flags,
      status: sawUnknown ? "partial-unknown" : "assessed",
    };
  }

  return { asOf: report.asOf, sectorShares, heldCorrelations, candidateAssessment };
}
