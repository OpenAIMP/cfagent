/**
 * Issue #1140 (epic #1096 Phase 5) — outcomes tracking to expiry:
 * ONE append-only outcomes path for recommendations.
 *
 * @deprecated Superseded by src/data/outcomeTrackingPorts.ts (port),
 * src/data/doSqliteOutcomeTrackingAdapter.ts (production adapter)
 * and src/data/createEvidenceSatellitePorts.ts (composition
 * root) — #1976 step 4c (#2356, ADR 0022 D-I step 4). This
 * module is a re-export shim: every function delegates to the
 * DO adapter (composed over the goal/scenario port for the
 * mas_outcomes join) over the caller's sql handle,
 * statement-for-statement identical to the pre-port
 * implementation. Terminal events are APPENDED; prior events
 * are never updated (there is deliberately no UPDATE against
 * the tracking table — the Phase 5 tests pin that at the
 * source level). A recommendation whose final price never
 * arrives stays open, and a terminal recorded without a price
 * is labeled Unverified with a null P&L — an outcome is never
 * fabricated (researchPipeline's honesty rule, applied to
 * the ledger).
 *
 * Tenant scoping follows the Phase 0 pattern: every event
 * carries user_login and every read/write is filtered by it
 * as a bound parameter. Tracking another tenant's
 * mas_outcomes row is refused.
 */

import { DoSqliteGoalScenarioStore } from "../data/doSqliteGoalScenarioAdapter";
import { DoSqliteOutcomeTrackingStore } from "../data/doSqliteOutcomeTrackingAdapter";
import type {
  OutcomeTrackingSummary,
  OutcomesPathEntry,
  RecordOutcomeTerminalInput,
  StartOutcomeTrackingInput,
} from "../data/outcomeTrackingPorts";
import type { TrackRecord } from "./researchTrackRecord";

export {
  OUTCOME_TRACKING_TABLE,
  type OutcomeProvenance,
  type OutcomeTrackingSummary,
  type OutcomesPathEntry,
  type TrackingQuality,
  type TrackingStatus,
} from "../data/outcomeTrackingPorts";

function store(sql: any): DoSqliteOutcomeTrackingStore {
  return new DoSqliteOutcomeTrackingStore(sql, new DoSqliteGoalScenarioStore(sql));
}

export function ensureOutcomeTrackingTable(sql: any): void {
  store(sql).ensureTable();
}

export function startOutcomeTracking(
  sql: any,
  userLogin: string,
  input: StartOutcomeTrackingInput,
): OutcomeTrackingSummary | null {
  return store(sql).start(userLogin, input);
}

export function recordOutcomeTerminal(
  sql: any,
  userLogin: string,
  recommendationRef: string,
  input: RecordOutcomeTerminalInput,
): { appended: boolean; reason?: string } {
  return store(sql).recordTerminal(userLogin, recommendationRef, input);
}

export function listOutcomeTracking(
  sql: any,
  userLogin: string,
): OutcomeTrackingSummary[] {
  return store(sql).list(userLogin);
}

export function expireDueOutcomes(
  sql: any,
  userLogin: string,
  input: { now: Date; finalPnlByRef: Record<string, number> },
): { expired: string[]; awaitingPrice: string[] } {
  return store(sql).expireDue(userLogin, input);
}

export function buildOutcomesPath(
  sql: any,
  userLogin: string,
  track: TrackRecord,
): OutcomesPathEntry[] {
  return store(sql).buildPath(userLogin, track);
}
