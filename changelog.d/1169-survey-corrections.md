### Fixed

- Corrected the AI Search activation survey's `SEARCH_AGENT` claims: the binding resolves via the `src/server.ts:216` export alias to `OrchestratorAgent` and is a live surface dispatched through `env.SEARCH_AGENT` — the survey's literal `class SearchAgent` grep had missed the alias (#1169).
