# Scan appendix (e) — Market-data / quote unification — parent #1717

## Agent

#CISO-bhdm

Scan head: `23de3ce`. Main doc: `docs/compliance/system-duplicates-scan-1717.md`.
Standing rules: NEVER EITHER/OR ALWAYS CONFIGURABLE (one switch per pair); scoped
defaults run > session > user > global env > built-in (public route behavior);
never remove an endpoint; never delete a code path. RUNTIME-CONFIRM: M2b is a
static call-site fact — confirm at runtime before baking a default.

## M1 — MarketDataService facade: HTTP read unified, everything else NOT behind it — DIVERGENT (partial unification, confirmed carry-over)

- Implementations: (a) `src/services/marketDataService.ts` —
  `resolveMarketDataQuotes()`, `MarketDataQuote`/`MarketDataQuoteView`/
  `MarketDataResolution`; (b) `src/services/marketStream.ts` — `liveMarketCache`,
  `fetchRealMarketQuote()`, `getBatchMarketQuotes()`,
  `handleMarketQuotesWebSocket()`; (c) `src/services/quoteCache.ts` —
  `getCachedQuote*`/`setCachedQuote()`; (d) provider fetchers in
  `src/services/fossResearch.ts`, `src/services/etrade.ts`,
  `src/trading/etrade/*`, `src/trading/dataProviders/adapters.ts`.
- What IS behind the facade (verified): only `handleMarketQuotesHttp()` in
  `marketStream.ts:338`, called from `src/server.ts:2194` for BOTH
  `GET /api/market/quotes` and its alias `GET /api/foss/quotes`. It resolves
  through `resolveMarketDataQuotes()` against `liveMarketCache`, so expired
  entries become `unavailable` instead of being served stale (the old
  `getBatchMarketQuotes` behaviour), and each served quote carries
  `provenance:"cached"`, `fetchedAtMs` (from `tick.timestamp`), `ageMs`, plus
  top-level `unavailable[]`, `dataUnavailable`, response-time `timestamp`, and
  joined `source`.
- What is NOT behind it (verified, facade header states this itself): WebSocket
  (M2), `quoteCache` (M8 — zero imports of `marketDataService` outside
  `marketStream` and its test; `fossResearch.ts` and `nasdaqListings.ts` still
  call `quoteCache` directly), and all provider fetchers (Alpaca/Yahoo in
  `marketStream`, E*TRADE in the platform service, Yahoo objects in
  `fossResearch` via `quoteCache`).
- Contract deltas: provenance vocabulary is facade-only (`"cached"|"unavailable"`,
  deliberately NO `"live"` — a cache read is never labelled live); the pre-facade
  `getBatchMarketQuotes` path had no provenance at all. TTLs are per-path and
  unchanged by the facade (20s/30s vs 5 min). No `live` fetch-through path exists.
- Auth/audit: the HTTP quote branch in `server.ts` performs NO `requireAuth` and
  no audit call (contrast most other `server.ts` branches, which call
  `requireAuth`). Same for the WS branch. Default symbols when `symbols` is
  empty: `NVDA,AAPL,MSFT,TSLA,SPY,QQQ,BTC/USD,ETH/USD,SOL/USD`.

## M2 — HTTP snapshot vs WebSocket stream — DIVERGENT

- `handleMarketQuotesHttp()` (facade, `marketStream.ts:338`) vs
  `handleMarketQuotesWebSocket()` (`marketStream.ts:365`) +
  `getBatchMarketQuotes()` (`marketStream.ts:319`), both served from
  `src/server.ts:2183,2194` (`/api/market/quotes/ws`, alias `/api/foss/quotes/ws`).
- Expiry: HTTP honours `expiresAt` (expired → `unavailable`); WS/`getBatch`
  ignores `expiresAt` entirely — it returns `cached.tick` whenever a map entry
  exists, and the 5s `sendLiveQuotes` loop deliberately "publishes the latest
  cached quote before waiting on I/O" and leaves "the last known quote visible"
  on provider failure, for stream continuity (stated design, not a bug claim).
