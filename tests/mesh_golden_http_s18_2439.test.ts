/**
 * Issue #2439 (Agent Mesh S18, programme #2225 G13b) — the
 * HTTP-routes golden task, in its own suite because driving the
 * real worker fetch takes the worker module graph (the
 * tests/iaaa_gate_coverage_1754.test.ts mock set), which differs
 * from the main golden suite's.
 *
 * The task: ScheduledAgent × http-routes — GET /api/schedule/goals
 * through the REAL worker fetch. The census records this door's
 * gate as the session gate in src/server.ts, applied before the
 * DO stub is resolved; the golden expectation covers both sides
 * of it: unauthenticated → 401 (a refusal is a golden outcome),
 * authenticated → 200 with the catalogue from the ScheduledAgent
 * stub behind its namespace (the binding seam).
 */
import { describe, expect, it, vi } from "vitest";
import { makeFakeSessionStore } from "./fake-session-store";

vi.mock("@cloudflare/ai-chat", () => {
  return {
    AIChatAgent: class MockAIChatAgent {
      ctx: unknown;
      env: unknown;
      constructor(ctx: unknown, env: unknown) {
        this.ctx = ctx;
        this.env = env;
      }
    },
  };
});
vi.mock("agents", () => {
  return { routeAgentRequest: async () => null, Agent: class MockAgent {} };
});
vi.mock("agents/mcp", () => {
  return { McpAgent: class MockMcpAgent {} };
});
vi.mock("agents/x402", () => {
  return { withX402: (cls: unknown) => cls };
});

import worker from "../src/server";
import type { Env } from "../src/types";
import {
  executeGoldenTasks,
  goldenTask,
  type GoldenTaskExecution,
} from "../src/services/meshGoldenTasks";
import { InMemoryMeshEvalStore } from "../src/data/inMemoryMeshEvalAdapter";
import type { ScheduledGoal } from "../src/schedule";

const LOGIN = "alice";
const SESSION_ID = "24390000-1c2b-4e3f-8a5b-243900000001";

const GOALS: ScheduledGoal[] = [
  {
    id: "opportunity-hunt",
    name: "Opportunity hunt",
    cron: "0 */6 * * *",
    operation: "search.opportunity_hunt",
    budgetCents: 1000,
    enabled: true,
  },
  {
    id: "daily-qa-sweep",
    name: "Daily QA sweep",
    cron: "0 6 * * *",
    operation: "qa.run_sweep",
    budgetCents: 500,
    enabled: true,
  },
];

function makeEnv() {
  const { namespace: sessionStoreNs, seed: seedSession } = makeFakeSessionStore();
  seedSession("sessions", SESSION_ID, { githubLogin: LOGIN, userLogin: LOGIN });
  const scheduledStub = {
    async listGoals(): Promise<ScheduledGoal[]> {
      return GOALS.map((g) => ({ ...g }));
    },
  };
  const env = {
    SESSION_STORE: sessionStoreNs,
    SCHEDULED_AGENT: {
      idFromName: (name: string) => name,
      get: (_id: unknown) => scheduledStub,
    },
    AI: {},
    VECTOR_MEMORY: {},
  };
  return env as unknown as Env;
}

const req = (cookie?: string) =>
  new Request("https://agent.test/api/schedule/goals", {
    method: "GET",
    headers: {
      ...(cookie ? { Cookie: `session_id=${cookie}` } : {}),
    },
  });

describe("golden task: http-schedule-goals (#2439)", () => {
  it("the session gate refuses anonymously and serves the catalogue when authenticated", async () => {
    const execution: GoldenTaskExecution = {
      task: goldenTask("http-schedule-goals")!,
      drive: async () => {
        const env = makeEnv();
        const anon = await worker.fetch(req(), env, {} as ExecutionContext);
        const authed = await worker.fetch(req(SESSION_ID), env, {} as ExecutionContext);
        const body = (await authed.json().catch(() => null)) as {
          goals?: unknown[];
        } | null;
        return {
          outcome: authed.status === 200 ? "completed" : "error",
          facts: {
            unauthenticatedStatus: anon.status,
            authenticatedStatus: authed.status,
            goalCount: body?.goals?.length ?? -1,
          },
        };
      },
    };

    const store = new InMemoryMeshEvalStore();
    const results = await executeGoldenTasks([execution], {
      store,
      runId: "mesh-eval:s18:golden-set",
    });
    expect(results).toHaveLength(1);
    expect(results[0].passed, results[0].failures.join("; ")).toBe(true);
    const recorded = await store.resultsForRun("mesh-eval:s18:golden-set");
    expect(recorded.map((r) => r.taskId)).toEqual(["http-schedule-goals"]);
    expect(recorded[0].door).toBe("http-routes");
  });
});
