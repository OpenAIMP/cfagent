/**
 * Issue #1461 ([AGENTIC] Phase 4, sub-issue of #1362) — composition
 * memory pin test.
 *
 * Plan-level memory ON the existing Vectorize index / VectorMemory
 * path: a compiled chain's outcome is recorded keyed on goal text;
 * compiling the same (or near-identical) goal again retrieves the
 * prior plan and reports the reuse with provenance; a serve leg
 * resolves to an existing stored report through the existing #337
 * semantic index instead of regenerating.
 *
 * Hard boundaries pinned here: no new vector store, index, or
 * embedding provider (remember/recall go through the SAME Vectorize
 * binding object passed to VectorMemory, with a `kind: "plan"`
 * filter); reused plans are rebuilt through the Phase 2 compiler
 * (registry validation still applies); recall failure never breaks
 * compilation; nothing here executes a chain, creates a schedule,
 * or touches the Phase 3 confirmation gate.
 */
import { describe, it, expect, vi } from "vitest";
import { VectorMemory } from "../src/memory/vector-memory";
import { compileGoal } from "../src/orchestrate";
import {
  SEMANTIC_MIN_SCORE,
  compileGoalWithMemory,
  describeReuse,
  findReusablePlan,
  normalizeGoalText,
  recordPlanOutcome,
  resolveServeLeg,
  resolveStoredReportForServe,
} from "../src/agentic/compositionMemory";

const GOAL = "Create a NASDAQ100 screen and send it to Slack";
const BUDGET = { budgetCents: 5000, budgetCapCents: 10000 };

function freshChain() {
  const chain = compileGoal(GOAL, BUDGET);
  expect(chain).not.toBeNull();
  return chain!;
}

/** In-memory Vectorize stand-in: stores upserts, answers queries. */
class FakeVectorize {
  rows: Array<{ id: string; values: number[]; metadata: Record<string, any> }> = [];
  queryScore = 0.9;
  queryImpl: ((values: number[], opts: any) => any) | null = null;
  upsert = vi.fn(async (vectors: any[]) => {
    for (const v of vectors) {
      const idx = this.rows.findIndex((r) => r.id === v.id);
      if (idx >= 0) this.rows[idx] = v;
      else this.rows.push(v);
    }
  });
  async query(_values: number[], opts: any) {
    if (this.queryImpl) return this.queryImpl(_values, opts);
    const kind = opts?.filter?.kind;
    const matches = this.rows
      .filter((r) => (kind === undefined ? true : r.metadata?.kind === kind))
      .map((r) => ({ id: r.id, score: this.queryScore, metadata: r.metadata }));
    return { matches };
  }
}

function fakeAi() {
  return { run: async () => ({ data: [[0.1, 0.2, 0.3]] }) };
}

function memoryWith(fake: FakeVectorize) {
  return new VectorMemory(fakeAi(), fake, undefined);
}

describe("composition memory (#1461) — goal normalization", () => {
  it("lowercases, collapses whitespace, and trims like the Phase 2 compiler", () => {
    expect(normalizeGoalText("  Create   a NASDAQ100\nScreen  ")).toBe(
      "create a nasdaq100 screen",
    );
    expect(normalizeGoalText("")).toBe("");
    expect(normalizeGoalText("  ")).toBe("");
  });
});

