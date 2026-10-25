/**
 * Consolidation C2 (issue #1246, epic #1151 R3/R4): the hub Review
 * inbox + Track record tabs read and decide through thin routes in
 * screenerResearch.ts over the EXISTING stores — the Phase 0
 * goal/scenario store (listGoals / updateGoalStatus), the Phase 3
 * re-selection transparency log (listReselectionProposals), the
 * Phase 5 outcome ledger (listOutcomeTracking), and the promotion
 * gate's approval/verdict reads (listPromotionApprovals /
 * listGateVerdicts). These tests pin the routes' contracts: tenant
 * scoping, the proposed-only goal decision guard, and honest empty
 * states. Handler-level, following the C1 route-test pattern
 * (tests/consolidation_c1_execution_path.test.ts).
 */
import { describe, it, expect, vi } from "vitest";
import {
  handleScreenerResearchRoutes,
  type ScreenerResearchRouteContext,
} from "../src/agents/routes/screenerResearch";
import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";
import {
  createGoal,
  createScenario,
  recordOutcome,
} from "../src/services/goalScenarioStore";
import {
  recordReselectionProposal,
  RESELECTION_GOVERNANCE,
  type ReselectionProposal,
} from "../src/services/strategyBankReselection";
import {
  startOutcomeTracking,
  recordOutcomeTerminal,
} from "../src/services/outcomeTracking";
import {
  requestPromotionApproval,
  ensureGateVerdictsTable,
} from "../src/services/promotionGate";
import { buildScreeningActivityFeed } from "../src/services/screeningActivity";

function routeCtx() {
  const sql = new MockSqlStorage();
  const orm = new DatabaseORM(sql as any);
  const settings = new Map<string, string>();
  const ctx = {
    getScreenerAgent: vi.fn(() => null),
    getScreenerExecutionContext: vi.fn(async () => ({ userLogin: "alice" })),
    getResearchAgent: vi.fn(() => null),
    runResearchAndPublish: vi.fn(async () => ({ success: true })),
    getOrm: vi.fn(() => orm),
    readSettingRaw: vi.fn((key: string) => settings.get(key) ?? null),
    writeSetting: vi.fn((key: string, value: string) => void settings.set(key, value)),
    env: {},
  } as unknown as ScreenerResearchRouteContext;
  return { ctx, orm, sql };
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

async function call(
  ctx: ScreenerResearchRouteContext,
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
) {
  const res = await handleScreenerResearchRoutes(
    req(method, path, body, headers),
    new URL(`https://agent.internal${path}`),
    path.split("?")[0],
    "s1",
    ctx,
  );
  expect(res, `${method} ${path} should be handled by screenerResearch routes`).not.toBeNull();
  return res!;
}

const ALICE = { "x-user-login": "alice" };
const BOB = { "x-user-login": "bob" };

function seedProposal(orm: DatabaseORM, userLogin: string) {
  const goal = createGoal(orm as any, {
    userLogin,
    kind: "income",
    title: "Covered-call income on SPY",
    source: "discovered",
    status: "proposed",
  });
  const scenario = createScenario(orm as any, {
    userLogin,
    goalId: goal.id,
    portfolioRef: { kind: "hypothetical" },
    shocks: { spotPct: -5 },
    constraints: { maxLoss: 500 },
  });
  return { goal, scenario };
}

describe("C2 GET /screening/goals", () => {
  it("lists the tenant's goals with their scenarios, status-filtered", async () => {
    const { ctx, orm } = routeCtx();
    const { goal } = seedProposal(orm, "alice");
    createGoal(orm as any, {
      userLogin: "alice",
      kind: "directional",
      title: "Already active",
      status: "active",
    });
    seedProposal(orm, "bob");

    const res = await call(ctx, "GET", "/screening/goals?status=proposed", undefined, ALICE);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.goals).toHaveLength(1);
    expect(body.goals[0].id).toBe(goal.id);
    expect(body.goals[0].status).toBe("proposed");
    expect(body.goals[0].scenarios).toHaveLength(1);
    expect(body.goals[0].scenarios[0].goalId).toBe(goal.id);
  });

  it("rejects an unknown status filter with 400", async () => {
    const { ctx } = routeCtx();
    const res = await call(ctx, "GET", "/screening/goals?status=moonshot", undefined, ALICE);
    expect(res.status).toBe(400);
  });

  it("answers an empty store with an empty list, not an error", async () => {
    const { ctx } = routeCtx();
    const res = await call(ctx, "GET", "/screening/goals", undefined, ALICE);
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).goals).toEqual([]);
  });
});

describe("C2 POST /screening/goals/decide", () => {
  it("activates a proposed goal and records the decision in the activity feed", async () => {
    const { ctx, orm } = routeCtx();
    const { goal } = seedProposal(orm, "alice");
    const res = await call(
      ctx,
      "POST",
      "/screening/goals/decide",
      { id: goal.id, decision: "activate" },
      ALICE,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.success).toBe(true);
    expect(body.goal.status).toBe("active");

    const feed = buildScreeningActivityFeed(orm as any, "alice", 10);
    const entry = feed.find((f) => f.kind === "goal_decision");
    expect(entry, "the decision is recorded in the screening activity log").toBeTruthy();
    expect(entry!.summary).toContain(goal.title);
  });

  it("dismiss archives a proposed goal", async () => {
    const { ctx, orm } = routeCtx();
    const { goal } = seedProposal(orm, "alice");
    const res = await call(
      ctx,
      "POST",
      "/screening/goals/decide",
      { id: goal.id, decision: "dismiss" },
      ALICE,
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).goal.status).toBe("archived");
  });

  it("refuses to decide a goal that is not proposed (409)", async () => {
    const { ctx, orm } = routeCtx();
    const active = createGoal(orm as any, {
      userLogin: "alice",
      kind: "income",
      title: "Active goal",
      status: "active",
    });
    const res = await call(
      ctx,
      "POST",
      "/screening/goals/decide",
      { id: active.id, decision: "dismiss" },
      ALICE,
    );
    expect(res.status).toBe(409);
  });

  it("404s a goal the tenant cannot see, and validates the body (400)", async () => {
    const { ctx, orm } = routeCtx();
    const { goal } = seedProposal(orm, "bob");
    const foreign = await call(
      ctx,
      "POST",
      "/screening/goals/decide",
      { id: goal.id, decision: "activate" },
      ALICE,
    );
    expect(foreign.status).toBe(404);
    const bad = await call(ctx, "POST", "/screening/goals/decide", { id: goal.id }, BOB);
    expect(bad.status).toBe(400);
  });
});

