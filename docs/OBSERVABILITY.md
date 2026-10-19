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

## 3. Free-tier budgets (issue #329)

The plan this Worker is on has **two 100,000/day ceilings that are spent the
same way**: one Workers request, one KV read per request. They fail hard, not
softly, and reset at **00:00 UTC**.

| Resource | Free tier | On exhaustion |
| --- | --- | --- |
| Worker requests | 100,000 / day | 429 at the edge |
| KV reads | 100,000 / day | every `get()` throws |
| KV writes / deletes / lists | 1,000 / day each | the operation throws |
| KV storage | 1 GB | writes fail |

**Where state lives now.** Sessions, E*TRADE credentials and the x402 replay
guard are in the `SessionStore` Durable Object (`src/security/sessionStore.ts`),
addressed through `createStoreKv` / `consumeStoreKey`. KV is a migration source
only, and `SESSIONS_KV_FALLBACK=off` switches even that off. The DO has no daily
read cap; its cost is one request per operation, so the same "call it less"
instinct still applies.

**Rules**

1. **No new KV read on a per-request path.** New hot-path state belongs in the
   DO. KV is for cold, migration-shaped data.
2. **Never poll KV to measure KV.** Dashboard and `wrangler kv` operations count
   against the same budget; a monitor that reads KV spends what it measures.
3. **Alert on level *and* rate.** 50% plus a rate-of-change signal; hourly
   75/90% checks leave too few observations between "fine" and 429.
4. **Treat quota errors as degraded, not fatal.** `createResilientKv` turns them
   into a miss behind a breaker, and `withErrorBoundary` converts anything
   escaped into a 503/500 — the 1101 path from issue #329 is closed by those two,
   not by the quota never running out.

**What "normal" costs.** After #418 an idle dashboard tab is ~5,760 requests/day
(20 s `/api/jobs` when idle, 60 s `/api/screener/latest`, both paused while
hidden), so the request budget holds ~17 concurrently open tabs. A regression
here — a new 4 s poller, a missing `visibilityState` gate — is the most likely
cause of a quota alert, and it shows up as request volume, not KV volume.

## Retention honesty (issue #257)

UI copy must advertise only enforced retention. What is actually enforced:

- `mas_messages`: nightly pruning pass, window default 90 days,
  configurable via `MAS_MESSAGES_RETENTION_DAYS` (`<=0` disables).
  See `src/security/storageRetention.ts` (issue #255).
- `mas_events`: append-only audit ledger. No pruning is enforced; it retains
  full history until R2 archival lands (follow-on — no bucket exists yet).
  Do not advertise a retention window for the ledger.
