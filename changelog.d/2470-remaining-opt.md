### Fixed

- Remaining DO request optimizations under Paid (#2470): session touch interval 60s to 300s via config, one shared poll for `/api/options/latest` so two mounted components produce one network poll per cadence, and verification (not removal) of the ORCHESTRATOR_AGENT and SANDBOX_AGENT bindings. Session get+put batching quantified as verified-negligible (at most one store call per touch interval) and deliberately not built.