describe("C2 GET /screening/reselection-proposals", () => {
  it("returns the tenant's recorded proposals, newest first, and no one else's", async () => {
    const { ctx, orm } = routeCtx();
    const proposal: ReselectionProposal = {
      regime: "bull",
      generatedAt: "2026-10-23T04:00:00.000Z",
      governance: RESELECTION_GOVERNANCE,
      overallWinRate: 0.55,
      activeSet: [{ strategy: "iron_condor", score: 0.8, winRate: 0.6, avgRMultiple: 1.2, evaluated: 12 }],
      log: [],
      evaluatedCount: 12,
      costUnitsUsed: 3,
      costCapUnits: 10,
    } as ReselectionProposal;
    recordReselectionProposal(orm as any, "alice", proposal);
    recordReselectionProposal(orm as any, "bob", proposal);

    const res = await call(ctx, "GET", "/screening/reselection-proposals", undefined, ALICE);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.proposals).toHaveLength(1);
    expect(body.proposals[0].proposal.governance).toBe(RESELECTION_GOVERNANCE);
    expect(body.proposals[0].proposal.activeSet[0].strategy).toBe("iron_condor");
  });
});

describe("C2 GET /screening/outcomes", () => {
  it("returns outcome-tracking summaries with honest quality states, tenant-scoped", async () => {
    const { ctx, orm } = routeCtx();
    recordOutcome(orm as any, {
      userLogin: "alice",
      recommendationRef: "rec-verified",
      kind: "paper",
    });
    recordOutcome(orm as any, {
      userLogin: "alice",
      recommendationRef: "rec-unverified",
      kind: "paper",
    });
    recordOutcome(orm as any, { userLogin: "bob", recommendationRef: "rec-bob", kind: "paper" });

    startOutcomeTracking(orm as any, "alice", { recommendationRef: "rec-verified" });
    startOutcomeTracking(orm as any, "alice", { recommendationRef: "rec-unverified" });
    recordOutcomeTerminal(orm as any, "alice", "rec-verified", {
      kind: "expired",
      pnlAfterCost: 12.5,
    });
    // No price supplied: the ledger must say Unverified, never estimate.
    recordOutcomeTerminal(orm as any, "alice", "rec-unverified", { kind: "expired" });

    const res = await call(ctx, "GET", "/screening/outcomes", undefined, ALICE);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.outcomes).toHaveLength(2);
    const byRef = new Map(body.outcomes.map((o: any) => [o.recommendationRef, o]));
    expect(byRef.get("rec-verified").quality).toBe("verified");
    expect(byRef.get("rec-verified").pnlAfterCost).toBe(12.5);
    expect(byRef.get("rec-unverified").quality).toBe("unverified");
    expect(byRef.get("rec-unverified").pnlAfterCost).toBeNull();
    expect(byRef.has("rec-bob")).toBe(false);
  });
});

describe("C2 GET /adaptation/candidates/approvals + /verdicts", () => {
  it("lists the candidate's approvals and gate verdicts (the inbox's decision evidence)", async () => {
    const { ctx, orm } = routeCtx();
    const approval = requestPromotionApproval(orm as any, "cand-1", "alice");
    ensureGateVerdictsTable(orm as any);
    orm.exec(
      `INSERT INTO mas_promotion_gate_verdicts (id, candidate_id, passed, reasons_json, heldout_evaluation_id, z, p_value, approval_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      "gv-1",
      "cand-1",
      1,
      JSON.stringify(["held-out edge significant"]),
      "eval-1",
      2.4,
      0.008,
      approval.id,
      "2026-10-23T05:00:00.000Z",
    );

    const approvalsRes = await call(
      ctx,
      "GET",
      "/adaptation/candidates/approvals?candidateId=cand-1",
    );
    expect(approvalsRes.status).toBe(200);
    const approvals = ((await approvalsRes.json()) as any).approvals;
    expect(approvals).toHaveLength(1);
    expect(approvals[0].id).toBe(approval.id);
    expect(approvals[0].status).toBe("pending");

    const verdictsRes = await call(ctx, "GET", "/adaptation/candidates/verdicts?candidateId=cand-1");
    expect(verdictsRes.status).toBe(200);
    const verdicts = ((await verdictsRes.json()) as any).verdicts;
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0].passed).toBe(true);
    expect(verdicts[0].pValue).toBeCloseTo(0.008);
  });

  it("requires candidateId (400) on both reads", async () => {
    const { ctx } = routeCtx();
    expect((await call(ctx, "GET", "/adaptation/candidates/approvals")).status).toBe(400);
    expect((await call(ctx, "GET", "/adaptation/candidates/verdicts")).status).toBe(400);
  });
});
