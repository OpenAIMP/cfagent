# 0006. Cloudflare feature flags: port-first architecture with Flagship adapter and fail-closed fallbacks

- Status: accepted
- Date: 2026-10-26
- Deciders: owner (Mubasher Ahmed), #ceo-aimp
- Issues: #1806, #1815
- Implementing PRs: #1809, (this branch)

## Context

Deploying code to `main` must not automatically expose unfinished, unapproved, or experimental features in production. Previously, the repository had no unified feature flag registry. Gating was handled ad-hoc via isolated environment variables in `wrangler.jsonc` (such as `SOCIAL_POSTING_ENABLED`, `IAAA_PDP_ENABLED`, and `IAAA_WIRING_ENABLED`), requiring full Worker redeployments for every state change. Furthermore, some capabilities were hidden only in the UI while their underlying server routes remained callable.

Following the overarching architectural standard established across ADR 0002 (Storage), ADR 0003 (Messaging), ADR 0004 (Workflows), ADR 0005 (Actors), and ADR 0007 (Retrieval):
> *"The blueprint's principle #1 ('Cloudflare Native First') is SUPERSEDED by owner direction: we use Cloudflare [X], but behind a port, with a second adapter and a conformance suite as independence proof — the blueprint is the WHAT, the cloud-agnostic adapter-first rule is the HOW."*

Issue #1806 and Issue #1815 require:
1. Confirming the exact Cloudflare feature-flag mechanism (dashboard, Workers config, or native Cloudflare solution) and documenting it.
2. Structuring feature flags under a strict Port-First / Ports & Adapters (Hexagonal) architecture.
3. Defining a single feature registry starting with `screener`, default-closed (OFF).
4. Migrating existing flags or establishing explicit fallbacks without running duplicate parallel flag systems.
5. Enforcing gating server-side so disabled features are unreachable (returning HTTP 404 `FEATURE_DISABLED`), not merely hidden.
6. Default-closed and fail-closed: unknown flags, missing configurations, or flag-service evaluation errors must evaluate to `false`.

## Decision

### 1. Port-First Feature Flag Architecture (`src/features/featureFlagPorts.ts`)

Domain code depends ONLY on the port interface:
```typescript
export interface FeatureFlagPort {
  isEnabled(flag: string, context?: FeatureEvaluationContext): Promise<boolean>;
  getAllFlags(context?: FeatureEvaluationContext): Promise<Record<FeatureFlag, boolean>>;
}
```
This interface contains zero Cloudflare types, zero binding imports, and zero environment variables.

### 2. Adapters

- **Cloudflare Flagship Adapter (`src/features/cfFlagshipAdapter.ts`):** Implements `FeatureFlagPort` against the native Cloudflare Flagship binding (`env.FLAGS`) compliant with CNCF OpenFeature. Local in-worker evaluation with sub-millisecond latency. Any Flagship error fails closed (`false`).
- **Environment Variable Adapter (`src/features/envFeatureFlagAdapter.ts`):** Implements `FeatureFlagPort` against environment variables (`FEATURE_<FLAG>`, `FEATURE_FLAGS` bulk JSON, and legacy `SOCIAL_POSTING_ENABLED`).
- **In-Memory Adapter (`src/features/inMemoryFeatureFlagAdapter.ts`):** Implements `FeatureFlagPort` with an in-memory map for deterministic unit testing and sandbox shadow runs.

### 3. Composition Root (`src/features/createFeatureFlagPort.ts`)

A centralized factory maps runtime bindings or environment configs to the appropriate port implementation:
- If `env.FLAGS` is present: instantiates `CfFlagshipAdapter`.
- If `env` without `FLAGS`: instantiates `EnvFeatureFlagAdapter`.
- If `"in-memory"`: instantiates `InMemoryFeatureFlagAdapter`.

### 4. Conformance Suite (`tests/feature-flags-port-conformance.test.ts`)

A dedicated conformance test suite exercises all adapters against the same set of assertions, proving complete provider independence and contract parity.

### 5. Server-Side Enforcement (Unreachable When Disabled)

Hiding a UI element is insufficient. Server routes must enforce feature state before execution:
- When a route belonging to a disabled feature is requested, the server immediately returns **HTTP 404** with:
  ```json
  {
    "error": "Feature 'screener' is disabled.",
    "code": "FEATURE_DISABLED",
    "feature": "screener"
  }
  ```
- This ensures disabled features are completely unreachable.

### 6. Client-Side Integration

- The Worker injects active flags into the bootstrap HTML via `window.__FEATURES__` (zero-latency client startup).
- An authenticated `GET /api/features` endpoint provides dynamic flag state on demand.
- The client navigation menu hides tabs for disabled features.
- Direct navigation to a disabled tab renders a clear, accessible disabled status card rather than a broken page.

## Consequences

- **Portability & Decoupling:** The domain layer has zero dependency on Cloudflare Flagship. Swapping providers (e.g. to LaunchDarkly, Unleash, or custom KV) requires only writing a new adapter without touching domain logic.
- **Screener First:** The screener is enabled first (`FEATURE_SCREENER: "1"` in `wrangler.jsonc`), while all other features default to closed (`false`) until intentionally rolled out.
- **Immediate Kill Switch:** Flipping a flag to OFF in Flagship immediately disables server routes and client access worldwide without a code deploy.
- **Backward Compatibility:** Existing deployments using `SOCIAL_POSTING_ENABLED` remain functional via the fallback path.
- **Auditability:** Flag checks are deterministic, synchronous where possible, and fail-closed under all edge cases.

## Alternatives Considered

1. **Client-Side Only Gating (Hiding Tabs):** Rejected. Leaving backend APIs open when a feature is nominally disabled violates least-privilege security and confidentiality.
2. **Workers KV Direct Lookup per Request:** Rejected in favor of Flagship. Flagship is purpose-built for feature flags with OpenFeature SDK support and sub-millisecond evaluation, avoiding KV eventual consistency lag.
3. **Procedural In-File Lookups:** Rejected in favor of the Port-First architecture. Hardcoding `env.FLAGS` lookups into business logic violated the repository's hexagonal architecture mandate.
