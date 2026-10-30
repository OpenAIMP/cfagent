/**
 * Issue #2357 (#1976 step 4b, ADR 0022 D-I step 4) — strategy
 * weights v2 port for the strategy-state cluster.
 *
 * ADR D-0 ruled this family DO-resident behind a port (step-4
 * audit §3): the champion/challenger promotion unit is a DO
 * transactionSync wrap over these tables, so residency is
 * load-bearing — a D1 move would dissolve the unit. This
 * module carries the record types and the port interface ONLY
 * (ADR 0002 R1/R2): no store client, no env binding, no SQL.
 * Adapters: doSqliteStrategyWeightsAdapter.ts (production, the
 * legacy strategyWeightsV2 store moved into the layer),
 * inMemoryStrategyWeightsAdapter.ts (test double). The pure
 * policy (proposals, decay, after-cost scoring) stays in
 * src/services/strategyWeightsV2.ts, which re-exports these
 * types and delegates its store functions to the DO adapter.
 *
 * CONFLICT POLICY (ADR D-E.1): the weights table is keyed by
 * (strategy, regime); writes are DELETE+INSERT (the legacy
 * MockSqlStorage-parity idiom), so a write replaces the row
 * for its key — declared here, unchanged from the legacy
 * module. Version records are append-only: there is no update
 * or delete path for them on this port.
 */

import type { RegimeAssessment } from "../services/researchPipeline";

export type WeightsV2Regime = RegimeAssessment["regime"];

export interface WeightVersionRecord {
  version: number;
  strategy: string;
  regime: string;
  /** Null when no weight row existed before this change (#760 semantics). */
  before: number | null;
  after: number;
  signal: number | null;
  evaluated: number;
  winRateAfterCost: number | null;
  avgRAfterCost: number | null;
  actor: string;
  rationale: string;
  createdAt: string;
}

/** The write shape for one append-only version record. */
export interface WeightVersionWrite {
  version: number;
  strategy: string;
  regime: string;
  before: number | null;
  after: number;
  signal: number | null;
  evaluated: number;
  winRateAfterCost: number | null;
  avgRAfterCost: number | null;
  actor: string;
  rationale: string;
}

/**
 * The weights store contract (sync, mirroring the legacy
 * module's seam). The row-level primitives (weightRowExists /
 * writeWeightRow / writeVersionRecord) are the legs the
 * adaptation seam's apply callbacks run inside the promotion
 * unit; they assume ensureTables has run (every read entry
 * point ensures).
 */
export interface StrategyWeightsStore {
  ensureTables(): void;
  currentVersion(): number;
  listVersionRecords(limit?: number): WeightVersionRecord[];
  getWeights(): Record<string, number>;
  getWeightsForRegime(regime: string): Record<string, number>;
  getWeightsCollapsed(): Record<string, number>;
  weightRowExists(strategy: string, regime: string): boolean;
  /** Replace the row for (strategy, regime); a null weight deletes it (#760 exact restore). */
  writeWeightRow(
    strategy: string,
    regime: string,
    weight: number | null,
    version: number,
    now: Date,
  ): void;
  writeVersionRecord(rec: WeightVersionWrite, now: Date): void;
}

/** Minimal SQL executor matching the Durable Object SqlStorage
 *  exec signature (the shape the legacy module's seam assumed). */
export interface StrategyWeightsSqlExecutor {
  exec(query: string, ...params: unknown[]): Iterable<unknown>;
}

/** The (strategy, regime) map key — one implementation, shared
 *  by both adapters and the service's pure policy. */
export function weightsV2Key(strategy: string, regime: string): string {
  return `${strategy}|${regime}`;
}
