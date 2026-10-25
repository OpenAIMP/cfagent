/**
 * Issue #1468 ([AGENTIC] Phase 6, sub-issue of #1362) — delegation pins.
 *
 * Each behavior must delegate to shipped code; these tests drive the
 * REAL shipped functions through a fake D1 sql shim (same pattern as
 * tests/promotion_gate.test.ts and tests/adaptation_audit.test.ts):
 *  - Promotion: the REAL #759 `runPromotionGate` mints the verdict
 *    that `promoteChainVersion` consumes. No verdict is minted here.
 *  - Audit: the REAL #755 `recordAdaptation` writes the row that
 *    `recordChainRunAudit` returns, readable via `listAdaptationAudit`.
 *  - Kill: the REAL #756 `isAdaptationHalted` is the global halt that
 *    `isGovernedHalted` exposes.
 */
import { describe, it, expect } from "vitest";
import { compileGoal } from "../src/orchestrate";
import {
  evaluateCandidate,
} from "../src/services/candidateEvaluation";
import {
  requestPromotionApproval,
  decidePromotionApproval,
  runPromotionGate,
  listGateVerdicts,
} from "../src/services/promotionGate";
import {
  listAdaptationAudit,
  isAdaptationHalted,
} from "../src/services/adaptationAudit";
import type { TrackRecord, TrackRecordIdea } from "../src/services/researchTrackRecord";
import {
  versionChain,
  promoteChainVersion,
  isGovernedHalted,
  attributeChainRun,
  recordChainRunAudit,
} from "../src/agentic/chainGovernance";

/** Minimal fake D1 sql: generic INSERT parsing + per-table SELECT/UPDATE. */
function makeFakeSql() {
  const tables: Record<string, any[]> = {
    mas_improvement_candidates: [],
    mas_candidate_evaluations: [],
    mas_promotion_approvals: [],
    mas_promotion_gate_verdicts: [],
    mas_adaptation_audit: [],
  };
  const settings = new Map<string, string>();
  const insert = (rows: any[], text: string, params: any[]) => {
    const cols = /\(([^)]+)\)\s*VALUES/i.exec(text)![1].split(",").map((c) => c.trim());
    const valuesPart = /VALUES\s*\((.*)\)\s*$/is.exec(text)![1];
    const tokens: string[] = [];
    let cur = "";
    let inQuote = false;
    for (const ch of valuesPart) {
      if (ch === "'") inQuote = !inQuote;
      if (ch === "," && !inQuote) {
        tokens.push(cur);
        cur = "";
      } else cur += ch;
    }
    tokens.push(cur);
    const row: any = {};
    let argIdx = 0;
    cols.forEach((c, i) => {
      const tok = (tokens[i] ?? "?").trim();
      if (tok === "?") row[c] = params[argIdx++];
      else if (tok.startsWith("'") && tok.endsWith("'"))
        row[c] = tok.slice(1, -1).replace(/''/g, "'");
      else if (tok.toUpperCase() === "NULL") row[c] = null;
      else if (!Number.isNaN(Number(tok))) row[c] = Number(tok);
      else row[c] = params[argIdx++];
    });
    rows.push(row);
  };
  const sql = {
    exec(text: string, ...params: any[]) {
      if (/^\s*CREATE/i.test(text)) return [];
      if (/FROM mas_settings/i.test(text)) {
        const v = settings.get(params[0]);
        return v === undefined ? [] : [{ value: v }];
      }
      const tableName = Object.keys(tables).find((t) => text.includes(t));
      if (!tableName) return [];
      const rows = tables[tableName];
      if (/^\s*INSERT/i.test(text)) {
        insert(rows, text, params);
        return [];
      }
      if (/UPDATE mas_improvement_candidates/i.test(text)) {
        const [status, updated_at, id, fromStatus] = params;
        const row = rows.find((r) => r.id === id && r.status === fromStatus);
        if (row) {
          row.status = status;
          row.updated_at = updated_at;
          return { changes: 1 };
        }
        return { changes: 0 };
      }
      if (/UPDATE mas_promotion_approvals/i.test(text)) {
        const [status, decided_by, decided_at, id, fromStatus] = params;
        const row = rows.find((r) => r.id === id && r.status === fromStatus);
        if (row) {
          row.status = status;
          row.decided_by = decided_by;
          row.decided_at = decided_at;
          return { changes: 1 };
        }
        return { changes: 0 };
      }
      if (/FROM mas_candidate_evaluations/i.test(text)) {
        return rows
          .filter((r) => r.candidate_id === params[0])
          .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
          .map((r) => ({ ...r }));
      }
      if (/FROM mas_promotion_approvals/i.test(text)) {
        let out = [...rows];
        if (/candidate_id = \?/.test(text)) out = out.filter((r) => r.candidate_id === params[0]);
        if (/\bid = \?/.test(text)) out = out.filter((r) => r.id === params[params.length - 1]);
        return out.map((r) => ({ ...r }));
      }
      if (/FROM mas_promotion_gate_verdicts/i.test(text)) {
        return rows
          .filter((r) => r.candidate_id === params[0])
          .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
          .map((r) => ({ ...r }));
      }
      if (/FROM mas_improvement_candidates/i.test(text)) {
        let out = [...rows];
        if (/id = \?/.test(text)) out = out.filter((r) => r.id === params[0]);
        return out.map((r) => ({ ...r }));
      }
      if (/FROM mas_adaptation_audit/i.test(text)) {
        let out = [...rows];
        if (/subject = \?/.test(text)) out = out.filter((r) => r.subject === params[0]);
        out.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
        const lim = /LIMIT (\d+)/.exec(text);
        if (lim) out = out.slice(0, Number(lim[1]));
        return out.map((r) => ({ ...r }));
      }
      return [];
    },
  };
  return { sql, tables, settings };
}