- Shape: HTTP returns `{quotes (with provenance/fetchedAtMs/ageMs), unavailable,
  dataUnavailable, timestamp, source}`; WS sends `{type:"snapshot", quotes,
  unavailable}` on subscribe and `{type:"ticks", ticks}` on refresh — ticks carry
  NO provenance/age fields, only `MarketTickData.timestamp`.
- Refresh: HTTP fires unawaited `refreshQuotesInBackground()` then answers from
  cache; WS refreshes on a 5s interval and re-sends.
- Provider selection: WS passes `env` to the handler (`server.ts:2188`); HTTP does
  NOT pass `env` (`server.ts:2200`) — see M2b.

## M2b — HTTP entry point can never use Alpaca (env dropped at the call site) — DIVERGENT

- `handleMarketQuotesHttp(symbols, env?)` forwards `env` to
  `refreshQuotesInBackground()` → `fetchRealMarketQuote(symbol, env)`, whose
  Alpaca leg requires `env.ALPACA_API_KEY|ALPACA_API_KEY_ID` +
  `env.ALPACA_SECRET_KEY|ALPACA_API_SECRET_KEY`. `server.ts:2200` passes no `env`,
  so `env` is `undefined`, the Alpaca leg is skipped, and HTTP refreshes are
  Yahoo-only even when Alpaca is configured. The WS path passes `env` and can use
  Alpaca. Same handler signature, different provider selection by entry point.
  This is a call-site fact, verified by reading both `server.ts` branches — not
  a facade property. **The slice must runtime-confirm this before writing
  Yahoo-only into a program default; if preserved, record Yahoo-only as the
  default explicitly, not silently "fixed" to Alpaca-first.**

## M3 — Inside marketStream: Alpaca leg vs Yahoo leg — DIVERGENT

- One function, `fetchRealMarketQuote()` (`marketStream.ts:145`), two legs.
- Price: Alpaca = mid `(bid+ask)/2` to 2dp, only if both > 0; Yahoo =
  `regularMarketPrice ?? chartPreviousClose`, unrounded wire value.
- Change: Alpaca derives change/changePercent from the PREVIOUS cached tick's
  implied close (`prevTick.price - prevTick.change`); with no previous tick with
  prevClose > 0 it falls through to Yahoo entirely. Yahoo computes from
  `regularMarketPreviousClose ?? chartPreviousClose`.
- Bid/ask: Alpaca = wire `bp/ap` (real NBBO); Yahoo = SYNTHETIC spread —
  `price ± max(0.01, price*spreadFraction/2)`, 0.0006 equities / 0.0004 crypto.
- Volume: Alpaca = literal `"—"` (unavailable marker, string in a string field);
  Yahoo = `formatVolume(regularMarketVolume)` (`"15.4M"`/`"$1.2B"` style fallbacks
  when volume ≤ 0 — themselves static-looking strings).
- Name: Alpaca = raw symbol (`name: norm`); Yahoo = `longName|shortName|symbol`.
- TTL: Alpaca cache 20s, Yahoo cache 30s. Failure backoff: 30s
  `failedQuoteRetryAfter` for both legs on total failure (returns `null`).
- Crypto mapping: `BTC/USD→BTC-USD` etc. for Yahoo; Alpaca crypto uses the raw
  `BTC/USD` symbol in the query string.
- Error semantics: any Alpaca exception falls through to Yahoo; total failure
  returns `null` (caller reports unavailable), never throws.

## M4 — Yahoo Finance, three implementations — DIVERGENT

- (a) `marketStream.ts` Yahoo leg: v8 chart, `interval=1d&range=1d`, 30s TTL,
  synthetic bid/ask, string volume, `source:"Yahoo Finance"`, epoch-ms `timestamp`.
- (b) `fossResearch.ts` `YahooFinanceProvider.getQuote()`: v8 chart query1→query2
  fallback, `interval=1d&range=1mo`, 5-min `quoteCache` (`yahoo:<SYM>`), real wire
  `bid/ask` when present (else omitted, never synthesised), numeric `volume`,
  `open = (dayHigh+dayLow)/2` (NOT the wire open — a derived midpoint), `high/low`
  fall back to 52-week values, `vwap = price`, `rsi14` + `macdSignal` computed from
  1mo closes, optional crumb `quoteSummary` enrichment for `trailingPE/marketCap`,
  `timestamp` ISO string, `provenance:"live"` fresh / `"cached"` + `cacheAgeMs` +
  explanatory `note` on cache hit, throws `fossLiveUnavailableError` on failure.