describe("composition memory (#1461) — recording a plan outcome", () => {
  it("upserts a plan: record on the SAME Vectorize binding with kind plan metadata", async () => {
    const fake = new FakeVectorize();
    const memory = memoryWith(fake);
    const id = await recordPlanOutcome(memory, {
      goal: GOAL,
      chain: freshChain(),
      success: true,
      summary: "NASDAQ100 screen delivered to Slack",
    });
    expect(id.startsWith("plan:")).toBe(true);
    expect(fake.upsert).toHaveBeenCalledTimes(1);
    const row = fake.upsert.mock.calls[0][0][0];
    expect(row.id).toBe(id);
    expect(row.metadata.kind).toBe("plan");
    expect(row.metadata.goal).toBe(GOAL);
    expect(row.metadata.normalizedGoal).toBe(normalizeGoalText(GOAL));
    expect(JSON.parse(row.metadata.steps)).toEqual(
      freshChain().steps.map((s) => s.capabilityId),
    );
    expect(row.metadata.success).toBe("true");
  });

  it("recalls recorded plans through the same binding with a kind plan filter", async () => {
    const fake = new FakeVectorize();
    const memory = memoryWith(fake);
    await recordPlanOutcome(memory, {
      goal: GOAL,
      chain: freshChain(),
      success: true,
      summary: "delivered",
    });
    const plans = await memory.recallPlans(GOAL);
    expect(plans).toHaveLength(1);
    expect(plans[0].goal).toBe(GOAL);
    expect(plans[0].capabilityIds).toEqual(
      freshChain().steps.map((s) => s.capabilityId),
    );
    expect(plans[0].success).toBe(true);
    expect(plans[0].score).toBe(0.9);
  });

  it("drops recall matches whose stored steps do not parse", async () => {
    const fake = new FakeVectorize();
    fake.queryImpl = async () => ({
      matches: [
        {
          id: "plan:broken",
          score: 0.99,
          metadata: {
            kind: "plan",
            goal: GOAL,
            normalizedGoal: normalizeGoalText(GOAL),
            steps: "not-json{[",
            success: "true",
          },
        },
      ],
    });
    const plans = await memoryWith(fake).recallPlans(GOAL);
    expect(plans).toEqual([]);
  });
});

describe("composition memory (#1461) — reuse on recompile", () => {
  it("compiling the same goal again reuses the prior plan and says so, with provenance", async () => {
    const fake = new FakeVectorize();
    const memory = memoryWith(fake);
    const first = await compileGoalWithMemory(GOAL, { ...BUDGET, memory });
    expect(first.chain).not.toBeNull();
    expect(first.reuse).toBeNull();

    await recordPlanOutcome(memory, {
      goal: GOAL,
      chain: first.chain!,
      success: true,
      summary: "NASDAQ100 screen delivered to Slack",
    });

    const second = await compileGoalWithMemory(GOAL, { ...BUDGET, memory });
    expect(second.chain).not.toBeNull();
    expect(second.chain!.steps.map((s) => s.capabilityId)).toEqual(
      first.chain!.steps.map((s) => s.capabilityId),
    );
    expect(second.reuse).not.toBeNull();
    expect(second.reuse!.priorGoal).toBe(GOAL);
    expect(second.reuse!.priorOutcome).toBe("success");
    expect(second.reuse!.matchedBy).toBe("exact");
    const said = describeReuse(second.reuse!);
    expect(said).toContain("Reused prior plan");
    expect(said).toContain(GOAL);
    expect(said).toContain("success");
    expect(said).toContain(second.reuse!.planId);
  });

  it("a near-identical goal reuses via semantic match above the threshold", async () => {
    const fake = new FakeVectorize();
    fake.queryScore = 0.92;
    const memory = memoryWith(fake);
    await recordPlanOutcome(memory, {
      goal: GOAL,
      chain: freshChain(),
      success: false,
      summary: "Slack delivery failed",
    });
    const reuse = await findReusablePlan(
      memory,
      "Create a NASDAQ100 screen and send it to Slack today",
    );
    expect(reuse).not.toBeNull();
    expect(reuse!.matchedBy).toBe("semantic");
    expect(reuse!.plan.goal).toBe(GOAL);
    expect(reuse!.plan.success).toBe(false);
  });

  it("a low semantic score does not reuse", async () => {
    const fake = new FakeVectorize();
    fake.queryScore = 0.3;
    const memory = memoryWith(fake);
    await recordPlanOutcome(memory, {
      goal: GOAL,
      chain: freshChain(),
      success: true,
      summary: "delivered",
    });
    expect(SEMANTIC_MIN_SCORE).toBe(0.5);
    const reuse = await findReusablePlan(
      memory,
      "Something entirely unrelated about bonds",
    );
    expect(reuse).toBeNull();
  });

  it("an exact normalized match wins over a higher-scored different goal", async () => {
    const fake = new FakeVectorize();
    const memory = memoryWith(fake);
    await recordPlanOutcome(memory, {
      goal: "Unrelated other goal",
      chain: freshChain(),
      success: true,
      summary: "other",
    });
    await recordPlanOutcome(memory, {
      goal: GOAL,
      chain: freshChain(),
      success: true,
      summary: "exact",
    });
    const reuse = await findReusablePlan(memory, `  ${GOAL}  `);
    expect(reuse).not.toBeNull();
    expect(reuse!.matchedBy).toBe("exact");
    expect(reuse!.plan.goal).toBe(GOAL);
  });

  it("a stored plan that no longer validates falls back to a fresh compile", async () => {
    const fake = new FakeVectorize();
    fake.queryImpl = async () => ({
      matches: [
        {
          id: "plan:stale",
          score: 0.99,
          metadata: {
            kind: "plan",
            goal: GOAL,
            normalizedGoal: normalizeGoalText(GOAL),
            steps: JSON.stringify(["feed-no-such-capability"]),
            budgetCents: 5000,
            recurrence: "recurring",
            reusesStoredReport: "false",
            success: "true",
            summary: "stale",
            timestamp: new Date().toISOString(),
          },
        },
      ],
    });
    const result = await compileGoalWithMemory(GOAL, {
      ...BUDGET,
      memory: memoryWith(fake),
    });
    expect(result.chain).not.toBeNull();
    expect(result.chain!.steps.map((s) => s.capabilityId)).toEqual(
      freshChain().steps.map((s) => s.capabilityId),
    );
    expect(result.reuse).toBeNull();
  });

  it("recall failure never breaks compilation — it falls back to a fresh compile", async () => {
    const fake = new FakeVectorize();
    fake.queryImpl = async () => {
      throw new Error("Vectorize down");
    };
    const result = await compileGoalWithMemory(GOAL, {
      ...BUDGET,
      memory: memoryWith(fake),
    });
    expect(result.chain).not.toBeNull();
    expect(result.reuse).toBeNull();
  });

  it("without memory it behaves exactly like the Phase 2 compiler", async () => {
    const result = await compileGoalWithMemory(GOAL, { ...BUDGET });
    expect(result.chain).toEqual(compileGoal(GOAL, BUDGET));
    expect(result.reuse).toBeNull();
    const unknown = await compileGoalWithMemory("do something unrecognized", {
      ...BUDGET,
    });
    expect(unknown.chain).toBeNull();
    expect(unknown.reuse).toBeNull();
  });
});