function idea(structure: string, win: boolean, createdAt: string, n: number): TrackRecordIdea {
  return {
    runId: `run_${createdAt.slice(0, 7)}_${n}`,
    runCreatedAt: createdAt,
    symbol: `SYM${n}`,
    structure,
    outlook: "bullish",
    thesis: "t",
    invalidation: "",
    entrySpot: 100,
    evaluation: {
      evaluatedAt: createdAt,
      invalidated: false,
      pnlEstimatePerUnit: win ? 1 : -1,
      rMultiple: null,
      evalSpot: 101,
      directionCorrect: win,
      notes: [],
    },
  } as any;
}

/** Weak poor in both months; Fine strong. Sept = tuning, Oct = held-out. */
function buildTrack(): TrackRecord {
  const ideas: TrackRecordIdea[] = [];
  let n = 0;
  for (const m of [
    { month: "2026-09", weakWins: 4, fineWins: 12 },
    { month: "2026-10", weakWins: 3, fineWins: 13 },
  ]) {
    for (let i = 0; i < 20; i++) ideas.push(idea("Weak", i < m.weakWins, `${m.month}-05T00:00:00.000Z`, n++));
    for (let i = 0; i < 20; i++) ideas.push(idea("Fine", i < m.fineWins, `${m.month}-06T00:00:00.000Z`, n++));
  }
  const wins = ideas.filter((i) => (i.evaluation!.pnlEstimatePerUnit ?? 0) > 0).length;
  return {
    published: ideas.length,
    evaluated: ideas.length,
    invalidated: 0,
    winRate: wins / ideas.length,
    directionAccuracy: null,
    avgPnlPerUnit: null,
    avgRMultiple: null,
    byStrategy: [],
    byPeriod: [],
    ideas,
  };
}

const T = (h: string) => new Date(`2026-10-21T${h}:00.000Z`);
const SEPT = { from: "2026-09-01", to: "2026-10-01" };
const OCT = { from: "2026-10-01", to: "2026-11-01" };

