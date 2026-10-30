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
 *
 * @deprecated Superseded by src/data/strategyPolicyPorts.ts (port),
 * src/data/doSqliteStrategyPolicyAdapter.ts (production adapter) and
 * src/data/createStrategyClusterPorts.ts (composition root) —
 * #1976 step 4b (#2357, ADR 0022 D-I step 4). This module is a
 * re-export shim: every function delegates to the DO adapter over
 * the caller's sql handle, statement-for-statement identical to
 * the pre-port implementation. New code should compose the port
 * through createStrategyClusterPorts.
 */

import { DoSqliteStrategyPolicyStore } from "../data/doSqliteStrategyPolicyAdapter";
import type { StrategyPolicySqlExecutor } from "../data/strategyPolicyPorts";

export type { StrategyPolicyStore } from "../data/strategyPolicyPorts";

function store(sql: StrategyPolicySqlExecutor): DoSqliteStrategyPolicyStore {
  return new DoSqliteStrategyPolicyStore(sql);
}

export function ensureStrategyPolicyTables(sql: any): void {
  store(sql).ensureTables();
}

/** The strategy's cap override, or null when the global bound applies. */
export function getStrategyWeightCap(sql: any, strategy: string): number | null {
  return store(sql).getCap(strategy);
}

/** All cap overrides as a strategy → cap record (for the policy fn). */
export function getStrategyWeightCaps(sql: any): Record<string, number> {
  return store(sql).getCaps();
}

/** Set a cap override; null deletes the row (exact-restore semantics). */
export function setStrategyWeightCap(
  sql: any,
  strategy: string,
  cap: number | null,
  now: Date = new Date()
): void {
  store(sql).setCap(strategy, cap, now);
}

export function isStrategyGatedOff(sql: any, strategy: string): boolean {
  return store(sql).isGatedOff(strategy);
}

/** Whether a gate ROW exists at all (snapshot fidelity for rollback). */
export function hasStrategyGateRow(sql: any, strategy: string): boolean {
  return store(sql).hasGateRow(strategy);
}

export function getStrategyGates(sql: any): Record<string, boolean> {
  return store(sql).getGates();
}

/** Set the gate; null deletes the row (exact-restore semantics). */
export function setStrategyGate(
  sql: any,
  strategy: string,
  gatedOff: boolean | null,
  now: Date = new Date()
): void {
  store(sql).setGate(strategy, gatedOff, now);
}
