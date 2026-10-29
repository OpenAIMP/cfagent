/**
 * Issue #2337 (#1976 step 2, ADR 0022 D-I step 2) — discovery
 * alert port: the alert log for the Phase 1 pipeline (issue
 * #18, Phase 2 — Decision 2).
 *
 * Every alert the dispatcher sends is recorded here FIRST; the
 * record is both the in-app channel's artifact and the
 * enforcement point for the two anti-spam rules: dedupe (at
 * most one alert per (scope, symbol, thesis, day)) and the
 * daily cap (counts records per (scope, day)).
 *
 * ADR D-0 ruled this family DO-resident behind a port: single
 * writer path, single host class; check-then-record
 * correctness leans on per-instance serialization (menu
 * property (b)).
 *
 * DEDUPE IS PART OF THE PORT CONTRACT (step-2 audit §2.4): an
 * adapter must enforce the (scope_key, symbol, thesis, day)
 * uniqueness BY CONSTRAINT, not by check-then-act — the SQL
 * adapter carries the schema's UNIQUE constraint, and the
 * in-memory adapter rejects a duplicate record with an error.
 * (The legacy in-memory store accepted duplicates and relied
 * on the dispatcher's hasAlerted check; the port resolves
 * that divergence — pinned in the step-2 conformance suite.)
 *
 * This module carries the record types and the port interface
 * ONLY (ADR 0002 R1/R2). Adapters:
 * doSqliteDiscoveryAlertAdapter.ts (production),
 * inMemoryDiscoveryAlertAdapter.ts (test double). The types
 * moved here from src/trading/options/discoveryAlertStore.ts,
 * which is now a re-export shim.
 */

import type { DiscoverySignalType } from "../trading";
import type { OptionThesis } from "../trading";

export interface DiscoveryAlertRecord {
  id: string;
  /** The discovery run that produced the setup (alert linkage). */
  runId: string;
  scopeKey: string;
  symbol: string;
  thesis: OptionThesis;
  discoveryScore: number;
  /** UTC day (YYYY-MM-DD) the dedupe + cap rules key on. */
  day: string;
  /** The setup's evidence line — every alert links run + evidence. */
  evidence: string;
  firedSignals: DiscoverySignalType[];
  createdAt: string;
}

export type DiscoveryAlertRecordInput = Omit<DiscoveryAlertRecord, "id">;

export interface DiscoveryAlertStore {
  hasAlerted(scopeKey: string, symbol: string, thesis: OptionThesis, day: string): Promise<boolean>;
  countForDay(scopeKey: string, day: string): Promise<number>;
  record(input: DiscoveryAlertRecordInput): Promise<DiscoveryAlertRecord>;
  list(scopeKey: string, options?: { limit?: number }): Promise<DiscoveryAlertRecord[]>;
}

/** Minimal SQL executor matching the Durable Object SqlStorage
 *  `exec` signature (the shape the sibling stores declare). */
export interface DiscoveryAlertSqlExecutor {
  exec(query: string, ...params: unknown[]): Iterable<unknown>;
}
