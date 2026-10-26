/**
 * Issue #1742 ([AGENTIC] RSI telemetry & calibration engine in
 * D1) — pure realization projectors.
 *
 * These converters are the ONLY place thesis outcomes become
 * D1 realization rows. They are pure functions over structural
 * inputs (decoupled from the pipeline/track-record modules),
 * so the join rules are pinned by test without any store:
 *
 *  - Join rule: an evaluation idea matches a report idea on
 *    (symbol, structure) — the same join buildTrackRecord uses.
 *  - Falsifiability rule: only DIRECTIONAL theses produce
 *    realizations. An idea with a non-directional outlook, or
 *    with directionCorrect null (unscored — no follow-up
 *    quote), is skipped, never counted as a miss. Pending
 *    ideas are not misses (the dashboard's rule, reused).
 *  - Direction rule: predicted comes from the outlook
 *    (bullish → up, bearish → down); realized is the predicted
 *    direction when directionCorrect, else its opposite.
 *  - Timestamp rule: evaluatedAt must parse to a valid epoch;
 *    unparseable timestamps skip the row (no invented time).
 *
 * Links to the D1 projections (R4, no re-implementation):
 * rows carry runId always, plus reportId/chainId when the
 * caller knows them (canonical-report or chain-job sources);
 * track-record sources leave them null and link by runId.
 */
import type {
  TelemetryStore,
  ThesisDirection,
  ThesisRealizationInput,
} from "./telemetryPorts";
import { toRealizationRecordedEnvelope } from "./telemetryPorts";
import type { MessageEnvelope } from "../messaging/messagingPorts";

export interface ReportIdeaLike {
  symbol: string;
  structure: string;
  thesis: string;
  outlook?: string;
  economics?: { maxLoss?: number | null };
}

export interface ReportLike {
  runId: string;
  regime?: string;
  ideas: ReportIdeaLike[];
}

export interface EvaluationIdeaLike {
  symbol: string;
  structure: string;
  directionCorrect: boolean | null;
  invalidated?: boolean;
  pnlEstimatePerUnit?: number | null;
  evalSpot?: number | null;
}

export interface EvaluationLike {
  evaluatedAt: string;
  ideas: EvaluationIdeaLike[];
}

function predictedFromOutlook(outlook: string | undefined): ThesisDirection | null {
  if (outlook === "bullish") return "up";
  if (outlook === "bearish") return "down";
  return null;
}

function opposite(direction: ThesisDirection): ThesisDirection {
  return direction === "up" ? "down" : "up";
}

/**
 * Realizations from one evaluated run: join the report's ideas
 * to the evaluation's ideas on (symbol, structure).
 */
export function realizationsFromEvaluation(
  report: ReportLike,
  evaluation: EvaluationLike,
  tenantId: string,
  links?: { reportId?: string | null; chainId?: string | null },
): ThesisRealizationInput[] {
  const evaluatedAtMs = Date.parse(evaluation.evaluatedAt);
  if (Number.isNaN(evaluatedAtMs)) return [];
  const rows: ThesisRealizationInput[] = [];
  for (const idea of report.ideas) {
    const match = evaluation.ideas.find(
      (e) => e.symbol === idea.symbol && e.structure === idea.structure,
    );
    if (!match || match.directionCorrect === null) continue;
    const predicted = predictedFromOutlook(idea.outlook);
    if (predicted === null) continue;
    const realized = match.directionCorrect ? predicted : opposite(predicted);
    const maxLoss = idea.economics?.maxLoss ?? null;
    const pnl = match.pnlEstimatePerUnit ?? null;
    rows.push({
      tenantId,
      outcomeId: `${report.runId}:${idea.symbol}:${idea.structure}`,
      thesis: idea.thesis,
      agentKey: "research",
      structure: idea.structure,
      regime: report.regime ?? "unknown",
      symbol: idea.symbol,
      runId: report.runId,
      reportId: links?.reportId ?? null,
      chainId: links?.chainId ?? null,
      predictedDirection: predicted,
      realizedDirection: realized,
      directionCorrect: match.directionCorrect,
      falsified: !match.directionCorrect,
      invalidated: match.invalidated ?? false,
      pnlEstimatePerUnit: pnl,
      rMultiple: pnl !== null && maxLoss !== null && maxLoss > 0 ? pnl / maxLoss : null,
      evaluatedAtMs,
    });
  }
  return rows;
}

