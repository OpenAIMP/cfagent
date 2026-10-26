/**
 * Issue #162: QA failure investigation via the model router.
 *
 * Pinned here:
 * - a well-formed LLM response is parsed into a structured investigation;
 * - when all models fail, a fallback investigation is returned (never throws);
 * - the router falls back across models on retryable errors.
 *
 * #1741: failover moved from runWithRouting into the gateway port.
 * The tests pass a fake AI binding because the gateway factory
 * refuses an unbound binding (the old path called generateText
 * with an undefined binding and relied on the mock to absorb it).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return { ...actual, generateText: vi.fn() };
});

import { generateText } from "ai";
import { investigateQAFailure } from "../src/qa/investigate";
import { MODEL_CHAINS } from "../src/models/router";

const generateTextMock = vi.mocked(generateText);

// Fake AI binding: satisfies the gateway factory's run-function
// guard. The mocked generateText intercepts before binding.run.
const ENV = { AI: { run: async () => ({}) } };
const failure = {
  operation: "api-search",
  errorClass: "http_500",
  detail: "POST /api/search returned 500 for 3 consecutive probes",
  runLink: "https://example.com/run/1",
};

beforeEach(() => {
  generateTextMock.mockReset();
});

describe("investigateQAFailure (#162)", () => {
  it("parses a well-formed LLM response", async () => {
    generateTextMock.mockResolvedValue({
      text: JSON.stringify({
        diagnosis: "The search endpoint throws on empty queries.",
        likelyCause: "Missing null guard in the query parser.",
        proposedFix: "Add a null check in src/search.ts and add a regression test.",
        confidence: 0.85,
      }),
    } as any);
    const result = await investigateQAFailure(ENV as any, failure);
    expect(result.diagnosis).toContain("empty queries");
    expect(result.likelyCause).toContain("null guard");
    expect(result.proposedFix).toContain("src/search.ts");
    expect(result.confidence).toBe(0.85);
    expect(result.model).toBe(MODEL_CHAINS.plan.cheap);
  });

  it("falls back across models on retryable errors", async () => {
    generateTextMock
      .mockRejectedValueOnce(Object.assign(new Error("overloaded"), { code: 429 }))
      .mockResolvedValueOnce({
        text: JSON.stringify({
          diagnosis: "d",
          likelyCause: "c",
          proposedFix: "f",
          confidence: 0.7,
        }),
      } as any);
    const result = await investigateQAFailure(ENV as any, failure);
    expect(generateTextMock).toHaveBeenCalledTimes(2);
    expect(result.model).toBe(MODEL_CHAINS.plan.primary);
    expect(result.confidence).toBe(0.7);
  });

  it("returns a fallback investigation when all models fail", async () => {
    generateTextMock.mockRejectedValue(new Error("all down"));
    const result = await investigateQAFailure(ENV as any, failure);
    expect(result.diagnosis).toContain("api-search");
    expect(result.confidence).toBe(0);
    expect(result.model).toBe("none");
    expect(result.proposedFix).toContain("https://example.com/run/1");
  });
});
