/**
 * Issue #2357 (#1976 step 4b) — the in-memory implementation
 * of the strategy policy state port, with semantics identical
 * to the DO-SQLite adapter (null deletes the row; a gate row
 * carrying "on" is distinct from no row at all).
 */
import type { StrategyPolicyStore } from "./strategyPolicyPorts";

export class InMemoryStrategyPolicyStore implements StrategyPolicyStore {
  private caps = new Map<string, number>();
  private gates = new Map<string, boolean>();

  ensureTables(): void {
    // In-memory: nothing to ensure.
  }

  getCap(strategy: string): number | null {
    return this.caps.has(strategy) ? this.caps.get(strategy)! : null;
  }

  getCaps(): Record<string, number> {
    return Object.fromEntries(this.caps);
  }

  setCap(strategy: string, cap: number | null): void {
    if (cap === null) this.caps.delete(strategy);
    else this.caps.set(strategy, cap);
  }

  isGatedOff(strategy: string): boolean {
    return this.gates.get(strategy) === true;
  }

  hasGateRow(strategy: string): boolean {
    return this.gates.has(strategy);
  }

  getGates(): Record<string, boolean> {
    return Object.fromEntries(this.gates);
  }

  setGate(strategy: string, gatedOff: boolean | null): void {
    if (gatedOff === null) this.gates.delete(strategy);
    else this.gates.set(strategy, gatedOff);
  }
}
