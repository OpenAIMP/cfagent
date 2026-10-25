/**
 * Issue #759 (P2-5.3) — promotion gate pins.
 *
 * Promotion requires BOTH:
 *  1. Held-out significance: the candidate's effect re-proves on a
 *     window disjoint from every tuning evaluation (two-proportion
 *     z-test, one-sided α = 0.05, plus a minimum held-out sample);
 *  2. Human approval through the #653 decision pattern — a recorded
 *     decision on a pending approval row, made AFTER the held-out
 *     evaluation exists (the human approves evidence, not a hunch).
 *
 * A candidate failing either condition can never pass — the bypass
 * attempts below (overlap, stale approval, someone else's approval,
 * pending approval, direct lifecycle manipulation) must all fail.
 * Every verdict, pass or fail, is persisted with its reasons.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  generateImprovementCandidates,
  getImprovementCandidate,
  transitionCandidate,
  type CandidateProposal,
} from "../src/services/improvementCandidates";
import { evaluateCandidate } from "../src/services/candidateEvaluation";
import {
  requestPromotionApproval,
  decidePromotionApproval,
  runPromotionGate,
  listGateVerdicts,
  twoProportionZTest,
  GATE_POLICY,
} from "../src/services/promotionGate";
import type { TrackRecord, TrackRecordIdea } from "../src/services/researchTrackRecord";

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
  };
}

function buildTrack(months: Array<{ month: string; weakWins: number; fineWins: number }>): TrackRecord {
  const ideas: TrackRecordIdea[] = [];
  let n = 0;
  for (const m of months) {
    for (let i = 0; i < 20; i++) ideas.push(idea("Weak", i < m.weakWins, `${m.month}-05T00:00:00.000Z`, n++));
    for (let i = 0; i < 20; i++) ideas.push(idea("Fine", i < m.fineWins, `${m.month}-06T00:00:00.000Z`, n++));
  }
  const evaluated = ideas.length;
  const wins = ideas.filter((i) => (i.evaluation!.pnlEstimatePerUnit ?? 0) > 0).length;
  const slice = (key: string, w: number) => ({
    key,
    published: 40,
    evaluated: 40,
    winRate: w / 40,
    avgRMultiple: null,
  });
  const weakTotal = months.reduce((a, m) => a + m.weakWins, 0);
  const fineTotal = months.reduce((a, m) => a + m.fineWins, 0);
  return {
    published: evaluated,
    evaluated,
    invalidated: 0,
    winRate: wins / evaluated,
    directionAccuracy: null,
    avgPnlPerUnit: null,
    avgRMultiple: null,
    byStrategy: [slice("Weak", weakTotal), slice("Fine", fineTotal)],
    byPeriod: [],
    ideas,
  };
}

/** Weak poor in both months; Fine strong. Sept = tuning, Oct = held-out. */
const TRACK = buildTrack([
  { month: "2026-09", weakWins: 4, fineWins: 12 },
  { month: "2026-10", weakWins: 3, fineWins: 13 },
]);

function makeFakeSql() {
  const tables: Record<string, any[]> = {
    mas_improvement_candidates: [],
    mas_candidate_evaluations: [],
    mas_promotion_approvals: [],
    mas_promotion_gate_verdicts: [],
  };
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
      else if (tok.startsWith("'") && tok.endsWith("'")) row[c] = tok.slice(1, -1).replace(/''/g, "'");
      else if (tok.toUpperCase() === "NULL") row[c] = null;
      else if (!Number.isNaN(Number(tok))) row[c] = Number(tok);
      else row[c] = params[argIdx++];
    });
    rows.push(row);
  };
  const sql = {
    exec(text: string, ...params: any[]) {
      if (/^\s*CREATE/i.test(text)) return [];
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
        if (/status = \?/.test(text)) out = out.filter((r) => r.status === params[0]);
        if (/target = \?/.test(text)) out = out.filter((r) => r.target === params[params.length - 1]);
        if (/id = \?/.test(text)) out = out.filter((r) => r.id === params[0]);
        out.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
        return out.map((r) => ({ ...r }));
      }
      return [];
    },
  };
  return { sql, tables };
}

