import { describe, expect, it } from "vitest";
import type { ETradeOptionChain, ETradeOptionExpireDate } from "../src/types";
import {
  buildContextLimitedRawOptionsIdeasInput,
  buildRawOptionsIdeasInput,
  parseRawOptionsIdeas,
} from "../src/trading/options/llmIdeas";
import { createRawOptionsIdeasXls, createRetrievedOptionsDataXls } from "../src/client/optionsIdeasExport";

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

  it("accepts answers tailored to arbitrary questions and validates referenced contract symbols", () => {
    const parsed = parseRawOptionsIdeas(llmResponse(
      "The listed call has a 0.5 delta. Explain what additional information is needed to compare strategies.",
      ["NVDA260120C00180000"],
    ), chains);
    expect(parsed.answer).toContain("0.5 delta");
    expect(parsed.contractSymbols).toEqual(["NVDA260120C00180000"]);
    expect(() => parseRawOptionsIdeas(llmResponse("Invented contract.", ["INVENTED"]), chains))
      .toThrow("not present in E*TRADE data");
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
});
