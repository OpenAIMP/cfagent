/**
 * Issue #760 (P2-5.4) — staged promotion + automatic rollback pins.
 *
 * A gated candidate (#759 verdict required) is promoted stepwise —
 * shadow (record only) → partial (halfway application) → full —
 * each application through the #755 audited seam, each stage
 * time-boxed, each advance preceded by a regression check against
 * the pre-promotion baseline. Regression rolls the change back
 * automatically and restores production state EXACTLY to the
 * pre-promotion snapshot; the incident is in the #755 audit trail.
 *
 * The drill: promote → regress → rollback, asserting exact restore.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  generateImprovementCandidates,
  getImprovementCandidate,
  transitionCandidate,
  type CandidateProposal,
} from "../src/services/improvementCandidates";
import {
  startPromotion,
  advancePromotion,
  getPromotion,
  listPromotions,
} from "../src/services/stagedPromotion";
import {
  getStrategyWeightCap,
  isStrategyGatedOff,
} from "../src/services/strategyPolicyState";
import {
  getStrategyWeights,
  proposeWeightAdjustments,
  runStrategyWeightAdjustment,
} from "../src/services/strategyWeights";
import type { TrackRecord, TrackRecordIdea } from "../src/services/researchTrackRecord";

// --- fake sql: #754-style maps + literal-aware rows for the new tables ---

function makeFakeSql() {
  const audit: any[] = [];
  const weights = new Map<string, { weight: number; updated_at: string }>();
  const caps = new Map<string, { cap: number; updated_at: string }>();
  const gates = new Map<string, { gated_off: number; updated_at: string }>();
  const settings = new Map<string, string>();
  const candidates: any[] = [];
  const verdicts: any[] = [];
  const promotions: any[] = [];

  const literalInsert = (rows: any[], text: string, params: any[]) => {
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
      if (/INSERT OR REPLACE INTO mas_strategy_weights|INSERT INTO mas_strategy_weights/i.test(text)) {
        weights.set(params[0], { weight: params[1], updated_at: params[2] });
        return [];
      }
      if (/DELETE FROM mas_strategy_weights/i.test(text)) {
        weights.delete(params[0]);
        return { changes: 1 };
      }
      if (/FROM mas_strategy_weights/i.test(text)) {
        if (/WHERE strategy = \?/.test(text)) {
          const w = weights.get(params[0]);
          return w ? [{ strategy: params[0], ...w }] : [];
        }
        return [...weights.entries()].map(([strategy, w]) => ({ strategy, ...w }));
      }
      if (/INSERT OR REPLACE INTO mas_strategy_weight_caps|INSERT INTO mas_strategy_weight_caps/i.test(text)) {
        caps.set(params[0], { cap: params[1], updated_at: params[2] });
        return [];
      }
      if (/DELETE FROM mas_strategy_weight_caps/i.test(text)) {
        caps.delete(params[0]);
        return { changes: 1 };
      }
      if (/FROM mas_strategy_weight_caps/i.test(text)) {
        if (/WHERE strategy = \?/.test(text)) {
          const c = caps.get(params[0]);
          return c ? [{ strategy: params[0], ...c }] : [];
        }
        return [...caps.entries()].map(([strategy, c]) => ({ strategy, ...c }));
      }
      if (/INSERT OR REPLACE INTO mas_strategy_gates|INSERT INTO mas_strategy_gates/i.test(text)) {
        gates.set(params[0], { gated_off: params[1], updated_at: params[2] });
        return [];
      }
      if (/DELETE FROM mas_strategy_gates/i.test(text)) {
        gates.delete(params[0]);
        return { changes: 1 };
      }
      if (/FROM mas_strategy_gates/i.test(text)) {
        if (/WHERE strategy = \?/.test(text)) {
          const g = gates.get(params[0]);
          return g ? [{ strategy: params[0], ...g }] : [];
        }
        return [...gates.entries()].map(([strategy, g]) => ({ strategy, ...g }));
      }
      if (/FROM mas_settings/i.test(text)) {
        const v = settings.get(params[0]);
        return v === undefined ? [] : [{ value: v }];
      }
      if (/INSERT INTO mas_settings|INSERT OR REPLACE INTO mas_settings/i.test(text)) {
        settings.set(params[0], params[1]);
        return [];
      }
      if (/INSERT INTO mas_improvement_candidates/i.test(text)) {
        literalInsert(candidates, text, params);
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
        if (/\bid = \?/.test(text)) rows = rows.filter((r) => r.id === params[0]);
        rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
        return rows.map((r) => ({ ...r }));
      }
      if (/INSERT INTO mas_promotion_gate_verdicts/i.test(text)) {
        literalInsert(verdicts, text, params);
        return [];
      }
      if (/FROM mas_promotion_gate_verdicts/i.test(text)) {
        return verdicts
          .filter((r) => r.candidate_id === params[0])
          .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
          .map((r) => ({ ...r }));
      }
      if (/INSERT INTO mas_promotions/i.test(text)) {
        literalInsert(promotions, text, params);
        return [];
      }
      if (/UPDATE mas_promotions/i.test(text)) {
        const [stage, stage_started_at, applied_json, last_check_json, id] = params;
        const row = promotions.find((r) => r.id === id);
        if (row) {
          row.stage = stage;
          row.stage_started_at = stage_started_at;
          row.applied_json = applied_json;
          row.last_check_json = last_check_json;
          return { changes: 1 };
        }
        return { changes: 0 };
      }
      if (/FROM mas_promotions/i.test(text)) {
        let rows = [...promotions];
        if (/candidate_id = \?/.test(text)) rows = rows.filter((r) => r.candidate_id === params[params.length - 1]);
        if (/\bid = \?/.test(text)) rows = rows.filter((r) => r.id === params[0]);
        rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
        return rows.map((r) => ({ ...r }));
      }
      return [];
    },
  };
  return { sql, audit, weights, caps, gates, settings, candidates, verdicts, promotions };
}

// --- fixtures ---

function idea(structure: string, win: boolean, createdAt: string, n: number): TrackRecordIdea {
  return {
    runId: `run_${n}`,
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

function trackOf(ideas: TrackRecordIdea[]): TrackRecord {
  const wins = ideas.filter((i) => (i.evaluation!.pnlEstimatePerUnit ?? 0) > 0).length;
  const byKey = new Map<string, { n: number; w: number }>();
  for (const i of ideas) {
    const e = byKey.get(i.structure) ?? { n: 0, w: 0 };
    e.n++;
    if ((i.evaluation!.pnlEstimatePerUnit ?? 0) > 0) e.w++;
    byKey.set(i.structure, e);
  }
  return {
    published: ideas.length,
    evaluated: ideas.length,
    invalidated: 0,
    winRate: ideas.length ? wins / ideas.length : null,
    directionAccuracy: null,
    avgPnlPerUnit: null,
    avgRMultiple: null,
    byStrategy: [...byKey.entries()].map(([key, v]) => ({
      key,
      published: v.n,
      evaluated: v.n,
      winRate: v.n ? v.w / v.n : null,
      avgRMultiple: null,
    })),
    byPeriod: [],
    ideas,
  };
}

/** Baseline ideas, all dated before promotion starts (2026-10-21). */
function baselineIdeas(): TrackRecordIdea[] {
  const ideas: TrackRecordIdea[] = [];
  for (let i = 0; i < 20; i++) ideas.push(idea("Weak", i < 4, "2026-09-05T00:00:00.000Z", i));
  for (let i = 0; i < 20; i++) ideas.push(idea("Fine", i < 12, "2026-09-06T00:00:00.000Z", 100 + i));
  return ideas;
}

