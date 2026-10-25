/**
 * Issue #758 (P2-5.2) — isolated evaluation harness pins.
 *
 * Queued candidates (#757) are evaluated here against recorded data
 * (counterfactual replay over the research track record) — never
 * against live state. The harness reports the measured effect versus
 * the live baseline with sample sizes, supports window splits (the
 * held-out mechanics #759's gate consumes), and is deterministic:
 * identical inputs produce identical reports.
 *
 * The boundary is the point of the issue and is pinned three ways:
 *  1. The harness module's source contains no live-write surface (no
 *     applyAdaptation / recordAdaptation / strategy-weight writes).
 *  2. Behaviorally, an evaluation run issues no writes to the live
 *     adaptation tables (statement log assertion).
 *  3. Evaluation only moves the candidate's own lifecycle state
 *     (queued → evaluating) and writes its own report table.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  replayCandidate,
  evaluateCandidate,
  listEvaluations,
} from "../src/services/candidateEvaluation";
import {
  generateImprovementCandidates,
  getImprovementCandidate,
  type ImprovementCandidate,
} from "../src/services/improvementCandidates";
import type { TrackRecord, TrackRecordIdea } from "../src/services/researchTrackRecord";

function idea(structure: string, pnl: number | null, createdAt: string, n: number): TrackRecordIdea {
  return {
    runId: `run_${createdAt.slice(0, 7)}`,
    runCreatedAt: createdAt,
    symbol: `SYM${n}`,
    structure,
    outlook: "bullish",
    thesis: "t",
    invalidation: "",
    entrySpot: 100,
    evaluation:
      pnl === null
        ? null
        : {
            evaluatedAt: createdAt,
            invalidated: false,
            pnlEstimatePerUnit: pnl,
            rMultiple: null,
            evalSpot: 101,
            directionCorrect: pnl > 0,
            notes: [],
          },
  };
}

function trackOf(ideas: TrackRecordIdea[]): TrackRecord {
  const evaluated = ideas.filter((i) => i.evaluation != null);
  return {
    published: ideas.length,
    evaluated: evaluated.length,
    invalidated: 0,
    winRate:
      evaluated.length > 0
        ? evaluated.filter((i) => (i.evaluation!.pnlEstimatePerUnit ?? 0) > 0).length / evaluated.length
        : null,
    directionAccuracy: null,
    avgPnlPerUnit: null,
    avgRMultiple: null,
    byStrategy: [],
    byPeriod: [],
    ideas,
  };
}

/** Weak: 20 evaluated, 4 wins (0.20). Fine: 20 evaluated, 12 wins (0.60). */
function mixedTrack(): TrackRecord {
  const ideas: TrackRecordIdea[] = [];
  for (let i = 0; i < 20; i++) ideas.push(idea("Weak", i < 4 ? 1 : -1, "2026-09-01T00:00:00.000Z", i));
  for (let i = 0; i < 20; i++) ideas.push(idea("Fine", i < 12 ? 1 : -1, "2026-09-02T00:00:00.000Z", 100 + i));
  return trackOf(ideas);
}

function gateOffCandidate(): ImprovementCandidate {
  return {
    id: "cand_test_gateoff",
    target: "strategy-gate:Weak",
    change: { action: "disable-strategy", parameter: "enabled", from: true, to: false, description: "Disable Weak." },
    hypothesis: "Weak drags the portfolio.",
    expectedEffect: { metric: "portfolioWinRate", direction: "increase" },
    evidenceRefs: ["track-record:Weak"],
    provenance: { source: "track-record", id: "Weak" },
    status: "queued",
    supersedesId: null,
    createdAt: "2026-10-21T00:00:00.000Z",
    updatedAt: "2026-10-21T00:00:00.000Z",
  };
}

