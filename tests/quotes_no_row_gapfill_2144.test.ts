/**
 * Issue #2144: Yahoo must not gap-fill live quote ROWS in a realtime
 * system. It may fill COLUMNS (technicals/history inside an E*TRADE
 * row), never a whole symbol's live quote.
 *
 * The sharded assemble step uses E*TRADE quotes only. A Yahoo sibling
 * row carrying legacy gapFillQuotes — stored by a pre-fix chain that
 * is still in flight when the fix deploys — is ignored, not merged
 * into the report. E*TRADE-missed symbols go missing honestly.
 */

import { describe, expect, it } from "vitest";
import { executeShardJob } from "../src/services/shardExecutors";

const etradeQuote = {
  symbol: "AAPL",
  companyName: "Apple, Inc.",
  lastPrice: 200,
  price: 200,
  change: 3,
  changePercent: 1.5,
  previousClose: 197,
  bid: 199.95,
  ask: 200.05,
  volume: 1000000,
  averageVolume: 900000,
  open: 198,
  high: 201,
  low: 197,
  week52High: 250,
  week52Low: 150,
  peRatio: 30,
  sector: "Technology",
  source: "E*TRADE live",
  quoteStatus: "LIVE",
};

// Legacy Yahoo gap-fill row shape, as stored by pre-fix feedYahoo
// (yahooQuoteToPipelineQuote output).
const yahooGapFillRow = {
  symbol: "MSFT",
  companyName: "Microsoft Corporation",
  lastPrice: 300,
  price: 300,
  change: -6,
  changePercent: -2,
  previousClose: 306,
  volume: 500000,
  open: 305,
  high: 306,
  low: 299,
  source: "Yahoo Finance",
};

function sqlRow(stage: string, key: string, result: unknown) {
  return {
    job_id: `job-${key}`,
    stage,
    status: "completed",
    payload_json: JSON.stringify({ shard: { stage, key } }),
    result_json: JSON.stringify(result),
    error: null,
    created_at: "2026-10-28T12:00:00.000Z",
    parent_job_id: null,
  };
}

describe("assemble ignores Yahoo gap-fill rows (issue #2144)", () => {
  it("uses E*TRADE quotes only, even when the Yahoo sibling carries legacy gapFillQuotes", async () => {
    const rows = [
      // The assemble gate requires all three feed shards completed.
      sqlRow("feed", "nasdaq", { listings: [] }),
      sqlRow("feed", "etrade", { quotes: [etradeQuote] }),
      sqlRow("feed", "yahoo", {
        gapFillQuotes: [yahooGapFillRow],
        technicals: [],
      }),
    ];
    const deps = {
      sql: { exec: () => rows },
      env: {},
      orm: {},
      sessionId: "session-1",
    };
    const result = (await executeShardJob(deps as never, {
      shard: { stage: "generate", key: "assemble" },
      chain: {
        chainId: "chain-1",
        universe: "NASDAQ100",
        userLogin: "u1",
        trigger: "scheduled",
        timestamp: "2026-10-28T12:30:00.000Z",
        channels: ["slack"],
      },
    } as never)) as {
      allStocks: Array<{ symbol: string; source?: string }>;
    };
    const symbols = result.allStocks.map((s) => s.symbol);
    expect(symbols).toContain("AAPL");
    expect(symbols).not.toContain("MSFT");
    expect(result.allStocks.every((s) => s.source !== "Yahoo Finance")).toBe(
      true
    );
  });
});
