### Changed

- **Feature flags port/adapter architecture (#1815):** Decoupled Cloudflare feature flags behind a cloud-agnostic `FeatureFlagPort` with native `CfFlagshipAdapter`, `EnvFeatureFlagAdapter`, `InMemoryFeatureFlagAdapter`, and `createFeatureFlagPort` composition root, preserving full OpenFeature semantics and fail-closed defaults.
