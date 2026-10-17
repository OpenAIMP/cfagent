/**
 * Opportunity Scanner panel — issue #84 slice 1.
 *
 * Surfaces, paired to their backends:
 *  - Surface 1 (mode switch, #23): the two strategy questions as an
 *    explicit segmented control — "Best strategy for a name"
 *    (per_name_best) vs "Names that fit my strategy" (strategy_fit).
 *    The mode is component state, is sent on every run, and the
 *    results header names the mode that produced them: never inferred
 *    from phrasing, never read back from live form state.
 *  - Surface 4 (strategy profiles, #28): a picker in the scan form
 *    (one tap from the fit-mode question) plus a full profile manager
 *    (list / create / edit / delete) over the profiles CRUD routes.
 *    Server validation messages (400s, duplicate names) surface
 *    verbatim; a scan run under a profile shows the server's
 *    profileRef stamp as a badge.
 *
 * Honesty rules carried from the backends: a strategy-fit run with
 * zero fits renders an explicit no-fit state with the gate accounting
 * (never an empty table); every array the payload may omit is treated
 * as empty (scannerApi coerces, this panel also guards).
 *
 *  - Slice 2 (matrix board #22 + type roll-up #26): the full
 *    names × strategy-types fit matrix renders as a board under the
 *    headline results, with the per-type screen roll-up as cards
 *    above it. A matrix "pass" is a SCREEN pass only (the scanner's
 *    risk screen) — qualification stays the fit gate's job, and the
 *    copy says so. A cell with a passing candidate hands off to the
 *    hub's existing HITL preview (onPreviewTrade) — the panel itself
 *    never calls an order endpoint.
 *
 * All HTTP goes through scannerApi → apiFetch (the 202 async-job
 * polling convention, issue #71). Later #84 slices add the full
 * trust layer and scan history (#27).
 */

import { useCallback, useEffect, useState } from "react";
import "./scannerPanel.css";
import { parseSymbolList } from "./accountApi";
import {
  createProfile,
  deleteProfile,
  listProfiles,
  runOpportunityScan,
  updateProfile,
  type OpportunityScanResponse,
  type ScanMode,
  type StrategyProfile,
  type StrategyProfileSpec,
} from "./scannerApi";
import type {
  OpportunityRow,
  ScanMatrixCell,
  ScanMatrixCellBest,
  ScanMatrixRow,
  ScanTypeRollup,
} from "../trading/options/opportunityScanner";
import type { TradeOrderContext } from "./trading/tradeOrderContext";
import type { ExpectedIvDirection, OptionThesis } from "../trading/options/strategyEngine";
import type { UnifiedOptionsRequest } from "../trading/options/unifiedOptionsService";

// Mode switch (surface 1) -----------------------------------------------

export const MODE_LABELS: Record<ScanMode, string> = {
  per_name_best: "Best strategy for a name",
  strategy_fit: "Names that fit my strategy",
};

const THESIS_OPTIONS: Array<{ value: OptionThesis; label: string }> = [
  { value: "bullish", label: "Bullish" },
  { value: "bearish", label: "Bearish" },
  { value: "range_bound", label: "Range-bound" },
  { value: "large_move", label: "Large move" },
];

const RISK_PROFILE_OPTIONS = ["conservative", "balanced", "aggressive"] as const;
type RiskProfileValue = (typeof RISK_PROFILE_OPTIONS)[number];

export interface ScanFormInput {
  symbolsText: string;
  thesis: OptionThesis;
  riskProfile: RiskProfileValue;
  mode: ScanMode;
  profileId: string;
  fitLimit: number;
}

/** The exact request body a Run click sends. Mode rides on EVERY run
 *  (explicit, per #84); a chosen profile sends its id; the fit limit
 *  rides the unified request's declared `limit` field in fit mode. */
export function buildScanRequest(input: ScanFormInput): UnifiedOptionsRequest {
  const symbols = parseSymbolList(input.symbolsText);
  return {
    action: "opportunities",
    ...(symbols.length > 0 ? { symbols } : {}),
    thesis: input.thesis,
    riskProfile: input.riskProfile,
    mode: input.mode,
    ...(input.profileId ? { profileId: input.profileId } : {}),
    ...(input.mode === "strategy_fit" ? { limit: input.fitLimit } : {}),
  };
}

// Result view-model helpers (exported for tests) --------------------------

/** The best passing cell of a fit row: highest composite score wins. */
export function bestFitCell(row: ScanMatrixRow) {
  let best: { strategyType: string; label: string; compositeScore: number; probabilityOfProfit: number; netDebit: number; maxLoss: number } | null = null;
  for (const cell of row.cells ?? []) {
    if (!cell.best) continue;
    if (!best || cell.best.compositeScore > best.compositeScore) {
      best = {
        strategyType: cell.strategyType,
        label: cell.best.label,
        compositeScore: cell.best.compositeScore,
        probabilityOfProfit: cell.best.probabilityOfProfit,
        netDebit: cell.best.netDebit,
        maxLoss: cell.best.maxLoss,
      };
    }
  }
  return best;
}

/** Coverage accounting with honest fallbacks for partial payloads. */
export function scanCounts(result: OpportunityScanResponse) {
  const gate = result.gate ?? { fit: 0, borderline: 0, noFit: 0 };
  const evaluated = result.coverage?.evaluated ?? gate.fit + gate.borderline + gate.noFit;
  const scanned = result.coverage?.scanned ?? result.scanned ?? 0;
  const skipped = result.coverage?.errors ?? (result.skipped ?? []).length;
  return { gate, evaluated, scanned, skipped };
}

