/**
 * Issue #2357 (#1976 step 4b) — the in-memory implementation
 * of the strategy weights v2 port, with semantics identical
 * to the DO-SQLite adapter (replace-by-key writes, null
 * deletes the row, append-only version records, the collapsed
 * read as the mean across regimes).
 */
import {
  weightsV2Key,
  type StrategyWeightsStore,
  type WeightVersionRecord,
  type WeightVersionWrite,
} from "./strategyWeightsPorts";

interface WeightRow {
  strategy: string;
  regime: string;
  weight: number;
  version: number;
  updatedAt: string;
}

export class InMemoryStrategyWeightsStore implements StrategyWeightsStore {
  private weights = new Map<string, WeightRow>();
  private versions: WeightVersionRecord[] = [];

  ensureTables(): void {
    // In-memory: nothing to ensure.
  }

  currentVersion(): number {
    return this.versions.reduce((m, r) => Math.max(m, r.version || 0), 0);
  }

  listVersionRecords(limit = 200): WeightVersionRecord[] {
    return [...this.versions]
      .sort((a, b) => a.version - b.version)
      .slice(0, limit)
      .map((r) => ({ ...r }));
  }

  getWeights(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const row of this.weights.values()) {
      out[weightsV2Key(row.strategy, row.regime)] = row.weight;
    }
    return out;
  }

  getWeightsForRegime(regime: string): Record<string, number> {
    const out: Record<string, number> = {};
    for (const row of this.weights.values()) {
      if (row.regime === regime) out[row.strategy] = row.weight;
    }
    return out;
  }

  getWeightsCollapsed(): Record<string, number> {
    const sums = new Map<string, { total: number; count: number }>();
    for (const row of this.weights.values()) {
      const acc = sums.get(row.strategy) ?? { total: 0, count: 0 };
      acc.total += row.weight;
      acc.count += 1;
      sums.set(row.strategy, acc);
    }
    const out: Record<string, number> = {};
    for (const [key, acc] of sums) out[key] = acc.total / acc.count;
    return out;
  }

  weightRowExists(strategy: string, regime: string): boolean {
    return this.weights.has(weightsV2Key(strategy, regime));
  }

  writeWeightRow(
    strategy: string,
    regime: string,
    weight: number | null,
    version: number,
    now: Date,
  ): void {
    const key = weightsV2Key(strategy, regime);
    this.weights.delete(key);
    if (weight !== null) {
      this.weights.set(key, { strategy, regime, weight, version, updatedAt: now.toISOString() });
    }
  }

  writeVersionRecord(rec: WeightVersionWrite, now: Date): void {
    this.versions.push({ ...rec, createdAt: now.toISOString() });
  }
}
