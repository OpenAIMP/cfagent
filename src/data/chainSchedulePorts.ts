/**
 * Issue #1651 ([AGENTIC] Slice 1, chains + schedules projection) —
 * port module (R1). Domain code depends ONLY on these interfaces.
 *
 * This module is deliberately free of any store client, any
 * binding reference, and any query language: no adapter import,
 * no store-specific type. The composition root
 * (src/data/createChainSchedulePorts.ts) wires a store adapter to
 * these ports; domain code never sees the adapter.
 *
 * Read contract: latestChain / latestSchedule answer from the
 * highest-version row for the tenant + id. A projection read may
 * lag one transition (R5); any consumer that cannot tolerate lag
 * reads the durable object directly and says so.
 *
 * Write contract (R5): one row per (tenant, chain, version).
 * Replaying the same version is a no-op, so at-least-once
 * delivery is safe. A later transition writes a HIGHER version
 * row, never an overwrite, so chain lifecycle stays auditable.
 *
 * Tenancy (R7): every method takes a tenant id resolved
 * server-side. There is no unscoped read method anywhere in this
 * module; adapters inject the tenant predicate into every query.
 *
 * Scope note: this slice covers chain and schedule rows only.
 * Job, audit, and report ports land in later slices; nothing
 * here may grow a second store's rows. No row type here carries
 * auth material of any kind — a writer accepting such a row is
 * a defect, pinned by test.
 */

export type ChainScheduleStatus = "pending" | "approved" | "killed";

/** One versioned row of a compiled chain's projection. */
export interface ChainRow {
  tenantId: string;
  workspaceId: string;
  /** The persisted chain identity: the synthesized record id. */
  chainId: string;
  /** Projection version: one higher per projected transition. */
  version: number;
  status: ChainScheduleStatus;
  goal: string;
  /** JSON array of the chain's steps (capability ids + stages). */
  stepsJson: string;
  /** Epoch milliseconds the DO record was created. */
  createdAtMs: number;
  /** Epoch milliseconds this projection row was written. */
  updatedAtMs: number;
  /** Writer provenance: which component wrote the row. */
  provenanceWriter: string;
  /** Source durable object that owns the authoritative state. */
  provenanceSourceDo: string;
  /** Row-shape version of the DO record mapping (1 in slice 1). */
  provenanceSourceVersion: string;
}

/** One versioned row of a synthesized schedule's projection. */
export interface ScheduleRow {
  tenantId: string;
  workspaceId: string;
  /** The synthesized record id; equals chainId in slice 1 wiring. */
  scheduleId: string;
  chainId: string;
  version: number;
  status: ChainScheduleStatus;
  kind: "recurring" | "one-shot";
  cron: string | null;
  createdAtMs: number;
  updatedAtMs: number;
  provenanceWriter: string;
  provenanceSourceDo: string;
  provenanceSourceVersion: string;
}

/** Tenant-scoped latest-row reads over both projections. */
export interface ChainScheduleReader {
  latestChain(
    tenantId: string,
    chainId: string,
  ): Promise<ChainRow | null>;
  latestSchedule(
    tenantId: string,
    scheduleId: string,
  ): Promise<ScheduleRow | null>;
}

/** Idempotent versioned writes over both projections. */
export interface ChainScheduleProjectionWriter {
  recordChain(row: ChainRow): Promise<void>;
  recordSchedule(row: ScheduleRow): Promise<void>;
}

/** The slice-1 store surface: one reader plus one writer. */
export interface ChainScheduleStore
  extends ChainScheduleReader,
    ChainScheduleProjectionWriter {}
