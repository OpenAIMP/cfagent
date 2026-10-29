/**
 * src/data/eventLogPorts.ts — #2345 (#1976 step 3a, ADR 0022
 * D-A): the mas_events port. DO residency (D-0 (a),(b),(e)).
 *
 * SHAPE FROZEN (gate G-5): the Q7 tamper-evidence wiring
 * (#945) owns this table's chain semantics — creates chain
 * previousEventHash → eventHash exactly as the pre-port
 * ChainedAuditRepository did (#2178), and this slice changes
 * no column, no hash input, and no verification rule. The port
 * adds only the retention selector the storage-retention pass
 * used to run through execQuery.
 *
 * #CDO-mha7
 */
import type { AuditEvent } from "../types";
import type { RepositoryPort } from "./repositoryPorts";

export interface EventLogPort extends RepositoryPort<AuditEvent> {
  /** Ids with created_at < cutoffIso, oldest first, ≤ limit. */
  idsCreatedBefore(cutoffIso: string, limit: number): string[];
}
