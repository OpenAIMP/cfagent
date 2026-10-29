/**
 * Issue #2337 (#1976 step 2, ADR 0022 D-I step 2) — discovery
 * setup-run port: the Phase 1 signal-driven pipeline's run store
 * (issue #14, spec §6 stage 6).
 *
 * ADR D-0 ruled this family DO-resident behind a port: written
 * and read by discoveryService on the orchestrator host class;
 * the delta classification reads latestForScope — the previous
 * run of the same scope — inside the same service that writes
 * the next, so cross-run reads are within-scope, within-user,
 * within one host class (judgement call, recorded in the
 * step-2 audit §2.3).
 *
 * This module carries the record types, the count-
 * reconciliation validator, the #103 visibility rule, and the
 * port interface ONLY (ADR 0002 R1/R2). Adapters:
 * doSqliteDiscoverySetupAdapter.ts (production),
 * inMemoryDiscoverySetupAdapter.ts (test double). The types
 * moved here from src/trading/options/discoverySetupStore.ts,
 * which is now a re-export shim. This store is distinct from
 * discoveryRunPorts.ts on purpose: that port persists the
 * #533/#223 scheduled-analysis lineage; this one persists the
 * signal-driven Phase 1 pipeline's runs, whose scopeKey is the
 * comparability key the delta classification runs against.
 *
 * RECONCILIATION IS PART OF THE CONTRACT: a run whose counts
 * do not reconcile (considered = setups + abstentions +
 * pre-screened-out + errors, acceptance (e)) is rejected at
 * save, BEFORE any write — a rejected run stores nothing.
 */

import type { DiscoveryConfidence } from "../trading";
import type { DiscoverySignalType } from "../trading";
import type { FitGateBucket } from "../trading";
import type { OptionThesis } from "../trading";

export const DISCOVERY_MODEL_VERSION = "discovery-v1";
export const DISCOVERY_SETUP_RUN_RETENTION_DAYS = 365;
export const DISCOVERY_SETUP_RUN_MAX_ROWS = 1000;

/** One expressed setup: an inferred view the pipeline priced and
 *  the fit gate judged. The evidence line is mandatory — a setup
 *  that cannot say why it exists does not get stored. */
/** Per-type roll-up carried on an expressed setup (issue #18):
 *  the best candidate per strategy type from the expression, so a
 *  setup card can show what else the pipeline liked, not only the
 *  pick. Slim projection of the expression's DiscoveryTypeRollup. */
export interface DiscoverySetupRollupEntry {
  type: string;
  label: string;
  compositeScore: number;
}

export interface DiscoverySetupExpressedItem {
  kind: "setup";
  symbol: string;
  thesis: OptionThesis;
  ruleId: string;
  confidence: DiscoveryConfidence;
  /** The expressed pick's composite score (0–100) — the number the
   *  delta classification and (in Phase 2) alert thresholds read. */
  discoveryScore: number;
  gateBucket: FitGateBucket;
  targetPrice: number;
  targetDate: string;
  firedSignals: DiscoverySignalType[];
  evidence: string;
  /** Best-per-type roll-up (issue #18). Optional: runs stored
   *  before the roll-up landed carry none, and readers must
   *  tolerate its absence. */
  rollup?: DiscoverySetupRollupEntry[];
}

/** One name the run considered but did not express, with the stage
 *  that stopped it and the reason in plain language. */
export interface DiscoverySetupAbstentionItem {
  kind: "abstention";
  symbol: string;
  stage: "prescreen" | "inference" | "expression";
  reason: string;
  nearMissSignals: DiscoverySignalType[];
}

export type DiscoverySetupItem = DiscoverySetupExpressedItem | DiscoverySetupAbstentionItem;

/** Coverage accounting for a run. `considered` is the universe size
 *  the run started from; every considered name lands in exactly one
 *  bucket (acceptance (e)). */
export interface DiscoveryRunCounts {
  considered: number;
  setups: number;
  abstentions: number;
  prescreenedOut: number;
  errors: number;
}

export function validateDiscoveryRunCounts(
  counts: DiscoveryRunCounts,
  items: readonly DiscoverySetupItem[],
): string | null {
  const setups = items.filter((i) => i.kind === "setup").length;
  const abstentions = items.length - setups;
  if (counts.setups !== setups || counts.abstentions !== abstentions) {
    return (
      `counts disagree with the run's items: counts claim ${counts.setups} setups / ` +
      `${counts.abstentions} abstentions but the items carry ${setups} / ${abstentions}`
    );
  }
  const total = counts.setups + counts.abstentions + counts.prescreenedOut + counts.errors;
  if (total !== counts.considered) {
    return (
      `counts do not reconcile: considered ${counts.considered} != setups + abstentions + ` +
      `prescreenedOut + errors (${total})`
    );
  }
  return null;
}

export interface DiscoverySetupRunInput {
  createdAt: string;
  /** Comparability key: runs sharing a scopeKey are successive
   *  observations of the same discovery scope (a schedule, a
   *  watchlist universe, an ad-hoc NLQ universe). */
  scopeKey: string;
  /** Where the run came from ("schedule" | "nlq" | "unified" | …). */
  source: string;
  /** Hash of the effective discovery + scanner config for the run. */
  configHash: string;
  counts: DiscoveryRunCounts;
  items: DiscoverySetupItem[];
  userLogin?: string;
}

export interface StoredDiscoverySetupRun extends DiscoverySetupRunInput {
  id: string;
  modelVersion: string;
}

export interface DiscoverySetupStore {
  /** Persist one run and return it stored. Saving prunes
   *  (retention window + row cap, oldest first). Throws when the
   *  run's counts do not reconcile. */
  save(input: DiscoverySetupRunInput): Promise<StoredDiscoverySetupRun>;
  /** Newest-first runs visible to the caller, optionally scoped. */
  list(options?: {
    limit?: number;
    offset?: number;
    scopeKey?: string;
    userLogin?: string;
  }): Promise<StoredDiscoverySetupRun[]>;
  /** The full stored run, or null when unknown/pruned/not visible —
   *  invisibility reads exactly like absence (#103). */
  get(id: string, options?: { userLogin?: string }): Promise<StoredDiscoverySetupRun | null>;
  /** The newest run for a scope — the delta baseline — or null. */
  latestForScope(scopeKey: string, options?: { userLogin?: string }): Promise<StoredDiscoverySetupRun | null>;
  /** Delete rows older than the retention window and rows beyond
   *  the row cap; returns how many rows were deleted. */
  prune(now: Date): Promise<number>;
}

/** The #103 visibility rule, identical to the sibling stores'. */
export function discoverySetupRunVisibleToCaller(
  run: Pick<StoredDiscoverySetupRun, "userLogin">,
  userLogin?: string,
): boolean {
  return run.userLogin === undefined || run.userLogin === null || run.userLogin === userLogin;
}

export interface DiscoverySetupStoreOptions {
  idFactory?: () => string;
  retentionDays?: number;
  maxRows?: number;
}

/** Minimal SQL executor matching the Durable Object SqlStorage
 *  `exec` signature (the same structural shape the sibling stores
 *  declare). */
export interface DiscoverySetupSqlExecutor {
  exec(query: string, ...params: unknown[]): Iterable<unknown>;
}