/**
 * Project one evaluated run into the store (the evaluateRun
 * hook body, extracted so it is testable without a DO):
 * convert, then idempotent record. Returns the store's
 * counts; empty conversions record nothing.
 *
 * Issue #1743: when opts.emit is supplied and at least one row
 * was newly recorded, each row's realization_recorded envelope
 * is emitted best-effort (failures swallowed — the stream
 * never blocks the projection). Emission is at-least-once
 * with deterministic ids (outcome id); a pure re-projection
 * (recorded 0) emits nothing. Treat stream realization counts
 * as approximate — the exact store is this table.
 */
export async function projectEvaluationRealizations(
  store: TelemetryStore,
  report: ReportLike,
  evaluation: EvaluationLike,
  tenantId: string,
  links?: { reportId?: string | null; chainId?: string | null },
  opts?: { emit?: (envelope: MessageEnvelope) => void | Promise<void> },
): Promise<{ recorded: number; duplicates: number }> {
  const rows = realizationsFromEvaluation(report, evaluation, tenantId, links);
  if (rows.length === 0) return { recorded: 0, duplicates: 0 };
  const result = await store.recordRealizations(rows);
  if (opts?.emit && result.recorded > 0) {
    for (const row of rows) {
      try {
        await opts.emit(
          toRealizationRecordedEnvelope({
            tenantId: row.tenantId,
            outcomeId: row.outcomeId,
            agentKey: row.agentKey,
            structure: row.structure,
            regime: row.regime,
            directionCorrect: row.directionCorrect,
            falsified: row.falsified,
            time: new Date(row.evaluatedAtMs).toISOString(),
          }),
        );
      } catch {
        // Best-effort stream emission, swallowed like #1742's emit.
      }
    }
  }
  return result;
}

export interface TrackRecordIdeaInput {
  runId: string;
  symbol: string;
  structure: string;
  thesis: string;
  outlook: string;
  regime: string;
  evaluation: {
    directionCorrect: boolean | null;
    evaluatedAt: string;
    invalidated?: boolean;
    pnlEstimatePerUnit?: number | null;
    rMultiple?: number | null;
  } | null;
}

/**
 * Realizations from track-record ideas (the reconcile import
 * path): ideas already carry thesis + outlook + regime, so no
 * join is needed — only the falsifiability/timestamp rules.
 */
export function realizationsFromTrackRecord(
  ideas: TrackRecordIdeaInput[],
  tenantId: string,
  agentKey = "research",
): ThesisRealizationInput[] {
  const rows: ThesisRealizationInput[] = [];
  for (const idea of ideas) {
    if (!idea.evaluation || idea.evaluation.directionCorrect === null) continue;
    const predicted = predictedFromOutlook(idea.outlook);
    if (predicted === null) continue;
    const evaluatedAtMs = Date.parse(idea.evaluation.evaluatedAt);
    if (Number.isNaN(evaluatedAtMs)) continue;
    const realized = idea.evaluation.directionCorrect ? predicted : opposite(predicted);
    rows.push({
      tenantId,
      outcomeId: `${idea.runId}:${idea.symbol}:${idea.structure}`,
      thesis: idea.thesis,
      agentKey,
      structure: idea.structure,
      regime: idea.regime,
      symbol: idea.symbol,
      runId: idea.runId,
      reportId: null,
      chainId: null,
      predictedDirection: predicted,
      realizedDirection: realized,
      directionCorrect: idea.evaluation.directionCorrect,
      falsified: !idea.evaluation.directionCorrect,
      invalidated: idea.evaluation.invalidated ?? false,
      pnlEstimatePerUnit: idea.evaluation.pnlEstimatePerUnit ?? null,
      rMultiple: idea.evaluation.rMultiple ?? null,
      evaluatedAtMs,
    });
  }
  return rows;
}
