/**
 * Issue #2361 (#1976 step 4e, ADR 0022 D-I step 4) — the
 * screener's run-lock port: the screen_run_locks table behind
 * ONE port, formalizing the bare-executor functions that lived
 * in src/services/screenRunLock.ts (step-4 audit §4e/R-4: those
 * statements were invisible to the D-D census patterns — the
 * family's blind spot this slice closes).
 *
 * The lock's semantics are #1993's, pinned by characterization
 * BEFORE this port existed and preserved exactly: one row per
 * (user_login, universe); acquire is insert-if-absent followed
 * by a compare-and-swap takeover of a stale row (only one
 * contender ever wins); release frees the row only for the
 * holder's token (a null token is a no-op); a row exactly
 * STALE_MS old still counts as running. Every operation is
 * synchronous over the instance's own SQLite — the atomicity
 * the lock exists for depends on no await ever intervening.
 *
 * ADR D-0 residency: the table stays DO-resident behind the
 * port — (a) agent-runtime identity (the lock is the screener
 * instance's own in-flight marker), (b) per-instance
 * serialization (the check-and-write atomicity above IS that
 * serialization), (e) colocated strongly-consistent storage,
 * (f) tenancy isolation by construction (the instance is
 * per-owner; the row's user_login scopes within it). This
 * module carries the constants, types and the port interface
 * ONLY (ADR 0002 R1/R2). Adapters:
 * doSqliteScreenRunLockAdapter.ts (production),
 * inMemoryScreenRunLockAdapter.ts (test doubles). Composition:
 * createScreenRunLockPorts.ts.
 *
 * AS-FOUND ASYMMETRY (pinned, not repaired): acquire and the
 * probe ensure the table; release does NOT — releasing against
 * a store where the table was never created surfaces the
 * storage error, exactly as the legacy function did. The
 * in-memory adapter has no table concept, so the asymmetry is
 * observable only on the DO adapter (and through the legacy
 * delegate, which forwards to it).
 *
 * TRANSACTION SEAM (ADR D-C): deliberately none — and none is
 * needed: every operation is one statement, except acquire's
 * read-back pair, whose correctness comes from the CAS (a lost
 * race reads back a foreign token and reports not-acquired),
 * not from a transaction.
 */
import type { SqlStorage } from "./repositoryPorts";

export type ScreenRunLockSqlExecutor = SqlStorage;

/** Stale threshold: a holder older than this may be taken over. */
export const SCREEN_RUN_LOCK_STALE_MS = 5 * 60 * 1000;

export interface ScreenRunLockAcquisition {
  acquired: boolean;
  /** Present only when acquired; the release token. */
  token: string | null;
  /** Epoch ms the current holder started; null when no row exists. */
  startedAt: number | null;
  /** True when this acquisition took over a stale row. */
  tookOverStale: boolean;
}

export interface ScreenRunLockPort {
  /** The table's ONE DDL home. Ensure-style; idempotent. */
  ensureSchema(): void;
  /**
   * Acquire the lock for one user + universe. Synchronous
   * throughout: implementations run over the DO's synchronous
   * storage handle, never an async wrapper, or the atomicity
   * this lock exists for is lost.
   */
  acquire(
    userLogin: string,
    universe: string,
    now?: number
  ): ScreenRunLockAcquisition;
  /** Release only when the token matches: never frees another
   *  run's lock. A null token is a no-op. Does NOT ensure the
   *  table (as-found asymmetry, see header). */
  release(userLogin: string, universe: string, token: string | null): void;
  /** Probe for the sharded submission gate: stale rows do not
   *  count as running, but their startedAt is still reported. */
  isRunning(
    userLogin: string,
    universe: string,
    now?: number
  ): { running: boolean; startedAt: number | null };
}
