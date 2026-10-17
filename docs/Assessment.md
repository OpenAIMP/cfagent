# cfagent Repository Assessment
**Repo:** https://github.com/OpenAIMP/cfagent  
**Commit:** 78f3ec6263856effa305af9214a23da39ff0b3d9 (main, 641 commits)  
**Date:** 2026-10-17  
**Assessor:** Automated Architecture & Security Review  
**Status:** Public, 0 stars, 0 forks — early stage, rapid iteration (created 2026-09-30)

## Executive Summary

`cfagent` is an **enterprise multi-agent assistant** built on Cloudflare Agents SDK + Workers AI + AI Search. It implements a durable orchestrator pattern with LLM Judge routing, specialized sub-agent tools (RAG search, payment drafting, task drafting, SQLite memory), streaming WebSocket UI, and a read-only NLQ analytics engine over conversation transcripts.

**Maturity:** Prototype-to-Beta. 641 commits in 17 days indicates intense development velocity. Project structure follows Cloudflare Agents conventions. Documentation is strong at README level but internal `docs/` is sparse. Security posture is explicitly considered (HMAC state, CSWSH validation, XSS-safe injection) which is rare for this stage.

**Biggest Strength:** Clean separation of concerns — Orchestrator DO as stateful coordinator, Judge as router/evaluator, tools as isolated capabilities, and shared NLQ channel routing (web/Slack/voice/email/webhook).

**Biggest Risk:** Scope expansion into **Cross-Channel Trading Research** (E*TRADE, Yahoo Finance, options research, XLSX export, email, webhook publishing) introduces financial-compliance, PII, and prompt-injection attack surface that dwarfs the core assistant. Payment drafting + trading recommendations + email/webhook in same worker needs hard guardrails.

**Overall Grade: B+ (Good foundation, needs hardening before production)**

## Architecture Review

### Core Pattern (from README + file list)

```
Browser React19+Vite --WS--> OrchestratorAgent (Durable Object)
                              |- LLM Judge (intent: search/payments/tasks/memory/general)
                              |- Workers AI: glm-4.7-flash
                              |- Cloudflare AI Search (RAG)
                              |- DO SQLite: mas_messages, mas_events, mas_memory
           REST APIs --> Worker Fetch
                              |- /auth/* GitHub OAuth 2.0
                              |- /api/nlq
                              |- /api/audit
                              |- /api/memory
                              |- /nlq/webhook (HMAC signed inbound)
```

**Files inferred:**
- `src/server.ts` — worker entry + DO routing
- `src/types.ts` — Env, Session, Audit, NLQ
- `src/session.ts` — session + constant-time HMAC
- `src/oauth.ts` — GitHub OAuth glassmorphic pages
- `src/agents/orchestrator.ts` — master DO
- `src/agents/judge.ts` — LLM Judge
- `src/agents/mas.ts` — unified sub-agent tools
- `src/agents/nlq.ts` — NLQ planner + SQLite executor
- `src/agents/search.ts|payments.ts|tasks.ts|memory.ts` — standalone agents
- `src/client/Chat.tsx` — multi-tab UI
- `wrangler.jsonc`, `vite.config.ts`, `package.json`

### What Works Well
1. **Durable Object SQLite for state:** `mas_messages`, `mas_events`, `mas_memory` is the correct Cloudflare pattern (2025+). No external DB needed for MVP.
2. **LLM Judge:** Intent classification with confidence scoring + response quality/safety evaluation is best practice for multi-agent orchestration vs naive function calling.
3. **Shared NLQ channel:** Web, Slack, voice, email, inbound webhook reuse same planner/executor — DRY, but see security notes.
4. **Tool boundaries:** Payments are **draft-only** with human-in-the-loop — never auto-executes money movement.

### Gaps
- `public/strategies`, `scratch/`, `scripts/` present at root — suggests experimental trading strategies checked into repo. Should be gitignored or moved to R2.
- No `wrangler.jsonc` content visible in this review (browser cache miss), but likely missing `observability`, `unsafe` bindings audit.
- `environment.config.json` at root — risk of secrets in repo if not gitignored properly.
- No explicit queue or workflow for long-running E*TRADE screen evaluations (could exceed DO 30s CPU).

