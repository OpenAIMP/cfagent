# Think Conformance Assessment — cfagent

Assessment performed against the review plan in
[`docs/agents/cloudflare.md`](./cloudflare.md) (plan sections cited as §n).
This document is the §14 required output for this repository. It is an
evidence-backed assessment, not an official certification, and it does not
declare readiness beyond the evidence listed under "Checks performed".

- **Baseline commit:** `f063104` (main, 2026-10-20; includes PR #548, which
  closed finding F1 below)
- **Scope:** agent runtime and its Cloudflare deployment configuration.
  Functional/business correctness of trading, payments, and screener
  features is out of scope except where it intersects the agent loop.
- **Tracking:** epic #539. Remediation issues: #540 (done), #542, #543, #545.

## Executive assessment

| Area | Verdict | Basis |
|---|---|---|
| Think adoption | **PARTIAL** | Exactly one agent class (`ResearchAgent`) extends `Think`. The remaining chat agents extend `AIChatAgent` and run manual `streamText` loops. No project document designates which roles are *required* to be Think-based (§2), so partial adoption is a gap against the plan's profile, not yet a proven requirement violation. |
| Version / API compatibility | **PARTIAL** | `@cloudflare/think` 0.19.0 and `agents` 0.24.0 are pinned, and `ResearchAgent`'s overrides match the installed 0.19.0 type declarations (verified, see F0-note). But until PR #548, six dependencies floated on `latest`; residual risk is process, not current state. |
| Functional completeness | **UNKNOWN** | Not assessed feature-by-feature in this pass; 177 test files exist but the full suite was not re-run for this assessment. |
| Security and isolation | **PARTIAL** | Research path is read-only with a boundary test pinning the absence of order-mutation symbols; session/OAuth hardening is documented in the README. A dedicated authorization/tenant-isolation audit per §9A was not performed in this pass. |
| Reliability and recovery | **PARTIAL** | Bounded step counts everywhere; deterministic fallback exists for the research Think turn — but the fallback can silently bypass Think (F4). Restart/reconnect behavior of Think turns was not exercised. |
| Operational readiness | **PARTIAL** | Workers Logs observability is explicitly configured in `wrangler.jsonc`; cron/retention design is documented inline. No production observation was available to this assessment. |

## Baseline (§4)

