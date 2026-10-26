# ADR 0010: LLM Gateway Port (AI Gateway fallback integration)

- **Status:** Accepted
- **Issue:** #1741 (sub-issue of #1736, item 5)
- **Design basis:** No doc pattern exists — AI Gateway does not
  appear in `docs/architecture/code/` (recorded honest gap at
  program filing). The port design below is the implementer's,
  justified here.
- **Related ADRs:** 0002 (data foundation layer, R1–R9),
  0003 (messaging port, CloudEvents envelope), 0005 (actor
  port), 0007 (hybrid RAG), 0008 (circuit breakers), 0009
  (telemetry & calibration).

## Context

Every LLM inference call went directly to the provider: the
model layer (`src/agents/model.ts`, `getWorkersAIModel`) built
a Workers AI model per call site, and `src/models/router.ts`
(`runWithRouting`) owned the only failover (cheap → primary →
fallback on retryable errors). There was no central rate
limiting, no caching, and no multi-provider failover beyond
the router's three-model chain; a provider outage or rate
limit failed the call instead of falling back, and there was
no single place to observe inference spend. The filing
inventory found AI Gateway entirely absent (only payment
`gatewayId` false positives).

## Decision

### 1. Port-first gateway module (R1, cloud-agnostic rule)

New `src/gateway/` port: `LlmGatewayPort.generate(input)`
with `ModelExecutor` as the provider transport. Two
executors, one shared AI SDK call helper
(`gatewayModelCall.ts`): `CloudflareAiGatewayExecutor`
(`createWorkersAI({ binding, gateway })` — first-class
gateway support in workers-ai-provider 4.0.0, no new
wrangler binding, AI SDK tool loop intact for actor turns)
and `WorkersAiDirectExecutor` (the current path, unchanged).
The conformance semantics in `tests/gateway_ports.test.ts`
run unchanged against any executor; domain code never
imports a provider SDK directly. Factory
`createGatewayPorts` is the only module mapping the Worker
AI binding to port implementations (same convention as the
messaging/retrieval factories): null when the binding is
missing or has no `run` function, gateway executor when
`AI_GATEWAY_ID` is configured, direct executor otherwise.
The core (cache/limiter/failover/stats/events) is identical
for both, so unconfigured deployments behave exactly as
before this slice.

### 2. Core rules (all pinned by tests)

