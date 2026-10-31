### Fixed

- **Cross-tenant queue fan-out addresses the right namespace (#2516):** `adminTenantQueues` instance resolution now goes through `env.SEARCH_AGENT` — where the per-login instances and their schedules/maintenance state live, matching `src/server.ts` and the chat client — instead of the `ORCHESTRATOR_AGENT` binding, whose instances hold none of that state. This is the precondition for Deploy A of the G0 rename (#2330) removing the `ORCHESTRATOR_AGENT` binding; the #2470 binding guard now pins the SEARCH_AGENT path.
