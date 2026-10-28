/**
 * Issue #2077 (#1804 S6) — the route-table-derived content switch.
 *
 * Chat's `<main>` region used to select tab content with 14 inline
 * `{tab === "x" && (...)}` conditionals, a second mechanism beside the
 * always-mounted trading hub. The switch is now one table-keyed lookup
 * (TAB_CONTENT[tab]) and these pins keep it that way:
 * - every ROUTES id resolves to a TAB_CONTENT key or a retained (hub) id;
 * - no per-tab conditional remains in the main region;
 * - the retained set is exactly the historical trading set (see #388).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ROUTES } from "../src/client/routes";
import { TRADING_TABS } from "../src/client/chat/types";

const here = dirname(fileURLToPath(import.meta.url));
const chatSrc = readFileSync(join(here, "..", "src", "client", "Chat.tsx"), "utf8").replace(/\r\n/g, "\n");

/** Keys of the TAB_CONTENT record, sliced out of Chat.tsx source. */
function tabContentKeys(src: string): string[] {
  const start = src.indexOf("const TAB_CONTENT");
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf("\n  };", start);
  expect(end).toBeGreaterThan(start);
  const slice = src.slice(start, end);
  return [...slice.matchAll(/^    "?([a-z0-9-]+)"?: \(/gm)].map((m) => m[1]);
}

const HISTORICAL_TRADING_IDS = [
  "autopilot",
  "ledger",
  "omnichannel",
  "options",
  "order",
  "orders",
  "portfolio",
  "reports",
  "scanner",
  "schedules",
  "screeners",
  "trading",
  "voice",
];

describe("route-table-derived content switch (#2077)", () => {
  it("every route id resolves to content or to the retained hub", () => {
    const keys = new Set(tabContentKeys(chatSrc));
    for (const route of ROUTES) {
      expect(
        keys.has(route.id) || TRADING_TABS.has(route.id),
        `route "${route.id}" has neither TAB_CONTENT entry nor retained hub`,
      ).toBe(true);
    }
  });

  it("the content keys are exactly the non-trading route ids", () => {
    const keys = tabContentKeys(chatSrc).sort();
    const expected = ROUTES.filter((r) => !TRADING_TABS.has(r.id))
      .map((r) => r.id)
      .sort();
    expect(keys).toEqual(expected);
  });

  it("no per-tab conditional remains in the main region", () => {
    const start = chatSrc.indexOf("{/* Main Tab Content */}");
    const end = chatSrc.indexOf("</main>", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(chatSrc.slice(start, end)).not.toContain('{tab === "');
  });

  it("the retained set is exactly the historical trading set (#388)", () => {
    expect([...TRADING_TABS].sort()).toEqual([...HISTORICAL_TRADING_IDS].sort());
  });

  it("the docs tab wires its existing panel (it rendered blank before)", () => {
    expect(tabContentKeys(chatSrc)).toContain("docs");
    expect(chatSrc).toContain('from "./DocsAndReportsPanel"');
  });
});
