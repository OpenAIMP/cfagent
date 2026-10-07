import { describe, expect, it } from "vitest";
import type { ETradeOptionChain, ETradeOptionExpireDate } from "../src/types";
import {
  buildContextLimitedRawOptionsIdeasInput,
  buildRawOptionsIdeasRankingPrompt,
  buildRawOptionsIdeasInput,
  parseRawOptionsIdeas,
  parseRawOptionsIdeasRanking,
  groupRawOptionsIdeasChains,
} from "../src/trading/options/llmIdeas";
import {
  createOptionsIdeasReportXls,
  createRawOptionsIdeasXls,
  createRetrievedOptionsDataXls,
} from "../src/client/optionsIdeasExport";

const expirations: ETradeOptionExpireDate[] = [{ year: 2026, month: 11, day: 20, expiryType: "REGULAR" }];
const chains: ETradeOptionChain[] = [{
  symbol: "NVDA",
  underlyingPrice: 180,
  raw: {
    nearPrice: 180,
    OptionPair: [{ Call: { symbol: "NVDA260120C00180000", OptionGreeks: { delta: 0.5 } } }],
  },
  pairs: [{
    call: { symbol: "NVDA260120C00180000", optionType: "CALL", strikePrice: 180, bid: 3, ask: 4, lastPrice: 3.5 },
  }],
}];

function llmResponse(answer: string, contractSymbols: string[] = []): string {
  return JSON.stringify({ answer, contractSymbols });
}

