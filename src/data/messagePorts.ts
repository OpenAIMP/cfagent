/**
 * src/data/messagePorts.ts — #2345 (#1976 step 3a, ADR 0022
 * D-A): the mas_messages port. DO residency (D-0 (a),(b),(e)):
 * conversation history is per-instance agent state.
 *
 * Beyond the generic repository contract, the port carries the
 * two range/purge reads the retention pass (#255/#786) and the
 * memory-reset route used to run as raw statements above the
 * layer (execQuery / sql.exec bypasses):
 *  - idsCreatedBefore: the retention selector (oldest first,
 *    bounded) — replaces storageRetention's execQuery SELECT;
 *  - deleteBySessionId: the reset route's purge — replaces the
 *    raw DELETE in agents/routes/memoryReset.ts; returns the
 *    number of rows removed.
 *
 * #CDO-mha7
 */
import type { MessageRecord } from "../types";
import type { RepositoryPort } from "./repositoryPorts";

export interface MessagePort extends RepositoryPort<MessageRecord> {
  /** Ids with created_at < cutoffIso, oldest first, ≤ limit. */
  idsCreatedBefore(cutoffIso: string, limit: number): string[];
  /** Delete every message of one session; returns rows removed. */
  deleteBySessionId(sessionId: string): number;
}