const T = (h: string) => new Date(`2026-10-21T${h}:00.000Z`);
const SEPT = { from: "2026-09-01", to: "2026-10-01" };
const OCT = { from: "2026-10-01", to: "2026-11-01" };

function gateOffFromGeneration(sql: any) {
  const gen = generateImprovementCandidates(sql, { track: TRACK }, T("00:00"));
  const cand = gen.created.find((c) => c.target === "strategy-gate:Weak");
  if (!cand) throw new Error("gate-off candidate was not generated");
  return cand;
}

function manualGateOff(sql: any, target = "strategy-gate:Weak") {
  const proposal: CandidateProposal = {
    target,
    change: { action: "disable-strategy", parameter: "enabled", from: true, to: false, description: "Disable." },
    hypothesis: "h",
    expectedEffect: { metric: "portfolioWinRate", direction: "increase" },
    evidenceRefs: ["manual:test"],
    provenance: { source: "learning", id: "learn_test" },
  };
  return generateImprovementCandidates(sql, { proposals: [proposal] }, T("00:00")).created[0];
}

describe("two-proportion z-test (#759)", () => {
  it("known values: 8/10 vs 2/10 is significant; equal rates give p = 0.5", () => {
    const sig = twoProportionZTest(8, 10, 2, 10);
    expect(sig.pOneSided).toBeGreaterThan(0.001);
    expect(sig.pOneSided).toBeLessThan(0.01);
    expect(twoProportionZTest(5, 10, 5, 10).pOneSided).toBeCloseTo(0.5, 3);
    expect(twoProportionZTest(0, 0, 0, 0).pOneSided).toBe(1);
  });
});

describe("the happy path: held-out significance + informed human approval (#759)", () => {
  it("passes only after both, moves the candidate to gated, and persists the verdict", () => {
    const { sql } = makeFakeSql();
    const cand = gateOffFromGeneration(sql);
    evaluateCandidate(sql, cand, TRACK, { window: SEPT }, T("01:00"));
    const heldOut = evaluateCandidate(sql, cand, TRACK, { window: OCT }, T("02:00"));
    expect(heldOut.sampleSize).toBe(40);

    const approval = requestPromotionApproval(sql, cand.id, "operator", T("02:30"));

    // Approval still pending → gate fails, candidate stays evaluating.
    const early = runPromotionGate(sql, getImprovementCandidate(sql, cand.id)!, TRACK, T("03:00"));
    expect(early.passed).toBe(false);
    expect(early.reasons.join(" ")).toMatch(/approval/i);
    expect(getImprovementCandidate(sql, cand.id)?.status).toBe("evaluating");

    expect(decidePromotionApproval(sql, approval.id, "approved", "operator", T("03:30"))).toBe(true);

    const verdict = runPromotionGate(sql, getImprovementCandidate(sql, cand.id)!, TRACK, T("04:00"));
    expect(verdict.passed).toBe(true);
    expect(verdict.heldOutEvaluationId).toBe(heldOut.id);
    expect(verdict.pValue).not.toBeNull();
    expect(verdict.pValue!).toBeLessThan(GATE_POLICY.alpha);
    expect(getImprovementCandidate(sql, cand.id)?.status).toBe("gated");
    expect(listGateVerdicts(sql, cand.id).length).toBeGreaterThanOrEqual(2); // fail + pass both persisted
  });
});