describe("replay core (#758)", () => {
  it("gate-off replay: baseline vs counterfactual win rate with sample sizes", () => {
    const r = replayCandidate(gateOffCandidate(), mixedTrack(), {});
    expect(r.method).toBe("counterfactual-replay");
    expect(r.baselineMetric).toBeCloseTo(0.4, 10); // 16/40
    expect(r.candidateMetric).toBeCloseTo(0.6, 10); // 12/20 without Weak
    expect(r.delta).toBeCloseTo(0.2, 10);
    expect(r.sampleSize).toBe(40);
    expect(r.detail.excludedCount).toBe(20);
  });

  it("weight-cap replay evaluates the target-at-cap scenario", () => {
    const cand: ImprovementCandidate = {
      ...gateOffCandidate(),
      id: "cand_test_cap",
      target: "strategy-weight-cap:Fine",
      change: { action: "raise-weight-cap", parameter: "weightCap", from: 2.0, to: 2.5, description: "Raise Fine cap." },
      expectedEffect: { metric: "weightedWinRate", direction: "increase" },
    };
    // Fine stored at the 2.0 cap; Weak at 1.0. At cap 2.5, Fine's wins weigh more.
    const r = replayCandidate(cand, mixedTrack(), { weights: { Fine: 2.0, Weak: 1.0 } });
    expect(r.method).toBe("counterfactual-replay");
    // baseline: (2*12 + 1*4) / (2*20 + 1*20) = 28/60
    expect(r.baselineMetric).toBeCloseTo(28 / 60, 10);
    // candidate: (2.5*12 + 1*4) / (2.5*20 + 1*20) = 34/70
    expect(r.candidateMetric).toBeCloseTo(34 / 70, 10);
    expect(r.detail.scenario).toBe("target-at-cap");
  });

  it("window splits restrict the replay to the requested period (held-out mechanics)", () => {
    const ideas: TrackRecordIdea[] = [];
    // September: Weak terrible. October: Weak fine — a windowed replay must see the difference.
    for (let i = 0; i < 10; i++) ideas.push(idea("Weak", -1, "2026-09-05T00:00:00.000Z", i));
    for (let i = 0; i < 10; i++) ideas.push(idea("Weak", 1, "2026-10-05T00:00:00.000Z", 100 + i));
    const track = trackOf(ideas);
    const sept = replayCandidate(gateOffCandidate(), track, { window: { from: "2026-09-01", to: "2026-10-01" } });
    expect(sept.sampleSize).toBe(10);
    expect(sept.baselineMetric).toBe(0);
    expect(sept.candidateMetric).toBeNull(); // nothing remains after exclusion
    const oct = replayCandidate(gateOffCandidate(), track, { window: { from: "2026-10-01" } });
    expect(oct.baselineMetric).toBe(1);
  });

  it("unsupported change classes report honestly instead of fabricating an effect", () => {
    const cand: ImprovementCandidate = {
      ...gateOffCandidate(),
      id: "cand_test_filters",
      target: "quant-pipeline:filters",
      change: { action: "tighten-quant-filters", parameter: "minQuantScore", description: "Tighten." },
      expectedEffect: { metric: "approvalRate", direction: "increase" },
    };
    const r = replayCandidate(cand, mixedTrack(), {});
    expect(r.method).toBe("unsupported");
    expect(r.candidateMetric).toBeNull();
    expect(r.delta).toBeNull();
    expect(String(r.detail.reason)).toMatch(/no replay/i);
  });

  it("determinism: identical inputs produce identical reports", () => {
    const a = replayCandidate(gateOffCandidate(), mixedTrack(), { weights: { Weak: 1.1 } });
    const b = replayCandidate(gateOffCandidate(), mixedTrack(), { weights: { Weak: 1.1 } });
    expect(a).toEqual(b);
  });
});

// --- persistence + boundary, over a statement-logging fake ---

