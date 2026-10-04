import { describe, expect, it } from "vitest";
import type { ETradeOptionChain, ETradeOptionExpireDate } from "../src/types";
import { buildRawOptionsIdeasInput, parseRawOptionsIdeas } from "../src/trading/options/llmIdeas";
import { createRawOptionsIdeasXls } from "../src/client/optionsIdeasExport";

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
  });
});
