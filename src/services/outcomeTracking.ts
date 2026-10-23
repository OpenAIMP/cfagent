/**
 * Issue #1140 (epic #1096 Phase 5) — outcomes tracking to expiry:
 * ONE append-only outcomes path for recommendations.
 *
 * The pieces already existed but did not join up: Phase 4 persists
 * recommendation bundles as paper records in mas_outcomes
 * (persistRecommendationBundle), Phase 3 records screen runs and
 * re-selection proposals, and #340's researchTrackRecord joins
 * published ideas to their evaluations append-only, with no
 * retrospective edits. This module is the join:
 *
 *   mas_outcomes row (the bundle was produced)
 *     + tracking events (this module, append-only)
 *     + track-record ideas matched by screen run ref
 *
 * A tracked recommendation carries its full provenance — screen run,
 * goal, scenario, the strategy-weights VERSION that was live when it
 * was produced, and the frozen EVAL-SET VERSION its lineage was
 * judged against — from `tracked` to a terminal event (expired /
 * realized / cancelled). Terminal events are APPENDED; prior events
 * are never updated (there is deliberately no UPDATE against the
 * tracking table in this module — the Phase 5 tests pin that at the
 * source level). A recommendation whose final price never arrives
 * stays open, and a terminal recorded without a price is labeled
 * Unverified with a null P&L — an outcome is never fabricated
 * (researchPipeline's honesty rule, applied to the ledger).
 *
 * Tenant scoping follows the Phase 0 pattern: every event carries
 * user_login and every read/write is filtered by it as a bound
 * parameter. Tracking another tenant's mas_outcomes row is refused.
 */

import {
  listOutcomes,
  type OutcomeKind,
  type OutcomeRecord,
} from "./goalScenarioStore";
import type { TrackRecord, TrackRecordIdea } from "./researchTrackRecord";

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

interface TrackingEvent {
  seq: number;
  recommendationRef: string;
  kind: "tracked" | OutcomeKind;
  at: string;
  provenance?: OutcomeProvenance;
  pnlAfterCost?: number | null;
  notes?: string;
}

export function ensureOutcomeTrackingTable(sql: any): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS ${OUTCOME_TRACKING_TABLE} (
    id TEXT PRIMARY KEY,
    user_login TEXT NOT NULL,
    recommendation_ref TEXT NOT NULL,
    seq INTEGER NOT NULL,
    event_kind TEXT NOT NULL,
    event_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`);
}

function readEvents(sql: any, userLogin: string): TrackingEvent[] {
  ensureOutcomeTrackingTable(sql);
  const rows = Array.from(
    sql.exec(
      `SELECT event_json FROM ${OUTCOME_TRACKING_TABLE} WHERE user_login = ? ORDER BY seq ASC`,
      userLogin
    )
  ) as any[];
  return rows.map((r) => JSON.parse(String(r.event_json)) as TrackingEvent);
}

function appendEvent(sql: any, userLogin: string, event: TrackingEvent): void {
  ensureOutcomeTrackingTable(sql);
  sql.exec(
    `INSERT INTO ${OUTCOME_TRACKING_TABLE} (id, user_login, recommendation_ref, seq, event_kind, event_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    `ot-${userLogin}-${event.recommendationRef}-${event.seq}`,
    userLogin,
    event.recommendationRef,
    event.seq,
    event.kind,
    JSON.stringify(event),
    event.at
  );
}

