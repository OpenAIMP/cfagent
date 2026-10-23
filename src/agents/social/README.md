# Social posting — Phase 4 (drafts only)

Issue #1077, Phase 4: the drafts-only skeleton of SocialMediaAgent.
It composes and stores one draft per enabled channel per day. It does
NOT publish anything.

## What Phase 4 is

- `config.ts` — reads `SOCIAL_*` config, resolves each channel to
  `autonomous` or `approval` under fail-closed rules.
- `draft.ts` — draft records + per-channel formatting limits.
- `ledger.ts` — idempotent draft storage (one draft per date+channel),
  in-memory implementation + a Durable-Object-storage-shaped adapter.
- `scheduler.ts` — the daily fire check (pure, NY wall-clock).
- `../socialAgent.ts` — `buildDailyDrafts`, tying the above together.
- `publishDraft` — refuses every attempt with `not_implemented_phase5`.

## Config names, defaults, and fail-closed rules

| Variable | Default | Meaning |
| --- | --- | --- |
| `SOCIAL_POSTING_ENABLED` | OFF | `"1"`/`"true"` = on. Off → no drafts at all. |
| `SOCIAL_AUTONOMOUS_CHANNELS` | `threads,x` | Channels that publish without approval (Phase 5). |
| `SOCIAL_APPROVAL_CHANNELS` | `facebook,instagram,linkedin` | Channels needing a Slack approval card first (Phase 5). |

The confirmed split above is the default, not a hardcoded list: the
owner moves a channel by changing config. Fail-closed rules:

- A channel in **both** lists → approval wins.
- An **unknown** channel id → approval, never autonomous.
- A known channel in **neither** list → approval.
- An **empty** autonomous list → everything needs approval.
- A channel with **no configured token** → never posted (`canPublish`
  is false without a token, regardless of list). No token storage
  exists in this phase, so no channel can publish yet.

Parsing follows the comma-split-trim pattern of `enabledProviders`
(`src/security/providers.ts`), except unset yields the default while an
explicitly blank value yields an empty list.

## What Phase 4 deliberately does NOT do

- No publishing: no platform API client, SDK, token, secret, or network
  call to any social platform exists anywhere in this phase.
- No invented content: without a brief, `buildDailyDrafts` returns
  `noBrief` and writes nothing.
- No live behavior change: `src/server.ts`, `wrangler.jsonc`, and every
  scheduled handler are untouched. Wiring the daily tick into
  `scheduled()` is a later step, as is Phase 5 publishing (tokens,
  per-platform publisher adapters, approval flow).
- Schedule defaults (09:00 America/New_York, Monday–Friday) are marked
  CONFIGURABLE DEFAULTS pending owner confirmation.

# Social posting — Phase 5a (token-independent publish path)

Issue #1077, Phase 5a: the publish path WITHOUT real tokens. Every
piece that does not need a platform credential is built and tested:
publisher adapters, the approval flow, the daily tick, and the
`scheduled()` wiring — with dry-run as the default so nothing can
reach a platform yet.

## What Phase 5a adds

- `publisher.ts` — one publisher definition per channel (token env
  var, endpoint, payload builder). Threads and Instagram publish in
  two steps (create container, then publish it); Facebook uses
  `/me/feed` (resolves to the Page only with a Page token); LinkedIn
  declares an account env var (`LINKEDIN_AUTHOR_URN`) and fails
  closed without it. Publishers take an injected transport — tests
  use a fake, and no production code path in this phase calls a real
  platform host. Payload shapes follow each platform's documented
  publish API but have NOT been proven live; re-confirm them against
  current platform docs before the first live post.
- `approvals.ts` — `approveDraft` / `rejectDraft` over the ledger
  (records are never deleted; rejection keeps the record as the audit
  trail) plus a pending-approval store retrievable per date. This
  phase RECORDS approval requests; it does not deliver them — Slack
  approval-card delivery is a Phase 5b wiring step.
- `../socialAgent.ts` — `publishDueDrafts`: approval-list drafts
  publish only when `approved`; autonomous drafts publish when
  `draft` or `approved`; posted/failed drafts are never republished;
  per-channel failures are error entries, never throws, never
  blocking other channels. A failed publish attempt leaves the draft
  publishable for retry (only an explicit reject marks it failed).
  The platform/dry-run post id travels in each publish result and in
  the dry-run sink record; `SocialDraft` itself is intentionally
  unextended (the ledger records the status transition to `posted`).
  The Phase 4 `publishDraft` stub is kept for API compatibility and
  is never called by this path.
- `tick.ts` — `runSocialDailyTick`: fire check → brief → build →
  publish, in that order, each step able to stop the run without
  inventing work. The brief comes from a `briefProvider` function:
  production wiring passes one returning null until the owner
  supplies a content source.
- `src/server.ts` — ONE call into the worker `scheduled()` handler
  on the `*/30` tick, after the existing dispatches.

## The three gates (all must pass for a live post)

1. `SOCIAL_POSTING_ENABLED` is `"1"`/`"true"` (default OFF).
2. `SOCIAL_LIVE_PUBLISHING` is `"1"`/`"true"` (default OFF).
3. The channel's token is present (Worker secret, passed explicitly
   to the publish path — never read from the config env, never in
   the repo), plus the account id where required (LinkedIn).

Defense in depth: a failed live gate is an ERROR entry, never a
silent dry-run fallback — an operator who asked for live must see
the failure. When live is simply not requested, dry-run is the
default: `DryRunPublisher` records the attempt (channel, draft id,
text, timestamp) and returns a `dry-run:<draftId>` id without
touching the network. Unknown channels always fail closed. The agent
itself may never flip these flags at runtime; they are config.

## Tick wiring no-op conditions (all hold today)

With default env and the production wiring as shipped, the tick is a
complete no-op, for four independent reasons — any one alone would
suffice:
- `SOCIAL_POSTING_ENABLED` is unset → `postingDisabled` before the
  fire check.
- The brief provider returns null → `noBrief`, nothing written,
  even if posting were enabled.
- No tokens are wired (`tokens: {}`) → live publishing is
  unavailable for every channel.
- The ledger is in-memory per tick → nothing persists across ticks
  (durable social storage is a Phase 5b wiring step).

Tick errors are logged, never thrown, so a social failure cannot
break the other jobs riding the `*/30` tick.

## What still gates the first live post (Phase 5b)

- Real tokens as Worker secrets (via the PROD-secrets → deploy-sync
  route) + the per-channel account mapping (which Page, which
  LinkedIn author URN, which Threads/Instagram identities).
- A content source for the brief provider + the voice/style rules.
- Posting-time/weekday confirmation (defaults 09:00 ET Mon–Fri stand
  until the owner changes them).
- A live transport behind the injected-transport seam, Slack
  approval-card delivery for pending approvals, and durable social
  storage replacing the in-memory ledger.
- Re-confirmation of every payload shape against current platform
  docs, plus a token-expiry health check and rotation runbook
  (tokens expire; expiry must warn before it breaks posting).
