// #411: the test suite is hermetic by default — outbound fetch is blocked.
//
// Every external API call in tests must be mocked explicitly (vi.stubGlobal,
// vi.spyOn, an injected fetcher, or a sanctioned fixture seam). This setup
// replaces the global fetch with one that throws before any socket opens,
// so no test can reach Yahoo, Nasdaq, E*TRADE, Slack, or any other live API
// by accident — the failure is deterministic and local instead of a slow,
// flaky real network call.
//
// Verified before landing (census on main): the full suite (271 files,
// 3,084 tests) passes with outbound fetch blocked this way. Suites that
// stub fetch themselves replace this block within their own tests; suites
// that rely on provider fallbacks exercise those fallbacks deterministically.
//
// Tests that need a successful fetch must stub the exact responses they
// depend on — see tests/real_apis.test.ts for the routing-mock pattern
// (match on new URL(url).hostname / pathname, never raw URL substrings).

const blockedFetch = async (input: unknown): Promise<Response> => {
  const url =
    typeof input === "string"
      ? input
      : ((input as { url?: string } | null)?.url ?? String(input));
  throw new Error(
    `Outbound fetch is blocked in tests (#411): stub fetch (vi.stubGlobal / vi.spyOn) or inject a fetcher — attempted: ${url}`
  );
};

globalThis.fetch = blockedFetch as typeof fetch;
