/**
 * Issue #755 (P2-4.2): adaptation budgets + audit trail for autonomous
 * changes — the substrate Phase 4 bounded adaptation (#754) runs on.
 *
 * #232's constraint — "audit everything: every self-modification logged
 * with before/after and rationale" — has a store here, and bounded
 * adaptation is bounded in aggregate, not just per-step: budgets cap
 * how many adaptations a subject may take per period and how far it
 * may cumulatively drift, enforced BEFORE application. A blocked
 * attempt is itself audited and consumes no budget.
 *
 * The audit table is append-only: this module exports no update or
 * delete path for audit rows (pinned by test). Adapters apply changes
 * exclusively through `applyAdaptation`, which evaluates the budget,
 * runs the caller's apply callback only when allowed, and writes the
 * audit record either way — there is no supported apply-without-audit
 * path.
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

const SETTING_KEYS = {
  maxPerPeriod: "adaptation.maxPerPeriod",
  periodDays: "adaptation.periodDays",
  maxCumulativeDrift: "adaptation.maxCumulativeDrift",
} as const;

export function ensureAdaptationAuditTable(sql: any): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS mas_adaptation_audit (
    id TEXT PRIMARY KEY,
    actor TEXT NOT NULL,
    subject TEXT NOT NULL,
    parameter TEXT NOT NULL,
    before_value TEXT NOT NULL,
    after_value TEXT NOT NULL,
    delta REAL,
    rationale TEXT NOT NULL,
    data_window TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'applied',
    block_reason TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  sql.exec(`CREATE INDEX IF NOT EXISTS idx_adaptation_audit_subject ON mas_adaptation_audit(subject, created_at)`);
}

/**
 * Budget configuration: mas_settings overrides over code defaults.
 * Settings are a tuning convenience, never a failure mode — any read
 * problem falls back to the defaults.
 */
export function getAdaptationBudget(sql: any): AdaptationBudget {
  const budget = { ...DEFAULT_ADAPTATION_BUDGET };
  try {
    for (const field of Object.keys(SETTING_KEYS) as Array<keyof AdaptationBudget>) {
      const rows = Array.from(
        sql.exec(`SELECT value FROM mas_settings WHERE key = ?`, SETTING_KEYS[field])
      ) as any[];
      if (rows.length > 0) {
        const v = Number(rows[0].value);
        if (Number.isFinite(v) && v > 0) budget[field] = v;
      }
    }
  } catch {
    /* defaults stand */
  }
  return budget;
}

function insertAuditRow(
  sql: any,
  rec: AdaptationRecord,
  status: "applied" | "blocked",
  blockReason: string | null,
  now: Date
): string {
  ensureAdaptationAuditTable(sql);
  const id = `adapt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  sql.exec(
    `INSERT INTO mas_adaptation_audit
     (id, actor, subject, parameter, before_value, after_value, delta, rationale, data_window, status, block_reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    rec.actor,
    rec.subject,
    rec.parameter,
    rec.before,
    rec.after,
    rec.delta,
    rec.rationale,
    rec.dataWindow,
    status,
    blockReason,
    rec.createdAt ?? now.toISOString()
  );
  return id;
}

/** Append an applied adaptation to the audit trail. */
export function recordAdaptation(sql: any, rec: AdaptationRecord, now: Date = new Date()): string {
  return insertAuditRow(sql, rec, "applied", null, now);
}

/** Append a blocked attempt to the audit trail (audited, never counted). */
export function recordBlockedAdaptation(
  sql: any,
  rec: AdaptationRecord,
  blockReason: string,
  now: Date = new Date()
): string {
  return insertAuditRow(sql, rec, "blocked", blockReason, now);
}

/** Full audit history for a subject (or all subjects), newest first. */
export function listAdaptationAudit(
  sql: any,
  subject?: string,
  limit = 100
): AdaptationAuditRow[] {
  ensureAdaptationAuditTable(sql);
  const lim = Math.max(1, Math.min(500, Math.floor(limit)));
  const rows = (
    subject
      ? Array.from(
          sql.exec(
            `SELECT * FROM mas_adaptation_audit WHERE subject = ? ORDER BY created_at DESC LIMIT ${lim}`,
            subject
          )
        )
      : Array.from(
          sql.exec(`SELECT * FROM mas_adaptation_audit ORDER BY created_at DESC LIMIT ${lim}`)
        )
  ) as any[];
  return rows.map((r) => ({
    id: r.id,
    actor: r.actor,
    subject: r.subject,
    parameter: r.parameter,
    before: r.before_value,
    after: r.after_value,
    delta: r.delta,
    rationale: r.rationale,
    dataWindow: r.data_window,
    status: r.status,
    blockReason: r.block_reason ?? null,
    createdAt: r.created_at,
  }));
}

