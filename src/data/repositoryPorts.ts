/**
 * src/data/repositoryPorts.ts — #2345 (#1976 step 3a, ADR 0022
 * D-A/D-E): the generic repository port the ORM core's 13 tables
 * sit behind, plus the SqlStorage seam type whose canonical home
 * moves here from src/orm (the src/orm modules are §22 re-export
 * shims from this slice on).
 *
 * The contract is the legacy Repository surface, declared:
 *  - findMany/findById/findOne/count are pure reads;
 *  - create INSERTs and returns the passed record; its conflict
 *    policy is insert-or-throw — a primary-key conflict surfaces
 *    as the store's own error, never a silent overwrite (D-E.1);
 *  - update applies the non-id fields and returns the RE-READ
 *    row, or null when the row does not exist; adapters verify
 *    the write landed (D-E.2);
 *  - upsert is check-then-act (findById → update | create),
 *    correct under the per-instance serialization the DO
 *    residency provides (D-0 property (b));
 *  - delete returns true ONLY when a row was actually removed
 *    (D-E.2 — the pre-port implementation returned true
 *    unconditionally; see ormRepositoryCore.ts);
 *  - boolean record fields map to 0/1 columns named is_*.
 *
 * Port modules import no store client (ADR 0022 D-B): this file
 * is types + the seam interface only.
 *
 * #CDO-mha7
 */

/** The Durable Object SqlStorage seam (exec-only surface). */
export interface SqlStorage {
  exec: (query: string, ...args: unknown[]) => Iterable<unknown>;
}

/** Read options for repository finds (the legacy QueryOptions). */
export interface RepositoryQueryOptions {
  where?: Record<string, unknown>;
  orderBy?: string;
  limit?: number;
  offset?: number;
}

/** The generic per-aggregate repository contract (ADR 0022 D-E). */
export interface RepositoryPort<T extends Record<string, any>> {
  readonly tableName: string;
  findMany(options?: RepositoryQueryOptions): T[];
  findById(id: string): T | null;
  findOne(where: Record<string, unknown>): T | null;
  create(record: T): T;
  update(id: string, updates: Partial<T>): T | null;
  upsert(record: T): T;
  delete(id: string): boolean;
  count(where?: Record<string, unknown>): number;
}
