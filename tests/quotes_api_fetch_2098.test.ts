/**
 * Issue #2098 — quotes consumers must go through apiFetch (rule #71).
 *
 * The worker may answer 202 with an async-job stub that only apiFetch
 * resolves (poll + synthesize). Both quotes consumers had exactly one
 * raw fetch() call on their polling-fallback path; a 202 there handed
 * the UI an unresolved stub. The fix imports apiFetch AS fetch, so the
 * existing call sites resolve to apiFetch with no other change — and
 * this pin keeps it that way: the call sites may say fetch(, but the
 * binding must be the apiFetch import, never the global.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const files = [
  "src/client/components/MarketTickerTape.tsx",
  "src/client/components/StockSearchBar.tsx",
];

describe("quotes consumers use apiFetch (#2098)", () => {
  it.each(files)("%s binds fetch to the apiFetch import", (file) => {
    const src = readFileSync(join(here, "..", file), "utf8");
    expect(src).toContain('apiFetch as fetch } from "../apiFetch"');
  });

  it.each(files)("%s never reaches the global fetch", (file) => {
    const src = readFileSync(join(here, "..", file), "utf8");
    expect(src).not.toContain("globalThis.fetch");
    expect(src).not.toContain("window.fetch");
  });
});
