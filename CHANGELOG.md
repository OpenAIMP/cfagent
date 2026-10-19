# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and releases follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Release discipline

- **How to cut a release:** open a PR that moves the `## [Unreleased]` entries into a
  versioned `## [X.Y.Z] - YYYY-MM-DD` section. CI's *Test & Build* job
  (typecheck + vitest + build) is the required gate on every release PR.
- **Tagging:** after the release PR merges, place the tag `vX.Y.Z` on its merge
  commit (e.g. `git tag -a v0.1.0 <merge-sha> && git push origin v0.1.0`).
- **Semver rules:** MAJOR = breaking contract or API changes; MINOR = new
  capabilities, backward-compatible; PATCH = fixes with no contract change.

## [Unreleased]

### Added

<<<<<<< HEAD
- **Canonical report store** (#308, #307): every generated report is stored
  once at generation into `mas_reports` (idempotent on generation id);
  UX, email, Slack, webhook, and HITL approval all deliver that single
  stored copy. Research-report dispatch stores first and fails closed if
  the store fails.
- **`POST /api/nlq/webhook`** (#313): the advertised `/api` spelling of the NLQ
  inbound webhook is now implemented. All three spellings — `/nlq/webhook`,
  `/api/trading/nlq/webhook`, `/api/nlq/webhook` — delegate to one single-owner
  handler (`handleNlqWebhookRequest` in `src/server.ts`), so the throttle,
  HMAC signature verification, replay protection, and NLQ forwarding behave
  identically for every spelling. Previously the advertised `/api` form 404'd.
- **Reports tab + schedule management UI** (#309): browse/search persisted
  reports and manage schedules from the UX, reading the same store.
- **AI Search result cache + scheduled-report persistence** (#278):
  TTL cache over AI Search results (scope-bound keys, hits audited); all
  scheduled-run reports (market screens, IV collection, retention runs)
  persist for later retrieval.
- **Report-dispatch HITL setting** (#277): Settings toggle
  `reportDispatchHitl` (default off — dispatch stays autonomous); when on,
  report email/webhook dispatch holds for approve/reject with a 24h
  pending window.
- **Advertised `POST /api/chat` route** (#312): the route the UX/docs
  advertised is implemented, delegating to the platform's canonical chat
  handler.
- **Judge + NLQ golden evaluation sets** (#258): 105 labeled judge-routing
  queries and 29 NLQ questions with accuracy/regression thresholds in CI.
- **Per-run PDF naming** (#297): screener PDFs are stored per run as
  `{screener}_{universe}_{schedule}_{timestamp}_{jobId}`.
- **Auto-tag every deploy** (#321): the deploy workflow tags each
  successful production deploy `v0.1.<patch>` (auto-incrementing),
  pointing at the deployed commit for rollback and release tracking;
  milestones bump minor/major manually.

### Changed

- **Trading boundary** (#290): all trading code is imported solely through
  `src/trading/index.ts` (enforced by a boundary test); secret namespacing
  audited — trading secrets are read only inside `src/trading/`, with the
  `ET_*` convention documented in `docs/COMPLIANCE.md`.
- **Options scanner defaults** (#296): scans default to the NASDAQ-100
  universe instead of 4 symbols; scanner delivery tries the cfpay A2A
  Slack/Email path first with local fallback (#303).
- **Reports/Schedules panels wired into navigation** (#324): the #309
  panels are reachable from the app navigation (NavigationMenu +
  ETradeTradingHub) instead of existing as orphan surfaces.

### Security

- **Advertised `POST /api/audit/event` implemented** (#270): strict
  validation, tenant-scoped writes into `mas_events` via the single
  `recordAudit()` owner; the advertised surface is real, per the
  no-fabrication rule.
- **SECURITY.md + threat model** (#276): security policy, threat model,
  and disclaimer documents added.
- **NLQ execution observability** (#257): every NLQ execution writes a
  timed structured event (no raw query text); wrangler log observability
  made explicit.

### Fixed

- **Storage lifecycle** (#255): nightly retention pass enforces the
  advertised 90-day window on `mas_messages` (configurable, batched,
  audited per run).
- **Screener data quality** (#294, #295): E*TRADE quote failures fail fast
  on auth instead of returning zero-price stubs; Yahoo history fetch
  carries diagnostics so empty technicals are explainable.
=======
- **`POST /api/nlq/webhook`** (#313): the advertised `/api` spelling of the NLQ
  inbound webhook is now implemented. All three spellings — `/nlq/webhook`,
  `/api/trading/nlq/webhook`, `/api/nlq/webhook` — delegate to one single-owner
  handler (`handleNlqWebhookRequest` in `src/server.ts`), so the throttle,
  HMAC signature verification, replay protection, and NLQ forwarding behave
  identically for every spelling. Previously the advertised `/api` form 404'd.
>>>>>>> 9bcc20a (feat(api): implement the advertised POST /api/nlq/webhook route (313))

## [0.1.0] - 2026-10-18

First tagged release. Assessment P0 hardening wave (#143).

### Security

- **NLQ table allowlist** (#245): a 25-table allowlist derived from the NLQ
  planner's real targets; every other table is refused at the execution seam.
  Classic SQL injection was already closed by parameter binding — verified
  before the fix.
- **Webhook replay cache + `emailTo` domain allowlist** (#249): provider-derived
  nonces with 24h TTL; duplicate TradingView / E\*TRADE / NLQ deliveries are
  rejected 409 before any order mutation. `EMAIL_TO_ALLOWED_DOMAINS` restricts
  email delivery targets (inert until configured).
- **SSRF guard + rate limiting** (#242): URL validator on outbound webhook
  dispatch; token-bucket throttling (429 + Retry-After) on the NLQ webhooks and
  the memory search route.
- **Secret scanning** (#239, #251): gitleaks workflow installed and active;
  its pull-request scan path was broken by a missing `GITHUB_TOKEN` env and is
  now fixed — every PR is scanned.

### Added

- **Storage retention** (#262): nightly pass in the scheduler deleting
  `mas_messages` rows older than `MAS_MESSAGES_RETENTION_DAYS` (default 90,
  `<=0` disables), with a per-run cap and a `mas_events` summary record.
  This enforces the 90-day retention the UI advertises.

### Docs

- **Collaboration protocol** (#252): branch-as-lock shared rule for
  multi-agent coordination, documented in `docs/collaboration.md`.
