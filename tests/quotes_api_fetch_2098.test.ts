/**
 * Issue #2098 (as moved by #2100) — one quotes feed, through apiFetch.
 *
 * #2098 pinned the two quotes consumers to the apiFetch import. #2100
 * moved the feed lifecycle into src/client/quotes/quotesService.ts, so
 * the pin moves with it: the service is the only place that touches the
 * quotes endpoints, and it binds the REST fallback to apiFetch (rule
 * #71 — a 202 async-job stub must resolve, never reach the UI). The
 * consumers must contain no socket, no poller, and no fetch at all —
 * they render what useMarketQuotes returns.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const service = "src/client/quotes/quotesService.ts";
const consumers = [
  "src/client/components/MarketTickerTape.tsx",
  "src/client/components/StockSearchBar.tsx",
];

describe("single quotes feed through apiFetch (#2098, #2100)", () => {
  it("the service binds its REST fallback to the apiFetch import", () => {
    const src = readFileSync(join(here, "..", service), "utf8");
    expect(src).toContain('import { apiFetch } from "../apiFetch"');
    expect(src).toContain("apiFetch(`/api/market/quotes?");
    expect(src).not.toContain("globalThis.fetch");
    expect(src).not.toContain("window.fetch");
  });

  it.each(consumers)("%s renders via useMarketQuotes", (file) => {
    const src = readFileSync(join(here, "..", file), "utf8");
    expect(src).toContain('useMarketQuotes } from "../quotes/useMarketQuotes"');
  });

  it.each(consumers)("%s owns no socket, poller, or fetch", (file) => {
    const src = readFileSync(join(here, "..", file), "utf8");
    expect(src).not.toContain("new WebSocket");
    expect(src).not.toContain("/api/market/quotes");
    expect(src).not.toContain("setInterval");
    expect(src).not.toContain("fetch(");
  });
});