## Code Quality & Maintainability

**Positives:**
- TypeScript strict (`npm run typecheck` claims 0 errors)
- Vite + React 19 — modern
- Glassmorphic dark-mode design system in `styles.css` (per README)
- `.agents/`, `.vscode/` conventions suggest Cursor/Claude Code integration

**Concerns:**
- 641 commits in 17 days (~37/day) with 0 releases/tags — high churn, no versioning discipline.
- Commit history not reviewed here but velocity suggests main-branch development without PR guardrails (`.github/` exists, need to verify workflows).
- `mas.ts` as unified tools vs standalone `search.ts/payments.ts` — duplication risk. Need to ensure single source of truth.
- No visible lint/format config (no eslint, prettier, biome in root list).

**Recommendations:**
- Add `eslint + biome` with pre-commit hook
- Adopt release tags + CHANGELOG
- Enforce branch protection + required checks in `.github/workflows`
- Move `scratch/` to `.gitignore`

## Security Assessment

### Stated Controls (Good)
- Constant-time HMAC OAuth state verification with replay protection — prevents timing oracle + CSRF.
- CSWSH origin validation — critical for WebSocket.
- XSS-safe user script injection — important for chat UI rendering AI output.

### Inbound/Outbound Webhook (High Attention)
- `POST /nlq/webhook` with `X-Signature-256: sha256=<hex>` HMAC-SHA256 over exact body using `INBOUND_NLQ_WEBHOOK_SECRET`, timestamp within 5min — correct pattern.
- **Need to verify:** constant-time compare on signature, raw body buffering (not parsed JSON), replay cache keyed by signature + timestamp.
- `OUTBOUND_WEBHOOK_URL` with HMAC — verify SSRF protection (allowlist, no internal metadata IP).
- `emailTo` optional but must be explicitly supplied — good, prevents exfiltration.

### OAuth
- GitHub OAuth only — good for internal tool. Need PKCE? State param with HMAC covers CSRF but not code interception — should use PKCE for confidential client.
- `SESSION_SECRET` 32-byte hex — verify `HttpOnly; Secure; SameSite=Lax` cookies.

### NLQ Engine (Critical)
- Claims **parameter-bound SQLite queries** over transcripts — must be true. NLQ is classic SQLi vector if planner concatenates.
- Should whitelist tables (`mas_messages`, `mas_events`) and enforce read-only (`SELECT` only), `LIMIT` cap, no `PRAGMA`, no `ATTACH`.
- Cross-channel: Slack message can request `email results to analyst@example.com` — need email domain allowlist + explicit consent.

### Trading / Payments Cross-Channel
- Payment drafting is safe (draft only), but **recommendation reports published to webhook + email as XLSX** could be spoofed for market manipulation. Need signing + audit trail.
- E*TRADE/Yahoo Finance keys — where stored? Must be in Secrets Store, not env var, not `environment.config.json`.
- No mention of rate limiting on `/api/nlq` — analytics query could be expensive.

**Security Grade: B** — thoughtful controls mentioned, but implementation not verified in this static review.

## Performance & Cost

- **Workers AI glm-4.7-flash:** Fast, cheap — good for judge. Verify token limits on long transcripts.
- **DO SQLite:** Excellent for session-local state, but `mas_messages` will grow unbounded — need TTL/compaction job.
- **AI Search:** RAG retrieval — check topK + chunk size to control cost/latency.
- **WebSocket streaming:** Should use `WebSocketPair` + `state.acceptWebSocket` per Cloudflare Agents SDK — verify hibernation handling.
- **XLSX export:** CPU heavy — offload to queue or R2 presigned export.

## Testing & Observability

- `tests/` directory exists — need coverage report. No test command listed in README (`typecheck`, `build`, `check` only).
- `src/agents/judge.ts` should have eval harness for routing accuracy — does `tests/` include judge evals?
- `/api/audit` real-time event log — good for observability, but need PII redaction.
- Missing: Workers Logs, Tail, OpenTelemetry traces.

**Recommendation:** Add `vitest` with `cloudflare:test`, judge golden-set evals, and Playwright for Chat.tsx.

