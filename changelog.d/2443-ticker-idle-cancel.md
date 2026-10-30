### Fixed
- TickerAgent 5s pushTicks alarm no longer runs with zero listeners (#2443): armed on first connect, cancelled on last disconnect, reconciled on start (retiring pre-fix schedules); 5s cadence kept while connected, externalized via TICKER_PUSH_INTERVAL_S (default 5s); cancel failures surface via log + resourceSink attribution instead of being swallowed.
