import { describe, expect, it } from "vitest";
import { generateSyntheticOptionChains } from "../src/trading/options/syntheticChains";
import { buildExportInput } from "../src/client/options/optionsDataExporter";
import { createRawOptionsIdeasXls, createRetrievedOptionsDataXls } from "../src/client/options/optionsIdeasExport";

describe("Options Data Exporter & Synthetic Fallback Chains", () => {
  it("generates realistic E*TRADE-compatible synthetic option chains for SPY", () => {
    const { expirations, chains } = generateSyntheticOptionChains("SPY");

    expect(expirations.length).toBe(3);
    expect(chains.length).toBe(3);

    const firstChain = chains[0];
    expect(firstChain.symbol).toBe("SPY");
    expect(firstChain.underlyingPrice).toBe(580);
    expect(firstChain.pairs.length).toBeGreaterThan(0);

    const firstPair = firstChain.pairs[0];
    expect(firstPair.call).toBeDefined();
    expect(firstPair.put).toBeDefined();
    expect(firstPair.call?.symbol).toContain("SPY");
    expect(firstPair.call?.delta).toBeGreaterThan(0);
    expect(firstPair.put?.delta).toBeLessThan(0);
    expect(firstChain.raw).toBeDefined();
    expect(firstChain.raw.OptionPair).toBeDefined();
  });

  it("buildExportInput synthesizes a fully conforming RawOptionsIdeasExport when llmInput is absent", async () => {
    const { expirations, chains } = generateSyntheticOptionChains("SPY");
    const retrievedData = {
      symbol: "SPY",
      question: "Retrieve complete raw option chains for SPY.",
      expirations,
      optionChains: chains.map((c) => c.raw ?? c),
    };

    const synthesized = buildExportInput("SPY", retrievedData, undefined);

    expect(synthesized.symbol).toBe("SPY");
    expect(synthesized.expirations).toEqual(expirations);
    expect(synthesized.optionChains.length).toBe(3);
    expect(synthesized.systemPrompt).toContain("expert options strategist");
    expect(synthesized.selection).toBeDefined();
    expect(synthesized.selection?.contractsAvailable).toBeGreaterThan(0);
    expect(synthesized.selection?.contractsIncluded).toBeGreaterThan(0);
    expect(synthesized.selection?.truncated).toBe(false);

    // Verify .xls binary workbook creation from synthesized input
    const xlsBytes = await createRawOptionsIdeasXls(synthesized);
    expect(xlsBytes).toBeInstanceOf(Uint8Array);
    expect(xlsBytes.length).toBeGreaterThan(0);
    // BIFF8 OLE header signature
    expect(xlsBytes.slice(0, 4)).toEqual(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]));
  });

  it("creates valid raw retrieved options data .xls workbook for SPY", async () => {
    const { expirations, chains } = generateSyntheticOptionChains("SPY");
    const retrievedData = {
      symbol: "SPY",
      question: "Retrieve complete raw option chains for SPY.",
      expirations,
      optionChains: chains.map((c) => c.raw ?? c),
    };

    const xlsBytes = await createRetrievedOptionsDataXls(retrievedData);
    expect(xlsBytes).toBeInstanceOf(Uint8Array);
    expect(xlsBytes.length).toBeGreaterThan(0);
    expect(xlsBytes.slice(0, 4)).toEqual(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]));
  });
});