- (c) `fossResearch.ts` `YahooFinanceProvider.getQuotes()` (batch, #1184): v7
  `quote` endpoint, ONE request per symbol chunk, REQUIRES a crumb session (throws
  `"no crumb session"` / HTTP status / `"no results"` otherwise), wire
  `regularMarketOpen` for `open` (contradicts (b)'s midpoint open), wire change
  values when present, `rsi14/macdSignal` deliberately UNSET (parity note: E*TRADE
  snapshots carry no indicators either), populates the same 5-min `yahoo:<SYM>`
  cache (b) reads, returns only symbols Yahoo returned (omitted symbols absent,
  caller falls back per-symbol).
- Shared: all uppercase/trim symbols; change/changePercent to 2dp where computed.
  Not shared: endpoint (v8 1d vs v8 1mo vs v7), open derivation, RSI/MACD presence,
  bid/ask synthesis vs omission, volume type, timestamp format, TTL, failure mode
  (null vs throw vs omission).

## M5 — Alpaca, three implementations of the same upstream — DIVERGENT

- (a) `marketStream.ts` Alpaca leg (M3): mid price, prev-tick change, volume `"—"`,
  requires previous tick else Yahoo fallback, 20s TTL, `source:"Alpaca"`.
- (b) `fossResearch.ts` `AlpacaMarketDataProvider.getQuote()`: mid price to 2dp,
  but `change: 0, changePercent: 0` ALWAYS (no prev-close leg at all), `volume: 0`,
  `open/high/low/previousClose/vwap = mid` (all equal to the mid — not OHLC data),
  `companyName: "<SYM> Asset"`, `bidSize/askSize` from `bs/as`, `timestamp = q.t`
  (wire time) or now, NO cache (no `quoteCache` read/write in this class),
  `isConfigured()` gates on keys, unconfigured/failed fetch THROWS
  `fossLiveUnavailableError` (never falls back to Yahoo inside this provider).
  Crypto detection: `symbol.includes("/") || lower includes "btc"|"eth"` — note
  this matches e.g. a symbol merely containing "btc"/"eth" as a substring.
- (c) `src/trading/alpaca/platform.ts` `AlpacaTradingPlatform.getQuote()`: wraps (b)
  via `AlpacaMarketDataProvider`, then re-maps into `ETradeQuote`:
  `companyName: "<SYM> (Alpaca Real-Time)"` (overwrites (b)'s name),
  `lastPrice/price = snap.price`, passes `change/changePercent` through (so 0/0
  from (b)), `bid/ask ?? 0`, `volume` passthrough, `open/high/low` passthrough
  (still all = mid), OPTIONAL `peRatio/marketCap/high52/low52/rsi` only if finite
  and positive (else omitted — the #1555 no-fabrication rule), `source:
  "Alpaca Real-Time NBBO Feed"`, fresh ISO `timestamp` (overwrites wire `q.t`),
  NO `quoteStatus` field at all, throws on Alpaca failure (from (b)) — no fallback.
  Constructor REQUIRES an explicit `userLogin` (#1185), unlike (a)/(b).

## M6 — Hybrid provider selection: three different "is Alpaca configured?" rules — DIVERGENT

- `HybridFossProvider.getQuote()` (`fossResearch.ts:2493`): price leg = Alpaca iff
  `env.ALPACA_API_KEY_ID && env.ALPACA_API_SECRET_KEY` (the `_ID`/`_SECRET_KEY`
  spellings ONLY); otherwise Yahoo. Fundamentals leg always Yahoo (best-effort,
  failure swallowed, missing fields stay missing); final `provider:"hybrid"`,
  `provenance` = weakest of price/fundamentals provenances.
- `marketStream.fetchRealMarketQuote()`: Alpaca iff `ALPACA_API_KEY|ALPACA_API_KEY_ID`
  AND `ALPACA_SECRET_KEY|ALPACA_API_SECRET_KEY` (either spelling, both sides).
- `AlpacaTradingPlatform.getStatus()`: configured iff `ALPACA_API_KEY|ALPACA_API_KEY_ID`
  AND `ALPACA_SECRET_KEY|ALPACA_API_SECRET_KEY` (same as marketStream).
- Consequence: an environment with only the non-`_ID` spellings set is "Alpaca" to
  marketStream/platform but "Yahoo" to the hybrid provider. Same env, different
  provider, different price/change/volume semantics (M3–M5).

## M7 — E*TRADE quote chain: five surfaces, five failure contracts — DIVERGENT

- (a) Wire client `src/trading/etrade/client.ts`: `fetchQuoteDetailed()` (live
  OAuth fetch, returns `{quote, error}` pair, optional `includeRawResponse` →
  `raw` wire payload) and `fetchQuote()` (thin wrapper reading shared
  `getLastError()` — documented as unsafe for concurrent callers), plus batch
  `fetchQuotes()` (comma-separated list, trace/`onWireResponse` hooks, #495).
- (b) Platform `src/trading/etrade/platform.ts` `ETradeTradingPlatform.getQuote()`:
  async; live fetch first (stub-quote rejected via `isStubQuote`: lastPrice 577.51
  or "GOOGLE INC" for non-GOOG/GOOGL); then cached screener-universe entry
  (live → its own `quoteStatus ?? STATIC_FALLBACK`, non-live → `SIMULATED_LEVEL1`);
  then curated table (LIVE → THROWS #922, non-live → simulated price, bid/ask/
  volume zeroed, `defaultPrice ?? 100.0`); else THROWS `AUTH_REQUIRED` (#294).
  `getQuoteDetailed()` is a verbatim passthrough to (a) (no fallback).
- (c) Service sync `src/services/etrade.ts` `ETradeService.getQuote()`: NEVER
  fetches live (universe → curated → zero-price `AUTH_REQUIRED` quote object,
  NOT a throw — contrast (b)'s throw for the unknown case); live curated hit
  THROWS #922 like (b); non-live curated hit returns simulated quote. Used by
  `previewOrder` (sync pricing path).
- (d) Service async `ETradeService.getQuoteAsync()` / `fetchQuoteRemote()`:
  `fetchQuoteDetailed` first (stub rejected by an inline copy of the stub
  heuristic, not the shared `isStubQuote`); LIVE env → failure THROWS with carried
  detail; NON-live → falls back to platform (b). Batch `fetchQuotesRemote()`:
  non-live returns `[]` (no sandbox fixture pretence); live delegates to (a).
- (e) Policy `src/trading/quotePolicies.ts` `fetchQuoteLiveStrict()`:
  generic over any `ITradingPlatform` with `getQuoteDetailed`; live + no good live
  quote → THROWS; non-live → platform default `getQuote()`. This is what MCP
  `etrade_get_quote` uses (appendix (f) M10 cross-ref). `quoteConfig.ts`
  (`DEFAULT_QUOTE_CONFIG`: batchSize 10, retryBatchSize 10, maxRetries 3,
  gaps/delays) and `quoteTrace.ts` (`QuoteTrace`, failure categories
  http/timeout/parse/auth/rate-limited/…) govern the screener batch pipeline
  only — not the single-quote paths.
- Money/rounding: E*TRADE surfaces pass the wire `lastPrice` through (no
  re-rounding named); the ONLY hard-coded money default in the chain is the
  curated `defaultPrice ?? 100.0` (non-live) and the sync zero-price stub.
  `quoteStatus` vocabulary (`REALTIME` = live per `isLiveQuoteStatus`,
  `STATIC_FALLBACK`, `SIMULATED_LEVEL1`, `AUTH_REQUIRED`) exists ONLY on the
  E*TRADE side — it does not map to Foss `provenance` or facade `cached`.

## M8 — Two quote caches, never shared — DIVERGENT

- `liveMarketCache` (`marketStream.ts`): `Map<string, {tick, expiresAt}>`, bare
  uppercase symbol key, per-entry TTL 20s (Alpaca) / 30s (Yahoo), values are
  `MarketTickData` (epoch-ms `timestamp`, formatted `$` strings, string volume).
  Expiry honoured by the facade, ignored by `getBatchMarketQuotes`/WS (M2).
- `quoteCache` (`quoteCache.ts`, #411): `Map<string, {value, fetchedAt, expiresAt}>`,
  caller-namespaced keys (`yahoo:<SYM>`, `nasdaq:listings:all`), fixed 5-min TTL,
  500-entry cap with oldest-eviction, ONLY successful live results stored, errors/
  fallbacks never cached, expiry enforced on read, `getCachedQuoteWithAge()` ages
  from original `fetchedAt` (not TTL window). Values are `FossQuote` (ISO
  `timestamp`) or Nasdaq listings — a different type universe from `MarketTickData`.
  Only callers: `fossResearch.ts` (Yahoo single + batch) and `nasdaqListings.ts`.
- The facade's `ageMs` is `now - tick.timestamp`; the Foss cache-hit `cacheAgeMs`
  is `now - fetchedAt`. Same idea, different clocks/fields, different stores —
  a symbol can be fresh in one cache and stale/missing in the other.

## M9 — DataProvider adapters: same Foss fetch, different envelope — DIVERGENT (envelope-only)

- `src/trading/dataProviders/adapters.ts`: `createYahooDataProvider()` /
  `createAlpacaDataProvider()` wrap the Foss providers (`createFossDataProvider`)
  and add: `tag(id, capability, result)` provenance tagging, optional capture
  (raw + normalised rows to blob, `recordCapture`), and fetch-outcome recording.
  `getQuote/getHistoricalBars/getFundamentals` delegate 1:1; `getQuotesBatch`
  exists ONLY when the wrapped provider has `getQuotes` — i.e. Yahoo only, not
  Alpaca (asymmetric batch capability from the same adapter factory).
  `verifyYahooDataProvider`/`verifyAlpacaDataProvider` run the conformance kit.
- `src/trading/dataProviders/registry.ts` (`DataProviderRegistry`, #1118):
  resolution is config-store driven (state `enabled` + flag + registered adapter +
  declared capability), routed primary + optional gap-fill, NO silent fallback
  (unservable primary → `DataProviderNotFoundError`, never a substitute provider),
  tier gating via `DataProviderTierError`. This is a THIRD provider-selection
  semantic alongside hybrid-env selection (M6) and marketStream try-Alpaca-then-
  Yahoo (M3).
- Underlying quote values are identical to M4/M5 (delegation, no recomputation),
  but the served envelope (tag, capture rows, outcome records, batch availability,
  error type) differs, and the registry's no-substitution rule contradicts
  marketStream's silent Alpaca→Yahoo fallthrough. Counted as DIVERGENT (the
  envelope is observable to callers).

## M10 — Quote surfaces across protocols — DIVERGENT

- `GET /api/market/quotes` (+ `/api/foss/quotes` alias): NO auth, NO audit, 200
  always (even all-unavailable: `quotes:[]`, `unavailable:[...]`,
  `dataUnavailable:true`), facade provenance, `MarketTickData` shape.
- `GET /foss/quote` (`src/agents/routes/fossResearch.ts:89`): NO session check in
  the handler (default symbol `NVDA` when absent, provider param default
  `hybrid`), NO audit on the quote path (audit exists on `/foss/research` and
  `/foss/screen` only), failure → 500 `{error}` (contrast market-quotes
  200-with-unavailable). Same `FossResearchService.getQuote()` as MCP below,
  different defaults/error/audit wrapper.
- MCP `foss_get_quote` (`src/mcp/fossCommands.ts:19`): `symbol` 1–20 chars (zod),
  provider enum default `hybrid`, audit `foss.quote.fetched` with
  `{symbol, provider, price, provenance}`; failure THROWS to the MCP framework
  (no HTTP status mapping here). Sibling MCP commands (`foss_company_fundamentals`,
  `foss_historical_bars`, …) follow the same audited-throw pattern.
- MCP `etrade_get_quote` (`src/mcp/etradeCommands.ts:74`): symbol 1–10 chars (zod —
  tighter than Foss's 20), session-bound (`context.sessionId` IS the caller login,
  #1185, no synthetic default), registry-resolved platform + `fetchQuoteLiveStrict`
  (M7e), audit `etrade.quote_fetched` with `{symbol, lastPrice, changePercent}`
  (different audit fields from Foss), `ETradeQuote` shape (not Foss/MarketTick).
- REST E*TRADE quote: NO dedicated HTTP quote route exists; E*TRADE quotes reach
  REST only embedded in screen/order/preview flows, which are session-gated at
  the dispatcher (handlers in `etradeOptions*.ts` receive identity via
  `x-user-login`, `routeIdentity.ts` fail-closed 401).
- Verdict: four wrappers, four auth/audit/error contracts, three quote shapes,
  over (partly) the same providers. Cross-ref: REST↔REST leg is R02 in appendix (m).

## M11 — Public.com quote-row mapping: a fourth quote normaliser — DIVERGENT

- `src/services/publicData.ts`: `extractPublicQuoteRows()` + `mapPublicQuoteRow()`:
  maps a Public payload row into a PARTIAL `ETradeQuote` — only fields the row
  carries are set (bid/ask/volume/open/high/low/previousClose/change from flat or
  nested `one_day_change`); absent fields are OMITTED, never zero-filled (the
  module header states `ETradeQuote`'s required fields are the E*TRADE feed's
  guarantee, not this provider's). No `quoteStatus`, no `source` provenance
  stamp named in the mapping, `timestamp` from row fields or caller `fetchedAtIso`.
  This is a separate normaliser from the E*TRADE wire normaliser (`client.ts`),
  the Foss normalisers (M4/M5), and the marketStream normaliser (M3) — it is NOT
  behind the #1643 facade and NOT behind the DataProvider registry (Public is a
  seeded registry descriptor, not a servable adapter, per `registry.ts` header).

## M12 — Screener quote acquisition: shared evaluator — IDENTICAL (evaluator)

- `src/trading/screenerPipeline.ts` `acquireUniverse()` + `screenWithQuotes()`:
  the E*TRADE leg (`screenLive` via `DynamicMarketScreener`, batch
  `fetchQuotesRemote` + `QuoteTrace`) and the Yahoo leg
  (`src/services/screeningRuntime.ts` `createYahooStockScreener()`: Yahoo
  acquisition → SAME `screenWithQuotes` evaluator, "filter semantics are identical
  and only the quote source changes", Yahoo failure THROWS → qualified-partial or
  502, never a fallback to E*TRADE data) share one evaluator. `goalDrivenScreen`
  and the `/foss/screen` route (appendix (k) S2) run through this same pipeline
  via `ScreenerAgent`. The Foss batch `getQuotes()` (M4c) is a third acquisition
  feeding the same per-symbol cache, not a fourth evaluator.
- Verdict: IDENTICAL for the screening evaluator; provider selection is a
  configuration/route choice (E*TRADE vs Yahoo), not a duplicated evaluator.

## S4 — Two provider seams for research data — DIVERGENT

- (a) `src/services/researchProviders.ts` `EtradeResearchDataProvider` (implements
  `ResearchDataProvider` from `researchPipeline.ts`): the research agent's single
  E*TRADE-backed provider (+ Yahoo history deps, Nasdaq universe deps via
  route bundles in `fitDiscoveryRunner.ts`), honestly-null technicals / empty
  universes on degradation, never a direct fetch fallback.
- (b) `src/trading/dataProviders/*` (`registry.ts` + `adapters.ts`, M9):
  config-driven multi-provider registry with routing, gap-fill, tiers, capture,
  and conformance — used by screening/universe routes (`dataProviders.ts` route
  runs `requireAuth` on every `/api/*` request before forwarding, per its header)
  and by `ScreenerAgent`'s universe resolution.
- Same provider implementations underneath (Foss/E*TRADE adapters wrap the same
  classes), but selection, auth placement, error type (`DataProviderNotFoundError`
  / `DataProviderTierError` vs honestly-empty degradation), and capture/outcome
  behaviour differ. A research run and a screen run can therefore resolve "the"
  provider differently for the same capability.

## Slice guidance for (e)

#1643's §15 already states fetch unification as remaining work; this scan
confirms it and extends it: the WS path and the HTTP call site (M2b) are separate
remaining items, not just "WS untouched, quoteCache not rewired". Each provider
pair (M3/M4/M5) needs its own switch with the current public-route behaviour as
default; M2b's default must be runtime-confirmed first. Do not present a cache
read as `live` in any new envelope (facade rule).
