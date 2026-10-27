### Changed

- **Fleet comment cleanup (#2033, tracker #1951):** corrected two comments left stale by the Think fleet migration, with no behavior change. `tests/trading_agent.test.ts` no longer carries the held-era HOLD claim that the file cannot run under node — harness #2003 landed, so the file runs under node with real assertions via the test-only `@cloudflare/think` stub. `tests/agent-conformance.test.ts` no longer claims BrowserAgent/SlackAgent extend AIChatAgent — both extend PortThink now (Browser #1959, Slack #1960); the pin list itself is unchanged (empty).
