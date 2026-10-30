### Fixed

- **DO request-volume polling migration (#2419):** all client polls converge onto the shared treatment — landing quotes widget and app quotes service reconnect with backoff instead of polling forever, REST fallback 12s → 60s, every poll pauses while its tab is hidden, and flows / options-latest / Chat auto-refresh / goal tracking migrate onto the visibility-aware shared layer. Every cadence is externalized (wrangler vars, `window.__POLLING_CONFIG__` at boot); visible-tab freshness is unchanged.
