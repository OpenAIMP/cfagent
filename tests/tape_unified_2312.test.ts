/**
 * One canonical tape (#2312, follow-up to #2230): the landing tape and
 * the in-app tape default are the same symbol list, from the single
 * `TAPE_SYMBOLS` source, over the single TickerAgent feed. If either
 * surface drifts again, this test fails.
 *
 * The landing page renders its tape items twice (the marquee loops),
 * so every union label must appear exactly twice as a `.ticker-sym`.
 * The app default preset derives from `TAPE_SYMBOLS`, so it must equal
 * the same union in the same order.
 */
import { describe, it, expect } from "vitest";
import { renderLandingPage } from "../src/client/landing";
import { TAPE_SYMBOLS } from "../src/client/quotes/symbolSets";
import { TAPE_PRESETS } from "../src/client/quotes/symbolSetResolver";

const UNION_SYMBOLS = [
  "SPY",
  "QQQ",
  "DIA",
  "IWM",
  "^VIX",
  "^TNX",
  "NVDA",
  "AAPL",
  "MSFT",
  "TSLA",
  "BTC/USD",
  "ETH/USD",
  "SOL/USD",
];

const UNION_LABELS = [
  "S&P 500",
  "NASDAQ 100",
  "DOW JONES",
  "RUSSELL 2000",
  "CBOE VIX",
  "US 10Y YIELD",
  "NVDA",
  "AAPL",
  "MSFT",
  "TSLA",
  "BTC / USD",
  "ETH / USD",
  "SOL / USD",
];

function landingTapeLabels(): string[] {
  const html = renderLandingPage("Test").replace(/&amp;/g, "&");
  const labels: string[] = [];
  const re = /<span class="ticker-sym">([^<]+)<\/span>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) labels.push(match[1]);
  return labels;
}

describe("one canonical tape (#2312)", () => {
  it("TAPE_SYMBOLS is the 13-symbol union, in order", () => {
    expect(TAPE_SYMBOLS.map((t) => t.symbol)).toEqual(UNION_SYMBOLS);
  });

  it("the app default preset is the same union", () => {
    expect(TAPE_PRESETS.default).toEqual(UNION_SYMBOLS);
  });

  it("the landing tape renders exactly the union labels, twice (marquee loop)", () => {
    const labels = landingTapeLabels();
    expect([...labels].sort()).toEqual([...UNION_LABELS, ...UNION_LABELS].sort());
    for (const label of UNION_LABELS) {
      expect(labels.filter((l) => l === label)).toHaveLength(2);
    }
  });

  it("every union symbol is subscribed by the landing updater", () => {
    const html = renderLandingPage("Test");
    for (const symbol of UNION_SYMBOLS) {
      expect(html).toContain(`"${symbol}"`);
    }
  });
});