const T0 = new Date("2026-10-21T00:00:00.000Z");
const NO_BOX = { shadowMs: 0, partialMs: 0, fullMs: 0 };

function gatedCandidate(sql: any, proposal: CandidateProposal, withVerdict = true) {
  const cand = generateImprovementCandidates(sql, { proposals: [proposal] }, T0).created[0];
  transitionCandidate(sql, cand.id, "evaluating", T0);
  transitionCandidate(sql, cand.id, "gated", T0);
  if (withVerdict) {
    sql.exec(
      `INSERT INTO mas_promotion_gate_verdicts (id, candidate_id, passed, reasons_json, heldout_evaluation_id, z, p_value, approval_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      `verdict_${cand.id}`,
      cand.id,
      1,
      "[]",
      "eval_heldout",
      3.1,
      0.001,
      "appr_1",
      T0.toISOString()
    );
  }
  return getImprovementCandidate(sql, cand.id)!;
}

const GATE_OFF: CandidateProposal = {
  target: "strategy-gate:Weak",
  change: { action: "disable-strategy", parameter: "enabled", from: true, to: false, description: "Disable Weak." },
  hypothesis: "Weak drags the portfolio.",
  expectedEffect: { metric: "portfolioWinRate", direction: "increase" },
  evidenceRefs: ["track-record:Weak"],
  provenance: { source: "track-record", id: "Weak" },
};

let errSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  errSpy.mockRestore();
});

describe("the drill: promote → regress → rollback restores exactly (#760)", () => {
  it("gate-off: shadow changes nothing, partial halves the distance, full gates off, regression restores the snapshot", () => {
    const { sql, audit, weights } = makeFakeSql();
    weights.set("Weak", { weight: 1.4, updated_at: "2026-10-01T00:00:00.000Z" });
    weights.set("Fine", { weight: 1.0, updated_at: "2026-10-01T00:00:00.000Z" });
    const cand = gatedCandidate(sql, GATE_OFF);
    const baseline = trackOf(baselineIdeas());
    expect(baseline.winRate).toBeCloseTo(0.4, 10);

    const started = startPromotion(sql, cand, baseline, { now: T0 });
    expect(started.ok).toBe(true);
    const promotion = started.promotion!;
    expect(promotion.stage).toBe("shadow");
    expect(getStrategyWeights(sql)).toEqual({ Weak: 1.4, Fine: 1.0 }); // shadow applies nothing

    const toPartial = advancePromotion(sql, promotion.id, baseline, { now: new Date("2026-10-21T01:00:00.000Z"), stageDurationsMs: NO_BOX });
    expect(toPartial.ok).toBe(true);
    expect(toPartial.promotion?.stage).toBe("partial");
    expect(getStrategyWeights(sql).Weak).toBeCloseTo(0.825, 10); // midpoint of 1.4 and the 0.25 floor
    expect(audit.some((a) => a.actor === "staged-promotion" && a.status === "applied")).toBe(true);

    // Healthy post-partial-stage data (12 ideas after 01:00, 8 wins):
    // the regression check passes and the stage may advance.
    const healthyIdeas = [...baselineIdeas()];
    for (let i = 0; i < 12; i++) healthyIdeas.push(idea("Fine", i < 8, "2026-10-21T01:30:00.000Z", 150 + i));
    const toFull = advancePromotion(sql, promotion.id, trackOf(healthyIdeas), { now: new Date("2026-10-21T02:00:00.000Z"), stageDurationsMs: NO_BOX });
    expect(toFull.promotion?.stage).toBe("full");
    expect(getStrategyWeights(sql).Weak).toBeCloseTo(0.25, 10);
    expect(isStrategyGatedOff(sql, "Weak")).toBe(true);
    expect(getImprovementCandidate(sql, cand.id)?.status).toBe("promoted");

    // The weight job now skips the gated-off strategy entirely — even
    // when the policy would move it (weight drifted back above the
    // floor here, so a proposal exists and must still be skipped).
    weights.set("Weak", { weight: 0.8, updated_at: "2026-10-21T02:30:00.000Z" });
    const jobTrack = trackOf(baselineIdeas());
    const job = runStrategyWeightAdjustment(sql, jobTrack, { now: new Date("2026-10-22T00:00:00.000Z"), force: true });
    expect(job.skippedGated).toContain("Weak");
    expect(getStrategyWeights(sql).Weak).toBeCloseTo(0.8, 10);
    weights.set("Weak", { weight: 0.25, updated_at: "2026-10-21T02:00:00.000Z" });

    // Regression: post-stage portfolio collapses (12 fresh evaluated ideas, 1 win).
    const regressedIdeas = [...baselineIdeas()];
    for (let i = 0; i < 12; i++) regressedIdeas.push(idea("Fine", i < 1, "2026-10-21T03:00:00.000Z", 200 + i));
    const regressed = trackOf(regressedIdeas);
    const rolled = advancePromotion(sql, promotion.id, regressed, { now: new Date("2026-10-21T04:00:00.000Z"), stageDurationsMs: NO_BOX });
    expect(rolled.action).toBe("rolled_back");
    expect(getPromotion(sql, promotion.id)?.stage).toBe("rolled_back");

    // EXACT restore of the promotion's own footprint: Weak's weight
    // back to the snapshot and its gate row gone. (Fine's weight is
    // 1.1, not the seeded 1.0 — the mid-drill job run legitimately
    // adjusted the non-gated strategy through its own audited path;
    // rollback restores what the promotion changed, nothing more.)
    expect(getStrategyWeights(sql).Weak).toBeCloseTo(1.4, 10);
    expect(getStrategyWeights(sql).Fine).toBeCloseTo(1.1, 10);
    expect(isStrategyGatedOff(sql, "Weak")).toBe(false);
    expect(getImprovementCandidate(sql, cand.id)?.status).toBe("rejected");
    // The incident is in the #755 audit trail.
    expect(audit.some((a) => a.actor === "staged-promotion-rollback" && a.status === "applied")).toBe(true);
  });

  it("weight-cap: staged caps apply, the policy honors them, rollback deletes the override", () => {
    const { sql, caps } = makeFakeSql();
    const cand = gatedCandidate(sql, {
      target: "strategy-weight-cap:Fine",
      change: { action: "raise-weight-cap", parameter: "weightCap", from: 2.0, to: 2.5, description: "Raise Fine cap." },
      hypothesis: "Fine earns a higher cap.",
      expectedEffect: { metric: "weightedWinRate", direction: "increase" },
      evidenceRefs: ["track-record:Fine"],
      provenance: { source: "track-record", id: "Fine" },
    });
    const baseline = trackOf(baselineIdeas());
    const started = startPromotion(sql, cand, baseline, { now: T0 });
    const promotion = started.promotion!;
    advancePromotion(sql, promotion.id, baseline, { now: new Date("2026-10-21T01:00:00.000Z"), stageDurationsMs: NO_BOX });
    expect(getStrategyWeightCap(sql, "Fine")).toBeCloseTo(2.25, 10); // partial: midpoint
    const healthyIdeas = [...baselineIdeas()];
    for (let i = 0; i < 12; i++) healthyIdeas.push(idea("Fine", i < 8, "2026-10-21T01:30:00.000Z", 150 + i));
    advancePromotion(sql, promotion.id, trackOf(healthyIdeas), { now: new Date("2026-10-21T02:00:00.000Z"), stageDurationsMs: NO_BOX });
    expect(getStrategyWeightCap(sql, "Fine")).toBeCloseTo(2.5, 10);

    // Policy integration: with the cap override the proposer may exceed 2.0 for Fine.
    const strong = trackOf([
      ...Array.from({ length: 40 }, (_, i) => idea("Fine", i < 36, "2026-09-06T00:00:00.000Z", 300 + i)),
      ...Array.from({ length: 40 }, (_, i) => idea("Weak", i < 8, "2026-09-05T00:00:00.000Z", 400 + i)),
    ]);
    const props = proposeWeightAdjustments(strong, { Fine: 2.45, Weak: 1.0 }, { Fine: 2.5 });
    expect(props.find((p) => p.strategy === "Fine")?.proposed).toBeGreaterThan(2.0);

    // Regression → rollback → the cap override row is gone (exact restore).
    const regressedIdeas = [...baselineIdeas()];
    for (let i = 0; i < 12; i++) regressedIdeas.push(idea("Fine", false, "2026-10-21T03:00:00.000Z", 500 + i));
    const rolled = advancePromotion(sql, promotion.id, trackOf(regressedIdeas), { now: new Date("2026-10-21T04:00:00.000Z"), stageDurationsMs: NO_BOX });
    expect(rolled.action).toBe("rolled_back");
    expect(getStrategyWeightCap(sql, "Fine")).toBeNull();
    expect(caps.size).toBe(0);
  });
});

describe("promotion refusals (#760)", () => {
  it("no passing gate verdict → no promotion; non-gated candidate → no promotion", () => {
    const { sql } = makeFakeSql();
    const noVerdict = gatedCandidate(sql, GATE_OFF, false);
    expect(startPromotion(sql, noVerdict, trackOf(baselineIdeas()), { now: T0 }).ok).toBe(false);
    const queued = generateImprovementCandidates(sql, { proposals: [{ ...GATE_OFF, target: "strategy-gate:Fine" }] }, T0).created[0];
    expect(startPromotion(sql, queued, trackOf(baselineIdeas()), { now: T0 }).ok).toBe(false);
    expect(listPromotions(sql, noVerdict.id)).toHaveLength(0);
  });

  it("the kill switch refuses start and advance without touching state", () => {
    const { sql, settings, weights } = makeFakeSql();
    weights.set("Weak", { weight: 1.4, updated_at: "2026-10-01T00:00:00.000Z" });
    const cand = gatedCandidate(sql, GATE_OFF);
    settings.set("adaptation.killSwitch", "on");
    expect(startPromotion(sql, cand, trackOf(baselineIdeas()), { now: T0 }).ok).toBe(false);
    settings.delete("adaptation.killSwitch");
    const started = startPromotion(sql, cand, trackOf(baselineIdeas()), { now: T0 });
    expect(started.ok).toBe(true);
    settings.set("adaptation.killSwitch", "on");
    const adv = advancePromotion(sql, started.promotion!.id, trackOf(baselineIdeas()), { now: new Date("2026-10-22T00:00:00.000Z"), stageDurationsMs: NO_BOX });
    expect(adv.ok).toBe(false);
    expect(getStrategyWeights(sql).Weak).toBeCloseTo(1.4, 10);
  });

  it("the stage time-box holds an advance until it elapses", () => {
    const { sql, weights } = makeFakeSql();
    weights.set("Weak", { weight: 1.4, updated_at: "2026-10-01T00:00:00.000Z" });
    const cand = gatedCandidate(sql, GATE_OFF);
    const started = startPromotion(sql, cand, trackOf(baselineIdeas()), { now: T0 });
    const adv = advancePromotion(sql, started.promotion!.id, trackOf(baselineIdeas()), {
      now: new Date("2026-10-21T01:00:00.000Z"),
      stageDurationsMs: { shadowMs: 24 * 3600_000, partialMs: 0, fullMs: 0 },
    });
    expect(adv.ok).toBe(false);
    expect(adv.reason).toMatch(/time-box/i);
    expect(getPromotion(sql, started.promotion!.id)?.stage).toBe("shadow");
  });

  it("insufficient post-stage data holds the stage — no advance, no rollback", () => {
    const { sql, weights } = makeFakeSql();
    weights.set("Weak", { weight: 1.4, updated_at: "2026-10-01T00:00:00.000Z" });
    const cand = gatedCandidate(sql, GATE_OFF);
    const started = startPromotion(sql, cand, trackOf(baselineIdeas()), { now: T0 });
    advancePromotion(sql, started.promotion!.id, trackOf(baselineIdeas()), { now: new Date("2026-10-21T01:00:00.000Z"), stageDurationsMs: NO_BOX });
    // Only 3 post-stage ideas (< 10 minimum): the partial → full advance must hold.
    const fewIdeas = [...baselineIdeas()];
    for (let i = 0; i < 3; i++) fewIdeas.push(idea("Fine", false, "2026-10-21T01:30:00.000Z", 600 + i));
    const adv = advancePromotion(sql, started.promotion!.id, trackOf(fewIdeas), { now: new Date("2026-10-21T02:00:00.000Z"), stageDurationsMs: NO_BOX });
    expect(adv.ok).toBe(false);
    expect(adv.reason).toMatch(/insufficient/i);
    expect(getPromotion(sql, started.promotion!.id)?.stage).toBe("partial");
    expect(getStrategyWeights(sql).Weak).toBeCloseTo(0.825, 10); // partial application intact
  });
});