describe("Raw E*TRADE LLM options ideas", () => {
  it("sends complete raw chain JSON with the NLQ and no quant candidate analytics", () => {
    const input = buildRawOptionsIdeasInput("NVDA", "Find bullish, bearish, neutral, and directional ideas.", expirations, chains);
    expect(input.userPrompt).toContain(JSON.stringify(chains[0].raw));
    expect(input.userPrompt).toContain("naturalLanguageQuestion");
    expect(input.userPrompt).toContain("Find bullish, bearish, neutral, and directional ideas.");
    expect(input.userPrompt).not.toContain("quantGeneratedCandidates");
    expect(input.userPrompt).not.toContain("quantScore");
  });

  it("accepts exact contract references and reports unverifiable model references without losing the answer", () => {
    const parsed = parseRawOptionsIdeas(llmResponse(
      "The listed call has a 0.5 delta. Explain what additional information is needed to compare strategies.",
      ["NVDA260120C00180000"],
    ), chains);
    expect(parsed.answer).toContain("0.5 delta");
    expect(parsed.contractSymbols).toEqual(["NVDA260120C00180000"]);
    const invalidReference = parseRawOptionsIdeas(llmResponse("Invented contract.", ["INVENTED"]), chains);
    expect(invalidReference.contractSymbols).toEqual([]);
    expect(invalidReference.contractWarnings[0]).toContain("Omitted unverified contract reference");
  });

  it("maps human-readable LLM contract labels to one exact E*TRADE contract", () => {
    const expiringChains: ETradeOptionChain[] = [{
      ...chains[0],
      selectedExpiry: { year: 2026, month: 10, day: 5 },
      pairs: [{
        call: { ...chains[0].pairs[0].call!, symbol: "NVDA261005C00220000", strikePrice: 220 },
      }],
    }];
    const parsed = parseRawOptionsIdeas(
      llmResponse("The call is a possible fit.", ["NVDA Oct 05 '26 $220 Call"]),
      expiringChains,
    );
    expect(parsed.contractSymbols).toEqual(["NVDA261005C00220000"]);
    expect(parsed.contractWarnings).toEqual([]);
  });

  it("normalizes formatting-only symbol differences in the answer and contract list", () => {
    const chainWithActualExpiry: ETradeOptionChain[] = [{
      ...chains[0],
      selectedExpiry: { year: 2026, month: 10, day: 16 },
      pairs: [{
        put: { ...chains[0].pairs[0].call!, symbol: "NVDA261016P00230000", optionType: "PUT", strikePrice: 230 },
        call: { ...chains[0].pairs[0].call!, symbol: "NVDA261016C00230000", strikePrice: 230 },
      }],
    }];
    const parsed = parseRawOptionsIdeas(JSON.stringify({
      answer: "Sell NVDA--261016P00230000 and buy NVDA--261016C00230000.",
      contractSymbols: ["NVDA--261016P00230000", "NVDA--261016C00230000"],
    }), chainWithActualExpiry);

    expect(parsed.answer).toContain("NVDA261016P00230000");
    expect(parsed.answer).toContain("NVDA261016C00230000");
    expect(parsed.contractSymbols).toEqual(["NVDA261016P00230000", "NVDA261016C00230000"]);
    expect(parsed.contractWarnings).toEqual([]);
  });

  it("extracts verifiable contract symbols from the answer when the model omits them from its list", () => {
    const parsed = parseRawOptionsIdeas(JSON.stringify({
      answer: "Consider NVDA--261016C00230000.",
    }), [{
      ...chains[0],
      pairs: [{
        call: { ...chains[0].pairs[0].call!, symbol: "NVDA261016C00230000" },
      }],
    }]);

    expect(parsed.contractSymbols).toEqual(["NVDA261016C00230000"]);
    expect(parsed.contractWarnings).toEqual([]);
  });

  it("does not map ambiguous human-readable contract references", () => {
    const duplicateExpiry = {
      ...chains[0],
      selectedExpiry: { year: 2026, month: 10, day: 5 },
      pairs: [{
        call: { ...chains[0].pairs[0].call!, symbol: "NVDA261005C00220000", strikePrice: 220 },
      }],
    };
    const anotherChain = {
      ...duplicateExpiry,
      pairs: [{
        call: { ...chains[0].pairs[0].call!, symbol: "NVDA261005C00220001", strikePrice: 220 },
      }],
    };
    const parsed = parseRawOptionsIdeas(
      llmResponse("Possible call idea.", ["NVDA Oct 05 '26 $220 Call"]),
      [duplicateExpiry, anotherChain],
    );
    expect(parsed.contractSymbols).toEqual([]);
    expect(parsed.contractWarnings[0]).toContain("Omitted unverified contract reference");
  });

  it("groups chains by expiry horizon for independent LLM analysis", () => {
    const asOf = new Date("2026-10-01T12:00:00Z");
    const horizonExpirations: ETradeOptionExpireDate[] = [
      { year: 2026, month: 10, day: 20 },
      { year: 2026, month: 12, day: 1 },
      { year: 2027, month: 2, day: 5 },
    ];
    const horizonChains = horizonExpirations.map((expiry) => ({
      ...chains[0],
      selectedExpiry: { year: expiry.year, month: expiry.month, day: expiry.day },
    }));
    const groups = groupRawOptionsIdeasChains(horizonExpirations, horizonChains, asOf);

    expect(groups.map((group) => group.id)).toEqual(["near-term", "mid-term", "long-term"]);
    expect(groups.every((group) => group.optionChains.length === 1 && group.expirations.length === 1)).toBe(true);

    const afterMarketDate = groupRawOptionsIdeasChains(
      [{ year: 2026, month: 11, day: 1 }],
      [{ ...chains[0], selectedExpiry: { year: 2026, month: 11, day: 1 } }],
      new Date("2026-10-02T02:00:00Z"),
    );
    expect(afterMarketDate.map((group) => group.id)).toEqual(["mid-term"]);
  });

  it("requires the final cross-group ranking to include each completed group exactly once", () => {
    const response = {
      answer: "Near term best fits the requested outlook.",
      rankings: [
        { rank: 1, groupId: "near-term", strategy: "Call spread", rationale: "Best fit." },
        { rank: 2, groupId: "long-term", strategy: "Long call", rationale: "More time." },
      ],
    };
    expect(parseRawOptionsIdeasRanking(JSON.stringify(response), ["near-term", "long-term"]).rankings)
      .toHaveLength(2);
    expect(() => parseRawOptionsIdeasRanking(JSON.stringify({
      ...response,
      rankings: [response.rankings[0], { ...response.rankings[1], groupId: "invented" }],
    }), ["near-term", "long-term"])).toThrow("did not rank every completed expiration group");
  });

  it("includes every group outcome in the final-ranking request but ranks only successful groups", () => {
    const prompt = buildRawOptionsIdeasRankingPrompt("Find the strongest strategy.", [
      { id: "near-term", label: "Near-term", status: "complete", answer: "Call spread.", contractSymbols: [] },
      { id: "mid-term", label: "Mid-term", status: "error", error: "LLM failure." },
    ]);
    expect(prompt.userPrompt).toContain('"id":"mid-term"');
    expect(prompt.userPrompt).toContain('"error":"LLM failure."');
    expect(prompt.userPrompt).toContain("Rank these completed group IDs exactly once: near-term.");
    expect(prompt.systemPrompt).toContain("Failed groups have no winner");
    expect(prompt.userPrompt).not.toContain("quantGeneratedCandidates");
    expect(prompt.userPrompt).not.toContain("quantScore");
  });

  it("exports the exact system prompt, user prompt, and full JSON payload as legacy .xls", async () => {
    const input = buildRawOptionsIdeasInput("NVDA", "Explain scenario strategies.", expirations, chains);
    const bytes = await createRawOptionsIdeasXls(input);
    const XLSX = await import("@e965/xlsx");
    const workbook = XLSX.read(bytes, { type: "array" });
    expect(bytes.slice(0, 4)).toEqual(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]));
    expect(workbook.SheetNames).toEqual(["Request", "LLM System Prompt", "LLM User Prompt", "Complete Input JSON"]);
    const readChunks = (sheetName: string) =>
      (XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1 }) as string[][])
        .slice(1)
        .map((row) => row[1])
        .join("");
    expect(readChunks("LLM System Prompt")).toBe(input.systemPrompt);
    expect(readChunks("LLM User Prompt")).toBe(input.userPrompt);
    const exportedInput = JSON.parse(readChunks("Complete Input JSON"));
    expect(exportedInput.etrade.optionChains[0]).toEqual(chains[0].raw);
    expect(exportedInput.dataCoverage).toEqual({
      contractsAvailable: 1,
      contractsIncluded: 1,
      truncated: false,
    });
  });

  it("exports every expiration-group LLM input and final-ranking prompt", async () => {
    const input = buildRawOptionsIdeasInput("NVDA", "Analyze near term.", expirations, chains);
    const bytes = await createRawOptionsIdeasXls({
      ...input,
      question: "Compare expiration groups.",
      groupInputs: [{
        id: "near-term",
        label: "Near-term",
        symbol: "NVDA",
        question: "Analyze near term.",
        expirations,
        optionChains: chains.map((chain) => chain.raw),
        systemPrompt: input.systemPrompt,
        userPrompt: input.userPrompt,
        selection: input.selection,
      }],
      finalRanking: { systemPrompt: "Rank group winners.", userPrompt: "Rank near-term." },
    });
    const XLSX = await import("@e965/xlsx");
    const workbook = XLSX.read(bytes, { type: "array" });
    const readChunks = (sheetName: string) =>
      (XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1 }) as string[][])
        .slice(1)
        .map((row) => row[1])
        .join("");
    expect(JSON.parse(readChunks("Complete Input JSON")).groupInputs[0].groupId).toBe("near-term");
    expect(readChunks("LLM System Prompt")).toContain("Rank group winners.");
    expect(readChunks("LLM User Prompt")).toContain("Rank near-term.");
  });

  it("fits a context budget while preserving expiration coverage and prioritizing near-the-money contracts", () => {
    const manyExpirations = Array.from({ length: 4 }, (_, expirationIndex) => ({
      year: 2026,
      month: 11 + expirationIndex,
      day: 20,
      expiryType: "REGULAR",
    }));
    const manyChains: ETradeOptionChain[] = manyExpirations.map((expiry, expirationIndex) => {
      const optionPairs = Array.from({ length: 24 }, (_, pairIndex) => {
        const strike = 80 + pairIndex * 2;
        const callSymbol = `NVDA${String(expiry.month).padStart(2, "0")}${String(pairIndex).padStart(2, "0")}C${String(strike * 1000).padStart(8, "0")}`;
        const putSymbol = callSymbol.replace("C", "P");
        return {
          Call: { symbol: callSymbol, strikePrice: strike, volume: pairIndex, openInterest: pairIndex, description: "x".repeat(80) },
          Put: { symbol: putSymbol, strikePrice: strike, volume: pairIndex, openInterest: pairIndex, description: "y".repeat(80) },
        };
      });
      return {
        symbol: "NVDA",
        underlyingPrice: 102,
        raw: { SelectedED: expiry, nearPrice: 102, OptionPair: optionPairs },
        pairs: optionPairs.map((pair) => ({
          call: { optionType: "CALL" as const, symbol: pair.Call.symbol, strikePrice: pair.Call.strikePrice, bid: 1, ask: 2, lastPrice: 1.5, volume: pair.Call.volume, openInterest: pair.Call.openInterest },
          put: { optionType: "PUT" as const, symbol: pair.Put.symbol, strikePrice: pair.Put.strikePrice, bid: 1, ask: 2, lastPrice: 1.5, volume: pair.Put.volume, openInterest: pair.Put.openInterest },
        })),
      };
    });
    const fullInput = buildRawOptionsIdeasInput("NVDA", "Compare ideas.", manyExpirations, manyChains);
    const fullTokenEstimate = Math.ceil(new TextEncoder().encode(fullInput.systemPrompt + fullInput.userPrompt).length * 0.8);
    const result = buildContextLimitedRawOptionsIdeasInput(
      "NVDA",
      "Compare ideas.",
      manyExpirations,
      manyChains,
      Math.floor(fullTokenEstimate / 2),
    );

    expect(result.truncated).toBe(true);
    expect(result.estimatedInputTokens).toBeLessThanOrEqual(Math.floor(fullTokenEstimate / 2));
    expect(result.input.expirations).toHaveLength(manyExpirations.length);
    expect(result.input.optionChains).toHaveLength(manyChains.length);
    expect(result.includedContractCount).toBeLessThan(4 * 24 * 2);
    for (const chain of result.input.optionChains) expect(chain.pairs.length).toBeGreaterThan(0);
    expect(result.input.optionChains[0].pairs.some((pair) => pair.call?.strikePrice === 102)).toBe(true);
  });

  it("exports every retrieved raw chain separately from the context-limited prompt", async () => {
    const bytes = await createRetrievedOptionsDataXls({
      symbol: "NVDA",
      question: "Compare ideas.",
      expirations,
      optionChains: chains,
    });
    const XLSX = await import("@e965/xlsx");
    const workbook = XLSX.read(bytes, { type: "array" });
    expect(workbook.SheetNames).toEqual(["Request", "Retrieved Raw JSON"]);
    const json = (XLSX.utils.sheet_to_json(workbook.Sheets["Retrieved Raw JSON"], { header: 1 }) as string[][])
      .slice(1)
      .map((row) => row[1])
      .join("");
    expect(JSON.parse(json).etrade.optionChains).toEqual([chains[0].raw]);
  });

  it("exports group evaluations and final ranking as an Excel report", async () => {
    const bytes = await createOptionsIdeasReportXls({
      symbol: "NVDA",
      question: "Compare expiration groups.",
      dataCoverage: { expirationCount: 3, chainCount: 3, contractCount: 120, sentContractCount: 80, inputTruncated: true },
      groups: [{
        id: "near-term",
        label: "Near-term (0–30 DTE)",
        status: "complete",
        answer: "A call spread is strongest.",
        contractSymbols: ["NVDA260120C00180000"],
        contractDetails: [{
          symbol: "NVDA260120C00180000",
          expiration: "2026-01-20",
          contract: chains[0].pairs[0].call!,
        }],
        expirationCount: 1,
        contractCount: 40,
        sentContractCount: 30,
        inputTruncated: true,
      }],
      finalAnalysis: {
        status: "complete",
        answer: "Near-term ranks first.",
        rankings: [{ rank: 1, groupId: "near-term", strategy: "Call spread", rationale: "Fits the outlook." }],
      },
    });
    const XLSX = await import("@e965/xlsx");
    const workbook = XLSX.read(bytes, { type: "array" });
    expect(workbook.SheetNames).toEqual(["Summary", "Group Evaluations", "Verified Contracts", "Cross-Group Ranking"]);
    expect(XLSX.utils.sheet_to_json(workbook.Sheets["Verified Contracts"], { header: 1 }))
      .toContainEqual([
        "Near-term (0–30 DTE)",
        "2026-01-20",
        "NVDA260120C00180000",
        "CALL",
        180,
        3,
        4,
        3.5,
      ]);
    expect(XLSX.utils.sheet_to_json(workbook.Sheets["Cross-Group Ranking"], { header: 1 }))
      .toContainEqual(["1", "Near-term (0–30 DTE)", "Call spread", "Fits the outlook."]);
  });

  it("converts a candidate strategy to a holistic StrategyToEvaluate object for LLM evaluation", async () => {
    const { candidateToEval } = await import("../src/client/OptionsResearchPanel");
    const mockCandidate = {
      id: "nvda-bull-call-1",
      symbol: "NVDA",
      label: "Bull Call Spread",
      type: "bull_call_spread" as const,
      category: "vertical_spread",
      underlyingPrice: 180,
      expirationDate: "2026-11-20",
      netDebit: 3.5,
      maxLoss: 350,
      maxProfit: 650,
      maxProfitUnbounded: false,
      breakevens: [183.5],
      modelImpliedProbabilityOfProfit: 0.62,
      targetPnl: 450,
      targetRewardRisk: 1.85,
      liquidityScore: 88,
      rank: 1,
      score: 84.5,
      dataFreshness: "FRESH" as const,
      legs: [
        { symbol: "NVDA261120C00180000", side: "BUY" as const, quantity: 1, strike: 180, expirationDate: "2026-11-20", optionType: "CALL" as const, bid: 5, ask: 5.5, entryPrice: 5.25 },
        { symbol: "NVDA261120C00190000", side: "SELL" as const, quantity: 1, strike: 190, expirationDate: "2026-11-20", optionType: "CALL" as const, bid: 1.7, ask: 1.8, entryPrice: 1.75 },
      ],
      scenarios: [{ daysToExpiry: 30, ivChangePct: 0, underlyingPrice: 185, pnl: 200 }],
      payoffCurve: [{ underlyingPrice: 170, pnl: -350 }, { underlyingPrice: 195, pnl: 650 }],
      netGreeks: { delta: 0.35, gamma: 0.02, theta: -0.05, vega: 0.08 },
      scoreBreakdown: { thesisAlignment: 90, targetRewardRisk: 85, liquidity: 88, volatilityAlignment: 75, thetaBurden: 80, freshness: 100 },
      explanations: ["Defined-risk trade with positive leverage."],
      warnings: [],
      assumptions: ["Modeled using live Black-Scholes formulas."],
    };

    const evalTarget = candidateToEval(mockCandidate, "bullish", 200);
    expect(evalTarget.symbol).toBe("NVDA");
    expect(evalTarget.strategyName).toBe("Bull Call Spread");
    expect(evalTarget.sentiment).toBe("bullish");
    expect(evalTarget.targetPrice).toBe(200);
    expect(evalTarget.expirationDate).toBe("2026-11-20");
    expect(evalTarget.dte).toBe(30);
    expect(evalTarget.netDebit).toBe(3.5);
    expect(evalTarget.maxLoss).toBe(350);
    expect(evalTarget.maxProfit).toBe(650);
    expect(evalTarget.chanceOfProfit).toBe(62);
    expect(evalTarget.breakevenText).toBe("Above $183.50");
    expect(evalTarget.legsText).toContain("BUY 1 NVDA261120C00180000");
    expect(evalTarget.legsText).toContain("SELL 1 NVDA261120C00190000");
  });
});