function summarize(events: TrackingEvent[]): OutcomeTrackingSummary | null {
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

function summaryFor(
  sql: any,
  userLogin: string,
  recommendationRef: string
): OutcomeTrackingSummary | null {
  const events = readEvents(sql, userLogin).filter(
    (e) => e.recommendationRef === recommendationRef
  );
  return summarize(events);
}

/**
 * Begin tracking a recommendation that exists as a mas_outcomes row
 * for THIS tenant. Idempotent: a duplicate delivery returns the
 * existing summary and appends nothing (the first provenance wins —
 * duplicate deliveries reconcile against the record, researchTaskLedger
 * idiom). Returns null when the tenant has no such outcome row.
 */
export function startOutcomeTracking(
  sql: any,
  userLogin: string,
  input: {
    recommendationRef: string;
    screenRunRef?: string;
    goalId?: string;
    scenarioId?: string;
    weightsVersion?: number;
    evalSetVersion?: string;
    expiryDate?: string;
    now?: Date;
  }
): OutcomeTrackingSummary | null {
  const existing = summaryFor(sql, userLogin, input.recommendationRef);
  if (existing) return existing;

  const outcome = listOutcomes(sql, userLogin).find(
    (o) => o.recommendationRef === input.recommendationRef
  );
  if (!outcome) return null;

  const now = input.now ?? new Date();
  const provenance: OutcomeProvenance = {
    screenRunRef: input.screenRunRef ?? outcome.screenRunRef ?? null,
    goalId: input.goalId ?? outcome.goalId ?? null,
    scenarioId: input.scenarioId ?? outcome.scenarioId ?? null,
    weightsVersion: input.weightsVersion ?? null,
    evalSetVersion: input.evalSetVersion ?? null,
    expiryDate: input.expiryDate ?? null,
  };
  const seq = readEvents(sql, userLogin).length + 1;
  appendEvent(sql, userLogin, {
    seq,
    recommendationRef: input.recommendationRef,
    kind: "tracked",
    at: now.toISOString(),
    provenance,
  });
  return summaryFor(sql, userLogin, input.recommendationRef);
}

/**
 * Append the terminal event for a tracked recommendation. A second
 * terminal attempt is refused (appended: false) — the first terminal
 * record stands, and history is never rewritten. pnlAfterCost may be
 * omitted/null: the outcome is then Unverified, never estimated here.
 */
export function recordOutcomeTerminal(
  sql: any,
  userLogin: string,
  recommendationRef: string,
  input: {
    kind: Exclude<OutcomeKind, "paper">;
    pnlAfterCost?: number | null;
    notes?: string;
    now?: Date;
  }
): { appended: boolean; reason?: string } {
  const summary = summaryFor(sql, userLogin, recommendationRef);
  if (!summary) return { appended: false, reason: "recommendation is not tracked" };
  if (summary.status !== "open") {
    return {
      appended: false,
      reason: `already terminal (${summary.status}); the first terminal record stands`,
    };
  }
  const now = input.now ?? new Date();
  const seq = readEvents(sql, userLogin).length + 1;
  appendEvent(sql, userLogin, {
    seq,
    recommendationRef,
    kind: input.kind,
    at: now.toISOString(),
    pnlAfterCost: input.pnlAfterCost ?? null,
    notes: input.notes,
  });
  return { appended: true };
}

export function listOutcomeTracking(
  sql: any,
  userLogin: string
): OutcomeTrackingSummary[] {
  const events = readEvents(sql, userLogin);
  const byRef = new Map<string, TrackingEvent[]>();
  for (const e of events) {
    const list = byRef.get(e.recommendationRef) ?? [];
    list.push(e);
    byRef.set(e.recommendationRef, list);
  }
  const out: OutcomeTrackingSummary[] = [];
  for (const list of byRef.values()) {
    const s = summarize(list);
    if (s) out.push(s);
  }
  return out.sort((a, b) => (a.trackedAt < b.trackedAt ? 1 : -1));
}

/**
 * Expire every tracked, still-open recommendation whose expiry date
 * has passed. A final P&L must be SUPPLIED by the caller (from the
 * evaluation path) — without one, the recommendation is reported as
 * awaiting-price and left open. Nothing is invented at the ledger.
 */
export function expireDueOutcomes(
  sql: any,
  userLogin: string,
  input: { now: Date; finalPnlByRef: Record<string, number> }
): { expired: string[]; awaitingPrice: string[] } {
  const expired: string[] = [];
  const awaitingPrice: string[] = [];
  const nowIso = input.now.toISOString();
  for (const summary of listOutcomeTracking(sql, userLogin)) {
    if (summary.status !== "open") continue;
    const expiry = summary.provenance.expiryDate;
    if (!expiry || expiry > nowIso.slice(0, 10)) continue;
    const pnl = input.finalPnlByRef[summary.recommendationRef];
    if (typeof pnl !== "number") {
      awaitingPrice.push(summary.recommendationRef);
      continue;
    }
    const res = recordOutcomeTerminal(sql, userLogin, summary.recommendationRef, {
      kind: "expired",
      pnlAfterCost: pnl,
      now: input.now,
    });
    if (res.appended) expired.push(summary.recommendationRef);
  }
  return { expired, awaitingPrice };
}

/* ------------------------------------------------------------------ */
/* The joined outcomes path                                            */
/* ------------------------------------------------------------------ */

export interface OutcomesPathEntry {
  outcome: OutcomeRecord;
  tracking: OutcomeTrackingSummary | null;
  /** #340 track-record ideas produced by the outcome's screen run. */
  trackIdeas: TrackRecordIdea[];
}

/**
 * The one outcomes path: every mas_outcomes row for the tenant, its
 * tracking summary (when tracked), and the track-record ideas its
 * screen run produced — provenance joined end to end.
 */
export function buildOutcomesPath(
  sql: any,
  userLogin: string,
  track: TrackRecord
): OutcomesPathEntry[] {
  const tracking = new Map(
    listOutcomeTracking(sql, userLogin).map((s) => [s.recommendationRef, s])
  );
  return listOutcomes(sql, userLogin).map((outcome) => ({
    outcome,
    tracking: outcome.recommendationRef
      ? (tracking.get(outcome.recommendationRef) ?? null)
      : null,
    trackIdeas: outcome.screenRunRef
      ? track.ideas.filter((i) => i.runId === outcome.screenRunRef)
      : [],
  }));
}
