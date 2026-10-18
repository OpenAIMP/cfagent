/**
 * Issue #258 — eval harness for the judge's deterministic routing layer
 * (Assessment P1, item 7).
 *
 * WHAT IT SCORES
 * - Judge routing: tests/fixtures/judge-golden.json (105 labeled queries)
 *   against deterministicRoute() in src/judge-routing.ts — the exact fast-path
 *   code production uses (LLMJudge.route() delegates to it; single source of
 *   truth). Labels encode the layer's first-match contract, NOT an aspirational
 *   routing: entries marked "known quirk" pin current behavior so a future
 *   rule change must update the fixture deliberately.
 * - NLQ planner: tests/fixtures/nlq-golden.json (29 labeled questions) against
 *   planWithRules() in src/agents/nlq.ts, scored on (domain, operation,
 *   action/targetTable).
 *
 * WHAT IT DOES NOT DO
 * - No LLM calls, no network. The CI path is fully hermetic.
 * - Queries that fall through every fast-path rule (LLM-routed at runtime)
 *   are intentionally absent from the golden sets — they are non-deterministic
 *   and cannot be golden-labeled.
 *
 * REGRESSION THRESHOLDS
 * Baseline (first green, 2026-10-18, local): judge accuracy 1.000 (105/105),
 * per-intent precision/recall 1.000; NLQ accuracy 1.000 (29/29).
 * The suite FAILS if overall accuracy drops below 0.99 or any intent's
 * precision/recall drops below 0.90 — a rule change that moves routing must
 * be accompanied by a deliberate fixture update on the same PR.
 *
 * LLM-DEPENDENT SCORING
 * The flag-gated block below (JUDGE_EVAL_LLM=1) exercises the judge's
 * LLM-integration seam — response parsing, agent allowlisting, confidence
 * clamping — with a stubbed model. It is OFF by default and is NOT required
 * for CI.
 */
import { describe, it, expect, vi } from "vitest";

// The deterministic suites below never touch the model layer. The
// JUDGE_EVAL_LLM=1 seam block stubs the model at the "ai" boundary, the same
// pattern as tests/judge_model_routing.test.ts.
vi.mock("ai", () => ({ generateText: vi.fn() }));
vi.mock("../src/agents/model", () => ({
  getWorkersAIModel: (_env: unknown, name?: string) => ({ routedName: name ?? "default-model" }),
  DEFAULT_AI_MODEL: "default-model",
  resolveAiModelName: (_env: unknown, name?: string) => name ?? "default-model",
}));

import { deterministicRoute } from "../src/judge-routing";
import { planWithRules } from "../src/agents/nlq";
import { generateText } from "ai";
import judgeGolden from "./fixtures/judge-golden.json";
import nlqGolden from "./fixtures/nlq-golden.json";

interface MetricRow {
  intent: string;
  support: number;
  precision: number;
  recall: number;
  f1: number;
}

function prf(
  labels: string[],
  predicted: string[],
  expected: string[],
  intents: string[]
): { rows: MetricRow[]; accuracy: number } {
  const rows: MetricRow[] = intents.map((intent) => {
    let tp = 0;
    let fp = 0;
    let fn = 0;
    for (let i = 0; i < labels.length; i++) {
      const p = predicted[i];
      const e = expected[i];
      if (p === intent && e === intent) tp++;
      else if (p === intent) fp++;
      else if (e === intent) fn++;
    }
    const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
    const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
    const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
    return { intent, support: tp + fn, precision, recall, f1 };
  });
  let correct = 0;
  for (let i = 0; i < labels.length; i++) if (predicted[i] === expected[i]) correct++;
  return { rows, accuracy: labels.length === 0 ? 1 : correct / labels.length };
}

function fmt(n: number): string {
  return n.toFixed(3);
}

const JUDGE_INTENTS = ["search", "research", "trading", "payments", "tasks", "memory", "general"];

describe("judge deterministic routing eval (golden set)", () => {
  const entries = (judgeGolden as { entries: Array<{
    id: string;
    text: string;
    expectedIntent: string;
    expectedConfidence: number;
    expectedNeedsConfirmation: boolean;
    recentMessages?: Array<{ role: string; content: string }>;
  }> }).entries;

  it("every entry hits a fast-path rule and matches agent + confidence + needsConfirmation", () => {
    const failures: string[] = [];
    for (const e of entries) {
      const got = deterministicRoute(e.text, (e.recentMessages as Array<{ role?: string; content?: string }>) ?? []);
      if (!got) {
        failures.push(`${e.id}: no fast-path match for "${e.text}"`);
        continue;
      }
      if (got.agent !== e.expectedIntent) failures.push(`${e.id}: agent ${got.agent} != ${e.expectedIntent}`);
      if (got.confidence !== e.expectedConfidence) failures.push(`${e.id}: confidence ${got.confidence} != ${e.expectedConfidence}`);
      if (got.needsConfirmation !== e.expectedNeedsConfirmation)
        failures.push(`${e.id}: needsConfirmation ${got.needsConfirmation} != ${e.expectedNeedsConfirmation}`);
    }
    expect(failures).toEqual([]);
  });

  it("meets the regression thresholds (accuracy >= 0.99, per-intent precision/recall >= 0.90)", () => {
    const predicted = entries.map((e) => deterministicRoute(e.text, (e.recentMessages as Array<{ role?: string; content?: string }>) ?? [])?.agent ?? "<no-match>");
    const expected = entries.map((e) => e.expectedIntent);
    const { rows, accuracy } = prf(entries.map((e) => e.id), predicted, expected, JUDGE_INTENTS);

    console.log("\njudge routing eval — per-intent precision/recall/F1 (support = golden count):");
    console.table(rows.map((r) => ({
      intent: r.intent,
      support: r.support,
      precision: fmt(r.precision),
      recall: fmt(r.recall),
      f1: fmt(r.f1),
    })));
    console.log(`judge routing eval — overall accuracy: ${fmt(accuracy)} (${predicted.filter((p, i) => p === expected[i]).length}/${entries.length})`);

    expect(accuracy).toBeGreaterThanOrEqual(0.99);
    for (const r of rows) {
      expect(r.precision, `precision[${r.intent}]`).toBeGreaterThanOrEqual(0.9);
      expect(r.recall, `recall[${r.intent}]`).toBeGreaterThanOrEqual(0.9);
    }
  });
});

