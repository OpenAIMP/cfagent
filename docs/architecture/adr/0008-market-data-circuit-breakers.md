# 0008. Market data circuit breakers: port-first breaker Decorator over provider calls

- Status: accepted
- Date: 2026-10-26
- Deciders: owner, #CAIO-quns
- Issue: #1745 (sub-issue of #1736, Top-10 item 9)
- Implementing PR: (filled on merge)

## Context

Market data providers failed in the open. Retry existed and was
shared (`src/services/resilience.ts`, #1181: exponential backoff +
jitter under `pipelinePolicy.ts`), but no circuit-breaker state
machine existed anywhere in `src/`: no open/half-open/closed states,
no per-provider breakers, no instant fallback states. A failing
Yahoo, Nasdaq, or E*TRADE endpoint was retried into the ground,
latency cascaded, and users saw raw provider errors.

The concrete budgeting failure is #1785 (closed): the options scan
was structurally capped at ~3/100 symbols because one invocation's
shared per-scan subrequest budget (35) was spent retrying a failing
provider symbol after symbol. The #1737 collation rule already
decided the shape of the answer: a tripped dependency yields a
qualified partial result, never a total failure.

Constraints that shaped the design:

- Port-first (R1, adapter-first rule): breaker domain code never
  imports a provider SDK or a provider error shape; providers stay
  behind stable interfaces (Protected Variations), and the breaker
  is a GoF Decorator over provider calls.
- Reuse, don't replace: the retry executor (`withRetry`) is reused
  inside breaker execution; breakers wrap it, they do not replace it.
