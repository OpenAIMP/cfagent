### Added

- **Market data circuit breakers (#1745):** per-provider breakers (Yahoo, Nasdaq, E*TRADE, Alpaca, public) with open/half-open/closed states, instant fallbacks (stale-but-labeled Yahoo cache or business messages, never synthetic data), and per-run budget enforcement — a tripped breaker spends zero budget and yields qualified partial results instead of failing the scan.
