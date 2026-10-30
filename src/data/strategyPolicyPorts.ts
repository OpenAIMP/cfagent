/**
 * Issue #2357 (#1976 step 4b, ADR 0022 D-I step 4) — strategy
 * policy state port: the per-strategy weight-cap overrides
 * and strategy gates owned by staged promotion (#760).
 *
 * ADR D-0 ruled this family DO-resident behind a port (step-4
 * audit §3): the gate state is read inside the champion/
 * challenger promotion unit and restored by its rollback, so
 * it shares the unit's residency. This module carries the
 * port interface ONLY (ADR 0002 R1/R2). Adapters:
 * doSqliteStrategyPolicyAdapter.ts (production, the legacy
 * strategyPolicyState moved into the layer),
 * inMemoryStrategyPolicyAdapter.ts (test double).
 *
 * EXACT-RESTORE SEMANTICS (#760, unchanged): a cap or gate
 * write accepts null, which DELETES the row — "no row existed"
 * is a distinct, restorable state from a row carrying the
 * default, which is why hasGateRow exists beside isGatedOff.
 */

export interface StrategyPolicyStore {
  ensureTables(): void;
  /** The strategy's cap override, or null when the global bound applies. */
  getCap(strategy: string): number | null;
  /** All cap overrides as a strategy → cap record. */
  getCaps(): Record<string, number>;
  /** Set a cap override; null deletes the row (exact-restore semantics). */
  setCap(strategy: string, cap: number | null, now?: Date): void;
  isGatedOff(strategy: string): boolean;
  /** Whether a gate ROW exists at all (snapshot fidelity for rollback). */
  hasGateRow(strategy: string): boolean;
  getGates(): Record<string, boolean>;
  /** Set the gate; null deletes the row (exact-restore semantics). */
  setGate(strategy: string, gatedOff: boolean | null, now?: Date): void;
}

/** Minimal SQL executor matching the Durable Object SqlStorage
 *  exec signature (the shape the legacy module's seam assumed). */
export interface StrategyPolicySqlExecutor {
  exec(query: string, ...params: unknown[]): Iterable<unknown>;
}
