# Threat Model — cfagent (OpenAIMP)

Assessment item 10 (issue #276). Focus: the cross-channel NLQ paths —
the exfil-relevant surfaces. This document is descriptive: it records the
threats we design against and where each mitigation lives in the code.

## 1. Scope

**In scope:**

- Inbound webhooks: E*TRADE broker notifications, TradingView alerts
  (`src/security/webhookSecurity.ts`, `src/security/webhookReplay.ts`,
  `src/services/tradingWebhooks.ts`).
- The NLQ webhook edge route: `POST /nlq/webhook`
  (and aliases `/api/trading/nlq/webhook`, `/api/nlq/webhook` — all three
  delegate to the single-owner `handleNlqWebhookRequest`, issue #313) in
  `src/server.ts` — fans out to
  the NLQ planner and optionally emails the result.
- The NLQ engine itself (`src/agents/nlq.ts`, SearchAgent) — turns natural
  language into reads against the SQLite/agent data layer.
- The Slack agent path (`src/agents/slackAgent.ts`) — signed inbound
  requests that can trigger agent work and email.
- Outbound dispatch: report/trading emails and outbound webhooks
  (`src/agents/orchestrator.ts`, `assertSafeOutboundWebhookUrl`).

**Out of scope:** the Cloudflare platform itself, provider-side security
(E*TRADE/Slack/TradingView), maintainer workstations, CI secrets handling
(see `SECURITY.md`).

## 2. Assets

1. **E*TRADE OAuth tokens** — bearer credentials for a live brokerage account.
2. **User trading data** — portfolios, orders, watchlists, screener results.
3. **Webhook/API secrets** — HMAC keys that authenticate inbound traffic.
4. **Email delivery** — the ability to send mail as the platform; a
   spoofed/forged dispatch is a phishing primitive.
5. **Agent execution** — NLQ-triggered queries and scheduled work billed to
   the owner's account.

## 3. Trust Boundaries

```
internet ──► edge Worker (untrusted input sanitized here)
  providers (E*TRADE / TradingView / Slack) ──HMAC──► webhook routes
  Slack signing secret ──HMAC+timestamp──► Slack agent
  NLQ webhook secret ──HMAC+timestamp──► /nlq/webhook ──► SearchAgent (table allowlist)
  agent internals ──SSRF guard──► outbound webhooks
```

The edge route handlers are the trust boundary: nothing behind them trusts
the network. Every inbound claim (identity, freshness, uniqueness) is
re-verified there.

## 4. Threats & Mitigations

### T1 — Forged inbound webhooks
An attacker POSTs a fabricated broker alert or NLQ request to trigger
agent actions (e.g. a fake TradingView alert drafting an order, or an NLQ
query exfiltrating data via the optional email leg).

Mitigations:
- HMAC-SHA256 signature verification on every inbound webhook, timing-safe
  comparison, **fail-closed**: an unconfigured secret rejects, never accepts
  (`verifyHmacSha256Signature`, issue #140).
- `/nlq/webhook` additionally requires a provider timestamp within ±5 minutes
  and a 128 KB body cap; the route 503s when `INBOUND_NLQ_WEBHOOK_SECRET` is
  unset instead of degrading to unsigned.
- Slack requests verified with `verifySlackSignature` (signing secret +
  5-minute timestamp window).
- Rate limiting on the edge routes (`throttle`, plus the global limiter in
  `src/security/rateLimiter.ts`, issue #241).

### T2 — Replay of a valid delivery
A captured, still-valid signed webhook re-POSTed to double-execute (two
order drafts from one TradingView alert; a duplicated NLQ email).

Mitigations:
- Durable nonce claim per processed event (`src/security/webhookReplay.ts`,
  PR #249): provider-derived nonce (E*TRADE `orderId:eventType:timestamp`)
  or SHA-256 of provider|signature|body; 24 h nonce lifetime; duplicates get
  409. The `/nlq/webhook` edge route uses an isolate-scoped fallback store
  with the same claim semantics plus its 5-minute timestamp window.

### T3 — NLQ as a data-exfiltration channel
The NLQ engine turns free text into data reads; a crafted query (via the
webhook route or Slack) could attempt to read tables outside the product's
legitimate surface — including SQLite system tables — and have the result
emailed out via `emailTo`.

Mitigations:
- Explicit 25-table allowlist enforced at the execution seam
  (`NLQ_TABLE_ALLOWLIST`, `isNlqTableAllowed`, PR #245); anything off-list,
  including `sqlite_master`, is refused with a clean error.
- The `/nlq/webhook` email leg: `emailTo` must be a syntactically valid
  address and, when `EMAIL_TO_ALLOWED_DOMAINS` is configured, must belong
  to an allowed domain; action-type plans (`preview_order`,
  `execute_order`, `paid_scan`, …) are never emailed
  (`emailDelivery: "not sent for an action request"`).
- Query length capped at 4,000 characters at the edge.

### T4 — SSRF via outbound webhooks
A user-controlled URL in an outbound webhook or report dispatch reaching
internal/metadata endpoints.

Mitigations:
- `assertSafeOutboundWebhookUrl` (PR #242, issue #240) validates every
  outbound webhook URL: no private/loopback/link-local targets.

### T5 — Email as a spoofing/phishing primitive
Forged or unconfirmed dispatches sent as the platform.

Mitigations:
- `emailTo` allowlist + format validation (above).
- Payment drafts already require HITL confirmation
  (`confirmationCard.ts` + `confirmDraft`); report dispatch confirmation is
  tracked separately (issue #277).
- No report/trading email is sent for action requests from the NLQ path.

### T6 — Token/secret exposure
Secrets committed to the repo or leaked through logs/errors.

Mitigations:
- Secrets travel only via GitHub Actions secrets + the deploy workflow's
  secret step; never the dashboard, never version control.
- Full-history and PR-range gitleaks scans (PR #251 fixed the PR-scan path).
- Error paths return generic messages; raw bodies and secrets are not
  echoed into responses or audit payloads.

## 5. Residual Risks (accepted, monitored)

- **LLM prompt injection via ingested content:** covered per-path in §7
  (AISecOps, #767). Novel injection shapes are the main reason this model
  is reviewed per assessment cycle.
- **Isolate-scoped replay store on the edge route:** a concurrent duplicate
  hitting a different isolate inside the 5-minute window is rejected by the
  timestamp check only after first processing; HMAC still gates who can send.
- **Email allowlist is opt-in:** without `EMAIL_TO_ALLOWED_DOMAINS`, any
  valid address passes. Operators should set it (see `SECURITY.md`).
- **Assessment P2 follow-ups:** report-dispatch confirmation (#277) and
  AI Search query caching (#278) are open hardening items, not open holes.

## 6. Review Cadence

This model is revisited with each Assessment cycle (parent issue #143).
Substantive new surfaces (new inbound providers, new email legs, new agent
tools that touch credentials) must update this document in the same PR.

## 7. Prompt-Injection Surface — Per-Path Boundaries (#767)

Every path by which content a principal does not fully control can reach an
LLM prompt, the trust boundary it crosses, and the mechanism that keeps the
content data rather than instructions. Filed by the RSI-InfoSec plan (#764),
AISecOps stage; defenses are designed here, not incidental. Paths are ordered
by exposure. A path not listed here that reaches a prompt is a documentation
defect against §6's same-PR rule.

| # | Path (entry → prompt assembly) | Untrusted source | Instruction/data separation today | Enforcement behind the prompt |
|---|---|---|---|---|
| 1 | **Inbound email → NLQ planner** — worker `email` export (`src/server.ts`) → `handleCloudflareEmailMessage` (`src/trading/email/agent.ts`): subject + body concatenated → `executeNaturalLanguageQuery` → planner (`src/agents/nlq/llmPlanning.ts`) | **Any internet sender.** The body *is* the planner's user prompt (truncated to 2,000 chars). Sender allowlist (`EMAIL_TO_ALLOWED_DOMAINS`) is opt-in and unset by default (§5) | **Shipped (#862)** — the email entry flags the call `untrustedContent`; the planner (both LLM call sites) and the validator append a data-is-not-instructions system rule and wrap the content in `<<<UNTRUSTED_EMAIL_CONTENT>>>` delimiters, with embedded end-markers defused so content cannot escape the region. Assembly pinned by `tests/nlq_untrusted_content.test.ts`; attack cases pinned by the #863 eval set | NLQ plan validated against the tool/domain allowlist; a second LLM validator checks plan-vs-question; order previews cannot execute — trades require the separate human APPROVE reply (HITL). Query results are emailed back to the sender, so a successful injection's blast radius includes data read-out to an external address |
| 2 | **Orchestrator chat turn** — `buildOrchestratorSystemPrompt` (`src/agents/chatPrompt.ts`), consumed at `src/agents/orchestrator.ts` | The authenticated user's own text is the instruction channel (trusted principal). **Retrieved content is not**: session memory, vector/knowledge results, and options-research context are assembled into the *system* prompt | **Shipped (#879, the #864 follow-up)** — each retrieved section is wrapped in `<<<UNTRUSTED_RETRIEVED_CONTENT>>>` delimiters with embedded end-markers defused so stored content cannot escape its region, and whenever any retrieved section is present the system prompt appends a data-is-not-instructions rule (the user's own message is the only instruction channel); with no retrieved content the assembly is byte-identical to the pre-#879 prompt. Assembly pinned by `tests/orchestrator_retrieved_content.test.ts`; attack cases pinned by the #879 eval set (`evaluations/injection/v2`) | Tool allowlist on the orchestrator catalog; payment/trade tools are draft-then-confirm (HITL) |
| 3 | **Chat NLQ fallback + MCP NLQ** — `src/agents/chatErrorFallback.ts`, `src/agents/routes/mcpChatNlq.ts`, orchestrator `execute_nlq` → same NLQ planner as path 1 | Authenticated user / MCP caller (trusted principal, direct instruction is legitimate use) | Same planner seam as path 1; the #862 separation applies whenever a caller flags its content untrusted (these trusted-principal callers do not) | Same NLQ allowlist + validator as path 1 |
| 4 | **News-sentiment scoring** — `buildNewsSentimentPrompt` (`src/trading/options/flows/newsSentiment.ts`) | Fetched news items (third-party publishers, via flow ingestion) | **Shipped (#881, the #864 follow-up)** — fetched items are wrapped in `<<<UNTRUSTED_NEWS_CONTENT>>>` delimiters with embedded end-markers defused so item text cannot escape the region, and the prompt carries a short data-is-not-instructions line (the system prompt already directed the classifier to treat headlines as untrusted data). Assembly pinned by `tests/news_sentiment_delimiters_881.test.ts`; attack cases pinned by the #881 eval set (`evaluations/injection/v3`, runner `tests/news_sentiment_injection_evalset.test.ts`). Revisit trigger: if the sentiment output ever gains authority (sizing, gating), this issue's priority rises. | Output is a bounded sentiment classification consumed by options flows; the model has no tool access on this path. |
| 5 | **Options-ideas ranking** — `buildRawOptionsIdeasRankingPrompt` (`src/trading/options/llmIdeas.ts`) | Per-group LLM analyses (themselves generated over market data) + the user's question — second-order content | **Partial, by instruction**: the system prompt directs the model to use only the supplied group analyses and to rank each exactly once; group payloads are JSON-encoded (structural separation) | Output is a ranking + short answer; no tool access. Group analyses are data-shaped JSON, which blunts raw instruction text |
| 6 | **Planner / supervisor goals** — `plannerPrompt` / `supervisorPrompt` (`src/orchestrate.ts`) | ScheduledAgent goals and briefs — operator-authored | N/A — trusted author, no third-party content on this path | Budget guard + goal lifecycle gates (ScheduledAgent) |
| 7 | **Webhook payloads (Slack/Stripe/etc.)** | Third-party senders, signature-verified at the edge | **No webhook body reaches a prompt today** — handlers route/verify/record; chat surfaces (path 2) are the only text-to-prompt leg | Signature verification + replay window at the edge. Named watch item: any future webhook→prompt flow must add its row here in the same PR (§6) |

**Reading of the table.** The designed defense concentrates where exposure
and authority meet: path 1 (unauthenticated, internet-facing, tool-adjacent,
output exfiltratable by reply) is the top-risk path and gets the first
implementation (#862) plus the red-team eval set that pins it (#863). Path 2's
follow-up has since shipped (#879, with its own eval set in
`evaluations/injection/v2`); path 4's follow-up has since shipped
(#881, with its own eval set in `evaluations/injection/v3`). The eval set
is the regression mechanism: a prompt or model change that widens any of
these surfaces must fail CI, the same way a code regression does.
