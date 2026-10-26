### Added

- **Cloudflare feature flags (#1806):** Edge-native feature flag registry and evaluator supporting Cloudflare Flagship native binding with OpenFeature compliance and fail-closed env-var fallback, enforcing server-side route gating (HTTP 404 for disabled features), client-side visibility gating, and screener-first rollout with ADR 0005.
