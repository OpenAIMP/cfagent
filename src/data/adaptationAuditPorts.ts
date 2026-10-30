/**
 * Issue #2357 (#1976 step 4b, ADR 0022 D-I step 4) — adaptation
 * audit port: the append-only audit trail for autonomous
 * changes (#755).
 *
 * ADR D-0 ruled this family DO-resident behind a port (step-4
 * audit §3). APPEND-ONLY is the contract: this port has an
 * insert and a list, and no update or delete path — a blocked
 * attempt is audited through the same insert with its status
 * and reason. The budget policy and the applyAdaptation seam
 * stay in src/services/adaptationAudit.ts, which re-exports
 * these types and delegates persistence here. Settings reads
 * (budget overrides, the kill switch) do NOT live on this
 * port: they move to the step-3a read-only settings port
 * (settingsReadPorts.ts, gate G-7) — no settings write path
 * exists here either.
 */

export interface AdaptationRecord {
  actor: string;
  subject: string;
  parameter: string;
  before: string;
  after: string;
  /** Numeric step size for drift accounting; null for non-numeric changes. */
  delta: number | null;
  rationale: string;
  dataWindow: string;
  createdAt?: string;
}

export interface AdaptationAuditRow extends Required<Omit<AdaptationRecord, "createdAt">> {
  id: string;
  status: "applied" | "blocked";
  blockReason: string | null;
  createdAt: string;
}

export interface AdaptationBudget {
  maxPerPeriod: number;
  periodDays: number;
  maxCumulativeDrift: number;
}

export const DEFAULT_ADAPTATION_BUDGET: AdaptationBudget = {
  maxPerPeriod: 4,
  periodDays: 7,
  maxCumulativeDrift: 0.5,
};

/**
 * The adaptation audit contract (sync, mirroring the legacy
 * module's seam). list clamps its limit to 1..500 exactly as
 * the legacy module did.
 */
export interface AdaptationAuditStore {
  ensureTable(): void;
  /** Append one audit row; returns the generated row id. */
  insert(
    rec: AdaptationRecord,
    status: "applied" | "blocked",
    blockReason: string | null,
    now: Date,
  ): string;
  /** Audit history for a subject (or all subjects), newest first. */
  list(subject?: string, limit?: number): AdaptationAuditRow[];
}

/** Minimal SQL executor matching the Durable Object SqlStorage
 *  exec signature (the shape the legacy module's seam assumed). */
export interface AdaptationAuditSqlExecutor {
  exec(query: string, ...params: unknown[]): Iterable<unknown>;
}