describe("composition memory (#1461) — serve-leg reuse via the #337 index", () => {
  const serveChain = compileGoal("Send me yesterday's report by email", {
    budgetCents: 0,
  })!;

  it("a reusesStoredReport chain resolves to the top semantic hit, not a regeneration", async () => {
    expect(serveChain.reusesStoredReport).toBe(true);
    const env = {
      AI: { run: async () => ({ data: [[0.1, 0.2, 0.3]] }) },
      VECTOR_MEMORY: {
        query: async () => ({
          matches: [
            { id: "report:r-yesterday", score: 0.88, metadata: { reportId: "r-yesterday" } },
          ],
        }),
      },
    };
    const resolved = await resolveServeLeg(env, serveChain, "yesterday's report");
    expect(resolved).toEqual({ reportId: "r-yesterday", via: "semantic", score: 0.88 });
    expect(await resolveStoredReportForServe(env, "yesterday's report")).toEqual(
      resolved,
    );
  });

  it("a chain that does not reuse a stored report makes no vector call", async () => {
    const fullChain = freshChain();
    expect(fullChain.reusesStoredReport).toBe(false);
    const query = vi.fn(async () => ({ matches: [] }));
    const env = {
      AI: { run: async () => ({ data: [[0.1]] }) },
      VECTOR_MEMORY: { query },
    };
    expect(await resolveServeLeg(env, fullChain, "NASDAQ100")).toBeNull();
    expect(query).not.toHaveBeenCalled();
  });

  it("without bindings the serve leg resolves to null (lexical fallback lives with the caller)", async () => {
    expect(await resolveServeLeg({}, serveChain, "yesterday's report")).toBeNull();
    expect(await resolveStoredReportForServe({}, "yesterday's report")).toBeNull();
  });
});
