/**
 * Issue #2337 (#1976 step 2, ADR 0022 D-I step 2) — strategy-
 * profile port: per-user saved strategy profiles (issue #28).
 *
 * ADR D-0 ruled this family DO-resident behind a port: per-user
 * config CRUD whose readers/writers are the owning user's
 * orchestrator surfaces. Name uniqueness (per user,
 * case-insensitive, trimmed) was enforced by read-then-write in
 * code with no storage constraint — correct only under
 * per-instance serialization (menu property (b)), which is
 * therefore genuinely consumed, not presumed (step-2 audit
 * §2.6, judgement call recorded).
 *
 * THE UNIQUENESS INVARIANT IS PART OF THE PORT CONTRACT: the
 * key is a normalized expression (trim + case-fold), not stored
 * data, so enforcement is the check-then-write unit itself —
 * on the DO adapter it runs INSIDE the transaction aspect
 * (withTransaction) when the host supplies the transaction-
 * capable storage object, making check + insert/update one
 * unit rather than merely serialized (R-3 ruling on #2337:
 * fix with disclosure; no schema UNIQUE retrofit on existing
 * per-instance tables). The SQL adapter also verifies
 * affected rows on update/delete (ADR D-E.2): a write that
 * lands on no row — or leaves the row in a state other than
 * the one written — throws instead of reporting success.
 * Behaviour changes are confined to silently-wrong cases.
 *
 * The store enforces only identity and per-user name
 * uniqueness. Spec VALIDATION is the caller's job
 * (validateStrategyProfile in strategyProfile.ts) — routes and
 * services validate before writing.
 *
 * This module carries the port interface and its options ONLY
 * (ADR 0002 R1/R2). Adapters: doSqliteStrategyProfileAdapter
 * .ts (production), inMemoryStrategyProfileAdapter.ts (test
 * double). The interface moved here from
 * src/trading/options/strategyProfileStore.ts, which is now a
 * re-export shim.
 */

import type { StrategyProfile, StrategyProfileSpec } from "../trading";
import type { ScanSqlExecutor } from "./scanRunPorts";

export interface StrategyProfileStore {
  /** Create a profile at version 1. Throws on a duplicate name (per user, case-insensitive). */
  create(userLogin: string, name: string, spec: StrategyProfileSpec): Promise<StrategyProfile>;
  /** All of the user's profiles, name ascending. */
  list(userLogin: string): Promise<StrategyProfile[]>;
  get(userLogin: string, id: string): Promise<StrategyProfile | null>;
  /** Case-insensitive, trimmed name lookup. */
  getByName(userLogin: string, name: string): Promise<StrategyProfile | null>;
  /**
   * Replace the spec (and optionally rename) — version + 1, updatedAt
   * refreshed. Returns null when the profile does not exist for the
   * user; throws on a rename that clashes with a DIFFERENT profile.
   */
  update(userLogin: string, id: string, spec: StrategyProfileSpec, name?: string): Promise<StrategyProfile | null>;
  delete(userLogin: string, id: string): Promise<boolean>;
}

export interface StrategyProfileStoreOptions {
  idFactory?: () => string;
  /** Injectable clock for deterministic tests; defaults to wall clock. */
  now?: () => Date;
}