describe("nlq deterministic planner eval (golden set)", () => {
  const entries = (nlqGolden as { entries: Array<{
    id: string;
    question: string;
    expectedDomain: string;
    expectedOperation: string;
    expectedAction?: string | null;
    expectedTargetTable?: string;
  }> }).entries;

  const actualOf = (q: string): { domain: string; operation: string; key: string | null } => {
    const p = planWithRules(q) as {
      domain: string;
      operation: string;
      targetTable?: string;
      tradingData?: { action?: string };
      researchData?: { action?: string };
      scheduleData?: { action?: string };
      agenticPaymentsData?: { action?: string };
      categoryData?: { action?: string };
    };
    const key =
      p.targetTable ??
      p.tradingData?.action ??
      p.researchData?.action ??
      p.scheduleData?.action ??
      p.agenticPaymentsData?.action ??
      p.categoryData?.action ??
      null;
    return { domain: p.domain, operation: p.operation, key };
  };

  it("every entry matches domain + operation + action/targetTable", () => {
    const failures: string[] = [];
    for (const e of entries) {
      const got = actualOf(e.question);
      const wantKey = e.expectedAction ?? e.expectedTargetTable ?? null;
      if (got.domain !== e.expectedDomain) failures.push(`${e.id}: domain ${got.domain} != ${e.expectedDomain}`);
      if (got.operation !== e.expectedOperation) failures.push(`${e.id}: operation ${got.operation} != ${e.expectedOperation}`);
      if (wantKey !== null && got.key !== wantKey) failures.push(`${e.id}: action/table ${got.key} != ${wantKey}`);
    }
    expect(failures).toEqual([]);
  });

  it("meets the regression thresholds (accuracy >= 0.99)", () => {
    const domains = [...new Set(entries.map((e) => e.expectedDomain))];
    const predicted = entries.map((e) => actualOf(e.question).domain);
    const expected = entries.map((e) => e.expectedDomain);
    const { rows, accuracy } = prf(entries.map((e) => e.id), predicted, expected, domains);

    console.log("\nnlq planner eval — per-domain precision/recall/F1:");
    console.table(rows.map((r) => ({
      domain: r.intent,
      support: r.support,
      precision: fmt(r.precision),
      recall: fmt(r.recall),
      f1: fmt(r.f1),
    })));
    console.log(`nlq planner eval — domain accuracy: ${fmt(accuracy)} (${entries.length} entries)`);

    expect(accuracy).toBeGreaterThanOrEqual(0.99);
    for (const r of rows) {
      expect(r.precision, `precision[${r.intent}]`).toBeGreaterThanOrEqual(0.9);
      expect(r.recall, `recall[${r.intent}]`).toBeGreaterThanOrEqual(0.9);
    }
  });
});

// LLM-dependent scoring seam — OFF by default, enabled with JUDGE_EVAL_LLM=1.
// Exercises the judge's LLM-integration logic (JSON parsing, agent allowlist,
// confidence clamping) against a stubbed model; never touches a real model.
const runLlmSeam = process.env.JUDGE_EVAL_LLM === "1";
(runLlmSeam ? describe : describe.skip)("judge LLM integration seam (JUDGE_EVAL_LLM=1)", () => {
  it("parses a stubbed LLM route and clamps invalid agents to general", async () => {
    const { LLMJudge } = await import("../src/agents/judge");
    const stub = vi.mocked(generateText);
    stub.mockReset();

    stub.mockResolvedValueOnce({ text: '{"agent":"trading","confidence":0.77,"reason":"stub","needsConfirmation":true}' } as never);
    const judge = new LLMJudge({} as never);
    const d1 = await judge.route("some novel query with no fast-path trigger xyzzy");
    expect(d1.agent).toBe("trading");
    expect(d1.confidence).toBe(0.77);
    expect(d1.needsConfirmation).toBe(true);

    stub.mockResolvedValueOnce({ text: '{"agent":"nonsense-agent","confidence":2.5}' } as never);
    const d2 = await judge.route("another novel query with no fast-path trigger xyzzy");
    expect(d2.agent).toBe("general");
    expect(d2.confidence).toBeLessThanOrEqual(1);

    stub.mockRejectedValueOnce(new Error("model down"));
    const d3 = await judge.route("yet another novel query with no fast-path trigger xyzzy");
    expect(d3.agent).toBe("general");
    expect(d3.reason).toBe("General conversation fallback");
  });
});
