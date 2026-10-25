/**
 * Issue #757 (P2-5.1) — improvement candidate generation pins.
 *
 * Phase 5 starts here: reflection findings (#705), learnings (#706),
 * and track-record anomalies (#340) become STRUCTURED, falsifiable
 * candidate changes — target, exact change, hypothesis, expected
 * effect + metric, evidence refs, provenance — queued for evaluation
 * (#758). Nothing here applies anything: the only path from a
 * candidate to production is #758 → #759 → #760.
 *
 * Generator rules pinned:
 *  - R1 (track record): a strategy with >= 20 evaluated ideas and
 *    winRate <= 0.25 yields a gate-off candidate.
 *  - R2 (track record): a strategy with >= 40 evaluated ideas beating
 *    the overall win rate by >= 0.20 yields a weight-cap-raise
 *    candidate (a BOUNDS change — deliberately not #754's path).
 *  - R3 (reflection): the overall-approval-rate diagnostic finding
 *    yields a quant-filter candidate. Family boost/down-weight
 *    findings do NOT (owned by #753 review + #754 weights).
 *  - R4 (learnings): a human learning carrying a "Proposed:" segment
 *    becomes a candidate with provenance preserved.
 *  - Dedup: an identical open candidate (same target + action) is not
 *    duplicated. Supersede: a different change for the same target
 *    supersedes the open one, linked via supersedesId.
 *  - Lifecycle transitions are explicit and guarded.
 */
import { describe, it, expect } from "vitest";
import {
  generateImprovementCandidates,
  listImprovementCandidates,
  transitionCandidate,
  type CandidateProposal,
} from "../src/services/improvementCandidates";
import type { TrackRecord } from "../src/services/researchTrackRecord";
import type { Learning } from "../src/services/learnings";
import type { ReflectionFinding } from "../src/services/reflection";