Declared and resolved versions at baseline (declared == resolved after
PR #548; the lockfile is the resolution source):

| Package | Declared | Resolved |
|---|---|---|
| `@cloudflare/think` | 0.19.0 | 0.19.0 |
| `agents` | 0.24.0 | 0.24.0 |
| `@cloudflare/ai-chat` | 0.12.0 | 0.12.0 |
| `ai` | 7.0.123 | 7.0.123 |
| `@ai-sdk/react` | 4.0.126 | 4.0.126 |
| `workers-ai-provider` | 4.0.0 | 4.0.0 |
| `@cloudflare/voice` | ^0.5.0 | 0.5.0 |
| `@cloudflare/workers-types` (dev) | 5.20260930.1 | 5.20260930.1 |
| `wrangler` (dev) | 4.144.0 | 4.144.0 |

- Package manager: npm (`package-lock.json`); Node >= 22 per `engines`.
- Entrypoint: `src/server.ts` (Worker fetch handler + DO exports).
- Wrangler: `compatibility_date` 2026-09-29, flag `nodejs_compat`; custom
  domain `agent.openaimp.com`; Workers Logs enabled with invocation logs
  at 100% head sampling; cron triggers include a 30-minute tick and
  nightly jobs (see inline comments in `wrangler.jsonc` for the
  5-trigger account ceiling workaround).
- Durable Object bindings / SQLite migrations: `SEARCH_AGENT`
  (OrchestratorAgent, v1), `OPTIONS_SCANNER_MCP` (v2), `PAYMENTS_AGENT`
  (v3), `SCHEDULED_AGENT` (v3), `SCREENER_AGENT` (v4), `RESEARCH_AGENT`
  (v5), `SESSION_STORE` (v6). Other bindings: `AI`, `ASSETS`, KV
  `SESSIONS`/`ETRADE_KV` (fallback off), Vectorize `VECTOR_MEMORY`.
- Commands on record: `npm run typecheck`, `npm run test` /
  `test:ci` (vitest), `npm run build` (vite), `npm run check` (tokens +
  typecheck + tests + build), `wrangler deploy`.

## Architecture and identities (§7)

```
Browser (React 19)
  ├─ WebSocket ─► OrchestratorAgent (DO, exported as SEARCH_AGENT)
  │                 ├─ LLM Judge routing / evaluation
  │                 ├─ manual streamText loop (stepCountIs, clamped 1–10)
  │                 ├─ sub-agent tool classes (search / payments / tasks /
  │                 │   memory — AIChatAgent subclasses in src/agents/)
  │                 └─ runAgentTool dispatch ─► ResearchAgent (Think)
  │                        instance id: research:<userLogin>
  └─ REST ──────► Worker routes (auth, NLQ, audit, memory, trading, …)
Other DOs: PaymentsAgent (Agent), ScheduledAgent (Agent),
ScreenerAgent (Agent), OptionsScannerMCP (McpAgent),
SessionStore (plain DurableObject)
```

Identities kept distinct in the research path: user/tenant login,
agent instance (`research:<login>`), run id, generation id. Two naming
hazards are recorded as finding F5: the `SEARCH_AGENT` binding runs the
*orchestrator* class under an alias, and two unrelated classes are both
named `PaymentsAgent` (the DO in `src/agents/payments-agent.ts` and an
`AIChatAgent` sub-agent class in `src/agents/payments.ts`).

## Conformance matrix (§8–§11)

| Requirement | Verdict | Evidence | Missing verification |
|---|---|---|---|
| §8A Think is a resolved runtime dependency | PASS | `package.json`: `@cloudflare/think` 0.19.0 (exact) | — |
| §8A Designated agents use the Think base class | PARTIAL | `src/agents/research-agent.ts`: `ResearchAgent extends Think<Env>`; it is the only occurrence | Which roles are designated is unspecified (§2) — decision tracked in #545 |
| §8A Routing actually reaches the Think implementation | PARTIAL | `src/server.ts` exports `ResearchAgent`; `wrangler.jsonc` binds `RESEARCH_AGENT` + v5 migration; orchestrator dispatches via `runAgentTool(ResearchAgent, …)` | No live Think turn was executed in this assessment |
| §8A Tests exercise the Think path | FAIL | `vite.config.ts` aliases `@cloudflare/think` to `tests/stubs/cloudflareThink.ts` in tests ("tests never instantiate one"); no conformance test existed at baseline | Remediation: #542 |
| §8B Model/prompt via supported Think APIs | PASS | `ResearchAgent.getModel()` returns a model-id string — a valid `ThinkModel` in the installed 0.19.0 types (a string is resolved through Think's built-in workers-ai-provider); `getSystemPrompt()` / `getTools()` signatures match the installed declarations | Provider failure/rate-limit handling inside a live turn not exercised |
| §8C Think owns the loop where adopted | PARTIAL | For research, Think owns the turn when dispatch succeeds; the orchestrator's deterministic fallback can replace the turn (F4). All other chat agents run manual loops around `streamText` with their own persistence | Whether manual loops duplicate *required* Think guarantees depends on the #545 designation decision |
| §8D Conversation vs application state | PARTIAL | Research state lives in DO SQLite tables (`research_runs` etc.) distinct from chat history; run history capped (`MAX_HISTORY` 20 in the agent) | Retention/deletion semantics for Think-managed chat state in ResearchAgent not reviewed |
| §8E Turns, concurrency, recovery | UNKNOWN | Step bounds exist (below); fallback gives an interrupted-turn recovery path for research | Concurrent-turn admission, cancellation, and reconnect behavior not tested in this pass |
| §8F Programmatic / sub-agent operation | PARTIAL | Orchestrator → ResearchAgent dispatch has explicit input (`trigger`, `userLogin`) and validates the outcome (fresh run id, trigger, login) before publishing; mismatch triggers fallback | Child-result schema validation is field checks, not a typed contract test |
| §8G Optional extensions (MCP etc.) | NOT APPLICABLE to Think profile | MCP is used via `OptionsScannerMCP` (McpAgent), outside Think | — |
| §9A Security and permissions | PARTIAL | Research modules are read-only; `tests/research-boundary.test.ts` fails if research code references order-mutation symbols; tool inputs use zod schemas | Full §9A audit (authZ on every path, approval binding) not performed here |
| §9B Durable execution / side effects | PARTIAL | Research pipeline persists run records; publish path stores exactly one canonical report (orchestrator `mas_reports` seam) | Idempotency proofs for non-research side effects not reviewed |
| §9C Separation of concerns | PARTIAL | Domain logic sits in `src/services/` and is unit-tested independently of agents; business rules use deterministic fixtures | Orchestrator remains a 2,802-line monolith (F6) |
| §9D Resource and cost controls | PASS (for loop bounds) | Standalone agents: `stepCountIs(2–3)`; orchestrator: `MAS_MAX_STEPS` env, clamped 1–10 in code; research tool instructs exactly one pipeline call per request | Token/time budgets per turn not separately verified |
| §9E Observability | PARTIAL | Workers Logs + invocation logs configured; audit endpoints exist | Think-vs-fallback path is not distinguishable in logs (F4; remediation #543) |
| §10 Autonomous collaboration | NOT APPLICABLE | Single-tenant agent system; no multi-agent worker pool claiming tasks | — |
| §11 Cloudflare deployment profile | PARTIAL | Bindings, migrations, compat date/flags, and cron design are explicit in `wrangler.jsonc` | Local-vs-deployed behavior and DO restart recovery not exercised |
| §12 Test requirements | PARTIAL | 177 test files; boundary/honesty/extraction suites pin many contracts | No Think conformance suite at baseline (#542); Workers-runtime integration evidence is mostly Node-level |

## Findings (§13)

### F1 — Floating `latest` dependency specs — MEDIUM — **CLOSED by #540 / PR #548**
- Classification: Baseline / SDK-API compatibility.
- Observed (pre-fix): six specs declared as `latest` in `package.json`
  (four runtime, two dev), so declared versions carried no information
  and installs were not reproducible from `package.json` alone.
- Correction: pinned to the exact lockfile-resolved versions (no
  upgrades) and added `tests/dependency-pinning.test.ts` as a regression
  guard.

### F2 — Designated Think roles are unspecified — MEDIUM — open, #545
- Classification: Think conformance / unverified assumption.
- Requirement: plan §2 — determine which roles are required to run
  through Think; if unspecified, report as unresolved.
- Observed: only `ResearchAgent` is Think-based; no project document
  designates required roles, so "should the orchestrator migrate?" has
  no authoritative answer today.
- Failure scenario: migration effort spent (or refused) on preference
  rather than requirement; conformance verdicts stay PARTIAL forever.
- Recommended correction: the decision record in #545.

### F3 — Think-path test evidence is a stub — MEDIUM — open, #542
- Classification: Think conformance / test evidence.
- Observed: vitest replaces `@cloudflare/think` with a minimal stub
  class; deleting the Think import, the DO export, or the
  `RESEARCH_AGENT` binding would not fail any test at baseline.
- Recommended correction: source-evidence conformance suite (#542).

### F4 — Research fallback silently bypasses the Think turn — MEDIUM — open, #543
- Classification: Reliability / observability.
- Observed: `OrchestratorAgent.runResearchAndPublish` falls back to a
  direct `agent.runResearch(...)` call when the Think child turn does
  not produce a fresh report, with no structured signal distinguishing
  the two paths.
- Failure scenario: a permanently broken Think path is masked by the
  fallback; operators see successful research while Think conformance
  regresses unnoticed.
- Recommended correction: identifier-carrying warning on the fallback
  branch, pinned by a regression test (#543).

### F5 — Agent identity naming hazards — LOW — open, follow-up proposed
- Classification: Maintainability.
- Observed: `SEARCH_AGENT` binding runs `OrchestratorAgent` (aliased
  export in `src/server.ts`); two distinct classes are named
  `PaymentsAgent` (`payments-agent.ts`, a DO, vs `payments.ts`, an
  `AIChatAgent` sub-agent class).
- Recommended correction: rename the standalone sub-agent classes (or
  document the alias map at the export site) in a dedicated issue.

### F6 — Orchestrator monolith — LOW — open, long-running
- Classification: Maintainability.
- Observed: `src/agents/orchestrator.ts` is 2,802 lines at baseline.
  The repo is already decomposing adjacent monoliths incrementally
  (e.g. the NLQ extraction); the same approach fits here.
- Recommended correction: continue extraction-by-domain PRs; no big-bang
  rewrite.

### Note (not a finding)
An early hypothesis — that `ResearchAgent.getModel()` returning a string
was an API misuse — was **disproven** against the installed
`@cloudflare/think` 0.19.0 type declarations: `ThinkModel` is
`LanguageModel | ThinkModelId`, and a string id is resolved through
Think's bundled `workers-ai-provider`. Recorded here so the correction
is not re-litigated.

## Checks performed

- Read `docs/agents/cloudflare.md` in full.
- Inspected `package.json` / `package-lock.json` (declared vs resolved).
- Downloaded `@cloudflare/think@0.19.0` and verified
  `getModel` / `getSystemPrompt` / `getTools` signatures against its
  shipped type declarations.
- Code-searched all `@cloudflare/think` / `Think` / `AIChatAgent` usages
  and read `src/agents/research-agent.ts`, `src/agents/model.ts`,
  `vite.config.ts`, `tests/stubs/cloudflareThink.ts`,
  `tests/research-boundary.test.ts`, and the `ResearchAgent` dispatch
  section of `src/agents/orchestrator.ts`.
- Read `wrangler.jsonc` (bindings, migrations, crons, observability).
- For remediation PR #548: `npm ci`, `npm run typecheck`,
  `npm run build`, and the new guard test were run locally and passed.

Checks **not** run: the full vitest suite for this assessment, any
`wrangler dev`/deployed execution, any live Think turn, load or
concurrency tests, and any production observation. Verdicts depending on
those are marked UNKNOWN or PARTIAL accordingly.

## Remediation plan

Required, in order (one PR each, merged before the next starts):
1. ~~Pin floating dependencies~~ — done, #540 / PR #548.
2. Think conformance regression tests — #542.
3. Observable Think-turn fallback — #543.
4. Designated-roles decision record — #545.

Optional / separate: F5 renames, F6 continued orchestrator extraction.

## Acceptance criteria

- F2 closes when the #545 decision record names a designation
  (required / optional / not planned) for every exported agent class.
- F3 closes when a merged test suite fails upon removal of any of:
  the Think import/base class, the `src/server.ts` export, the
  `RESEARCH_AGENT` binding, or its SQLite migration.
- F4 closes when the fallback branch emits a structured signal carrying
  trigger, login, and child status, pinned by a test.
- F5/F6 close per their own follow-up issues, when created.

## Final recommendation

**Ready with documented limitations** for the current environment: the
one designated-by-implementation Think agent is API-correct against the
installed framework, the baseline is now reproducible, and the material
gaps (F2–F4) have tracked, sequenced remediation. Not ready to claim
full Think conformance — by the plan's own rule, that claim waits on
the F2 designation decision and live-path evidence.
