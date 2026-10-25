/**
 * Issue #654: GET /research/track-record/calibration.
 *
 * - Returns the calibration built from the caller's track record
 *   (per thesis / strategy / regime / month), via the same
 *   x-user-login → ResearchAgent pattern as the track-record route.
 * - No agent binding → 503 business error, same as the sibling routes.
 * - A non-matching path returns null (the orchestrator keeps routing).
 */
import { describe, it, expect, vi } from "vitest";
import {
  handleScreenerResearchRoutes,
  type ScreenerResearchRouteContext,
} from "../src/agents/routes/screenerResearch";
import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";

function routeCtx(agent: unknown) {
  const orm = new DatabaseORM(new MockSqlStorage() as any);
  const ctx = {
    getScreenerAgent: vi.fn(() => null),
    getScreenerExecutionContext: vi.fn(async () => ({ userLogin: "alice" })),
    getResearchAgent: vi.fn(() => agent),
    runResearchAndPublish: vi.fn(async () => ({ success: true })),
    getOrm: vi.fn(() => orm),
    readSettingRaw: vi.fn(() => null),
    writeSetting: vi.fn(),
    env: {},
  } as unknown as ScreenerResearchRouteContext;
  return ctx;
}

function call(ctx: ScreenerResearchRouteContext, path: string) {
  return handleScreenerResearchRoutes(
    new Request(`https://agent.internal${path}`, {
      method: "GET",
      headers: { "x-user-login": "alice" },
    }),
    new URL(`https://agent.internal${path}`),
    path,
    "s1",
    ctx
  );
}

const TRACK = {
  ideas: [
    {
      thesis: "bullish",
      structure: "bull_put_spread",
      regime: "bull",
      evaluation: { directionCorrect: true, evaluatedAt: "2026-10-05T12:00:00.000Z" },
    },
    {
      thesis: "bullish",
      structure: "bull_put_spread",
      regime: "bull",
      evaluation: { directionCorrect: false, evaluatedAt: "2026-10-06T12:00:00.000Z" },
    },
    {
      thesis: "bearish",
      structure: "bear_call_spread",
      regime: "bear",
      evaluation: null,
    },
  ],
};

describe("Issue #654 — calibration route", () => {
  it("returns the calibration built from the track record", async () => {
    const ctx = routeCtx({ getTrackRecord: vi.fn(async () => TRACK) });
    const res = await call(ctx, "/research/track-record/calibration");
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as any;
    expect(body.calibration.totalEvaluated).toBe(2);
    expect(body.calibration.pending).toBe(1);
    expect(body.calibration.overallHitRate).toBe(0.5);
    expect(body.calibration.byThesis).toEqual([
      { thesis: "bullish", evaluated: 2, hits: 1, hitRate: 0.5 },
    ]);
    expect(body.calibration.byStrategy).toEqual([
      { key: "bull_put_spread", evaluated: 2, hits: 1, hitRate: 0.5 },
    ]);
  });

  it("no agent binding → 503", async () => {
    const ctx = routeCtx(null);
    const res = await call(ctx, "/research/track-record/calibration");
    expect(res!.status).toBe(503);
  });

  it("a non-owned path returns null", async () => {
    const ctx = routeCtx({ getTrackRecord: vi.fn(async () => TRACK) });
    const res = await call(ctx, "/research/track-record/calibration/extra");
    expect(res).toBeNull();
  });
});
