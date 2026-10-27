### Changed

- **Named providers everywhere (#1906):** the legacy generic provider
  label is renamed to named providers across routes, services, client,
  MCP tools, and docs. Canonical routes are now `/api/market-data/*`
  (quote, fundamentals, bars, research, compare, providers, screen,
  snapshot, alpaca/account, alpaca/positions, alpaca/orders,
  alpaca/order, quotes, quotes/ws); MCP tools are now
  `market_data_get_quote`, `market_data_company_fundamentals`,
  `market_data_historical_bars`, `market_data_research`,
  `alpaca_snapshot`, `alpaca_account`, `alpaca_positions`,
  `alpaca_orders`, `alpaca_place_order`; the research service is
  `MarketDataResearchService` (`src/services/marketDataResearch.ts`)
  and the mode config is `src/config/marketDataModes.ts` with canonical
  env vars `MARKET_DATA_*_MODE` / `ALPACA_*_MODE`. Audit events move
  to the `market_data.*` family. Every pre-rename name remains
  available as a deprecated alias on the same handler (routes, tools,
  resources, prompt, env vars, mode value); alias removal is a
  separate follow-up slice. Historical records (released changelog
  entries, merged fragments, dated compliance scans, the 2026-10-20
  architecture audit) are intentionally left as written.
