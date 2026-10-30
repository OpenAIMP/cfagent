/**
 * src/data/settingsReadPorts.ts — the mas_settings port family.
 * DO residency (the table lives in the orchestrator's instance
 * storage).
 *
 * Step 3a (#2345, ADR 0022 D-A) landed the READ contract only,
 * read-only by design pending gate G-7. Step 4g (#2390) executes
 * the G-7 ruling (user, 2026-10-29): a NEW dedicated settings
 * port owns mas_settings — this family now carries the write
 * contract too, its DO adapter owns the table's DDL, and all
 * four former writers (reportDispatch's doors, screeningFlags'
 * factories, governedHalt's DO kill-switch write, the
 * enrichment adapter's killswitch write) are callers. Domains
 * keep owning their keys' semantics; the port owns the table.
 *
 * Atomicity, honestly: set() is the incumbent DELETE+INSERT
 * pair issued back-to-back on the owning instance's storage.
 * No transaction wrap is claimed — the pair relies on the
 * Durable Object's per-instance serialization (statements from
 * one turn cannot interleave with another turn's), which is
 * exactly what the four legacy writers relied on. A crash
 * between the two statements leaves the key ABSENT (never a
 * stale value), and every safety-relevant reader of this table
 * already treats an absent key fail-closed or as its documented
 * default.
 *
 * Ensure discipline: adapters do NOT self-ensure inside
 * get/set/delete. ensureSchema() is the single DDL site and is
 * invoked by composition (the orchestrator's ensureTables) and
 * by delegates whose legacy shape ensured on every call (the
 * screeningFlags factories). Callers that historically wrote
 * without ensuring (governedHalt, the enrichment killswitch)
 * keep that exact shape through this port.
 *
 * #CDO-mha7
 */

/** Minimal exec-shaped SQL surface the settings adapters run over. */
export interface SettingsSqlExecutor {
  exec: (query: string, ...args: unknown[]) => Iterable<unknown>;
}

/** Read-only view over mas_settings (key → value). */
export interface SettingsReadPort {
  /** The stored value for key, or null when absent. */
  get(key: string): string | null;
  /** Whether a value is stored for key. */
  has(key: string): boolean;
}

/**
 * The dedicated settings port (G-7 ruling): the read contract
 * plus the table's write surface and DDL ownership.
 */
export interface SettingsPort extends SettingsReadPort {
  /**
   * Upsert one key (DELETE+INSERT, the incumbent idiom — not
   * INSERT OR REPLACE, so MockSqlStorage-shaped stores stay
   * compatible). `updatedAt` is the row's stored timestamp;
   * callers with their own clock (governedHalt's nowMs) pass
   * it explicitly, everyone else gets the current time.
   */
  set(key: string, value: string, updatedAt?: string): void;
  /** Remove one key (absent key: no-op). */
  delete(key: string): void;
  /** Create the table if absent — the family's only DDL site. */
  ensureSchema(): void;
}
