# Scan appendix (b) — NLQ unification — parent #1717

## Agent

#CISO-bhdm

Scan head: `23de3ce`. Main doc: `docs/compliance/system-duplicates-scan-1717.md`.
Standing rules: NEVER EITHER/OR ALWAYS CONFIGURABLE (one switch per pair); scoped
defaults run > session > user > global env > built-in (public route behavior);
never remove an endpoint; never delete a code path. SAFETY: the webhook
social-brief withholding below must be preserved by any unification.

All NLQ paths call `executeNaturalLanguageQuery` / `executeNLQQueryAsync` in
`src/agents/nlq/execution.ts`, but with different injected ports.

## M03 — execute_nlq vs POST /nlq — DIVERGENT

- REST `POST /nlq` (`src/agents/routes/mcpChatNlq.ts:243`): requires `x-user-login`
  (401 otherwise); calls `executeNaturalLanguageQuery` with context,
  `validateWithLLM`, `scanRunStore`, `profileStore`, `schedulingPort`,
  `socialBriefPort` (trusted chat only), `discoveryRunner`, `fitDiscoveryRunner`;
  audits `nlq.executed`; returns the result synchronously.
- MCP `execute_nlq` (`src/mcp/commands.ts:497`): via `POST /mcp` it is wrapped as
  an async job (`capability:"mcp.tool"`, see appendix (d) J02) returning
  `{jobId, status: "queued", statusUrl}` — NOT the result. When finally executed
  via `executeMCPTool`, it takes the facade path: `planNLQ` +
  `executeNLQQueryAsync` with NO ports, NO stores, NO runners, NO LLM validation,
  `userLogin = sessionId` (not the `x-user-login` login), and a facade audit
  instead of the route audit. Via direct factory execution (no facade) it calls
  `executeNaturalLanguageQuery` with no options, so `userLogin = sessionId`,
  `userDid` undefined.
- Effect: scheduling/social/discovery/stock-screen NLQ operations fail honestly
  or fall back to the listings screener on the MCP path while succeeding on the
  REST path.

## N01 — NLQ port matrix: four execution contexts, four contracts — DIVERGENT

| Context | scheduling | stockScreen | socialBrief | discovery + fit | scan/profile stores | identity (userLogin) | LLM validation |
|---|---|---|---|---|---|---|---|
| REST `POST /nlq` (sync) | YES | NO → listings fallback | YES (trusted only) | YES | YES | `x-user-login` (401 if absent) | YES (`validateWithLLM` passthrough) |
| Async job `nlq.execute` | YES | YES (ScreenerAgent, maxItems 10) | NO → honest error | YES | YES | payload `userLogin` or session key | via `executeNaturalLanguageQuery` (no explicit flag) |
| MCP via facade | NO → honest error | NO → listings fallback | NO → honest error | NO | NO | `sessionId` | NO (plan + async execute only; no `llmValidation`/`planSource` patch) |
| MCP direct (no facade) | NO | NO | NO | NO | NO | `sessionId`, `userDid` undefined | YES (full `executeNaturalLanguageQuery`, no options) |
| Chat-error fallback | YES | YES | NO | NO | YES | orchestrator session | (fallback path) |

Verified effects: no scheduling port → `"Scheduling (…) unavailable: no live
agent scheduling port … NOT executed"`; no social port → social brief honest
error, nothing stored; no stock-screen port → market screens run
`ETradeService.screenMarketsAsync` (listings) instead of the ScreenerAgent run +
canonical report persistence, and `watchlist_save` falls back to the listings
top-10 instead of standout picks. Discovery/fit behaviour without runners was not
traced to a single error string in the scan — verify before claiming a specific
failure mode — but the runners are absent on both MCP paths while present on
REST/async paths, so discovery NLQ cannot be identical across them.

## N02 — Webhook NLQ social-brief withholding — DIVERGENT (by design)

- Worker (`src/server.ts:203,270,367`): `/nlq/webhook`,
  `/api/trading/nlq/webhook`, `/api/nlq/webhook` (throttled 30/min, HMAC-verified,
  nonce replay-claimed) forward to DO `/nlq` with `x-nlq-source: webhook`.
- DO route (`mcpChatNlq.ts:265`): webhook origin ⇒ `socialBriefPort = undefined`,
  so a social-brief NLQ over webhook fails honestly instead of writing a
  public-post input with no human approval. The header can only REMOVE the port
  (a forged `webhook` value on a direct call disables intake for that caller),
  never grant it. Scheduling and discovery ports are NOT withheld on the webhook
  path — webhook NLQ can still create schedules and run discovery.
- Slice guidance: any unification must preserve this asymmetric withholding. A
  switch that made webhook NLQ gain a social-brief port would be a safety
  regression, not a unification.

## Port matrix note for the slice

The slice must pin each cell of the N01 matrix in both switch modes before
changing port injection, and must decide (recorded, owner-overturnable) whether
the switch default is the REST-sync contract or the async-job contract — both are
"public route behavior" in different spellings, so the slice must name which one
is the built-in default rather than assuming it.