- No synthetic market data, ever (#923): fallbacks are stale-but-
  labeled cached data or business messages, never invented prices.
- No silent nulls, no lazy fallbacks: a fallback value must be
  self-labeling (cached provenance), and a missing fallback
  surfaces as a business error, not a raw provider error.

## Decision

A breaker port in `src/breakers/` with an in-memory adapter:

- `breakerPorts.ts`: the port — `BreakerPolicy` (failureThreshold,
  resetTimeoutMs, halfOpenMaxProbes), `BreakerState`
  (closed/open/half-open), `CircuitBreaker` (execute/getState/
  snapshot/reset), `BreakerRegistry` (breakerFor/snapshots/
  resetAll), policy resolution (code defaults < Worker env
  `BREAKER_<ID>_*` < settings `breaker.<id>.*`, invalid ignored
  with a log — the pipelinePolicy pattern), and the CloudEvents
  state-change envelope (`breaker.state_changed`, same #1739
  envelope, id-as-idempotency-key, counts-only data).
- `inMemoryBreakerAdapter.ts`: the state machine. One failure
  counted per execute(), never per retry attempt — otherwise a
  single execute with 3 attempts would trip a threshold-3 breaker
  alone. Permanent failures (shouldRetry false) are recorded but
  never count toward the trip threshold: an auth/config failure
  is not an outage signal. Half-open admits halfOpenMaxProbes
  concurrent probes (default 1); further callers during a probe
  are rejected instantly.
- `breakerDecorator.ts`: `withBreaker`, the single layering point
  (budget gate → breaker gate → retry → fallback), plus
  `fetchBatched`, the chunked batching primitive.
- `marketDataBreakerWrapper.ts`: the Decorator over
  `IMarketDataProvider`. Batch/snapshot methods exist on the
  wrapper exactly when the inner provider offers them (the
  pipeline's optional-dep check relies on that shape). Sync cache
  reads pass through unwrapped — they make no provider call.
- `createBreakerPorts.ts`: the per-isolate shared default registry
  (see Consequences) plus the `__resetDefaultBreakerRegistry`
  test seam (the quoteCache pattern).

Wiring (all five registry ids):

- Yahoo + Alpaca + hybrid: `MarketDataResearchService` wraps each
  strategy (Yahoo quotes fall back to the 5-minute quote cache,
  stamped cached with its age per #930; everything else has no
  fallback, so errors propagate unchanged and the service's
  multi-provider chains keep working). The hybrid strategy is
  guarded at the composed level (breaker "hybrid"); its legs are
  covered by the yahoo/alpaca breakers on direct use.
- Pipeline Yahoo paths: the data-provider factory takes an opt-in
  `breaker` (absent = raw provider, so verifiers and conformance
  tests are unaffected); the screener-agent (2 sites),
  shardExecutors, and platformHistory pipeline constructions pass
  the yahoo breaker.
- E*TRADE: `ETradeService.fetchQuoteRemote` / `fetchQuotesRemote`
  run behind the etrade breaker with no fallback — live failures
  stay explicit by the existing deliberate rule (never stale
  cache for live E*TRADE), and no decorator budget (the client
  charges its own SubrequestBudget per fetch; double-charging
  would undercount the run's remaining budget).
- Nasdaq: `fetchAllUsStockListings` runs behind the nasdaq breaker
  with no fallback (the 5-minute cache is checked first, and
  #1554 forbids substituting the curated universe). A tripped
  breaker surfaces as its business error, unwrapped by the #1554
  catch.
- Public: `readPublicQuotes` runs behind the public breaker with
  no fallback.

Budget arithmetic (#1785, stated so the change is auditable):

- An open breaker spends ZERO budget and makes ZERO provider calls:
  after the trip (3 consecutive failed executes), the remaining
  symbols resolve as fallbacks/partials inside the same budget
  instead of burning it.
- One budget spend per execute(), never per retry attempt, and
  never per symbol inside a batch call: a batch endpoint call
  (Yahoo getQuotes, E*TRADE fetchQuotesRemote) is one budgeted
  execution covering its whole symbol list.
- Budget exhaustion itself serves the fallback (qualified partial
  with audit status, the #1737 collation vocabulary) instead of
  throwing mid-scan — unless no fallback exists, in which case
  the business error is thrown.
- `fetchBatched` is the batching primitive for future chain-request
  batching; the options scanner's per-symbol snapshot loop
  conversion is a follow-up, not this slice.

## Consequences

- Breaker state is per-provider infrastructure state, held in
  memory per isolate (documented loss semantics: an isolate
  recycle resets breakers to closed — fail-open on cold start).
  State is never user-scoped. A durable cross-isolate breaker
  store is a follow-up, not this slice.
- Trading is out of scope: Alpaca trading calls (placeOrder /
  getAccount / getPositions / getOrders) stay on the raw Alpaca
  client — breakers never gate trades.
- #1742 hooks (named, not built): `snapshots()` per breaker
  (state, trip counts, fallback counts), the `onStateChange`
  event stream, and the `breaker.state_changed` envelope type.
- #1741 interface note (named, not built): when AI Gateway
  fallback lands, its fallback interface should accept a breaker
  the way provider calls do here; breakers sit behind the
  provider ports, not behind gateway internals.
- #1717 boundary (slice (e) market-data/quotes, CISO lane): the
  facade (`marketDataService.ts`) owns quote READS and
  provenance; breakers own provider FETCH calls. This slice does
  not move any fetcher behind the facade — that remains #1643's
  stated remaining work / slice (e) territory. The slice (e)
  provider-port work was checked before defining this port; no
  duplication (the facade and the breaker port are disjoint
  surfaces, linked here, not rebuilt).
- Healthy-provider behavior is unchanged: closed breakers add one
  policy check per call and reuse the existing retry schedule;
  the full suite pins this (#1746 discipline).

## Alternatives considered

- Durable (DO/D1) breaker store now: rejected for this slice —
  correct for cross-isolate consistency, but a new store and
  migration for a first breaker iteration; the in-memory adapter
  proves the port, and the store becomes a second adapter behind
  the same port (the R1 pattern).
- Breaker per call site instead of a registry: rejected — the
  registry centralizes policy, metrics, and state-change events
  per provider id; call-site breakers would fragment all three.
- Counting every retry attempt toward the threshold: rejected —
  it trips on a single flapping execute and punishes the retry
  policy the breaker is supposed to complement.