function makeFakeSql() {
  const candidates: any[] = [];
  const evaluations: any[] = [];
  const statements: string[] = [];
  const literalAwareInsert = (table: any[], text: string, params: any[]) => {
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
    table.push(row);
  };
  const sql = {
    exec(text: string, ...params: any[]) {
      statements.push(text);
      if (/^\s*CREATE/i.test(text)) return [];
      if (/INSERT INTO mas_improvement_candidates/i.test(text)) {
        literalAwareInsert(candidates, text, params);
        return [];
      }
      if (/INSERT INTO mas_candidate_evaluations/i.test(text)) {
        literalAwareInsert(evaluations, text, params);
        return [];
      }
      if (/UPDATE mas_improvement_candidates/i.test(text)) {
        const [status, updated_at, id, fromStatus] = params;
        const row = candidates.find((r) => r.id === id && r.status === fromStatus);
        if (row) {
          row.status = status;
          row.updated_at = updated_at;
          return { changes: 1 };
        }
        return { changes: 0 };
      }
      if (/FROM mas_candidate_evaluations/i.test(text)) {
        return evaluations.filter((r) => r.candidate_id === params[0]).map((r) => ({ ...r }));
      }
      if (/FROM mas_improvement_candidates/i.test(text)) {
        let rows = [...candidates];
        if (/status = \?/.test(text)) rows = rows.filter((r) => r.status === params[0]);
        if (/target = \?/.test(text)) rows = rows.filter((r) => r.target === params[params.length - 1]);
        if (/id = \?/.test(text)) rows = rows.filter((r) => r.id === params[0]);
        rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
        return rows.map((r) => ({ ...r }));
      }
      return [];
    },
  };
  return { sql, candidates, evaluations, statements };
}

const NOW = new Date("2026-10-21T12:00:00.000Z");

describe("evaluateCandidate: persistence + lifecycle (#758)", () => {
  it("persists a report and moves the candidate queued → evaluating", () => {
    const { sql } = makeFakeSql();
    const gen = generateImprovementCandidates(sql, {
      track: {
        ...mixedTrack(),
        byStrategy: [
          { key: "Weak", published: 20, evaluated: 20, winRate: 0.2, avgRMultiple: null },
          { key: "Fine", published: 20, evaluated: 20, winRate: 0.6, avgRMultiple: null },
        ],
        winRate: 0.4,
      },
    }, NOW);
    const cand = gen.created.find((c) => c.target === "strategy-gate:Weak")!;
    expect(cand).toBeTruthy();
    const report = evaluateCandidate(sql, cand, mixedTrack(), {}, NOW);
    expect(report.candidateMetric).toBeCloseTo(0.6, 10);
    expect(getImprovementCandidate(sql, cand.id)?.status).toBe("evaluating");
    const stored = listEvaluations(sql, cand.id);
    expect(stored).toHaveLength(1);
    expect(stored[0].delta).toBeCloseTo(0.2, 10);
  });
});

describe("the cannot-touch-live boundary (#758)", () => {
  it("an evaluation run issues no writes to live adaptation state", () => {
    const { sql, statements } = makeFakeSql();
    const gen = generateImprovementCandidates(sql, {
      track: {
        ...mixedTrack(),
        byStrategy: [{ key: "Weak", published: 20, evaluated: 20, winRate: 0.2, avgRMultiple: null }],
        winRate: 0.4,
      },
    }, NOW);
    statements.length = 0; // only the evaluation run is under test
    evaluateCandidate(sql, gen.created[0], mixedTrack(), {}, NOW);
    const liveWrites = statements.filter((s) =>
      /INSERT INTO mas_strategy_weights|UPDATE mas_strategy_weights|INSERT INTO mas_adaptation_audit|DELETE FROM mas_strategy_weights/i.test(s)
    );
    expect(liveWrites).toEqual([]);
  });

  it("the harness module source carries no live-application surface", () => {
    const src = readFileSync(join(process.cwd(), "src/services/candidateEvaluation.ts"), "utf8");
    expect(src).not.toMatch(/applyAdaptation|recordAdaptation|setStrategyWeight/);
    expect(src).not.toMatch(/INSERT INTO mas_strategy_weights|INSERT INTO mas_adaptation_audit/);
  });
});
