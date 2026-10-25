/**
 * Issue #755 — adaptation budgets + audit trail pins (P2-4.2).
 *
 * Bounded adaptation (#754) must be bounded in aggregate and fully
 * auditable (#232: "audit everything — every self-modification logged
 * with before/after and rationale"). These pins hold the substrate:
 *
 *  - Every applied adaptation writes an append-only audit record:
 *    actor, subject, parameter, before/after, delta, rationale, data
 *    window, timestamp. History per subject is queryable end-to-end.
 *  - Budgets are enforced BEFORE application: max adaptations per
 *    period per subject, and max cumulative |drift| per subject per
 *    period. Exhaustion blocks application.
 *  - A blocked attempt is itself audited (status "blocked" + reason)
 *    and does not consume budget.
 *  - The enforcement wrapper (`applyAdaptation`) is the seam adapters
 *    call: on block, the apply callback never runs; on allow, it runs
 *    exactly once and the applied record is written.
 *  - The module surface is append-only: no update/delete of audit rows.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  recordAdaptation,
  recordBlockedAdaptation,
  listAdaptationAudit,
  adaptationUsage,
  evaluateAdaptationBudget,
  applyAdaptation,
  DEFAULT_ADAPTATION_BUDGET,
  type AdaptationRecord,
} from "../src/services/adaptationAudit";

function makeFakeSql() {
  const audit: any[] = [];
  const settings = new Map<string, string>();
  const sql = {
    exec(text: string, ...params: any[]) {
      if (/^\s*CREATE/i.test(text)) return [];
      if (/INSERT INTO mas_adaptation_audit/i.test(text)) {
        const cols = /\(([^)]+)\)\s*VALUES/i.exec(text)![1].split(",").map((c) => c.trim());
        const row: any = {};
        cols.forEach((c, i) => (row[c] = params[i]));
        audit.push(row);
        return [];
      }
      if (/FROM mas_adaptation_audit/i.test(text)) {
        let rows = [...audit];
        if (/subject = \?/.test(text)) rows = rows.filter((r) => r.subject === params[0]);
        rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
        const lim = /LIMIT (\d+)/.exec(text);
        if (lim) rows = rows.slice(0, Number(lim[1]));
        return rows.map((r) => ({ ...r }));
      }
      if (/FROM mas_settings/i.test(text)) {
        const v = settings.get(params[0]);
        return v === undefined ? [] : [{ value: v }];
      }
      return [];
    },
  };
  return { sql, audit, settings };
}

const NOW = new Date("2026-10-21T12:00:00.000Z");
const HOUR = 3_600_000;

function rec(over: Partial<AdaptationRecord> = {}): AdaptationRecord {
  return {
    actor: "reflection-job",
    subject: "strategy-weight:Momentum",
    parameter: "rankingPrior",
    before: "1.00",
    after: "1.10",
    delta: 0.1,
    rationale: "Calibration: family over-predicted by 8% over 40 outcomes.",
    dataWindow: "2026-09-21..2026-10-21",
    ...over,
  };
}

function appliedAt(over: Partial<AdaptationRecord> & { at: Date }): AdaptationRecord {
  const { at, ...rest } = over;
  return { ...rec(rest), createdAt: at.toISOString() } as AdaptationRecord;
}

describe("adaptation audit trail (#755)", () => {
  it("records an applied adaptation with before/after, rationale and window; history is queryable per subject", () => {
    const { sql } = makeFakeSql();
    recordAdaptation(sql, rec(), NOW);
    recordAdaptation(sql, rec({ subject: "strategy-weight:MeanReversion", after: "0.90", delta: -0.1 }), NOW);
    const history = listAdaptationAudit(sql, "strategy-weight:Momentum");
    expect(history).toHaveLength(1);
    const row = history[0];
    expect(row.actor).toBe("reflection-job");
    expect(row.parameter).toBe("rankingPrior");
    expect(row.before).toBe("1.00");
    expect(row.after).toBe("1.10");
    expect(row.delta).toBe(0.1);
    expect(row.rationale).toContain("Calibration");
    expect(row.dataWindow).toBe("2026-09-21..2026-10-21");
    expect(row.status).toBe("applied");
    expect(row.createdAt).toBe(NOW.toISOString());
  });

  it("usage counts only applied records inside the window", () => {
    const { sql } = makeFakeSql();
    recordAdaptation(sql, appliedAt({ at: new Date(NOW.getTime() - HOUR) }), new Date(NOW.getTime() - HOUR));
    recordAdaptation(sql, appliedAt({ at: new Date(NOW.getTime() - 30 * 24 * HOUR), delta: 0.4 }), new Date(NOW.getTime() - 30 * 24 * HOUR));
    const usage = adaptationUsage(sql, "strategy-weight:Momentum", NOW);
    expect(usage.count).toBe(1);
    expect(usage.cumulativeDrift).toBeCloseTo(0.1);
  });
});

describe("adaptation budgets (#755)", () => {
  it("allows while under both budgets", () => {
    const { sql } = makeFakeSql();
    const v = evaluateAdaptationBudget(sql, "strategy-weight:Momentum", 0.1, NOW);
    expect(v.allowed).toBe(true);
  });

  it("blocks on per-period count exhaustion; the blocked attempt is audited and consumes no budget", () => {
    const { sql } = makeFakeSql();
    for (let i = 0; i < DEFAULT_ADAPTATION_BUDGET.maxPerPeriod; i++) {
      recordAdaptation(sql, rec(), NOW);
    }
    const v = evaluateAdaptationBudget(sql, "strategy-weight:Momentum", 0.05, NOW);
    expect(v.allowed).toBe(false);
    expect(v.reason).toMatch(/per-period|count/i);
    recordBlockedAdaptation(sql, rec({ delta: 0.05 }), v.reason!, NOW);
    const history = listAdaptationAudit(sql, "strategy-weight:Momentum");
    const blocked = history.filter((r) => r.status === "blocked");
    expect(blocked).toHaveLength(1);
    expect(blocked[0].blockReason).toBe(v.reason);
    // Blocked attempts do not consume budget: usage unchanged.
    const usage = adaptationUsage(sql, "strategy-weight:Momentum", NOW);
    expect(usage.count).toBe(DEFAULT_ADAPTATION_BUDGET.maxPerPeriod);
  });

  it("blocks when cumulative drift would exceed the per-subject cap", () => {
    const { sql } = makeFakeSql();
    recordAdaptation(sql, rec({ delta: 0.3 }), NOW);
    recordAdaptation(sql, rec({ delta: -0.15 }), NOW);
    // cumulative |drift| = 0.45; +0.10 = 0.55 > 0.50 cap
    const v = evaluateAdaptationBudget(sql, "strategy-weight:Momentum", 0.1, NOW);
    expect(v.allowed).toBe(false);
    expect(v.reason).toMatch(/drift/i);
    // A smaller step that stays within the cap is allowed.
    const v2 = evaluateAdaptationBudget(sql, "strategy-weight:Momentum", 0.04, NOW);
    expect(v2.allowed).toBe(true);
  });

  it("budget settings in mas_settings override the defaults", () => {
    const { sql, settings } = makeFakeSql();
    settings.set("adaptation.maxPerPeriod", "1");
    recordAdaptation(sql, rec(), NOW);
    const v = evaluateAdaptationBudget(sql, "strategy-weight:Momentum", 0.05, NOW);
    expect(v.allowed).toBe(false);
  });
});

describe("applyAdaptation enforcement wrapper (#755)", () => {
  it("allowed: applies exactly once and audits the applied record", () => {
    const { sql } = makeFakeSql();
    let calls = 0;
    const out = applyAdaptation(sql, rec(), () => { calls++; }, NOW);
    expect(out.applied).toBe(true);
    expect(calls).toBe(1);
    const history = listAdaptationAudit(sql, "strategy-weight:Momentum");
    expect(history).toHaveLength(1);
    expect(history[0].status).toBe("applied");
  });

  it("blocked: the apply callback never runs and the blocked attempt is audited", () => {
    const { sql } = makeFakeSql();
    for (let i = 0; i < DEFAULT_ADAPTATION_BUDGET.maxPerPeriod; i++) {
      recordAdaptation(sql, rec(), NOW);
    }
    let calls = 0;
    const out = applyAdaptation(sql, rec({ delta: 0.05 }), () => { calls++; }, NOW);
    expect(out.applied).toBe(false);
    expect(out.reason).toBeTruthy();
    expect(calls).toBe(0);
    const blocked = listAdaptationAudit(sql, "strategy-weight:Momentum").filter((r) => r.status === "blocked");
    expect(blocked).toHaveLength(1);
  });
});

describe("append-only surface (#755)", () => {
  it("the audit module issues no UPDATE or DELETE against the audit table", () => {
    const src = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/services/adaptationAudit.ts"),
      "utf8"
    );
    expect(/UPDATE\s+mas_adaptation_audit/i.test(src)).toBe(false);
    expect(/DELETE\s+FROM\s+mas_adaptation_audit/i.test(src)).toBe(false);
  });
});
