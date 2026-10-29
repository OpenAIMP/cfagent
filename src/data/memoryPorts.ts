/**
 * src/data/memoryPorts.ts — #2345 (#1976 step 3a, ADR 0022
 * D-A): the mas_memory port (key-addressed). DO residency
 * (D-0 (a),(b),(e)): session facts are per-instance state.
 *
 * Beyond the generic contract (id field = key), the port
 * carries the three operations that used to run as raw
 * statements above the layer:
 *  - clear(): the MCP manage_session_memory "clear" action's
 *    whole-table DELETE (was `(orm as any).sql.exec(...)`);
 *    returns the number of rows removed;
 *  - keysUpdatedBefore: the retention selector (#786) — was
 *    an execQuery SELECT in storageRetention;
 *  - search / listRecent: the MAS recallFacts reads (keyword
 *    LIKE over key+value, or newest-first), newest first,
 *    bounded — were raw SELECTs in agents/mas.ts.
 *
 * #CDO-mha7
 */
import type { MemoryRecord } from "../types";
import type { RepositoryPort } from "./repositoryPorts";

export interface MemoryPort extends RepositoryPort<MemoryRecord> {
  /** Delete every row; returns the number of rows removed. */
  clear(): number;
  /** Keys with updated_at < cutoffIso, oldest first, ≤ limit. */
  keysUpdatedBefore(cutoffIso: string, limit: number): string[];
  /** Newest-first facts whose key or value contains the term (case-insensitive). */
  search(term: string, limit: number): MemoryRecord[];
  /** Newest-first facts, ≤ limit. */
  listRecent(limit: number): MemoryRecord[];
}
