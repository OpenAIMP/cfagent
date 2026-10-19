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
  (and alias `/api/trading/nlq/webhook`) in `src/server.ts` — fans out to
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

- **LLM prompt injection via ingested content:** NLQ results and fetched
  documents are data, not instructions; planner output is still validated
  against the allowlist and action gates. Novel injection shapes are the
  main reason this model is reviewed per assessment cycle.
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
