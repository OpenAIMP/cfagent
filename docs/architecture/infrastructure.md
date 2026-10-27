# Infrastructure architecture

Container: this document is the infrastructure section of the ADD
(`docs/architecture/ADD.md`, issue #1449, CPO lane). Until that container
lands, this file stands alone; the ADD's infrastructure section will link
here. The COO lane holds the adjacent networking-operations view (a #1449
sibling) — the two docs are cross-linked, not duplicated: this file covers
what the infrastructure *is* (Workers, Durable Objects, bindings, storage,
scheduling, deploy pipeline); the networking-operations view covers how
the network is *operated*.

Everything below is verified against `wrangler.jsonc`, `src/server.ts`,
and `.github/workflows/deploy.yml` on main. No secret values are recorded
here; secrets live out of band (see §9).

## 1. Topology

```
Internet
  → Cloudflare edge (custom domain agent.openaimp.com)
  → Worker ai-search-agent (src/server.ts)
      → Durable Objects (per-instance SQLite) via stub-per-id RPC
      → R2 bucket `screener` (report bodies, blobs)
      → Workers AI, AI Search, Vectorize, Flagship (feature flags)
      → Analytics Engine (observability dataset)
  → Upstream providers: E*TRADE, Yahoo Finance, Alpaca, Nasdaq
  → Delivery channels: Slack, email (via cfpay A2A), webhook
```

The app is GitHub-auth gated (see `src/oauth.ts`). The client is a React
+ Vite SPA served from the Worker's static assets (see §2), not a
separate host.

## 2. Worker

- **Name:** `ai-search-agent`. **Entry:** `src/server.ts`.
- **Compatibility:** date `2026-09-29`, flag `nodejs_compat`.
- **Static assets:** `./dist/` behind the `ASSETS` binding, with
  `run_worker_first: ["/", "/index.html"]` — the SPA shell is served
  through the Worker, and unmatched routes still reach Worker code.
- **Dispatch pattern:** the Worker's `fetch` handler forwards to Durable
  Objects with `env.<BINDING>.get(id).fetch(...)` — one stub per
  instance id, RPC across the DO boundary. Request bodies do not cross
  that boundary (see the cfpay reference pattern in
  `docs/architecture/reference/cfpay.md`).

## 3. Durable Objects

Each class is a SQLite-backed DO; migrations are tagged per class. One
instance holds its own state — there is no cross-instance enumeration,
which is why cross-instance collection is an open design question for
the orphan sweep (issue #1168).

| Binding | Class | Migration | Purpose |
|---|---|---|---|
| SEARCH_AGENT | SearchAgent | v1 | Search / orchestrator entry (also exported as OrchestratorAgent) |
| OPTIONS_SCANNER_MCP | OptionsScannerMCP | v2 | Options scanner MCP surface |
| PAYMENTS_AGENT | PaymentsAgent | v3 | Payments |
| SCHEDULED_AGENT | ScheduledAgent | v3 | Scheduled runs |
| SCREENER_AGENT | ScreenerAgent | v4 | Stock screener |
| RESEARCH_AGENT | ResearchAgent | v5 | Research runs |
| SESSION_STORE | SessionStore | v6 | Sessions + credentials (see §5) |
| REPORT_ASSET_AGENT | ReportAssetAgent | v7 | Report assets |
| TRADING_AGENT | TradingAgent | v8 | Trading competency |
| ORCHESTRATOR_AGENT | OrchestratorAgent | v9 | Orchestrator root namespace (sub-agent bootstrap) |

## 4. Workflows

| Binding | Workflow | Purpose |
|---|---|---|
| TRADE_WORKFLOW | TradingTradeWorkflow | Trade execution workflow |
| SCREENER_WORKFLOW | ScreenerScreenWorkflow | Screen execution workflow |

## 5. Storage

- **R2 — `REPORTS_BUCKET` → bucket `screener`.** Report bodies live at
  `reports/<reportId>.json`; capture/blob datasets (e.g. gather output)
  live under their own prefixes. Report PDFs are generated assets, not
  rows.
- **KV — none.** KV namespaces were removed (issue #606): sessions and
  E*TRADE credentials live in the SessionStore DO, report PDFs in R2.
  (The Cloudflare-dashboard namespace deletion is an owner step.)
- **Vectorize — `VECTOR_MEMORY` → index `vector-memory`.** Retrieval
  memory for the RAG path.
- **Analytics Engine — `OBSERVABILITY` → dataset `observability`.**
- **DO SQLite** — per-instance state (see §3); `mas_reports` rows live
  per DO instance, with `body_r2_key` pointing at the R2 object.

## 6. AI, search, and flags

- **Workers AI — `AI` binding.** Model selection is config
  (`AI_MODEL`, currently `@cf/zai-org/glm-4.7-flash`).
- **AI Search — `AI_SEARCH_ENDPOINT`.** Cached search endpoint
  (`AI_SEARCH_CACHE_TTL_MS`, `AI_SEARCH_CACHE_MAX_ENTRIES`).
- **Flagship — `FLAGS` binding.** Cloudflare Flagship feature-flag app
  (feature flags behind the FlagFlagPort adapter).

## 7. Scheduling

`src/server.ts` `scheduled()` handles three cron triggers:

| Schedule (UTC) | Purpose |
|---|---|
| `0 3 * * *` | Daily scheduled work |
| `*/30 * * * *` | ScheduledAgent tick (every 30 minutes) |
| `0 4 * * *` | Nightly `mas_messages` retention pass |

The daily options-research run (21:00 UTC) deliberately rides the
30-minute tick instead of a fourth trigger: the account is at the
Workers Free ceiling of 5 triggers per account (error 10072), and a
fifth entry fails the entire deploy.

## 8. Deploy pipeline

`.github/workflows/deploy.yml` — "Deploy NextGenTP":

- **Triggers:** push to `main`, plus `workflow_dispatch` with a target
  environment input (`CONFIG` / `PROD` / `TEST`).
- **First step:** Load Active Environment — reads
  `environment.config.json` (or the dispatch input) to determine the
  target environment. CI and deploy both key off this step.
- **Runtime:** Node 22. Branch protection on `main` requires a PR,
  green checks, up-to-date branches, and linear history (rebase merges
  only); delivery rules live in `docs/agents/gitops.md`.

## 9. Configuration

Non-secret runtime config lives in `wrangler.jsonc` `vars`:

| Var | Meaning |
|---|---|
| `APP_NAME` | `NextGenTP` |
| `MAS_MAX_STEPS` | Max agent steps (`4`) |
| `AI_MODEL` | Workers AI model id |
| `AI_SEARCH_CACHE_TTL_MS` / `AI_SEARCH_CACHE_MAX_ENTRIES` | AI Search cache tuning |
| `CF_WALLET_NETWORK` / `CF_WALLET_FACILITATOR` | x402 wallet network (`base-sepolia`) and facilitator |
| `IAAA_*` | Identity/authorization wiring flags (providers, PDP) |

Secrets (E*TRADE session, A2A token, wallet recipient, and similar) are
set via `wrangler secret` or the Cloudflare dashboard and never appear
in the repo. The PROD E*TRADE session is owner-connected in Settings.

## 10. Observability

- **Workers Logs:** enabled, invocation logs on, head sampling rate 1
  (100% sampled). Visible under Observability > Logs.
- **No external destination:** no OpenTelemetry destination is
  configured in the dashboard. See `docs/OBSERVABILITY.md`.
- **Analytics Engine:** the `observability` dataset (§5).

## 11. Cross-links

- ADD container: `docs/architecture/ADD.md` (issue #1449, CPO lane) —
  pending; this file is its infrastructure section when it lands.
- Networking operations: the COO lane's #1449 sibling view.
- Delivery rules: `docs/agents/gitops.md`.
- System overview: `docs/architecture/business/system-overview.md`.
- Architecture decision records: `docs/architecture/adr/`.
- Observability detail: `docs/OBSERVABILITY.md`.
