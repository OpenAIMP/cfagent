/**
 * Generic `view` query-param helpers (#1804 S2, issue #2027): the inner
 * view of a page lives in `?view=<id>`, alongside the page's `?tab=<id>`.
 * Pure functions only — no window needed. Validation is the caller's job
 * (each page owns its view ids), so an unknown or missing view is null
 * and the caller falls back to its default.
 */
import { describe, it, expect } from "vitest";
import { parseViewFromSearch, buildSearchWithView } from "../src/client/router";

const isValid = (v: unknown): v is string =>
  typeof v === "string" && ["stocks", "options", "summary"].includes(v);

describe("router view param", () => {
  it("reads the view from ?view= when valid", () => {
    expect(parseViewFromSearch("?view=stocks", isValid)).toBe("stocks");
    expect(parseViewFromSearch("?tab=screeners&view=options", isValid)).toBe("options");
  });

  it("returns null for unknown or missing views", () => {
    expect(parseViewFromSearch("?view=bogus", isValid)).toBeNull();
    expect(parseViewFromSearch("?tab=screeners", isValid)).toBeNull();
    expect(parseViewFromSearch("", isValid)).toBeNull();
  });

  it("sets ?view= while preserving every other param", () => {
    expect(buildSearchWithView("", "stocks")).toBe("?view=stocks");
    expect(buildSearchWithView("?tab=screeners", "options")).toBe("?tab=screeners&view=options");
    expect(buildSearchWithView("?tab=screeners&view=stocks", "options")).toBe(
      "?tab=screeners&view=options",
    );
  });
});
