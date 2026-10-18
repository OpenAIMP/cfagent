# Observability

Issue #257 (Assessment P1, part of #143). Two complementary telemetry
channels; neither duplicates the other.

## 1. Workers Logs (platform invocation logs)

Configured explicitly in `wrangler.jsonc` under `observability.logs`:

```jsonc
"observability": {
  "enabled": true,
  "logs": { "invocation_logs": true, "head_sampling_rate": 1 }
}
```

- Captures one log per Worker invocation: request/response metadata plus
  `console.*` output. View under **Cloudflare dashboard > Observability >
  Logs** after a deploy (a config change requires redeploy to take effect).
- `head_sampling_rate: 1` = 100% of invocations sampled.
- No external destinations are configured: no OpenTelemetry `destinations`
  block is present because no destination exists in the dashboard. Adding
  one requires a dashboard-side destination first, then the names go here.

## 2. `mas_events` — structured audit sink (SQLite, per-tenant)

Schema: `src/orm/index.ts:462`
(`id, session_id, type, agent, payload, created_at`). Writes are best-effort
and never fail the operation they instrument. Verified writers:

| Writer | Type values | Where |
|---|---|---|
| Orchestrator routing/jobs | varies | `src/agents/orchestrator.ts` (`audit()`) |
| Scheduled tasks | varies | `src/services/scheduledTasks.ts` |
| Storage retention pass | `storage.retention` (per-run summary) | `src/security/storageRetention.ts` (issue #255) |
| TradingView webhook | provider event | `src/services/tradingWebhooks.ts` (`processTradingViewAlert`) |
| E*TRADE broker webhook | `ETRADE_<eventType>` | `src/services/tradingWebhooks.ts` (`processETradeBrokerWebhook`) |
| NLQ execution seam | `nlq.executed` / `nlq.error` | `src/agents/nlq.ts` (`auditNlqExecution`, issue #257) — one row per execution; payload carries domain/count/duration/source only, never the raw query text |
| Agent scheduling actions | `schedule.created` / `schedule.cancelled` | `src/agents/nlq.ts` (`executeSchedulingAction`) |

Query the sink via the orchestrator's `query_table_data` operation or the
MCP observability tooling (`src/mcp/commands.ts`).

## Retention honesty (issue #257)

UI copy must advertise only enforced retention. What is actually enforced:

- `mas_messages`: nightly pruning pass, window default 90 days,
  configurable via `MAS_MESSAGES_RETENTION_DAYS` (`<=0` disables).
  See `src/security/storageRetention.ts` (issue #255).
- `mas_events`: append-only audit ledger. No pruning is enforced; it retains
  full history until R2 archival lands (follow-on — no bucket exists yet).
  Do not advertise a retention window for the ledger.
