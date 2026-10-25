/**
 * Issue #1548 ([AGENTIC] Slice 0, data foundation layer) — port
 * module (R1). Domain code depends ONLY on these interfaces.
 *
 * This module is deliberately free of any store client, any
 * binding reference, and any query language: no adapter import,
 * no SQL string, no store-specific type. The composition root
 * (src/data/createGovernancePorts.ts) wires a store adapter to
 * these ports; domain code never sees the adapter.
 *
 * Read contract (R6): HaltRead is the one read that must be
 * fresh — it answers from the latest mirrored row for the
 * tenant/scope, and it FAILS CLOSED: any read error is reported
 * as halted, never as clear. latestHalt, by contrast, THROWS on
 * error: it is a writer-path read (seed, reconciliation), where a
 * silent failure would be worse than a loud one.
 *
 * Write contract (R5/R6): recordHalt appends one row per event
 * (never overwrites history). Replaying the same event id is a
 * no-op, so at-least-once delivery is safe. Clearing is a new
 * row, never an overwrite, so halt history stays auditable.
 *
 * Tenancy (R7): every method takes a tenant id resolved
 * server-side. There is no unscoped read method anywhere in this
 * module; adapters inject the tenant predicate into every query.
 *
 * Scope note: this slice covers governance rows only. Chain,
 * schedule, job, audit, and report ports land in later slices;
 * nothing here may grow a second store's rows.
 */

export type HaltScope = "global" | "chain";
export type HaltState = "halted" | "clear";

/** One append-only governance event row (mirror of a DO-side transition). */
export interface GovernanceHaltRow {
  /** Deterministic event id; replays of the same id are no-ops. */
  eventId: string;
  /** Tenant the row belongs to; injected into every query. */
  tenantId: string;
  /** "global" halts everything; "chain" halts one chain id. */
  scope: HaltScope;
  /** Chain id for scope "chain"; null for scope "global". */
  scopeId: string | null;
  state: HaltState;
  /** Who (or what process) set the state. */
  setBy: string;
  /** Epoch milliseconds of the transition. */
  setAtMs: number;
  /** Human-readable reason for the transition. */
  reason: string;
  /** Schema version of the row (1 in slice 0). */
  version: number;
  /** Writer provenance: which component wrote the row. */
  provenance: string;
}

export interface HaltReadOptions {
  scope?: HaltScope;
  scopeId?: string | null;
}

/**
 * Fresh, tenant-scoped halt reads. isHalted fails closed on any
 * error; latestHalt throws on any error (writer-path semantics).
 */
export interface HaltReader {
  isHalted(tenantId: string, opts?: HaltReadOptions): Promise<boolean>;
  latestHalt(
    tenantId: string,
    opts?: HaltReadOptions,
  ): Promise<GovernanceHaltRow | null>;
}

/** Idempotent append of governance transition rows. */
export interface GovernanceProjectionWriter {
  recordHalt(row: GovernanceHaltRow): Promise<void>;
}

/** The slice-0 store surface: one reader plus one writer. */
export interface GovernanceStore extends HaltReader, GovernanceProjectionWriter {}