/** Applied-adaptation usage for a subject inside the budget window. */
export function adaptationUsage(
  sql: any,
  subject: string,
  now: Date = new Date(),
  budget: AdaptationBudget = getAdaptationBudget(sql)
): { count: number; cumulativeDrift: number } {
  const since = new Date(now.getTime() - budget.periodDays * 86_400_000).toISOString();
  const rows = listAdaptationAudit(sql, subject, 500).filter(
    (r) => r.status === "applied" && r.createdAt >= since
  );
  return {
    count: rows.length,
    cumulativeDrift: rows.reduce((sum, r) => sum + Math.abs(r.delta ?? 0), 0),
  };
}

/** mas_settings key for the global adaptation kill switch (#756). */
export const ADAPTATION_KILL_SWITCH_KEY = "adaptation.killSwitch";

/**
 * Issue #756's switch, read by every adaptation entry point: when
 * `adaptation.killSwitch` is "on" (also "1"/"true"), all autonomous
 * adaptation halts. Fail-closed with a log: if the settings read itself
 * fails, adaptation halts rather than proceeding unverified — a safety
 * switch that cannot be read is treated as thrown, never silently
 * ignored.
 */
export function isAdaptationHalted(sql: any): boolean {
  try {
    const rows = Array.from(
      sql.exec(`SELECT value FROM mas_settings WHERE key = ?`, ADAPTATION_KILL_SWITCH_KEY)
    ) as any[];
    if (rows.length === 0) return false;
    const v = String(rows[0].value).trim().toLowerCase();
    return v === "on" || v === "1" || v === "true";
  } catch (err) {
    console.error(
      "[Adaptation] Kill-switch read failed; halting adaptation (fail-closed):",
      err
    );
    return true;
  }
}

export interface BudgetVerdict {
  allowed: boolean;
  reason?: string;
  usage: { count: number; cumulativeDrift: number };
  budget: AdaptationBudget;
}

/** Enforce per-period count and cumulative-drift budgets for a subject. */
export function evaluateAdaptationBudget(
  sql: any,
  subject: string,
  proposedDelta: number | null,
  now: Date = new Date()
): BudgetVerdict {
  const budget = getAdaptationBudget(sql);
  const usage = adaptationUsage(sql, subject, now, budget);
  if (usage.count >= budget.maxPerPeriod) {
    return {
      allowed: false,
      reason:
        `per-period adaptation count exhausted for ${subject}: ` +
        `${usage.count}/${budget.maxPerPeriod} in ${budget.periodDays}d`,
      usage,
      budget,
    };
  }
  const driftAfter = usage.cumulativeDrift + Math.abs(proposedDelta ?? 0);
  if (driftAfter > budget.maxCumulativeDrift) {
    return {
      allowed: false,
      reason:
        `cumulative drift cap would be exceeded for ${subject}: ` +
        `${usage.cumulativeDrift.toFixed(3)} + ${Math.abs(proposedDelta ?? 0).toFixed(3)} > ${budget.maxCumulativeDrift} in ${budget.periodDays}d`,
      usage,
      budget,
    };
  }
  return { allowed: true, usage, budget };
}

/**
 * The enforcement seam every adapter goes through: evaluate the budget;
 * when blocked, audit the attempt and do not apply; when allowed, run
 * `apply` exactly once and audit the applied record. If `apply` throws,
 * nothing is audited as applied — the caller sees the throw.
 */
export function applyAdaptation(
  sql: any,
  rec: AdaptationRecord,
  apply: () => void,
  now: Date = new Date(),
  opts: { enforceBudgets?: boolean } = {}
): { applied: boolean; reason?: string } {
  // Budgets bound AUTONOMOUS adaptation (the #754 self-service loop).
  // Human-gated staged promotions (#760) pass enforceBudgets: false —
  // their bound is the #759 gate + stages + automatic rollback — but
  // they are still audited here, and the kill switch is still
  // enforced by the caller before the seam is reached. Default true:
  // every pre-#760 caller keeps the original enforcement.
  if (opts.enforceBudgets !== false) {
    const verdict = evaluateAdaptationBudget(sql, rec.subject, rec.delta, now);
    if (!verdict.allowed) {
      recordBlockedAdaptation(sql, rec, verdict.reason!, now);
      console.error(`[Adaptation] Blocked adaptation for ${rec.subject}: ${verdict.reason}`);
      return { applied: false, reason: verdict.reason };
    }
  }
  apply();
  recordAdaptation(sql, rec, now);
  return { applied: true };
}