function makeFakeSql() {
  const candidates: any[] = [];
  const sql = {
    exec(text: string, ...params: any[]) {
      if (/^\s*CREATE/i.test(text)) return [];
      if (/INSERT INTO mas_improvement_candidates/i.test(text)) {
        const cols = /\(([^)]+)\)\s*VALUES/i.exec(text)![1].split(",").map((c) => c.trim());
        // Literal-aware value mapping (mock-sql #669 discipline): a
        // quoted literal occupies its column without consuming a param.
        const valuesPart = /VALUES\s*\((.*)\)\s*$/is.exec(text)![1];
        const tokens: string[] = [];
        {
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
        }
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
        candidates.push(row);
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
  return { sql, candidates };
}

function track(byStrategy: Array<{ key: string; evaluated: number; winRate: number | null }>): TrackRecord {
  const evaluated = byStrategy.reduce((n, s) => n + s.evaluated, 0);
  const hits = byStrategy.reduce((n, s) => n + (s.winRate ?? 0) * s.evaluated, 0);
  return {
    published: evaluated, evaluated, invalidated: 0,
    winRate: evaluated > 0 ? hits / evaluated : null,
    directionAccuracy: null, avgPnlPerUnit: null, avgRMultiple: null,
    byStrategy: byStrategy.map((s) => ({ published: s.evaluated, avgRMultiple: null, ...s })),
    byPeriod: [], ideas: [],
  };
}

const NOW = new Date("2026-10-21T12:00:00.000Z");

describe("track-record generators (#757)", () => {
  it("R1: a persistently poor strategy yields a structured gate-off candidate", () => {
    const { sql } = makeFakeSql();
    const out = generateImprovementCandidates(sql, {
      track: track([
        { key: "WeakStrategy", evaluated: 30, winRate: 0.2 },
        { key: "FineStrategy", evaluated: 30, winRate: 0.55 },
      ]),
    }, NOW);
    expect(out.created).toHaveLength(1);
    const c = out.created[0];
    expect(c.target).toBe("strategy-gate:WeakStrategy");
    expect(c.change.action).toBe("disable-strategy");
    expect(c.hypothesis).toMatch(/WeakStrategy/);
    expect(c.expectedEffect.metric).toBe("portfolioWinRate");
    expect(c.expectedEffect.direction).toBe("increase");
    expect(c.evidenceRefs.join(" ")).toMatch(/winRate:0\.20/);
    expect(c.provenance.source).toBe("track-record");
    expect(c.status).toBe("queued");
  });

  it("R1 does not fire above the win-rate floor or below the sample floor", () => {
    const { sql } = makeFakeSql();
    const out = generateImprovementCandidates(sql, {
      track: track([
        { key: "Mediocre", evaluated: 30, winRate: 0.3 },
        { key: "TinySample", evaluated: 19, winRate: 0.1 },
      ]),
    }, NOW);
    expect(out.created).toHaveLength(0);
  });

  it("R2: a persistent outperformer yields a weight-cap-raise candidate (a bounds change)", () => {
    const { sql } = makeFakeSql();
    const out = generateImprovementCandidates(sql, {
      track: track([
        { key: "StarStrategy", evaluated: 45, winRate: 0.85 },
        { key: "Average", evaluated: 45, winRate: 0.35 },
      ]),
    }, NOW);
    const c = out.created.find((x) => x.target === "strategy-weight-cap:StarStrategy");
    expect(c).toBeTruthy();
    expect(c?.change.action).toBe("raise-weight-cap");
    expect(c?.change.from).toBe(2.0);
    expect(c?.change.to).toBe(2.5);
    expect(c?.expectedEffect.metric).toBe("weightedWinRate");
  });
});

describe("reflection + learnings generators (#757)", () => {
  it("R3: the approval-rate diagnostic becomes a quant-filter candidate; family findings do not", () => {
    const { sql } = makeFakeSql();
    const findings: ReflectionFinding[] = [
      {
        domain: "strategy_ranking",
        observation: "Overall approval rate 20% across 12 reviewed candidates — the quant pipeline may be misaligned with human judgment.",
        evidenceRefs: ["mas_strategy_reviews:all"],
        confidence: 0.7,
        proposedAdjustment: "Review quant pipeline filters against rejected candidate characteristics.",
      },
      {
        domain: "strategy_ranking",
        observation: 'Strategy family "Momentum" approved 4/5 times.',
        evidenceRefs: ["mas_strategy_reviews:Momentum"],
        confidence: 0.9,
        proposedAdjustment: 'Boost "Momentum" in LLM ranking priors.',
      },
    ];
    const out = generateImprovementCandidates(sql, { findings }, NOW);
    expect(out.created).toHaveLength(1);
    expect(out.created[0].target).toBe("quant-pipeline:filters");
    expect(out.created[0].expectedEffect.metric).toBe("approvalRate");
    expect(out.created[0].provenance.source).toBe("reflection");
  });

  it("R4: a human learning with a proposal becomes a candidate, provenance preserved", () => {
    const { sql } = makeFakeSql();
    const learnings: Learning[] = [
      {
        id: "learn_h1", domain: "screener", confidence: 0.8, source: "human",
        observation: "Tight screens before earnings outperform. Proposed: add an earnings-proximity exclusion to the screener gate.",
        evidenceRefs: ["mas_runs:2026-10"], createdAt: NOW.toISOString(), supersededBy: null,
      },
      {
        id: "learn_m1", domain: "screener", confidence: 0.5, source: "reflection",
        observation: "A machine note with no proposal segment.",
        evidenceRefs: [], createdAt: NOW.toISOString(), supersededBy: null,
      },
    ];
    const out = generateImprovementCandidates(sql, { learnings }, NOW);
    expect(out.created).toHaveLength(1);
    expect(out.created[0].provenance).toEqual({ source: "learning", id: "learn_h1" });
    expect(out.created[0].change.description).toMatch(/earnings-proximity exclusion/);
  });
});

describe("dedup + supersede (#757)", () => {
  it("an identical open candidate is not duplicated", () => {
    const { sql } = makeFakeSql();
    const input = { track: track([{ key: "WeakStrategy", evaluated: 30, winRate: 0.2 }, { key: "Fine", evaluated: 30, winRate: 0.55 }]) };
    const first = generateImprovementCandidates(sql, input, NOW);
    expect(first.created).toHaveLength(1);
    const second = generateImprovementCandidates(sql, input, NOW);
    expect(second.created).toHaveLength(0);
    expect(second.deduped).toHaveLength(1);
    expect(listImprovementCandidates(sql)).toHaveLength(1);
  });

  it("a different change for the same target supersedes the open candidate", () => {
    const { sql, candidates } = makeFakeSql();
    // Pre-seed an open candidate for the R1 target with a different action.
    const seed: CandidateProposal = {
      target: "strategy-gate:WeakStrategy",
      change: { action: "reduce-size", description: "Halve position sizing for WeakStrategy." },
      hypothesis: "Smaller size limits the drag.",
      expectedEffect: { metric: "portfolioWinRate", direction: "increase" },
      evidenceRefs: ["manual:seed"],
      provenance: { source: "learning", id: "learn_seed" },
    };
    generateImprovementCandidates(sql, { proposals: [seed] }, NOW);
    const out = generateImprovementCandidates(sql, {
      track: track([{ key: "WeakStrategy", evaluated: 30, winRate: 0.2 }, { key: "Fine", evaluated: 30, winRate: 0.55 }]),
    }, NOW);
    expect(out.superseded).toHaveLength(1);
    expect(out.created).toHaveLength(1);
    expect(out.created[0].supersedesId).toBe(out.superseded[0]);
    const rows = listImprovementCandidates(sql);
    expect(rows.find((r) => r.id === out.superseded[0])?.status).toBe("superseded");
    expect(candidates).toHaveLength(2);
  });
});

describe("candidate lifecycle (#757)", () => {
  it("transitions follow the guarded map; terminal states do not move", () => {
    const { sql } = makeFakeSql();
    const out = generateImprovementCandidates(sql, {
      track: track([{ key: "WeakStrategy", evaluated: 30, winRate: 0.2 }, { key: "Fine", evaluated: 30, winRate: 0.55 }]),
    }, NOW);
    const id = out.created[0].id;
    expect(transitionCandidate(sql, id, "promoted", NOW)).toBe(false); // must pass through evaluating + gated
    expect(transitionCandidate(sql, id, "evaluating", NOW)).toBe(true);
    expect(transitionCandidate(sql, id, "gated", NOW)).toBe(true);
    expect(transitionCandidate(sql, id, "promoted", NOW)).toBe(true);
    expect(transitionCandidate(sql, id, "evaluating", NOW)).toBe(false); // promoted is terminal here
    expect(listImprovementCandidates(sql, "promoted")).toHaveLength(1);
  });
});
