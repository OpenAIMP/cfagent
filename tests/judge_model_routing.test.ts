/**
 * Issue #163: the live judge's model calls route through the model router
 * (cheap → primary → fallback on retryable errors).
 *
 * Pinned here:
 * - route() and evaluate() retry on 429/quota errors with the next model
 *   in the chain;
 * - after all three models fail, the existing graceful fallbacks still apply;
 * - non-retryable errors do not retry.
 *
 * #1741: failover moved from runWithRouting into the gateway port.
 * The tests now observe the modelId of the Workers AI model object
 * the port's executor hands to generateText (instead of the old
 * getWorkersAIModel routedName marker), and pass a fake AI binding
 * because the gateway factory refuses an unbound binding (the old
 * path called generateText with an undefined binding and relied
 * on the mock to absorb it).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return { ...actual, generateText: vi.fn() };
});

import { generateText } from "ai";
import { LLMJudge } from "../src/agents/judge";
import { MODEL_CHAINS } from "../src/models/router";

const generateTextMock = vi.mocked(generateText);

// Fake AI binding: satisfies the gateway factory's run-function
// guard. The mocked generateText intercepts before binding.run.
const ENV = { AI: { run: async () => ({}) } };

const retryableError = () => {
  const err: any = new Error("Rate limited");
  err.code = 429;
  return err;
};

const modelsSeen = () =>
  generateTextMock.mock.calls.map((c: any) => c[0].model.modelId);

beforeEach(() => {
  generateTextMock.mockReset();
});

describe("LLMJudge model routing (#163)", () => {
  it("route() falls back to the next model on a retryable error", async () => {
    generateTextMock
      .mockRejectedValueOnce(retryableError())
      .mockResolvedValueOnce({
        text: JSON.stringify({ agent: "trading", confidence: 0.9, reason: "test" }),
      } as any);
    const judge = new LLMJudge(ENV as any);
    // No fast-path heuristic matches this text, so it reaches generateText.
    const decision = await judge.route("xyzzy quux flibbertigibbet");
    expect(decision.agent).toBe("trading");
    expect(decision.confidence).toBe(0.9);
    expect(generateTextMock).toHaveBeenCalledTimes(2);
    expect(modelsSeen()).toEqual([MODEL_CHAINS.plan.cheap, MODEL_CHAINS.plan.primary]);
  });

  it("evaluate() falls back to the next model on a quota error", async () => {
    generateTextMock
      .mockRejectedValueOnce(Object.assign(new Error("quota exceeded"), { code: 4006 }))
      .mockResolvedValueOnce({
        text: JSON.stringify({ score: 90, grounded: true, safe: true, issues: [] }),
      } as any);
    const judge = new LLMJudge(ENV as any);
    const quality = await judge.evaluate({ question: "q", answer: "a", agent: "general" });
    expect(quality.score).toBe(90);
    expect(generateTextMock).toHaveBeenCalledTimes(2);
    expect(modelsSeen()).toEqual([MODEL_CHAINS.judge.cheap, MODEL_CHAINS.judge.primary]);
  });

  it("uses the graceful fallback after all three models fail", async () => {
    generateTextMock.mockRejectedValue(retryableError());
    const judge = new LLMJudge(ENV as any);
    const decision = await judge.route("xyzzy quux flibbertigibbet");
    expect(decision.agent).toBe("general");
    expect(generateTextMock).toHaveBeenCalledTimes(3);
    expect(modelsSeen()).toEqual([
      MODEL_CHAINS.plan.cheap,
      MODEL_CHAINS.plan.primary,
      MODEL_CHAINS.plan.fallback,
    ]);

    generateTextMock.mockReset();
    generateTextMock.mockRejectedValue(retryableError());
    const quality = await judge.evaluate({ question: "q", answer: "a", agent: "general" });
    expect(quality.score).toBe(75);
    expect(quality.issues).toEqual(["Automated evaluation skipped due to judge timeout or rate limit"]);
  });

  it("does not retry non-retryable errors", async () => {
    generateTextMock.mockRejectedValue(new Error("plain failure"));
    const judge = new LLMJudge(ENV as any);
    const decision = await judge.route("xyzzy quux flibbertigibbet");
    expect(decision.agent).toBe("general");
    expect(generateTextMock).toHaveBeenCalledTimes(1);
  });
});