describe("bypass attempts must all fail (#759)", () => {
  it("an overlapping held-out window fails even with approval", () => {
    const { sql } = makeFakeSql();
    const cand = manualGateOff(sql);
    evaluateCandidate(sql, cand, TRACK, { window: SEPT }, T("01:00"));
    evaluateCandidate(sql, cand, TRACK, { window: { from: "2026-09-15", to: "2026-10-15" } }, T("02:00"));
    const approval = requestPromotionApproval(sql, cand.id, "operator", T("02:30"));
    decidePromotionApproval(sql, approval.id, "approved", "operator", T("03:00"));
    const verdict = runPromotionGate(sql, getImprovementCandidate(sql, cand.id)!, TRACK, T("04:00"));
    expect(verdict.passed).toBe(false);
    expect(verdict.reasons.join(" ")).toMatch(/overlap|disjoint/i);
    expect(getImprovementCandidate(sql, cand.id)?.status).toBe("evaluating");
  });

  it("an insignificant held-out effect fails even with approval", () => {
    const { sql } = makeFakeSql();
    // Weak recovers in October (12/20) — nearly Fine's 13/20.
    const recovered = buildTrack([
      { month: "2026-09", weakWins: 4, fineWins: 12 },
      { month: "2026-10", weakWins: 12, fineWins: 13 },
    ]);
    const cand = manualGateOff(sql);
    evaluateCandidate(sql, cand, recovered, { window: SEPT }, T("01:00"));
    evaluateCandidate(sql, cand, recovered, { window: OCT }, T("02:00"));
    const approval = requestPromotionApproval(sql, cand.id, "operator", T("02:30"));
    decidePromotionApproval(sql, approval.id, "approved", "operator", T("03:00"));
    const verdict = runPromotionGate(sql, getImprovementCandidate(sql, cand.id)!, recovered, T("04:00"));
    expect(verdict.passed).toBe(false);
    expect(verdict.reasons.join(" ")).toMatch(/significan/i);
  });

  it("an approval decided BEFORE the held-out evaluation does not count", () => {
    const { sql } = makeFakeSql();
    const cand = manualGateOff(sql);
    evaluateCandidate(sql, cand, TRACK, { window: SEPT }, T("01:00"));
    const approval = requestPromotionApproval(sql, cand.id, "operator", T("01:15"));
    decidePromotionApproval(sql, approval.id, "approved", "operator", T("01:30")); // before held-out exists
    evaluateCandidate(sql, cand, TRACK, { window: OCT }, T("02:00"));
    const verdict = runPromotionGate(sql, getImprovementCandidate(sql, cand.id)!, TRACK, T("03:00"));
    expect(verdict.passed).toBe(false);
    expect(verdict.reasons.join(" ")).toMatch(/approval/i);
  });

  it("someone else's approval does not count; direct lifecycle jumps are refused", () => {
    const { sql } = makeFakeSql();
    const cand = manualGateOff(sql);
    const other = manualGateOff(sql, "strategy-gate:Fine");
    evaluateCandidate(sql, cand, TRACK, { window: SEPT }, T("01:00"));
    evaluateCandidate(sql, cand, TRACK, { window: OCT }, T("02:00"));
    const othersApproval = requestPromotionApproval(sql, other.id, "operator", T("02:30"));
    decidePromotionApproval(sql, othersApproval.id, "approved", "operator", T("03:00"));
    const verdict = runPromotionGate(sql, getImprovementCandidate(sql, cand.id)!, TRACK, T("04:00"));
    expect(verdict.passed).toBe(false);
    expect(verdict.reasons.join(" ")).toMatch(/approval/i);
    // Direct manipulation: evaluating → promoted is not a legal move.
    expect(transitionCandidate(sql, cand.id, "promoted", T("04:30"))).toBe(false);
    expect(getImprovementCandidate(sql, cand.id)?.status).toBe("evaluating");
  });

  it("the gate is the only code path that transitions a candidate to gated", () => {
    const files = [
      "src/services/promotionGate.ts",
      "src/services/improvementCandidates.ts",
      "src/services/candidateEvaluation.ts",
      "src/services/strategyWeights.ts",
      "src/services/reflection.ts",
      "src/agents/routes/screenerResearch.ts",
    ];
    for (const f of files) {
      const src = readFileSync(join(process.cwd(), f), "utf8");
      const calls = src.match(/transitionCandidate\([^;]*?"gated"/g) ?? [];
      if (f.endsWith("promotionGate.ts")) expect(calls.length).toBeGreaterThanOrEqual(1);
      else expect(calls).toEqual([]);
    }
  });
});
