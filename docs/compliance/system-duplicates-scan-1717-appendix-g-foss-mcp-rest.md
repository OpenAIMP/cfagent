# Scan appendix (g) — FOSS MCP vs REST — parent #1717

## Agent

#CISO-bhdm

Scan head: `23de3ce`. Main doc: `docs/compliance/system-duplicates-scan-1717.md`.
Standing rules: NEVER EITHER/OR ALWAYS CONFIGURABLE; scoped defaults run >
session > user > global env > built-in (public route behavior); never remove an
endpoint; never delete a code path.

All tools in `src/mcp/fossCommands.ts`, all via `FossResearchService`. Deltas are
vs `src/agents/routes/fossResearch.ts` (+ Alpaca routes, appendix (m) R01).

## F01 — foss_get_quote / foss_company_fundamentals / foss_market_research vs REST — DIVERGENT-minor

- Same service calls (`getQuote`, `getFundamentals`, `generateResearchReport`).
- Deltas: MCP quote provider default `hybrid` (REST `/foss/quote` also `hybrid` —
  identical there; REST `/foss/bars` defaults `yfinance`, see F02); MCP research
  audit `foss.research.generated` vs REST `foss.research_generated` (dot vs
  underscore — different event names for the same operation); REST quote/
  fundamentals default symbol `NVDA` when the query param is absent, MCP requires
  the symbol; REST has no audit on quote/fundamentals, MCP audits snapshot/bars/
  research but not quote/fundamentals (inconsistent even within the MCP file).
- Slice guidance: audit-name unification is part of this slice — two event names
  for one operation break attributable audit; the switch must not preserve the
  split silently. Default = route behavior for defaults; audit names need an
  explicit recorded decision (route spelling vs MCP spelling), not an accident.

## F02 — foss_historical_bars vs GET /foss/bars — DIVERGENT-presentation

- Same `getHistoricalBars`.
- Deltas: REST passes an explicit `provider` (default `yfinance`) and returns
  `{symbol, provider, timeframe, count, bars, provenance, source, timestamp}`;
  MCP takes no provider (service default), returns `{symbol, count, provenance,
  bars}`, and audits `foss.bars.fetched` where REST audits nothing for bars.
  Provenance labelling (`live` vs `generated`) is shared; the envelope is not.

## F03 — foss_alpaca_snapshot vs GET /foss/snapshot — DIVERGENT-minor

- Same `getAlpacaSnapshot`.
- Deltas: MCP audit `foss.alpaca.snapshot` `{symbol, assetClass, tradePrice,
  provenance}` vs REST `alpaca.snapshot_queried` `{symbol, price, bid, ask,
  assetClass}`; REST defaults symbol `NVDA`, MCP requires it.

## F04 — foss_alpaca_account / positions / orders vs REST twins — DIVERGENT (audit + defaults, see R01)

- Same service calls. MCP audits `alpaca.account.query` /
  `alpaca.positions.query` / `alpaca.orders.query` (verb `query`, no result
  payload beyond the call); `/foss` REST audits `alpaca.account_queried` /
  `positions_queried` / `orders_queried` with result-derived payloads; `/trading`
  REST audits none of the three reads.
- Orders `status`: MCP schema `open|closed|all` (no default stated, passed
  through); both REST twins default `"open"`.
- Slice guidance: this pair interacts with appendix (m) R01 (the two REST twins
  already diverge from each other) — the slice must reconcile a THREE-way split
  (MCP vs `/foss` vs `/trading`), not a two-way one, and must record which
  surface's audit payload is the default.

## F05 — foss_alpaca_place_order vs REST order twins — DIVERGENT (see R01)

- Same `placeAlpacaOrder`. MCP passes input verbatim (no qty default, no symbol
  uppercasing, no `quantity`/`orderAction`/`orderType` aliases, `limit_price`
  only) and audits `alpaca.order.place` with the full field set; REST twins
  default `qty 1`, normalise case/aliases, and audit `alpaca.order_placed` with
  different payloads (see R01).
- Slice guidance: same three-way note as F04. Input normalisation differences
  (case, aliases, defaults) are observable contract deltas, not cosmetics —
  pin them in both switch modes.