describe("promotion consumes a REAL #759 verdict (#1468)", () => {
  it("runPromotionGate mints a passing verdict naming the chain; promotion consumes it", () => {
    const { sql, tables } = makeFakeSql();
    const chainId = "chain-nasdaq-slack";
    // The chain version is the gate's evaluation subject, by id.
    tables.mas_improvement_candidates.push({
      id: chainId,
      target: "strategy-gate:Weak",
      change_json: JSON.stringify({
        action: "disable-strategy",
        parameter: "enabled",
        from: true,
        to: false,
        description: "Disable Weak.",
      }),
      hypothesis: "Disabling Weak improves the retained win rate.",
      expected_metric: "portfolioWinRate",
      expected_direction: "increase",
      evidence_refs: "[]",
      provenance_source: "learning",
      provenance_id: "learn_test",
      status: "evaluating",
      supersedes_id: null,
      created_at: "2026-10-21T00:00:00.000Z",
      updated_at: "2026-10-21T00:00:00.000Z",
    });
    const track = buildTrack();
    const candidate: any = {
      id: chainId,
      target: "strategy-gate:Weak",
      change: { action: "disable-strategy", parameter: "enabled", from: true, to: false, description: "Disable Weak." },
      hypothesis: "Disabling Weak improves the retained win rate.",
      expectedEffect: { metric: "portfolioWinRate", direction: "increase" },
      evidenceRefs: [],
      provenance: { source: "learning", id: "learn_test" },
      status: "evaluating",
    };
    evaluateCandidate(sql, candidate, track, { window: SEPT }, T("01:00"));
    evaluateCandidate(sql, candidate, track, { window: OCT }, T("02:00"));
    const approval = requestPromotionApproval(sql, chainId, "operator", T("03:00"));
    expect(decidePromotionApproval(sql, approval.id, "approved", "operator", T("04:00"))).toBe(true);
    const verdict = runPromotionGate(sql, candidate, track, T("05:00"));
    expect(verdict.passed).toBe(true);
    expect(verdict.candidateId).toBe(chainId);
    // The shipped verdict store is the source of truth the module reads.
    expect(listGateVerdicts(sql, chainId)[0]?.passed).toBe(true);

    const chain = compileGoal("Create a NASDAQ100 screen and send it to Slack", {
      budgetCents: 5000,
      budgetCapCents: 10000,
    });
    if (!chain) throw new Error("test chain did not compile");
    const version = versionChain(chainId, chain, 1);
    const promoted = promoteChainVersion(version, sql);
    expect(promoted.stage).toBe("shadow");
    expect(promoted.gateVerdictId).toBe(verdict.id);
  });

  it("without any gate run, promotion refuses even though the subject exists", () => {
    const { sql } = makeFakeSql();
    const chain = compileGoal("Create a NASDAQ100 screen and send it to Slack", {
      budgetCents: 5000,
    });
    if (!chain) throw new Error("test chain did not compile");
    expect(() => promoteChainVersion(versionChain("chain-ungated", chain, 1), sql)).toThrow(
      /no passing promotion-gate verdict/,
    );
  });
});

describe("audit + kill delegate to shipped #755/#756 code (#1468)", () => {
  it("recordChainRunAudit writes a REAL #755 audit row readable via listAdaptationAudit", () => {
    const { sql } = makeFakeSql();
    const chain = compileGoal("Create a NASDAQ100 screen and send it to Slack", {
      budgetCents: 5000,
    });
    if (!chain) throw new Error("test chain did not compile");
    const version = versionChain("chain-nasdaq-slack", chain, 1);
    const attr = attributeChainRun(version, {
      goal: chain.goal,
      shardProvenance: ["shard-feed-1", "shard-generate-1"],
      outcome: "completed",
      runAt: "2026-10-26T06:00:00.000Z",
    });
    const auditId = recordChainRunAudit(sql, attr, new Date("2026-10-26T06:00:00.000Z"));
    expect(typeof auditId).toBe("string");
    const rows = listAdaptationAudit(sql, "chain-nasdaq-slack");
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(auditId);
    expect(rows[0].parameter).toBe("chain-version:1");
    expect(rows[0].status).toBe("applied");
    expect(rows[0].dataWindow).toBe("shard-feed-1,shard-generate-1");
    expect(rows[0].after).toContain("completed");
  });

  it("isGovernedHalted IS the shipped #756 switch: on halts, off/unknown does not", () => {
    const { sql, settings } = makeFakeSql();
    expect(isGovernedHalted(sql)).toBe(false);
    expect(isGovernedHalted(sql)).toBe(isAdaptationHalted(sql));
    settings.set("adaptation.killSwitch", "on");
    expect(isGovernedHalted(sql)).toBe(true);
    expect(isAdaptationHalted(sql)).toBe(true);
    settings.set("adaptation.killSwitch", "off");
    expect(isGovernedHalted(sql)).toBe(false);
  });
});
