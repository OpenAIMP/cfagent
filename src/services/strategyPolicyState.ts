/**
 * Issue #760 (P2-5.4): per-strategy policy state owned by staged
 * promotion — weight-cap overrides and strategy gates.
 *
 * These are the two pieces of live state a promoted candidate
 * changes: a strategy's weight cap (default: the global
 * STRATEGY_WEIGHT_BOUNDS.max) and its gate (gated-off strategies are
 * skipped by the #754 weight job). Both stores are separate from
 * mas_strategy_weights so a rollback can restore the pre-promotion
 * state exactly — including "no row existed", which is why the
 * writers accept null (delete).
 *
 * Writers are only called inside #755-seam applications by the
 * staged-promotion service; readers are used by the weight job and
 * the evaluation/promotion services.
 */

export function ensureStrategyPolicyTables(sql: any): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS mas_strategy_weight_caps (
    strategy TEXT PRIMARY KEY,
    cap REAL NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS mas_strategy_gates (
    strategy TEXT PRIMARY KEY,
    gated_off INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
}

/** The strategy's cap override, or null when the global bound applies. */
export function getStrategyWeightCap(sql: any, strategy: string): number | null {
  ensureStrategyPolicyTables(sql);
  const rows = Array.from(
    sql.exec(`SELECT cap FROM mas_strategy_weight_caps WHERE strategy = ?`, strategy)
  ) as any[];
  return rows.length > 0 ? rows[0].cap : null;
}

/** All cap overrides as a strategy → cap record (for the policy fn). */
export function getStrategyWeightCaps(sql: any): Record<string, number> {
  ensureStrategyPolicyTables(sql);
  const rows = Array.from(sql.exec(`SELECT strategy, cap FROM mas_strategy_weight_caps`)) as any[];
  const out: Record<string, number> = {};
  for (const r of rows) out[r.strategy] = r.cap;
  return out;
}

/** Set a cap override; null deletes the row (exact-restore semantics). */
export function setStrategyWeightCap(
  sql: any,
  strategy: string,
  cap: number | null,
  now: Date = new Date()
): void {
  ensureStrategyPolicyTables(sql);
  if (cap === null) {
    sql.exec(`DELETE FROM mas_strategy_weight_caps WHERE strategy = ?`, strategy);
    return;
  }
  sql.exec(
    `INSERT OR REPLACE INTO mas_strategy_weight_caps (strategy, cap, updated_at) VALUES (?, ?, ?)`,
    strategy,
    cap,
    now.toISOString()
  );
}

export function isStrategyGatedOff(sql: any, strategy: string): boolean {
  ensureStrategyPolicyTables(sql);
  const rows = Array.from(
    sql.exec(`SELECT gated_off FROM mas_strategy_gates WHERE strategy = ?`, strategy)
  ) as any[];
  return rows.length > 0 && (rows[0].gated_off === 1 || rows[0].gated_off === true);
}

/** Whether a gate ROW exists at all (snapshot fidelity for rollback). */
export function hasStrategyGateRow(sql: any, strategy: string): boolean {
  ensureStrategyPolicyTables(sql);
  const rows = Array.from(
    sql.exec(`SELECT gated_off FROM mas_strategy_gates WHERE strategy = ?`, strategy)
  ) as any[];
  return rows.length > 0;
}

export function getStrategyGates(sql: any): Record<string, boolean> {
  ensureStrategyPolicyTables(sql);
  const rows = Array.from(sql.exec(`SELECT strategy, gated_off FROM mas_strategy_gates`)) as any[];
  const out: Record<string, boolean> = {};
  for (const r of rows) out[r.strategy] = r.gated_off === 1 || r.gated_off === true;
  return out;
}

/** Set the gate; null deletes the row (exact-restore semantics). */
export function setStrategyGate(
  sql: any,
  strategy: string,
  gatedOff: boolean | null,
  now: Date = new Date()
): void {
  ensureStrategyPolicyTables(sql);
  if (gatedOff === null) {
    sql.exec(`DELETE FROM mas_strategy_gates WHERE strategy = ?`, strategy);
    return;
  }
  sql.exec(
    `INSERT OR REPLACE INTO mas_strategy_gates (strategy, gated_off, updated_at) VALUES (?, ?, ?)`,
    strategy,
    gatedOff ? 1 : 0,
    now.toISOString()
  );
}