- **Failover:** models are attempted in order, advancing
  ONLY on retryable errors. The classification is
  `isRetryable` from `src/models/router.ts` — the single
  source of truth, unchanged. Non-retryable errors fail
  fast (preserving the judge's timeout fail-fast behavior).
  Total failure is a business error
  (`GatewayAllProvidersFailedError`, "Inference is
  temporarily unavailable."), never a raw provider error.
  The router's chain order stays defined once, via the new
  `chainModels(task)` helper (cheap → primary → fallback).
- **Cache:** ONLY when a tenantId is present, no tools are
  attached, skipCache is unset, and the key material is
  <= 8000 chars. Without a tenant the call is never served
  from cache and never stored — fail-safe against
  cross-tenant leaks. Tools are never cached (tool results
  vary by execution). Key = tenant + models + system +
  prompt/messages + temperature + schema JSON.
- **Rate limiting:** gateway-level token bucket per
  (tenant ?? caller, first model), one spend per generate
  call, configured only via `AI_GATEWAY_RATE_LIMIT_RPM`
  (unset = limiter off). A limited call throws
  `GatewayRateLimitedError` immediately with NO failover —
  failover must never evade a limit. This does not replace
  #1745 provider breakers or #1742 governed calibration.
- **Breaker composition (ADR 0008 interface, consumed not
  duplicated):** an optional per-model `breakerFor`
  resolver wraps each attempt. An open or budget-exhausted
  breaker SKIPS the attempt (no provider call, no budget
  spend) and failover continues; a breaker "fallback"
  outcome is never served as text — model fallback is the
  fallback. Breakers sit behind the provider ports, not
  behind gateway internals, exactly as ADR 0008's #1741
  note requires. The breaker's own in-provider retries
  (withRetry) run before gateway failover: retry within a
  provider, failover across providers.
- **Timeouts:** per-attempt AbortController (the judge's
  2500ms route timeout is preserved as `timeoutMs`).
  A timeout is non-retryable and fails fast.

### 3. Two-layer migration

- **Layer 1 (model factory):** `getWorkersAIModel` gains
  gateway options from `getGatewayOptions(env)` when
  `AI_GATEWAY_ID` is configured; unconfigured behavior is
  byte-identical. This routes every `getWorkersAIModel`
  consumer through AI Gateway at the transport level.
- **Layer 2 (port migration):** every LLM text-inference
  call site now calls `port.generate` — judge route +
  evaluate, screener digest, QA investigate, NLQ planning
  (generateObject + JSON-extraction fallback) + NLQ
  validation, comparison idea details, options comparison,
  news sentiment, options ideas + ranking (retry loops
  preserved: they retry on JSON-parse failure, not model
  failure), and the actor turn (gateway turn function when
  a port exists, legacy `generateTextModelTurn` otherwise,
  so unbound/mocked AI environments are unchanged). A
  code-search pin (`tests/gateway_routing_coverage.test.ts`)
  asserts `generateText`/`generateObject` appear only in
  the gateway module and the legacy actor-turn fallback,
  and `createWorkersAI` only in the model layer and the
  gateway executors.

### 4. Observability (consumes #1742 and #1739, builds no second store)

- Stats live in a module-singleton accumulator per isolate
  (same loss semantics as `defaultBreakerRegistry()`: an
  isolate recycle resets them — fail-open, never
  fail-closed) and surface as an additive optional `gateway`
  field on the existing telemetry summary route
  (`/api/telemetry/summary`), wired in `src/server.ts`.
  No new route, no IAAA catalog change, no D1 tables in
  this slice (stats are in-memory).
- Gateway events use the #1739 CloudEvents envelope
  (`gateway.request_completed` / `gateway.cache_hit` /
  `gateway.fallback` / `gateway.rate_limited`, id
  `gateway:<type>:<seq>`, id-as-idempotency-key) via an
  optional injected sink, best-effort (emission failure is
  swallowed + logged, never failing the call — the #1740
  emitter pattern). Envelope data carries counts only:
  model, provider, cacheHit, attempts, durationMs — never
  prompts, outputs, or tenant material. Server-boot sink
  wiring is a #1743 follow-up; with no sink, no emission
  happens and stats are still recorded.

### 5. Configuration and activation

Env vars (plain vars, owner-set, non-secret, declared on
`Env`): `AI_GATEWAY_ID` (gateway id; unset = direct path),
`AI_GATEWAY_CACHE_TTL` (gateway cache TTL seconds),
`AI_GATEWAY_RATE_LIMIT_RPM` (port limiter). Activation is
owner-side: create an AI Gateway in the Cloudflare
dashboard and set `AI_GATEWAY_ID`; the slice never writes
an id into `wrangler.jsonc` and never invents one. The
gateway id is a Cloudflare-account object like D1
`agentdb` was owner-created.

### 6. Exemptions (explicit, not hidden)

- `src/models/verifier.ts` direct `env.AI.run` in
  `verifyWithLLM`: untouched — it is #1717 Adapter S1's
  listed site (CISO lane territory), and it uses
  `env.AI.run`, not `generateText`, so the coverage pin
  does not flag it. Recorded here so the exemption is
  visible.
- Embeddings: untouched (scope-excluded per the issue).
  `VectorMemory` constructions and
  `src/services/reportSemanticIndex.ts` own `embed()` +
  direct `env.VECTOR_MEMORY` calls stay as-is; S1 owns the
  embed dedup.
- `src/agents/mas.ts` direct AI Search fetch: untouched
  (S1 owns the `aiSearch.ts` client migration; not LLM
  inference anyway).
- No tenant is threaded at any migrated call site in this
  slice (none had one without signature changes), so
  production caching is currently inactive by design
  (cache skipped, rate limit caller-keyed). Tenant
  threading for cache activation is a follow-up (below).

### 7. #1717 S1 boundary

Adapter S1 (#1775) routes Workers AI through existing
adapters. This slice consumes that seam rather than
duplicating it: Layer 1 adds gateway options to the
existing `getWorkersAIModel` factory, and the port's
executors reuse `createWorkersAI` — no new Workers AI
routing surface is introduced, and no S1-listed site is
moved. If S1 later changes the routing seam, this slice's
Layer 1 is the single place to reconcile.

## Consequences

- Successful inference outputs are unchanged for the same
  inputs when no gateway is configured (direct executor =
  current path); when a gateway is configured, the same
  models run through it with gateway caching/rate limiting
  applied on top of the port's own cache/limiter.
- Failover is now uniform (port) instead of split between
  the router chain (three sites) and single-model calls
  (no failover at all); single-model sites gain no
  failover from this slice unless their model list grows —
  the port accepts ordered lists, so adding a fallback
  model later is a one-line change per site.
- AI SDK 7 facts recorded for later slices: there is no
  `maxSteps` option (`stopWhen: stepCountIs(maxSteps)`);
  `generateObject` results carry no `text` field (the
  schema path returns `JSON.stringify(object)` as text);
  schema types are `FlexibleSchema<any>` (zod, jsonSchema,
  and standard schemas all accepted).

## Follow-ups (not absorbed)

- Tenant threading: pass tenantId at call sites that can
  resolve one (screener schedule owner, request session)
  so gateway caching activates in production.
- Model → breaker registry mapping: wire `breakerFor`
  from the #1745 default registry once model names map to
  breaker provider ids; the port interface is ready.
- Server-boot event sink wiring for gateway CloudEvents
  (belongs to #1743's Analytics Engine stream, which
  consumes these envelopes).
- Scheduled-screen cutover; work-queue consumer + DLQ
  wiring; MCP `chain.run` execution binding; #1078
  enforcement flip; seed invokes + #1546 closure;
  champion/challenger gate integration (§13.1 Phase 4).
