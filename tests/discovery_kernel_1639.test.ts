/**
 * #1639 (§1 discovery kernel, parent #1638) — remaining gaps after #1256.
 *
 * - D8: a standalone RecommendationService entry for the kernel's
 *   LlmIdeaBuilder (before this slice it existed only inside the 3-way
 *   comparison arms), with the same gate / price / falsify honesty as
 *   every other kernel path: an LLM candidate with no falsification
 *   evidence lands at most Unverified, never silently qualified.
 * - D8: the llmIdeas raw generator's response maps onto the builder's
 *   LlmGeneratorResponse contract, so generateRawOptionsIdeas can feed
 *   LlmIdeaBuilder without the kernel ever calling an LLM itself.
 * - D7: the client strategyDiscoveryEngine module states its own
 *   disposition — modeling layer for legs the user is editing, never
 *   the engine of record (the server panel path is). The module must
 *   contain no server fetch: a modeling layer cannot rank of record.
 * - D5: the facade's llm_ideas notice no longer claims LLM generation
 *   is "retired" — the kernel LLM entry is the live target path.
 *
 * No real LLM is ever called here: every LLM-facing seam takes an
 * injected stub generator.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  RecommendationService,
  type KernelSnapshot,
  type LlmGeneratorResponse,
} from "../src/services/recommendationKernel";
import {
  mapRawOptionsIdeasToLlmGeneratorResponse,
  type RawOptionsIdeasResponse,
} from "../src/trading/options/llmIdeas";

const EXPIRY = "2026-12-18";
const NOW = Date.now();

function snapshot(): KernelSnapshot {
  return {
    symbol: "AAA",
    dataSource: "live",
    chainProvenance: "live",
    underlyingPrice: 100,
    quotes: {
      "AAA:20261218:C100": { bid: 2.0, ask: 2.2, iv: 0.3, volume: 100, openInterest: 200 },
    },
  };
}

function stubResponse(): LlmGeneratorResponse {
  return {
    model: "stub-llm",
    answer: "A long call expresses upside with defined risk for a bullish outlook on AAA, with the strike near spot and about seven weeks to expiry.",
    contractSymbols: ["AAA:20261218:C100", "AAA:20261218:C999"],
    contractDetails: [
      {
        symbol: "AAA:20261218:C100",
        expiration: EXPIRY,
        contract: { optionType: "CALL", strikePrice: 100, symbol: "AAA:20261218:C100", bid: 2.0, ask: 2.2, impliedVolatility: 0.3, volume: 100, openInterest: 200 },
      },
      {
        symbol: "AAA:20261218:C999",
        expiration: EXPIRY,
        contract: { optionType: "CALL", strikePrice: 999, symbol: "AAA:20261218:C999", bid: 0, ask: 0 },
      },
    ],
  };
}

describe("RecommendationService.discoverLlmIdeas (#1639, D8)", () => {
  it("runs LLM candidates through the kernel template method in generation order", async () => {
    const result = await new RecommendationService().discoverLlmIdeas({
      snapshot: snapshot(),
      request: { symbol: "AAA", thesis: "bullish" },
      generateFn: async () => stubResponse(),
      model: "stub-llm",
      temperature: 0,
      gateContext: {
        quote: { price: 100, timestamp: NOW, source: "test" },
        chain: { underlyingPrice: 100, asOf: NOW, provenance: "live" },
      },
    });
    expect(result.attrition.generated).toBe(2);
    // The priced idea survives, ranked first in generation order.
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].id).toBe("llm:AAA:20261218:C100");
    expect(result.candidates[0].provenance).toBe("llm");
    expect(result.candidates[0].builderId).toBe("llm-idea");
    expect(result.candidates[0].model).toBe("stub-llm");
    expect(result.candidates[0].economics).not.toBeNull();
    expect(result.candidates[0].rank).toBe(1);
    // Honesty: no falsification evidence ⇒ at most Unverified, never qualified.
    expect(result.candidates[0].status).toBe("unverified");
    // The unpriceable idea has no legs at all, so the contract-integrity
    // gate rejects it outright (recorded in rejected, never fabricated
    // into a candidate) — the kernel does not carry legless ideas as
    // Unverified candidates.
    expect(result.rejected.map((r) => r.id)).toContain("llm:AAA:20261218:C999");
  });

  it("an empty generation yields no candidates and records the limitation", async () => {
    const result = await new RecommendationService().discoverLlmIdeas({
      snapshot: snapshot(),
      request: { symbol: "AAA", thesis: "bullish" },
      generateFn: async () => ({ answer: "No idea.", contractSymbols: [], contractDetails: [] }),
    });
    expect(result.candidates).toHaveLength(0);
    expect(result.attrition.generated).toBe(0);
    expect(result.limitations.some((l) => /LlmIdeaBuilder/i.test(l))).toBe(true);
  });
});

describe("llmIdeas → LlmIdeaBuilder mapping (#1639, D8)", () => {
  it("maps a RawOptionsIdeasResponse onto the builder contract, field for field", () => {
    const raw: RawOptionsIdeasResponse = {
      model: "stub-llm",
      answer: "A long call expresses upside.",
      contractSymbols: ["AAA:20261218:C100"],
      contractWarnings: [],
      contractDetails: [
        {
          symbol: "AAA:20261218:C100",
          expiration: EXPIRY,
          contract: { optionType: "CALL", strikePrice: 100, symbol: "AAA:20261218:C100", bid: 2.0, ask: 2.2, lastPrice: 2.1, impliedVolatility: 0.3, volume: 10, openInterest: 20 },
        },
      ],
    };
    const mapped = mapRawOptionsIdeasToLlmGeneratorResponse(raw);
    expect(mapped.model).toBe("stub-llm");
    expect(mapped.answer).toBe("A long call expresses upside.");
    expect(mapped.contractSymbols).toEqual(["AAA:20261218:C100"]);
    expect(mapped.contractDetails).toHaveLength(1);
    expect(mapped.contractDetails![0].contract.strikePrice).toBe(100);
    expect(mapped.contractDetails![0].contract.bid).toBe(2.0);
    // And the mapped response feeds the builder unchanged (priced via snapshot quotes).
    expect(mapped.contractDetails![0].expiration).toBe(EXPIRY);
  });
});

describe("client strategyDiscoveryEngine disposition (#1639, D7)", () => {
  it("the module declares itself a modeling layer, not an engine of record, and fetches nothing", () => {
    const src = readFileSync(join(__dirname, "../src/client/options/strategyDiscoveryEngine.ts"), "utf8");
    expect(src).toMatch(/#1639/);
    expect(src).toMatch(/modeling layer/i);
    expect(src).toMatch(/not an engine of record/i);
    expect(src).not.toMatch(/apiFetch|fetch\(|XMLHttpRequest/);
    const server = readFileSync(join(__dirname, "../src/client/options/serverDiscovery.ts"), "utf8");
    expect(server).toMatch(/fetchServerDiscovery/);
  });
});

describe("UnifiedOptionsService llm_ideas notice (#1639, D5)", () => {
  it("no longer claims LLM generation is retired; it points at the kernel LLM entry", () => {
    const src = readFileSync(join(__dirname, "../src/trading/options/unifiedOptionsService.ts"), "utf8");
    expect(src).not.toMatch(/llm_ideas retired as an independent recommender/);
    expect(src).toMatch(/discoverLlmIdeas/);
  });
});
