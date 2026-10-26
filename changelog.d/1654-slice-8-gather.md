### Added

- **Screener gather stage (#1654 slice 8):** feed quotes + daily bars now flow through a gather stage that computes and attaches Bollinger %B/bandwidth/squeeze, anchored VWAP, ATR%, regime, 6-vote bias, and Fibonacci levels; analysis gates run on gathered data. Gathered datasets persist as capture/blob blobs under gather/<runId>.json, with Alpaca bars within 15 minutes of fetch labeled IEX-partial.
- **Minute-bar provider extension (#1654 slice 8):** Alpaca 1-59Min passthrough and Yahoo 1m/2m/5m/15m/30m/90m/1h mapping with full ISO timestamps; unsupported minute timeframes throw before any fetch.

### Changed

- **AVWAP gate is now strict (#1654 slice 8):** the anchored-VWAP gate rejects at exact equality (spot must remain strictly above AVWAP), per ruling.
