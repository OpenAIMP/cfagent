/**
 * Issue #2361 (#1976 step 4e) — the in-memory implementation
 * of the screener's run-lock port (test double for the
 * conformance suite). The state machine mirrors the DO
 * adapter exactly: insert-if-absent, stale compare-and-swap
 * on the observed started_at, token-matched release (null
 * token a no-op), and the probe's boundary (exactly STALE_MS
 * old still counts as running). Synchronous throughout, like
 * the DO adapter — the atomicity argument is the same.
 *
 * The one deliberate divergence is invisible through the port
 * contract: this double has no table concept, so release on an
 * empty store is a no-op where the DO adapter surfaces the
 * storage's missing-table error (the as-found asymmetry named
 * on the port; pinned against the DO adapter, not here).
 */
import {
  SCREEN_RUN_LOCK_STALE_MS,
  type ScreenRunLockAcquisition,
  type ScreenRunLockPort,
} from "./screenRunLockPorts";

interface LockRow {
  token: string;
  startedAt: number;
}

export class InMemoryScreenRunLock implements ScreenRunLockPort {
  private readonly rows = new Map<string, LockRow>();

  ensureSchema(): void {}

  acquire(
    userLogin: string,
    universe: string,
    now: number = Date.now()
  ): ScreenRunLockAcquisition {
    const key = `${userLogin}\u0000${universe}`;
    const token = crypto.randomUUID();
    const existing = this.rows.get(key);
    if (!existing) {
      this.rows.set(key, { token, startedAt: now });
      return { acquired: true, token, startedAt: now, tookOverStale: false };
    }
    const startedAt = existing.startedAt;
    if (Number.isFinite(startedAt) && now - startedAt > SCREEN_RUN_LOCK_STALE_MS) {
      // CAS on the observed started_at: the row still carries
      // it (this double is synchronous, so the check IS the
      // swap), so this contender wins the takeover.
      if (this.rows.get(key)?.startedAt === startedAt) {
        this.rows.set(key, { token, startedAt: now });
        return { acquired: true, token, startedAt: now, tookOverStale: true };
      }
    }
    return {
      acquired: false,
      token: null,
      startedAt: Number.isFinite(startedAt) ? startedAt : null,
      tookOverStale: false,
    };
  }

  release(userLogin: string, universe: string, token: string | null): void {
    if (!token) return;
    const key = `${userLogin}\u0000${universe}`;
    if (this.rows.get(key)?.token === token) this.rows.delete(key);
  }

  isRunning(
    userLogin: string,
    universe: string,
    now: number = Date.now()
  ): { running: boolean; startedAt: number | null } {
    const row = this.rows.get(`${userLogin}\u0000${universe}`);
    if (!row) return { running: false, startedAt: null };
    const startedAt = row.startedAt;
    if (Number.isFinite(startedAt) && now - startedAt <= SCREEN_RUN_LOCK_STALE_MS) {
      return { running: true, startedAt };
    }
    return { running: false, startedAt };
  }
}
