# Asynchronous capability execution

The Orchestrator exposes a shared durable job lifecycle for work submitted through REST, Chat, and MCP. A job is scoped to the authenticated user's Orchestrator Durable Object and recorded in its SQLite storage.

## Horizontal contract

Each job has a UUID, capability name, status (`queued`, `running`, `completed`, or `failed`), timestamps, and either a result or an error. Work is scheduled through the Agent scheduler; the UI does not need to keep the originating page open.

- `GET /api/jobs?limit=30` lists recent jobs for this session.
- `GET /api/jobs/{jobId}` returns status and the terminal result/error.
- Every other `/api/*` request handled by the Orchestrator is submitted as a durable job and initially returns HTTP `202` with `{ jobId, status, statusUrl }`. The Worker's signed NLQ webhook retains its synchronous callback contract. The paid x402 scanner verifies payment first, then submits its scan to the same Orchestrator job queue; `get_scan_job` and `list_scan_jobs` are its MCP status adapters.
- The browser's `apiFetch` adapter polls the job endpoint and reconstructs the original API response, preserving existing forms and consumers. If polling times out, the job continues and remains available in the Async Tasks panel.
- MCP tool calls return a queued job ticket. `get_async_job` and `list_async_jobs` are control-plane tools and remain immediate.

Terminal records older than 30 days are removed when new work is submitted; at most 500 recent terminal records are retained per session. The per-request body limit is 8 MB and persisted response body limit is 5 MB. Execution is intentionally at-most-once: if a job is interrupted after it starts and does not record a result within two hours, it is marked failed with an unknown-outcome warning rather than automatically replaying a possibly side-effecting API call.

## Vertical execution

The job runner currently dispatches:

- `http.request`: executes any existing Orchestrator REST route and stores the response for the compatibility adapter.
- `mcp.tool`: executes a registered general MCP command. The separately paid scanner submits its REST screening request as `http.request` after x402 payment acceptance.
- `nlq.execute`: runs the shared asynchronous NLQ executor, including the options strategy pipeline.
- `task.draft`: creates an asynchronously tracked task draft.

REST, Chat, and MCP therefore share the same job lifecycle. The options NLQ route and `McpSystemFacade.executeNlq` use `executeNLQQueryAsync`, so strategy actions no longer fall back to the sync executor.

## Adding a capability

Add a typed capability identifier and validated input at the entry surface, persist only serializable input, and register its execution branch in `OrchestratorAgent.executeAsyncJob`. Domain logic should live in a vertical service imported by all relevant adapters, rather than being duplicated in an HTTP route or MCP command. Keep job-status reads and MCP job-control tools immediate to avoid recursively queueing the control plane.
