# 0006. Cloudflare feature flags: native Flagship binding with fail-closed env-var fallback

- Status: accepted
- Date: 2026-10-26
- Deciders: owner (Mubasher Ahmed), #ceo-aimp
- Issue: #1806
- Implementing PR: feat/cf-feature-flags-1806

## Context

Deploying code to `main` must not automatically expose unfinished, unapproved, or experimental features in production. Previously, the repository had no unified feature flag registry. Gating was handled ad-hoc via isolated environment variables in `wrangler.jsonc` (such as `SOCIAL_POSTING_ENABLED`, `IAAA_PDP_ENABLED`, and `IAAA_WIRING_ENABLED`), requiring full Worker redeployments for every state change. Furthermore, some capabilities were hidden only in the UI while their underlying server routes remained callable.

Issue #1806 requires:
1. Confirming the exact Cloudflare feature-flag mechanism (dashboard, Workers config, or native Cloudflare solution) and documenting it.
2. Defining a single feature registry starting with `screener`, default-closed (OFF).
3. Migrating existing flags or establishing explicit fallbacks without running duplicate parallel flag systems.
4. Enforcing gating server-side so disabled features are unreachable (returning HTTP 404 `FEATURE_DISABLED`), not merely hidden.
5. Default-closed and fail-closed: unknown flags, missing configurations, or flag-service evaluation errors must evaluate to `false`.

## Decision

### 1. Cloudflare Native Mechanism: Flagship (OpenFeature)

The primary feature flag provider is **Cloudflare Flagship**, Cloudflare's native edge feature flagging service built into the Cloudflare global network.
- Flagship exposes a native Worker binding (`env.FLAGS`) compliant with the CNCF **OpenFeature** standard.
- Flag evaluation executes locally in-worker with sub-millisecond latency (zero external HTTP round trips).
- Flag updates made via the Cloudflare dashboard or `wrangler flagship` propagate globally within seconds without requiring Worker redeployment.
- The binding interface provides:
  ```typescript
  env.FLAGS.getBooleanValue(flag: string, defaultValue: boolean, context?: Record<string, unknown>): Promise<boolean>
  ```

### 2. Dual-Layer Fallback Architecture (Reuse & Local Dev)

To guarantee fail-safe operation during local development, test suites (Vitest), and deployments before Flagship is provisioned:
1. **Primary Layer:** `env.FLAGS.getBooleanValue(flag, false, context)` (Cloudflare Flagship).
2. **Environment Variable Fallback:** If `env.FLAGS` is not bound, check:
   - Bulk JSON variable `env.FEATURE_FLAGS` (e.g. `{"screener": true}`).
   - Specific named variable `env["FEATURE_" + flag.toUpperCase()]` (e.g. `FEATURE_SCREENER="1"`).
   - Explicit legacy mapping: `social_publishing` falls back to `env.SOCIAL_POSTING_ENABLED === "1"`.
3. **Fail-Closed Default:** If a flag is unrecognized, unconfigured, or if evaluation throws an error, the evaluation returns `false`.

### 3. Single Feature Registry (`src/config/featureFlags.ts`)

All product features are catalogued in a single registry enum:
- `screener`: Stock & options screening pipelines (E*TRADE and Yahoo/FOSS), screening presets, and workflow runs.
- `options_research`: Autonomous options research flows, sweeps, blocks, and IV analysis.
- `autopilot`: Autonomous policy execution and trading desk.
- `trading_orders`: Fast order ticket, order preview, and order execution.
- `voice_trading`: Hands-free voice trading desk and audio recognition.
- `social_publishing`: Social media brief generation, Slack approval actions, and publishing.
- `nlq`: Natural language database records and ledger explorer.
- `payments`: x402 protocol, billing, and payment gateway sandbox.
- `schedules`: Scheduled background tasks and cron-driven goals.

### 4. Server-Side Enforcement (Unreachable When Disabled)

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

### 5. Client-Side Integration

- The Worker injects active flags into the bootstrap HTML via `window.__FEATURES__` (zero-latency client startup).
- An authenticated `GET /api/features` endpoint provides dynamic flag state on demand.
- The client navigation menu hides tabs for disabled features.
- Direct navigation to a disabled tab renders a clear, accessible disabled status card rather than a broken page.

## Consequences

- **Screener First:** The screener is enabled first (`FEATURE_SCREENER: "1"` in `wrangler.jsonc`), while all other features default to closed (`false`) until intentionally rolled out.
- **Immediate Kill Switch:** Flipping a flag to OFF in Flagship immediately disables server routes and client access worldwide without a code deploy.
- **Backward Compatibility:** Existing deployments using `SOCIAL_POSTING_ENABLED` remain functional via the fallback path.
- **Auditability:** Flag checks are deterministic, synchronous where possible, and fail-closed under all edge cases.

## Alternatives Considered

1. **Client-Side Only Gating (Hiding Tabs):** Rejected. Leaving backend APIs open when a feature is nominally disabled violates least-privilege security and confidentiality.
2. **Workers KV Direct Lookup per Request:** Rejected in favor of Flagship. Flagship is purpose-built for feature flags with OpenFeature SDK support and sub-millisecond evaluation, avoiding KV eventual consistency lag.
3. **Hardcoded Code Constants:** Rejected because toggling features required a full pull request, review, rebase, and CI/CD deployment cycle.
