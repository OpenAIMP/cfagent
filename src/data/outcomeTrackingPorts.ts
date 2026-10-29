/**
 * Issue #2356 (#1976 step 4c, ADR 0022 D-I step 4) — outcome
 * tracking port for the evidence satellites.
 *
 * ADR D-0 ruled this family DO-resident behind a port (audit
 * §3): append-only events on the orchestrator instance,
 * joined to the DO-resident mas_outcomes rows through the
 * goal/scenario port. This module carries the record types,
 * the pure summary logic, and the port interface ONLY (ADR
 * 0002 R1/R2). Adapters: doSqliteOutcomeTrackingAdapter.ts
 * (production), inMemoryOutcomeTrackingAdapter.ts (test
 * double). Types moved here from src/services/
 * outcomeTracking.ts, now a re-export shim.
 *
 * APPEND-ONLY IS THE CONTRACT: the port has no update or
 * delete method; terminal events are appended and the first
 * terminal record stands. A terminal recorded without a
 * price is Unverified with a null P&L — an outcome is never
 * fabricated.
 *
 * TRANSACTION SEAM (ADR D-C): each operation appends at
 * most one event row (a single INSERT); no multi-statement
 * unit exists to wrap.
 */
import type { OutcomeKind, OutcomeRecord } from "./goalScenarioPorts";
import type { TrackRecord, TrackRecordIdea } from "../services/researchTrackRecord";

export const OUTCOME_TRACKING_TABLE = "mas_outcome_tracking";

export type TrackingStatus = "open" | OutcomeKind;
export type TrackingQuality = "pending" | "verified" | "unverified";

export interface OutcomeProvenance {
  screenRunRef: string | null;
  goalId: string | null;
  scenarioId: string | null;
  /** strategyWeights v2 version live when the bundle was produced. */
  weightsVersion: number | null;
  /** Frozen evaluation-dataset version (e.g. "v2"). */
  evalSetVersion: string | null;
  expiryDate: string | null;
}

export interface OutcomeTrackingSummary {
  recommendationRef: string;
  status: TrackingStatus;
  quality: TrackingQuality;
  provenance: OutcomeProvenance;
  /** After-cost P&L recorded at the terminal event; null = not known. */
  pnlAfterCost: number | null;
  trackedAt: string;
  terminalAt: string | null;
}

export interface TrackingEvent {
  seq: number;
  recommendationRef: string;
  kind: "tracked" | OutcomeKind;
  at: string;
  provenance?: OutcomeProvenance;
  pnlAfterCost?: number | null;
  notes?: string;
}

export interface StartOutcomeTrackingInput {
  recommendationRef: string;
  screenRunRef?: string;
  goalId?: string;
  scenarioId?: string;
  weightsVersion?: number;
  evalSetVersion?: string;
  expiryDate?: string;
  now?: Date;
}

export interface RecordOutcomeTerminalInput {
  kind: Exclude<OutcomeKind, "paper">;
  pnlAfterCost?: number | null;
  notes?: string;
  now?: Date;
}

export interface OutcomesPathEntry {
  outcome: OutcomeRecord;
  tracking: OutcomeTrackingSummary | null;
  /** #340 track-record ideas produced by the outcome's screen run. */
  trackIdeas: TrackRecordIdea[];
}

/** Summarize one recommendation's event stream (pure; shared
 *  by both adapters so the rule cannot drift). */
export function summarizeTrackingEvents(
  events: TrackingEvent[],
): OutcomeTrackingSummary | null {
  const tracked = events.find((e) => e.kind === "tracked");
  if (!tracked || !tracked.provenance) return null;
  const terminal = events.find((e) => e.kind !== "tracked");
  return {
    recommendationRef: tracked.recommendationRef,
    status: terminal ? (terminal.kind as OutcomeKind) : "open",
    quality: !terminal
      ? "pending"
      : terminal.pnlAfterCost !== null && terminal.pnlAfterCost !== undefined
        ? "verified"
        : "unverified",
    provenance: tracked.provenance,
    pnlAfterCost: terminal ? (terminal.pnlAfterCost ?? null) : null,
    trackedAt: tracked.at,
    terminalAt: terminal ? terminal.at : null,
  };
}

/** The outcome-tracking contract (sync, mirroring the legacy
 *  module's seam). Tenant scoping is part of the contract:
 *  every event carries user_login and every read/write is
 *  filtered by it. */
export interface OutcomeTrackingStore {
  ensureTable(): void;
  start(userLogin: string, input: StartOutcomeTrackingInput): OutcomeTrackingSummary | null;
  recordTerminal(
    userLogin: string,
    recommendationRef: string,
    input: RecordOutcomeTerminalInput,
  ): { appended: boolean; reason?: string };
  list(userLogin: string): OutcomeTrackingSummary[];
  expireDue(
    userLogin: string,
    input: { now: Date; finalPnlByRef: Record<string, number> },
  ): { expired: string[]; awaitingPrice: string[] };
  buildPath(userLogin: string, track: TrackRecord): OutcomesPathEntry[];
}

export interface OutcomeTrackingSqlExecutor {
  exec(query: string, ...params: unknown[]): Iterable<unknown>;
}