## Documentation

- README is strong — capabilities, architecture diagram, setup, project structure.
- DESIGN.md exists — need to verify alignment with README.
- `docs/` directory exists but empty in this snapshot — this assessment should be first doc.
- `.dev.vars.example` present — good DX.
- No `SECURITY.md`, `CONTRIBUTING.md`, or threat model doc.

## Deployment

- Secrets listed: `CF_API_TOKEN`, `CF_ACCOUNT_ID`, `GH_CLIENT_ID`, `GH_CLIENT_SECRET`, `APP_BASE_URL`, `SESSION_SECRET` — plus implied `INBOUND_NLQ_WEBHOOK_SECRET`, `OUTBOUND_WEBHOOK_URL`, `EMAIL` binding, AI Search, E*TRADE creds.
- Uses GitHub Actions for deploy — verify least-privilege token (Workers Edit, no Zone).
- No `environment.config.json` content — risk if contains secrets. Should be `environment.config.example.json`.

## Risk Matrix

| Area | Risk | Likelihood | Impact | Mitigation |
|------|------|------------|--------|------------|
| NLQ SQLi | Planner concatenates strings | Medium | Critical | Enforce param binding + SELECT-only allowlist + unit tests |
| Webhook SSRF | OUTBOUND_WEBHOOK_URL to internal IP | Low | High | URL allowlist, no 169.254/127/10.0.0.0 |
| Email exfil | Slack `emailTo` leaks data | Medium | High | Allowlist domains + explicit emailTo required |
| XLSX injection | CSV formula injection in Excel | Medium | Medium | Sanitize leading `= + - @` |
| Payment hallucination | LLM drafts wrong amount | Medium | High | Human confirm + schema validation |
| Trading advice | Unlicensed financial advice | High | High | Disclaimer + signed reports + audit |
| Secret leakage | `environment.config.json` in git | Medium | Critical | gitignore + gitleaks in CI |
| DO storage bloat | mas_messages unbounded | High | Medium | TTL + compaction cron |

## Recommendations (Prioritized)

### P0 — Before production
1. **Audit `nlq.ts`:** Prove param binding, read-only, LIMIT, table allowlist. Add `tests/nlq.sql-injection.test.ts`.
2. **Harden webhooks:** Constant-time HMAC compare, raw body, 5min timestamp, replay cache, SSRF allowlist.
3. **Secrets audit:** `git log --all -p -- environment.config.json .dev.vars` + add gitleaks. Move E*TRADE keys to Secrets Store.
4. **Add rate limiting:** On `/api/nlq`, `/nlq/webhook`, `/api/memory` — use Cloudflare Rate Limiting binding.

### P1 — This month
5. **Release discipline:** Tags, CHANGELOG, branch protection, required `npm run check`.
6. **Observability:** Add `mas_events` structured logging, Workers Logs, eval metrics for judge (precision/recall per intent).
7. **Testing:** `vitest` + judge golden set (100 queries across 5 intents), NLQ evals.
8. **Storage lifecycle:** Cron to archive `mas_messages` >30d to R2, keep memory table compact.

### P2 — Next quarter
9. **Extract trading domain:** Move `public/strategies` + E*TRADE integration to separate worker `cfagent-trading` with isolated secrets and compliance review.
10. **Security docs:** Add `SECURITY.md`, threat model for cross-channel NLQ, financial disclaimer.
11. **UX hardening:** Confirmation drawer for payment drafts + recommendation reports, audit view with redaction.
12. **Performance:** Queue for XLSX generation, cache AI Search results.

## Conclusion

`cfagent` shows **strong engineering taste** — Durable Objects + SQLite + Agents SDK + Judge pattern is exactly how modern Cloudflare AI apps should be built. Security was considered early, not bolted on. The main concern is **scope creep into trading/finance** without commensurate compliance and isolation.

If you lock down NLQ → SQLite binding, webhook HMAC + SSRF protections, and isolate trading keys, this is production-ready for internal enterprise use.

---
*Generated by automated review. Full source code inspection was limited by browser cache (only README + file list available at review time). Recommend re-running with full `src/` checkout for line-level audit.*