/** The explicit no-fit statement (acceptance: never an empty table). */
export function noFitMessage(result: OpportunityScanResponse): string {
  const { gate, evaluated, skipped } = scanCounts(result);
  return `No names fit under the current gate — ${evaluated} evaluated, ${gate.borderline} borderline, ${skipped} skipped.`;
}

function fmtMoney(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtEntry(netDebit: number | null | undefined): string {
  if (netDebit === null || netDebit === undefined || !Number.isFinite(netDebit)) return "—";
  return netDebit >= 0 ? `${fmtMoney(netDebit)} debit` : `${fmtMoney(-netDebit)} credit`;
}

function fmtPct(fraction: number | null | undefined): string {
  if (fraction === null || fraction === undefined || !Number.isFinite(fraction)) return "—";
  return `${(fraction * 100).toFixed(1)}%`;
}

function fmtTarget(price: number | null | undefined, source: string | null | undefined, emUnits: number | null | undefined): string {
  if (price === null || price === undefined || !Number.isFinite(price)) return "—";
  const em = emUnits !== null && emUnits !== undefined && Number.isFinite(emUnits)
    ? ` · ${emUnits >= 0 ? "+" : ""}${emUnits.toFixed(2)} EM`
    : "";
  return `${fmtMoney(price)}${source ? ` (${source})` : ""}${em}`;
}

// Slice 2 view-model helpers (exported for tests) -------------------------

/**
 * Board column order: the union of strategy types across all rows,
 * in first-appearance order (rows in matrix order, cells in cell
 * order). Derived from the matrix alone, so the board renders even
 * when a payload carries no roll-up.
 */
export function matrixStrategyTypes(rows: ScanMatrixRow[]): string[] {
  const seen: string[] = [];
  for (const row of rows) {
    for (const cell of row.cells ?? []) {
      if (!seen.includes(cell.strategyType)) seen.push(cell.strategyType);
    }
  }
  return seen;
}

/** A cell's most frequent rejection reason (ties keep the histogram's
 *  own order); null when nothing was rejected with a recorded reason. */
export function topRejectionReason(
  rejectionReasons: Record<string, number> | undefined,
): { reason: string; count: number } | null {
  let top: { reason: string; count: number } | null = null;
  for (const [reason, count] of Object.entries(rejectionReasons ?? {})) {
    if (!top || count > top.count) top = { reason, count };
  }
  return top;
}

/**
 * Build the HITL-preview handoff for a matrix cell's best candidate.
 * Faithful replication of OptionsResearchPanel's module-local
 * toTradeContext (same field mapping, same label format, quantity 1)
 * for the flattened ScanMatrixCellBest shape: the symbol comes from
 * the matrix row (the cell best carries none) and the action follows
 * the run's thesis exactly as the research panel derives it. The cell
 * best carries no spot price, so underlyingPrice is omitted — the
 * research panel's value comes from its own screened chain, not from
 * the candidate, and inventing one here would misstate the preview.
 */
export function matrixCellTradeContext(
  row: ScanMatrixRow,
  cell: ScanMatrixCell,
  thesis?: OptionThesis,
): TradeOrderContext {
  const best = cell.best as ScanMatrixCellBest;
  const optionLegs = best.legs.map((leg) => ({
    securityType: leg.optionType === "STOCK" ? "EQ" as const : "OPTN" as const,
    side: leg.side,
    quantity: leg.quantity,
    optionType: leg.optionType === "STOCK" ? undefined : leg.optionType,
    strike: leg.optionType === "STOCK" ? undefined : leg.strike,
    expirationDate: leg.optionType === "STOCK" ? undefined : leg.expirationDate,
  }));
  return {
    assetClass: optionLegs.some((leg) => leg.securityType === "OPTN") ? "options" : "equity",
    symbol: row.symbol,
    action: thesis === "bearish" ? "SELL_SHORT" : "BUY",
    quantity: 1,
    label: `${best.label} (${best.expirationDate}), max loss $${best.maxLoss}`,
    legs: best.legs.map((leg) => `${leg.side} ${leg.quantity} ${leg.symbol} @ $${leg.entryPrice.toFixed(2)}`),
    optionLegs,
    strategyNetDebit: best.netDebit,
  };
}

// Results (presentational — exported for render tests) --------------------

export interface ScanRunContext {
  mode: ScanMode;
  profileLabel: string | null;
  /** The thesis the run was submitted with (snapshotted like the
   *  mode): the matrix-cell trade handoff derives its action from it,
   *  the same way the research panel derives it from its thesis. */
  thesis?: OptionThesis;
}

/**
 * Per-strategy-type roll-up cards (issue #26 surface). "Passed" on
 * this surface is the scanner's RISK SCREEN pass, counted from the
 * matrix cells — the backend keeps it distinct from the single-name
 * ledger's acceptance-rule passes and from fit-gate qualification,
 * and the copy here keeps that distinction in front of the user.
 * Renders nothing when the scan carried no roll-up.
 */
export function TypeRollupCards({ rollup }: { rollup: ScanTypeRollup[] }) {
  if (!rollup || rollup.length === 0) return null;
  return (
    <div className="scp-rollup-wrap">
      <div className="scp-subhead">By strategy type</div>
      <div className="scp-legend">
        Risk-screen roll-up: counts are candidates that passed the scanner's risk screen.
        A screen pass is not an acceptance-rule pass and not a fit-gate qualification.
      </div>
      <div className="scp-rollup">
        {rollup.map((entry) => (
          <div className="scp-rollup-card" key={entry.strategyType}>
            <div className="scp-rollup-type">{entry.strategyType}</div>
            <div className="scp-rollup-line">
              {entry.symbolsPassed} of {entry.symbolsEvaluated} symbols passed the screen
            </div>
            <div className="scp-rollup-meta">
              {entry.passedCount} passed · {entry.rejectedCount} rejected of {entry.evaluatedCount} candidates
            </div>
            {entry.bestOverall ? (
              <div className="scp-rollup-best">
                Best: <strong>{entry.bestOverall.symbol}</strong> — {entry.bestOverall.label} · score{" "}
                {entry.bestOverall.compositeScore.toFixed(1)} · POP {fmtPct(entry.bestOverall.probabilityOfProfit)}
              </div>
            ) : (
              <div className="scp-rollup-best scp-muted">No passing candidate</div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

const VERDICT_LABELS: Record<ScanMatrixRow["verdict"], string> = {
  pass: "PASS",
  no_pass: "NO PASS",
  skipped: "SKIPPED",
};

/**
 * The names × strategy-types fit matrix as a board (issue #22
 * surface). Verdicts are screen verdicts only — the row's fit-gate
 * badge rides next to the verdict chip so the two layers are never
 * conflated. A cell whose type produced a passing candidate is a
 * button into the hub's existing HITL preview when the panel was
 * given onPreviewTrade; the panel itself places no orders.
 */
export function MatrixBoard({
  matrix,
  thesis,
  onPreviewTrade,
}: {
  matrix: ScanMatrixRow[];
  thesis?: OptionThesis;
  onPreviewTrade?: (ctx: TradeOrderContext) => void;
}) {
  if (!matrix || matrix.length === 0) return null;
  const types = matrixStrategyTypes(matrix);
  return (
    <div className="scp-matrix" id="scanner-matrix-board">
      <div className="scp-subhead">Fit matrix</div>
      <div className="scp-legend">
        Pass = screen pass only: at least one candidate passed the scanner's risk screen in that
        type. Qualification is the fit gate's job — see the fit / borderline / no fit badge on each row.
      </div>
      <div className="scp-matrix-scroll">
        <table className="scp-table scp-matrix-table">
          <thead>
            <tr>
              <th>Symbol</th>
              {types.map((t) => <th key={t}>{t}</th>)}
            </tr>
          </thead>
          <tbody>
            {matrix.map((row, idx) => (
              <tr key={`${row.symbol}-${idx}`}>
                <td className="scp-matrix-symbol">
                  <strong>{row.symbol}</strong>{" "}
                  <span className={`scp-badge scp-badge-verdict-${row.verdict}`}>{VERDICT_LABELS[row.verdict]}</span>
                  {row.gateBucket && (
                    <> <span className={`scp-badge scp-badge-${row.gateBucket}`}>{row.gateBucket}</span></>
                  )}
                  {row.verdict !== "skipped" && (
                    <div className="scp-row-meta">Target {fmtTarget(row.targetPrice, row.targetSource, row.targetEmUnits)}</div>
                  )}
                  {row.gateReasons && row.gateReasons.length > 0 && (
                    <div className="scp-reasons">{row.gateReasons.join("; ")}</div>
                  )}
                </td>
                {row.verdict === "skipped" ? (
                  <td className="scp-skip-reason" colSpan={Math.max(types.length, 1)}>
                    Skipped — {row.skipReason ?? "not evaluated"}
                  </td>
                ) : (
                  types.map((type) => {
                    const cell = (row.cells ?? []).find((c) => c.strategyType === type);
                    if (!cell) return <td key={type} className="scp-cell-empty">—</td>;
                    if (!cell.best) {
                      const top = topRejectionReason(cell.rejectionReasons);
                      return (
                        <td key={type} className="scp-cell">
                          <div>{cell.passedCount}/{cell.evaluatedCount} passed · {cell.rejectedCount} rejected</div>
                          {top && (
                            <div className="scp-cell-reason" title={top.reason}>
                              top rejection: {top.reason} ×{top.count}
                            </div>
                          )}
                        </td>
                      );
                    }
                    const content = (
                      <>
                        <div className="scp-cell-score">{cell.best.compositeScore.toFixed(1)}</div>
                        <div>{cell.passedCount}/{cell.evaluatedCount} passed</div>
                        <div className="scp-cell-label">{cell.best.label}</div>
                      </>
                    );
                    return (
                      <td key={type} className="scp-cell">
                        {onPreviewTrade ? (
                          <button
                            type="button"
                            className="scp-cell-btn"
                            title={`Preview ${cell.best.label} for ${row.symbol}`}
                            onClick={() => onPreviewTrade(matrixCellTradeContext(row, cell, thesis))}
                          >
                            {content}
                          </button>
                        ) : content}
                      </td>
                    );
                  })
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function ScanResultsView({ result, runContext, onPreviewTrade }: { result: OpportunityScanResponse; runContext: ScanRunContext; onPreviewTrade?: (ctx: TradeOrderContext) => void }) {
  const mode = runContext.mode;
  const { gate, evaluated, scanned, skipped } = scanCounts(result);
  const generatedAt = result.generatedAt || result.meta?.generatedAt;
  const opportunities = result.opportunities ?? [];
  const fits = result.fits ?? [];
  const assumptions = result.assumptions ?? [];
  const borderline = result.borderline ?? [];
  const matrix = result.matrix ?? [];
  const typeRollup = result.typeRollup ?? [];

  return (
    <div className="scp-results">
      <div className="scp-results-head">
        <strong>Mode: {MODE_LABELS[mode]}</strong>
        {result.profileRef && (
          <span className="scp-badge scp-badge-profile">Profile: {result.profileRef.name} v{result.profileRef.version}</span>
        )}
        {!result.profileRef && runContext.profileLabel && (
          <span className="scp-badge">Profile: {runContext.profileLabel}</span>
        )}
        {generatedAt && <span className="scp-asof">generated {new Date(generatedAt).toLocaleString()}</span>}
      </div>
      <div className="scp-counts">
        {scanned} scanned · {evaluated} evaluated · {skipped} skipped
        {mode === "strategy_fit" && (
          <> · <strong>{result.fitsTotal ?? 0} fits</strong> · gate: {gate.fit} fit / {gate.borderline} borderline / {gate.noFit} no fit</>
        )}
        {mode === "per_name_best" && (
          <> · gate: {gate.fit} fit / {gate.borderline} borderline / {gate.noFit} no fit</>
        )}
        {result.persisted && result.scanRunId && <> · saved as scan run {result.scanRunId}</>}
      </div>

      <TypeRollupCards rollup={typeRollup} />

      {mode === "per_name_best" && (
        opportunities.length > 0 ? (
          <table className="scp-table">
            <thead>
              <tr><th>Symbol</th><th>Strategy</th><th>Score</th><th>POP</th><th>Target</th><th>Entry</th><th>Max loss</th><th>Gate</th></tr>
            </thead>
            <tbody>
              {opportunities.map((row: OpportunityRow, idx: number) => {
                const candidate = row.pick?.best?.candidate;
                const score = row.pick?.best?.compositeScore ?? row.score;
                return (
                  <tr key={`${row.symbol}-${idx}`}>
                    <td><strong>{row.symbol}</strong></td>
                    <td>{candidate ? candidate.label : row.pick?.status === "no_trade" ? "No qualifying trade" : "—"}</td>
                    <td>{typeof score === "number" && Number.isFinite(score) ? score.toFixed(1) : "—"}</td>
                    <td>{fmtPct(candidate?.modelImpliedProbabilityOfProfit)}</td>
                    <td>{fmtTarget(row.targetPrice, row.targetSource, row.targetEmUnits)}</td>
                    <td>{fmtEntry(candidate?.netDebit)}</td>
                    <td>{fmtMoney(candidate?.maxLoss)}</td>
                    <td>
                      <span className={`scp-badge scp-badge-${row.gateBucket ?? "none"}`}>{row.gateBucket ?? "—"}</span>
                      {row.gateReasons && row.gateReasons.length > 0 && (
                        <div className="scp-reasons">{row.gateReasons.join("; ")}</div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <div className="scp-nofit" role="note">No qualifying trades were returned for this scan.</div>
        )
      )}

      {mode === "strategy_fit" && (
        (result.fitsTotal ?? 0) === 0 ? (
          <div className="scp-nofit" role="note">{noFitMessage(result)}</div>
        ) : fits.length > 0 ? (
          <table className="scp-table">
            <thead>
              <tr><th>Symbol</th><th>Best fit strategy</th><th>Score</th><th>POP</th><th>Target</th><th>Entry</th><th>Max loss</th><th>Gate</th></tr>
            </thead>
            <tbody>
              {fits.map((row: ScanMatrixRow, idx: number) => {
                const best = bestFitCell(row);
                return (
                  <tr key={`${row.symbol}-${idx}`}>
                    <td><strong>{row.symbol}</strong></td>
                    <td>{best ? best.label : "—"}</td>
                    <td>{best ? best.compositeScore.toFixed(1) : "—"}</td>
                    <td>{fmtPct(best?.probabilityOfProfit)}</td>
                    <td>{fmtTarget(row.targetPrice, row.targetSource, row.targetEmUnits)}</td>
                    <td>{fmtEntry(best?.netDebit)}</td>
                    <td>{fmtMoney(best?.maxLoss)}</td>
                    <td>
                      <span className={`scp-badge scp-badge-${row.gateBucket ?? "none"}`}>{row.gateBucket ?? "—"}</span>
                      {row.gateReasons && row.gateReasons.length > 0 && (
                        <div className="scp-reasons">{row.gateReasons.join("; ")}</div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <div className="scp-nofit" role="note">{noFitMessage(result)}</div>
        )
      )}

      {mode === "strategy_fit" && borderline.length > 0 && (
        <div className="scp-note">Borderline (evaluated, below the gate): {borderline.map((r) => r.symbol).join(", ")}</div>
      )}

      <MatrixBoard matrix={matrix} thesis={runContext.thesis} onPreviewTrade={onPreviewTrade} />

      {assumptions.length > 0 && (
        <div className="scp-assumptions">
          <div className="scp-subhead">Assumptions &amp; disclosures</div>
          <ul>
            {assumptions.map((line, idx) => <li key={idx}>{line}</li>)}
          </ul>
        </div>
      )}
    </div>
  );
}

// Profile form model (exported for tests) ---------------------------------

export interface ProfileFormState {
  name: string;
  thesis: string;
  allowedStrategies: string;
  maxPlannedLoss: string;
  minRewardRisk: string;
  minDte: string;
  maxDte: string;
  eventPolicy: string;
  expectedIvDirection: string;
  optimizationBias: string;
  riskProfile: string;
  mode: string;
  gateEnabled: boolean;
  gateMinCompositeScore: string;
  gateMinProbabilityOfProfit: string;
  gateRequireFresh: boolean;
  gateMinConfidence: string;
}

export function emptyProfileForm(): ProfileFormState {
  return {
    name: "", thesis: "", allowedStrategies: "", maxPlannedLoss: "", minRewardRisk: "",
    minDte: "", maxDte: "", eventPolicy: "", expectedIvDirection: "", optimizationBias: "",
    riskProfile: "", mode: "",
    gateEnabled: false, gateMinCompositeScore: "", gateMinProbabilityOfProfit: "",
    gateRequireFresh: true, gateMinConfidence: "",
  };
}

export function profileToForm(profile: StrategyProfile): ProfileFormState {
  const num = (v: number | undefined) => (v === undefined ? "" : String(v));
  return {
    name: profile.name,
    thesis: profile.thesis ?? "",
    allowedStrategies: (profile.allowedStrategies ?? []).join(", "),
    maxPlannedLoss: num(profile.maxPlannedLoss),
    minRewardRisk: num(profile.minRewardRisk),
    minDte: num(profile.minDte),
    maxDte: num(profile.maxDte),
    eventPolicy: profile.eventPolicy ?? "",
    expectedIvDirection: profile.expectedIvDirection ?? "",
    optimizationBias: num(profile.optimizationBias),
    riskProfile: profile.riskProfile ?? "",
    mode: profile.mode ?? "",
    gateEnabled: !!profile.fitGate,
    gateMinCompositeScore: num(profile.fitGate?.minCompositeScore),
    gateMinProbabilityOfProfit: num(profile.fitGate?.minProbabilityOfProfit),
    gateRequireFresh: profile.fitGate?.requireFresh ?? true,
    gateMinConfidence: profile.fitGate?.minConfidence ?? "",
  };
}

/**
 * Assemble the spec a Save click submits. Empty optional fields are
 * OMITTED (undefined — never null/"") so the profile constrains only
 * what the user actually set. Non-numeric text in a numeric field is a
 * local problem (named, never silently dropped or sent as NaN); all
 * semantic validation (ranges, unknown strategy ids, DTE ordering) is
 * the server's, and its 400 message surfaces verbatim.
 */
export function buildProfileSpec(form: ProfileFormState): { spec: StrategyProfileSpec; problems: string[] } {
  const spec: StrategyProfileSpec = {};
  const problems: string[] = [];
  const num = (text: string, field: string, label: string) => {
    const trimmed = text.trim();
    if (trimmed === "") return;
    const value = Number(trimmed);
    if (!Number.isFinite(value)) {
      problems.push(`${label} must be a number.`);
      return;
    }
    (spec as Record<string, unknown>)[field] = value;
  };
  if (form.thesis) spec.thesis = form.thesis as OptionThesis;
  const types = form.allowedStrategies.split(/[,\s]+/).map((t) => t.trim()).filter(Boolean);
  if (types.length > 0) spec.allowedStrategies = types;
  num(form.maxPlannedLoss, "maxPlannedLoss", "Max planned loss");
  num(form.minRewardRisk, "minRewardRisk", "Min reward/risk");
  num(form.minDte, "minDte", "Min DTE");
  num(form.maxDte, "maxDte", "Max DTE");
  if (form.eventPolicy) spec.eventPolicy = form.eventPolicy as "warn" | "exclude";
  if (form.expectedIvDirection) spec.expectedIvDirection = form.expectedIvDirection as ExpectedIvDirection;
  num(form.optimizationBias, "optimizationBias", "Optimization bias");
  if (form.riskProfile) spec.riskProfile = form.riskProfile as RiskProfileValue;
  if (form.mode) spec.mode = form.mode as ScanMode;
  if (form.gateEnabled) {
    const gate: NonNullable<StrategyProfileSpec["fitGate"]> = { requireFresh: form.gateRequireFresh };
    const gateNum = (text: string, field: "minCompositeScore" | "minProbabilityOfProfit", label: string) => {
      const trimmed = text.trim();
      if (trimmed === "") return;
      const value = Number(trimmed);
      if (!Number.isFinite(value)) {
        problems.push(`${label} must be a number.`);
        return;
      }
      gate[field] = value;
    };
    gateNum(form.gateMinCompositeScore, "minCompositeScore", "Gate min score");
    gateNum(form.gateMinProbabilityOfProfit, "minProbabilityOfProfit", "Gate min POP");
    if (form.gateMinConfidence) gate.minConfidence = form.gateMinConfidence as "LOW" | "MEDIUM" | "HIGH";
    spec.fitGate = gate;
  }
  return { spec, problems };
}

/** One-line constraint summary for a profile list row: only the
 *  constraints the profile actually sets, in a fixed order. */
export function profileSummary(profile: StrategyProfile): string {
  const parts: string[] = [];
  if (profile.thesis) parts.push(`thesis ${profile.thesis}`);
  if (profile.maxPlannedLoss !== undefined) parts.push(`max loss $${profile.maxPlannedLoss}`);
  if (profile.minRewardRisk !== undefined) parts.push(`min R/R ${profile.minRewardRisk}`);
  if (profile.minDte !== undefined || profile.maxDte !== undefined) {
    parts.push(profile.minDte !== undefined && profile.maxDte !== undefined
      ? `DTE ${profile.minDte}–${profile.maxDte}`
      : profile.minDte !== undefined ? `DTE ≥${profile.minDte}` : `DTE ≤${profile.maxDte}`);
  }
  if (profile.allowedStrategies && profile.allowedStrategies.length > 0) parts.push(`types: ${profile.allowedStrategies.join(", ")}`);
  if (profile.eventPolicy) parts.push(`events ${profile.eventPolicy}`);
  if (profile.expectedIvDirection) parts.push(`IV ${profile.expectedIvDirection}`);
  if (profile.optimizationBias !== undefined) parts.push(`bias ${profile.optimizationBias}`);
  if (profile.riskProfile) parts.push(profile.riskProfile);
  if (profile.mode) parts.push(MODE_LABELS[profile.mode]);
  if (profile.fitGate) {
    const g: string[] = [];
    if (profile.fitGate.minCompositeScore !== undefined) g.push(`score ≥${profile.fitGate.minCompositeScore}`);
    if (profile.fitGate.minProbabilityOfProfit !== undefined) g.push(`POP ≥${(profile.fitGate.minProbabilityOfProfit * 100).toFixed(0)}%`);
    if (profile.fitGate.requireFresh !== undefined) g.push(profile.fitGate.requireFresh ? "fresh only" : "stale ok");
    if (profile.fitGate.minConfidence !== undefined) g.push(`≥${profile.fitGate.minConfidence}`);
    if (g.length > 0) parts.push(`gate: ${g.join(", ")}`);
  }
  return parts.length > 0 ? parts.join(" · ") : "No constraints set";
}

// Panel -------------------------------------------------------------------

export interface ScannerPanelProps {
  activeEnv: "TEST" | "PROD";
  userLogin?: string;
  /** HITL preview handoff (the hub's existing order-ticket handler):
   *  matrix cells with a passing candidate offer a preview through
   *  it. Absent → cells render non-interactive. */
  onPreviewTrade?: (ctx: TradeOrderContext) => void;
}

export function ScannerPanel({ activeEnv, userLogin, onPreviewTrade }: ScannerPanelProps) {
  // Scan form state
  const [mode, setMode] = useState<ScanMode>("per_name_best");
  const [symbolsText, setSymbolsText] = useState("AAPL, MSFT, NVDA, AMZN, GOOGL");
  const [thesis, setThesis] = useState<OptionThesis>("bullish");
  const [riskProfile, setRiskProfile] = useState<RiskProfileValue>("balanced");
  const [profileId, setProfileId] = useState("");
  const [fitLimit, setFitLimit] = useState(25);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState("");
  const [result, setResult] = useState<OpportunityScanResponse | null>(null);
  const [runContext, setRunContext] = useState<ScanRunContext | null>(null);

  // Profiles state
  const [profiles, setProfiles] = useState<StrategyProfile[]>([]);
  const [profilesLoaded, setProfilesLoaded] = useState(false);
  const [profilesError, setProfilesError] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<ProfileFormState>(emptyProfileForm());
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedNote, setSavedNote] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const loadProfiles = useCallback(async () => {
    try {
      const list = await listProfiles(activeEnv, userLogin);
      setProfiles(list);
      setProfilesError("");
      setProfileId((current) => (current && !list.some((p) => p.id === current) ? "" : current));
    } catch (cause) {
      setProfilesError(cause instanceof Error ? cause.message : "Failed to load strategy profiles.");
    } finally {
      setProfilesLoaded(true);
    }
  }, [activeEnv, userLogin]);

  useEffect(() => { void loadProfiles(); }, [loadProfiles]);

  const runScan = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (scanning) return;
    const input: ScanFormInput = { symbolsText, thesis, riskProfile, mode, profileId, fitLimit };
    const chosen = profiles.find((p) => p.id === profileId);
    // Snapshot the run's context BEFORE the request: the results header
    // describes the run that produced them, not the live form.
    const context: ScanRunContext = {
      mode,
      profileLabel: chosen ? `${chosen.name} v${chosen.version}` : null,
      thesis,
    };
    setScanning(true);
    setScanError("");
    try {
      const scan = await runOpportunityScan(activeEnv, userLogin, buildScanRequest(input));
      setResult(scan);
      setRunContext(context);
    } catch (cause) {
      setScanError(cause instanceof Error ? cause.message : "Scanner request failed.");
    } finally {
      setScanning(false);
    }
  };

  const openCreateForm = () => {
    setEditingId(null);
    setForm(emptyProfileForm());
    setFormError("");
    setSavedNote("");
    setConfirmDeleteId(null);
    setFormOpen(true);
  };

  const openEditForm = (profile: StrategyProfile) => {
    setEditingId(profile.id);
    setForm(profileToForm(profile));
    setFormError("");
    setSavedNote("");
    setConfirmDeleteId(null);
    setFormOpen(true);
  };

  const saveProfile = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving) return;
    const name = form.name.trim();
    if (!name) {
      setFormError("Profile name is required.");
      return;
    }
    const { spec, problems } = buildProfileSpec(form);
    if (problems.length > 0) {
      setFormError(problems.join(" "));
      return;
    }
    setSaving(true);
    setFormError("");
    try {
      const saved = editingId
        ? await updateProfile(activeEnv, userLogin, editingId, name, spec)
        : await createProfile(activeEnv, userLogin, name, spec);
      await loadProfiles();
      setFormOpen(false);
      setEditingId(null);
      setSavedNote(`Saved profile "${saved.name}" — now v${saved.version}.`);
    } catch (cause) {
      // Server validation / duplicate-name 400s land here verbatim.
      setFormError(cause instanceof Error ? cause.message : "Failed to save strategy profile.");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (profile: StrategyProfile) => {
    if (confirmDeleteId !== profile.id) {
      setConfirmDeleteId(profile.id);
      return;
    }
    setConfirmDeleteId(null);
    try {
      await deleteProfile(activeEnv, userLogin, profile.id);
      if (editingId === profile.id) {
        setFormOpen(false);
        setEditingId(null);
      }
      await loadProfiles();
      setSavedNote(`Deleted profile "${profile.name}".`);
    } catch (cause) {
      setProfilesError(cause instanceof Error ? cause.message : "Failed to delete strategy profile.");
    }
  };

  const setField = (field: keyof ProfileFormState) => (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const value = event.target.type === "checkbox" ? (event.target as HTMLInputElement).checked : event.target.value;
    setForm((current) => ({ ...current, [field]: value }));
  };

  return (
    <section className="scp-panel" id="section-opportunity-scanner" style={{ scrollMarginTop: 80 }}>
      <div className="scp-header">
        <h3>📈 Opportunity Scanner</h3>
        <span className="scp-asof">{activeEnv} environment</span>
      </div>

      <div className="scp-mode-switch" role="group" aria-label="Scan mode">
        {(Object.keys(MODE_LABELS) as ScanMode[]).map((value) => (
          <button
            key={value}
            type="button"
            className={mode === value ? "scp-mode-btn active" : "scp-mode-btn"}
            aria-pressed={mode === value}
            onClick={() => setMode(value)}
          >
            {MODE_LABELS[value]}
          </button>
        ))}
      </div>

      <form className="scp-form" onSubmit={runScan}>
        <div className="scp-field scp-field-wide">
          <label htmlFor="scp-symbols">Symbols</label>
          <input
            id="scp-symbols"
            type="text"
            value={symbolsText}
            onChange={(e) => setSymbolsText(e.target.value)}
            placeholder="AAPL, MSFT, NVDA"
          />
        </div>
        <div className="scp-field">
          <label htmlFor="scp-thesis">Thesis</label>
          <select id="scp-thesis" value={thesis} onChange={(e) => setThesis(e.target.value as OptionThesis)}>
            {THESIS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
        <div className="scp-field">
          <label htmlFor="scp-risk">Risk profile</label>
          <select id="scp-risk" value={riskProfile} onChange={(e) => setRiskProfile(e.target.value as RiskProfileValue)}>
            {RISK_PROFILE_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        </div>
        <div className="scp-field">
          <label htmlFor="scp-profile">Strategy profile</label>
          <select id="scp-profile" value={profileId} onChange={(e) => setProfileId(e.target.value)}>
            <option value="">No profile</option>
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>{p.name} (v{p.version})</option>
            ))}
          </select>
        </div>
        {mode === "strategy_fit" && (
          <div className="scp-field">
            <label htmlFor="scp-fit-limit">Show fits up to</label>
            <select id="scp-fit-limit" value={fitLimit} onChange={(e) => setFitLimit(Number(e.target.value))}>
              {[10, 25, 50].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </div>
        )}
        <div className="scp-field scp-field-btn">
          <label>&nbsp;</label>
          <button type="submit" className="scp-run" disabled={scanning}>
            {scanning ? "Running scan…" : "Run scan"}
          </button>
        </div>
      </form>
      <div className="scp-note">
        {mode === "per_name_best"
          ? "Per-name best: the strongest trade for each symbol, ranked — the gate still grades every pick."
          : "Strategy fit: only names whose best pick clears the fit gate are listed as fits; borderline and skipped names are accounted, not hidden."}
      </div>

      {scanError && <div className="scp-error" role="alert">{scanError}</div>}
      {result && runContext && <ScanResultsView result={result} runContext={runContext} onPreviewTrade={onPreviewTrade} />}

      {/* Strategy profiles manager (surface 4) */}
      <div className="scp-subhead">
        Strategy Profiles
        <button type="button" className="scp-mini-btn" onClick={openCreateForm}>+ New profile</button>
      </div>
      {profilesError && <div className="scp-error" role="alert">{profilesError}</div>}
      {savedNote && <div className="scp-note">{savedNote}</div>}
      {!profilesLoaded && <div className="scp-muted">Loading strategy profiles…</div>}
      {profilesLoaded && profiles.length === 0 && !profilesError && (
        <div className="scp-muted">No saved profiles yet. Create one to scan by “my strategy” instead of re-stating constraints each time.</div>
      )}
      {profiles.map((profile) => (
        <div className="scp-row" key={profile.id}>
          <div className="scp-row-main">
            <strong>{profile.name}</strong> <span className="scp-badge">v{profile.version}</span>
            <span className="scp-row-summary">{profileSummary(profile)}</span>
            <span className="scp-row-meta">updated {new Date(profile.updatedAt).toLocaleString()}</span>
          </div>
          <button type="button" className="scp-mini-btn" onClick={() => setProfileId(profile.id)}>Use in scan</button>
          <button type="button" className="scp-mini-btn" onClick={() => openEditForm(profile)}>Edit</button>
          <button
            type="button"
            className={confirmDeleteId === profile.id ? "scp-danger armed" : "scp-danger"}
            onClick={() => void handleDelete(profile)}
          >
            {confirmDeleteId === profile.id ? "Confirm delete?" : "Delete"}
          </button>
        </div>
      ))}

      {formOpen && (
        <form className="scp-profile-form" id="scp-profile-form" onSubmit={saveProfile}>
          <div className="scp-subhead">{editingId ? "Edit profile" : "New profile"}</div>
          {formError && <div className="scp-error" role="alert">{formError}</div>}
          <div className="scp-form-grid">
            <div className="scp-field scp-field-wide">
              <label htmlFor="scp-pf-name">Name *</label>
              <input id="scp-pf-name" type="text" value={form.name} onChange={setField("name")} placeholder="Income" />
            </div>
            <div className="scp-field">
              <label htmlFor="scp-pf-thesis">Thesis</label>
              <select id="scp-pf-thesis" value={form.thesis} onChange={setField("thesis")}>
                <option value="">(unset)</option>
                {THESIS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
            <div className="scp-field scp-field-wide">
              <label htmlFor="scp-pf-types">Allowed strategy types (comma-separated ids)</label>
              <input id="scp-pf-types" type="text" value={form.allowedStrategies} onChange={setField("allowedStrategies")} placeholder="put_credit_spread, iron_condor" />
            </div>
            <div className="scp-field">
              <label htmlFor="scp-pf-maxloss">Max planned loss ($)</label>
              <input id="scp-pf-maxloss" type="number" min="0" step="any" value={form.maxPlannedLoss} onChange={setField("maxPlannedLoss")} />
            </div>
            <div className="scp-field">
              <label htmlFor="scp-pf-minrr">Min reward / risk</label>
              <input id="scp-pf-minrr" type="number" min="0" step="any" value={form.minRewardRisk} onChange={setField("minRewardRisk")} />
            </div>
            <div className="scp-field">
              <label htmlFor="scp-pf-mindte">Min DTE</label>
              <input id="scp-pf-mindte" type="number" min="0" step="1" value={form.minDte} onChange={setField("minDte")} />
            </div>
            <div className="scp-field">
              <label htmlFor="scp-pf-maxdte">Max DTE</label>
              <input id="scp-pf-maxdte" type="number" min="0" step="1" value={form.maxDte} onChange={setField("maxDte")} />
            </div>
            <div className="scp-field">
              <label htmlFor="scp-pf-events">Event policy</label>
              <select id="scp-pf-events" value={form.eventPolicy} onChange={setField("eventPolicy")}>
                <option value="">(unset)</option>
                <option value="warn">warn</option>
                <option value="exclude">exclude</option>
              </select>
            </div>
            <div className="scp-field">
              <label htmlFor="scp-pf-iv">Expected IV direction</label>
              <select id="scp-pf-iv" value={form.expectedIvDirection} onChange={setField("expectedIvDirection")}>
                <option value="">(unset)</option>
                <option value="rise">rise</option>
                <option value="unchanged">unchanged</option>
                <option value="fall">fall</option>
              </select>
            </div>
            <div className="scp-field">
              <label htmlFor="scp-pf-bias">Optimization bias (0–100)</label>
              <input id="scp-pf-bias" type="number" min="0" max="100" step="1" value={form.optimizationBias} onChange={setField("optimizationBias")} />
            </div>
            <div className="scp-field">
              <label htmlFor="scp-pf-risk">Risk profile posture</label>
              <select id="scp-pf-risk" value={form.riskProfile} onChange={setField("riskProfile")}>
                <option value="">(unset)</option>
                {RISK_PROFILE_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            </div>
            <div className="scp-field">
              <label htmlFor="scp-pf-mode">Default scan mode</label>
              <select id="scp-pf-mode" value={form.mode} onChange={setField("mode")}>
                <option value="">(unset)</option>
                {(Object.keys(MODE_LABELS) as ScanMode[]).map((value) => (
                  <option key={value} value={value}>{MODE_LABELS[value]}</option>
                ))}
              </select>
            </div>
          </div>

          <label className="scp-check">
            <input type="checkbox" checked={form.gateEnabled} onChange={setField("gateEnabled")} />
            Set fit-gate thresholds (issue #24)
          </label>
          {form.gateEnabled && (
            <div className="scp-form-grid">
              <div className="scp-field">
                <label htmlFor="scp-pf-gate-score">Gate min score (0–100)</label>
                <input id="scp-pf-gate-score" type="number" min="0" max="100" step="any" value={form.gateMinCompositeScore} onChange={setField("gateMinCompositeScore")} />
              </div>
              <div className="scp-field">
                <label htmlFor="scp-pf-gate-pop">Gate min POP (0–1)</label>
                <input id="scp-pf-gate-pop" type="number" min="0" max="1" step="0.05" value={form.gateMinProbabilityOfProfit} onChange={setField("gateMinProbabilityOfProfit")} />
              </div>
              <div className="scp-field">
                <label htmlFor="scp-pf-gate-conf">Gate min confidence</label>
                <select id="scp-pf-gate-conf" value={form.gateMinConfidence} onChange={setField("gateMinConfidence")}>
                  <option value="">(unset)</option>
                  <option value="LOW">LOW</option>
                  <option value="MEDIUM">MEDIUM</option>
                  <option value="HIGH">HIGH</option>
                </select>
              </div>
              <div className="scp-field">
                <label className="scp-check scp-check-inline">
                  <input type="checkbox" checked={form.gateRequireFresh} onChange={setField("gateRequireFresh")} />
                  Require fresh quotes
                </label>
              </div>
            </div>
          )}

          <div className="scp-form-actions">
            <button type="submit" className="scp-run" disabled={saving}>
              {saving ? "Saving…" : editingId ? "Save changes" : "Create profile"}
            </button>
            <button type="button" className="scp-mini-btn" onClick={() => { setFormOpen(false); setEditingId(null); }}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

export default ScannerPanel;
