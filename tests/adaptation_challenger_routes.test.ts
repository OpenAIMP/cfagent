/**
 * Issue #1257 (epic #1151 remainder, part 2 of (a)): the
 * /adaptation/* routes re-pointed from the #757→#760 chain to the
 * champion/challenger governance (#1140), with the hub panel reworked
 * to the challenger model in the same PR.
 *
 * Route-level pins via handleScreenerResearchRoutes + MockSqlStorage.
 * Frozen-set expectations reuse the phase5 precedents: the
 * long_strangle-only active-set challenger FAILS on the v2 set, and
 * the iron_condor/bull_put_spread challenger PASSES it.
 *
 * Generate defaults (documented, frozen-set-calibrated): the v2 set
 * holds only 4 cases x 1 idea, so the holdout fold evaluates at most
 * 2 ideas — minEvaluated 1 and minHoldoutEdge 0.0005 (the phase5
 * test precedent) are the only bars a challenger can pass today. A
 * larger frozen set must revisit these defaults; they are NOT
 * aspirational bars.
 */
import { describe, it, expect, vi } from "vitest";
import {
  handleScreenerResearchRoutes,
  type ScreenerResearchRouteContext,
} from "../src/agents/routes/screenerResearch";
import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";

const NOW = new Date("2026-10-24T12:00:00.000Z");

function routeCtx() {
  const sql = new MockSqlStorage();
  const orm = new DatabaseORM(sql as any);
  const settings = new Map<string, string>();
  const agent = {
    getTrackRecord: vi.fn(async () => ({ ideas: [], byStrategy: [] })),
    getResearchConfig: vi.fn(async () => ({ feePerContract: 0.65, slippagePerContract: 0.02 })),
  };
  const ctx = {
    getScreenerAgent: vi.fn(() => null),
    getScreenerExecutionContext: vi.fn(async () => ({ userLogin: "alice" })),
    getResearchAgent: vi.fn(() => agent),
    runResearchAndPublish: vi.fn(async () => ({ success: true })),
    getOrm: vi.fn(() => orm),
    readSettingRaw: vi.fn((key: string) => settings.get(key) ?? null),
    writeSetting: vi.fn((key: string, value: string) => void settings.set(key, value)),
    env: {},
  } as unknown as ScreenerResearchRouteContext;
  return { ctx, orm, sql, settings, agent };
}

function req(method: string, path: string, body?: unknown, headers?: Record<string, string>) {
  return new Request(`https://agent.internal${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(headers || {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function call(ctx: ScreenerResearchRouteContext, method: string, path: string, body?: unknown) {
  const res = await handleScreenerResearchRoutes(
    req(method, path, body, { "x-user-login": "alice" }),
    new URL(`https://agent.internal${path}`),
    path.split("?")[0],
    "s1",
    ctx
  );
  if (!res) throw new Error(`no route matched ${method} ${path}`);
  return { res, data: (await res.json()) as any };
}

function tables(sql: MockSqlStorage) {
  return (sql as any).tables as Map<string, Array<Record<string, any>>>;
}

function seedChallenger(sql: MockSqlStorage, overrides: Record<string, any> = {}) {
  const row = {
    id: "chl-1",
    user_login: "alice",
    kind: "active_set",
    title: "Strangle only",
    regime: "high_vol",
    spec_json: JSON.stringify({ activeStrategies: ["long_strangle"] }),
    criteria_json: JSON.stringify({ minHoldoutEdge: 0.0005, minEvaluated: 1 }),
    eval_set_version: "v2",
    source_proposal_id: null,
    status: "proposed",
    evaluation_json: null,
    created_by: "research-agent",
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
    ...overrides,
  };
  tables(sql).set("mas_challengers", [row]);
  return row;
}

function seedProposal(sql: MockSqlStorage, overrides: Record<string, any> = {}) {
  const row = {
    id: "prop-1",
    user_login: "alice",
    regime: "chop",
    proposal_json: JSON.stringify({
      regime: "chop",
      generatedAt: NOW.toISOString(),
      governance: "proposal_only_not_promoted",
      overallWinRate: 0.5,
      activeSet: [
        { strategy: "iron_condor", score: 0.4, winRate: 0.6, avgRMultiple: 0.7, evaluated: 20, weight: 1.2 },
        { strategy: "bull_put_spread", score: 0.3, winRate: 0.55, avgRMultiple: 0.5, evaluated: 18, weight: 1.0 },
      ],
      log: [],
      evaluatedCount: 2,
      costUnitsUsed: 20,
      costCapUnits: 100,
    }),
    created_at: NOW.toISOString(),
    ...overrides,
  };
  tables(sql).set("mas_strategy_bank_proposals", [row]);
  return row;
}

describe("challenger-backed /adaptation/* routes", () => {
  it("GET /adaptation/candidates lists challengers (not #757 candidates)", async () => {
    const { ctx, sql } = routeCtx();
    seedChallenger(sql);
    const { data } = await call(ctx, "GET", "/api/adaptation/candidates");
    expect(data.candidates).toHaveLength(1);
    expect(data.candidates[0].id).toBe("chl-1");
    expect(data.candidates[0].kind).toBe("active_set");
    expect(data.candidates[0].spec.activeStrategies).toEqual(["long_strangle"]);
    expect(data.candidates[0].status).toBe("proposed");
  });

  it("POST /adaptation/candidates/generate creates challengers from proposals, deduped on re-run", async () => {
    const { ctx, sql } = routeCtx();
    seedProposal(sql);
    const first = await call(ctx, "POST", "/api/adaptation/candidates/generate", {});
    expect(first.data.success).toBe(true);
    expect(first.data.created).toHaveLength(1);
    expect(first.data.created[0].kind).toBe("active_set");
    expect(first.data.created[0].regime).toBe("chop");
    expect(first.data.created[0].spec.activeStrategies).toEqual(["iron_condor", "bull_put_spread"]);
    expect(first.data.created[0].sourceProposalId).toBe("prop-1");
    expect(first.data.created[0].evalSetVersion).toBe("v2");
    expect(first.data.created[0].createdBy).toBe("strategy-bank-reselection");
    const second = await call(ctx, "POST", "/api/adaptation/candidates/generate", {});
    expect(second.data.created).toHaveLength(0);
    expect(second.data.skipped.map((s: any) => s.proposalId)).toContain("prop-1");
  });

  it("POST /adaptation/candidates/evaluate runs the frozen-set evaluation and stores it", async () => {
    const { ctx, sql } = routeCtx();
    seedChallenger(sql);
    const { data } = await call(ctx, "POST", "/api/adaptation/candidates/evaluate", { candidateId: "chl-1" });
    expect(data.success).toBe(true);
    // Phase5 precedent: long_strangle-only FAILS on the v2 frozen set.
    expect(data.evaluation.verdict).toBe("fail");
    expect(data.evaluation.datasetVersion).toBe("v2");
    const { data: listed } = await call(ctx, "GET", "/api/adaptation/candidates");
    expect(listed.candidates[0].status).toBe("evaluated");
    expect(listed.candidates[0].evaluation.verdict).toBe("fail");
  });

  it("GET evaluations/approvals/verdicts/promotions read challenger records", async () => {
    const { ctx, sql } = routeCtx();
    seedChallenger(sql, {
      status: "evaluated",
      evaluation_json: JSON.stringify({
        datasetVersion: "v2",
        evaluatedAt: NOW.toISOString(),
        selection: { championScore: 0.1, challengerScore: 0.05, evaluated: 2 },
        holdout: { championScore: 0.1, challengerScore: 0.05, evaluated: 2 },
        verdict: "fail",
        criteria: { minHoldoutEdge: 0.0005, minEvaluated: 1 },
      }),
    });
    tables(sql).set("mas_challenger_approvals", [
      { id: "apr-1", challenger_id: "chl-1", user_login: "alice", approver: "owner-mubasher", decision: "approved", created_at: NOW.toISOString() },
    ]);
    tables(sql).set("mas_challenger_promotions", [
      { id: "prm-1", challenger_id: "chl-1", user_login: "alice", action: "promoted", prior_json: "{}", applied_json: "{}", weights_version: 1, actor: "owner-mubasher", reason: null, created_at: NOW.toISOString() },
    ]);
    const ev = await call(ctx, "GET", "/api/adaptation/candidates/evaluations?candidateId=chl-1");
    expect(ev.data.evaluations).toHaveLength(1);
    expect(ev.data.evaluations[0].verdict).toBe("fail");
    const ap = await call(ctx, "GET", "/api/adaptation/candidates/approvals?candidateId=chl-1");
    expect(ap.data.approvals).toHaveLength(1);
    expect(ap.data.approvals[0].approver).toBe("owner-mubasher");
    const ve = await call(ctx, "GET", "/api/adaptation/candidates/verdicts?candidateId=chl-1");
    expect(ve.data.verdicts).toHaveLength(1);
    expect(ve.data.verdicts[0].passed).toBe(false);
    const pr = await call(ctx, "GET", "/api/adaptation/promotions?candidateId=chl-1");
    expect(pr.data.promotions).toHaveLength(1);
    expect(pr.data.promotions[0].action).toBe("promoted");
  });

  it("POST approve records a direct decision; self-approval is refused", async () => {
    const { ctx, sql } = routeCtx();
    seedChallenger(sql);
    const ok = await call(ctx, "POST", "/api/adaptation/candidates/approve", { candidateId: "chl-1", decision: "approved" });
    expect(ok.data.success).toBe(true);
    const ap = await call(ctx, "GET", "/api/adaptation/candidates/approvals?candidateId=chl-1");
    expect(ap.data.approvals).toHaveLength(1);
    expect(ap.data.approvals[0].decision).toBe("approved");
    // The creator (research-agent) cannot approve its own challenger —
    // but the route actor here is alice via x-user-login; self-approval
    // is exercised by seeding a challenger created by alice.
    seedChallenger(sql, { id: "chl-2", created_by: "alice" });
    const self = await call(ctx, "POST", "/api/adaptation/candidates/approve", { candidateId: "chl-2", decision: "approved" });
    expect(self.data.success).toBe(false);
    expect(self.data.reason).toMatch(/self-approval/i);
  });

  it("POST gate returns the frozen-set verdict", async () => {
    const { ctx, sql } = routeCtx();
    seedChallenger(sql);
    const { data } = await call(ctx, "POST", "/api/adaptation/candidates/gate", { candidateId: "chl-1" });
    expect(data.success).toBe(true);
    expect(data.verdict.passed).toBe(false);
  });

  it("POST promotions/promote requires evaluation + pass + approval by the promoter", async () => {
    const { ctx, sql } = routeCtx();
    // Evaluated + passed + approved by owner-mubasher, but the route
    // actor is alice (x-user-login) → promoter != approver → refused.
    seedChallenger(sql, {
      id: "chl-pass",
      kind: "active_set",
      title: "Passing set",
      regime: "chop",
      spec_json: JSON.stringify({ activeStrategies: ["iron_condor", "bull_put_spread"] }),
      status: "evaluated",
      evaluation_json: JSON.stringify({
        datasetVersion: "v2",
        evaluatedAt: NOW.toISOString(),
        selection: { championScore: 0.1, challengerScore: 0.2, evaluated: 2 },
        holdout: { championScore: 0.1, challengerScore: 0.2, evaluated: 2 },
        verdict: "pass",
        criteria: { minHoldoutEdge: 0.0005, minEvaluated: 1 },
      }),
    });
    tables(sql).set("mas_challenger_approvals", [
      { id: "apr-1", challenger_id: "chl-pass", user_login: "alice", approver: "owner-mubasher", decision: "approved", created_at: NOW.toISOString() },
    ]);
    const refused = await call(ctx, "POST", "/api/adaptation/promotions/promote", { candidateId: "chl-pass" });
    expect(refused.data.success).toBe(false);
    expect(refused.data.reason).toMatch(/promoter must be/i);
    // Approved by alice herself → promoter == approver → promoted.
    tables(sql).set("mas_challenger_approvals", [
      { id: "apr-2", challenger_id: "chl-pass", user_login: "alice", approver: "alice", decision: "approved", created_at: NOW.toISOString() },
    ]);
    const ok = await call(ctx, "POST", "/api/adaptation/promotions/promote", { candidateId: "chl-pass" });
    expect(ok.data.success).toBe(true);
    const { data: listed } = await call(ctx, "GET", "/api/adaptation/candidates");
    expect(listed.candidates[0].status).toBe("promoted");
  });

  it("POST promotions/rollback restores the prior state", async () => {
    const { ctx, sql } = routeCtx();
    seedChallenger(sql, {
      id: "chl-pass",
      kind: "active_set",
      title: "Passing set",
      regime: "chop",
      spec_json: JSON.stringify({ activeStrategies: ["iron_condor"] }),
      status: "promoted",
      evaluation_json: JSON.stringify({
        datasetVersion: "v2",
        evaluatedAt: NOW.toISOString(),
        selection: { championScore: 0.1, challengerScore: 0.2, evaluated: 2 },
        holdout: { championScore: 0.1, challengerScore: 0.2, evaluated: 2 },
        verdict: "pass",
        criteria: { minHoldoutEdge: 0.0005, minEvaluated: 1 },
      }),
    });
    tables(sql).set("mas_challenger_promotions", [
      { id: "prm-1", challenger_id: "chl-pass", user_login: "alice", action: "promoted", prior_json: JSON.stringify({ activeSet: null }), applied_json: JSON.stringify({ activeSet: { strategies: ["iron_condor"], version: 1 } }), weights_version: null, actor: "alice", reason: null, created_at: NOW.toISOString() },
    ]);
    const { data } = await call(ctx, "POST", "/api/adaptation/promotions/rollback", { candidateId: "chl-pass" });
    expect(data.success).toBe(true);
    const { data: listed } = await call(ctx, "GET", "/api/adaptation/candidates");
    expect(listed.candidates[0].status).toBe("rolled_back");
  });

  it("POST promotions/start is gone: staged promotions are retired", async () => {
    const { ctx } = routeCtx();
    await expect(call(ctx, "POST", "/api/adaptation/promotions/start", { candidateId: "chl-1" })).rejects.toThrow("no route matched");
  });

  it("GET promotions/active is gone: staged drain visibility retired", async () => {
    const { ctx } = routeCtx();
    await expect(call(ctx, "GET", "/api/adaptation/promotions/active")).rejects.toThrow("no route matched");
  });
});
