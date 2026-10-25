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
  RETIRED in Phase 5b slice 1: the fire check moved into
  `src/schedule.ts` `isDue` with an optional `timeZone` (see below).
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
  publish when `approved`, or when `dry-run-posted` with their
  approval record (#1171: approval standing survives a dry-run
  publish); autonomous drafts publish when `draft`, `approved`, or
  `dry-run-posted`; posted/failed drafts are never republished; a
  dry-run sweep skips already dry-run-posted drafts. Per-channel
  failures are error entries, never throws, never blocking other
  channels. A failed publish attempt leaves the draft publishable
  for retry (only an explicit reject marks it failed). A live
  publish records the platform post id on the draft; a dry-run
  publish records no id — its synthetic id travels in the publish
  result and the dry-run sink record only.
  The Phase 4 `publishDraft` stub is kept for API compatibility and
  is never called by this path.
- `tick.ts` — `runSocialDailyTick`: fire check → brief → build →
  publish, in that order, each step able to stop the run without
  inventing work. The brief comes from a `briefProvider` function:
  production wiring passes one returning null until the owner
  supplies a content source. RETIRED in Phase 5b slice 1: the tick
  is replaced by the social goal executor (see below).
- `src/server.ts` — ONE call into the worker `scheduled()` handler
  on the every-30-minute tick, after the existing dispatches.
  RETIRED in Phase 5b slice 1: the parallel social-tick block is
  removed; `scheduled()` keeps only the ScheduledAgent `onCron`
  call, which now evaluates the social goal itself.

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

## Goal wiring no-op conditions (all hold today)

With default env and the production wiring as shipped, social
posting is a complete no-op, for four independent reasons — any one
alone would suffice:
- The seeded `daily-social-post` goal is DISABLED → `onCron`
  skips it before any social code runs.
- `SOCIAL_POSTING_ENABLED` is unset → `postingDisabled` even if
  the goal were enabled.
- The brief provider reads the firing date's brief from the durable
  brief store (slice 2) → `noBrief`, nothing written, when no brief
  is stored for that date.
- No tokens are wired → live publishing is unavailable for every
  channel; dry-run is the default, and dry-run records are
  discarded at tick end.

Goal errors are recorded in the tick record, never thrown, so a
social failure cannot break the other goals riding the tick.

# Social posting — Phase 5b slice 1 (goal-driven scheduling)

Issue #1077, Phase 5b slice 1: social posting becomes a
ScheduledAgent goal, and the bespoke fire check is retired. There
is exactly one scheduler for social posts: the goal system.

## What slice 1 adds

- `src/schedule.ts` — `isDue(cron, lastRun, now, timeZone?)` reads
  the cron against wall-clock parts in the zone (Intl), with lists,
  ranges, and steps in every field and weekday matching (0 = Sunday
  … 6 = Saturday, 7 also Sunday). Without a timeZone the historical
  UTC behavior is preserved byte-for-byte, including the
  opportunity-hunt `"0 */6 * * *"` never-fires quirk (deliberately
  NOT fixed — fixing it would change a shipped goal's behavior).
  `isValidCron` shares the same field expansion for `addGoal`
  validation. `ScheduledGoal` gains an optional `timeZone`.
- `src/agents/scheduled-agent.ts` — `addGoal` accepts ranges/lists
  in cron fields and an optional `timeZone` (validated via Intl;
  invalid → throw). `onCron` passes the goal's `timeZone` to
  `isDue`, and executes due `"social.publish"` goals through the
  executor below instead of `createJob` (there is no orchestrator
  job for posting). Other goals keep the exact `createJob` path.
- `src/orchestrate.ts` — catalog entry `{ agent: "social",
  operations: ["social.publish"] }`, so `addGoal` accepts the
  operation and the dashboard can list it.
- `goalExecutor.ts` — `executeSocialGoal`: `buildDailyDrafts` then
  `publishDueDrafts` under the existing gating (posting switch,
  `SOCIAL_LIVE_PUBLISHING`, tokens, approval flow, dry-run
  default). It contains NO fire check — the goal's cron decides
  when. The goal counts as run ONLY when at least one draft was
  actually produced; `postingDisabled`, `noBrief`, and `noDrafts`
  leave `lastRun` untouched so the goal stays due and retries on
  the next tick. Publish failures do not unfire a run (the drafts
  exist; per-channel errors land in the tick record).
- `durableStores.ts` — SessionStore-backed async ledger + pending
  approval store over the `SESSION_STORE` binding, using ONLY op
  get/put/delete (the SessionStore `list` op refuses non-E*TRADE
  namespaces). `listDrafts`/`listPending` fan out gets over the five
  known channels; keys reuse `social-draft:<date>:<channel>` and
  mirror it as `social-pending:<date>:<channel>`. Values are JSON
  strings; a corrupt value is treated as absent (never a minted
  draft or approval) while a transport failure throws so the goal
  stays due for retry. Store interfaces in `ledger.ts` /
  `approvals.ts` now return `T | Promise<T>` and all call sites
  await — sync in-memory stores still satisfy the widened types.
- Seeded goal (DISABLED): id `daily-social-post`, cron
  `0 9 * * 1-5`, timeZone `America/New_York`, operation
  `social.publish`, budgetCents 1 (a cap, not a charge — posting
  spends nothing). Seeding happens only when the goal store is
  empty; already-running deployments add it via the dashboard API.

## Activating the goal (owner steps)

1. Set the posting gates + tokens (Worker secrets via the
   PROD-secrets → deploy-sync route; never the repo).
2. Enable the goal via the schedule dashboard API
   (`POST /api/schedule/goals` for a new goal, or the enabled
   toggle for the seeded one). Until a brief is provisioned for
   the firing date (slice 2: human route or NLQ), the enabled goal
   reports `noBrief` every tick — enabled but harmless.
3. Approval-channel posts still need an approval action (slice 3):
   a Slack approval card, or the session-gated route below. Either
   approval publishes the draft promptly (publish-on-approve); a
   same-day approval that arrives after the firing is also picked
   up by the next firing's catch-up sweep.

## Known limitation (fixed in slice 3)

Each goal firing used to publish ONLY its own date's drafts, so an
approval arriving after the day's firing was never published by a
later firing. Slice 3 fixes this two ways (see the slice 3 section
below): publish-on-approve (the approval action itself publishes)
and a 7-day catch-up sweep in the executor. The dry-run "posted"
carry-forward from Phase 5a is FIXED by #1171: a dry-run publish
now marks its draft "dry-run-posted", never "posted", and only a
live publish earns "posted" with the platform post id recorded —
so flipping live mid-day live-publishes that day's drafts exactly
once instead of skipping them.

## What still gates the first live post (after slice 1)

- Real tokens as Worker secrets + the per-channel account mapping
  (which Page, which LinkedIn author URN, which Threads/Instagram
  identities).
- A content source for the brief provider is slice 2 (below); the
  voice/style rules for brief content are still open.
- Posting-time/weekday confirmation (defaults 09:00 ET Mon–Fri stand
  until the owner changes them — now as the seeded goal, editable
  via the dashboard).
- A live transport behind the injected-transport seam, plus
  re-confirmation of every payload shape against current platform
  docs, plus a token-expiry health check and rotation runbook
  (tokens expire; expiry must warn before it breaks posting).

# Social posting — Phase 5b slice 3 (Slack approval delivery + publish-on-approve/catch-up)

Issue #1077, Phase 5b slice 2: the brief stops being null. Content
arrives two ways — a human-provision route and an NLQ request — and
lands in one durable store the goal reads at firing time. Nothing
else in this slice invents, generates, or defaults content.

## The brief store

- `briefStore.ts` — SessionStore-backed, following the
  `durableStores.ts` pattern exactly: same SESSION_STORE binding
  and "social" namespace, ONLY op get/put (never list), JSON string
  values `{ text }`, corrupt values read as absent (self-healed by
  the next provision), transport failures throw.
- Key: `social-brief:<date>` (NY date). Overwrite semantics: the
  most recent provision wins for that date. A brief stored for a
  past date never affects past firings; `onCron` reads only the
  firing date's brief, derived with the goal's timeZone (default
  America/New_York) — the same derivation `buildDailyDrafts` uses
  for the draft date, so brief and drafts cannot disagree.
- Caps: 4000 characters (shared with the NLQ webhook cap), refused
  with an error, never truncated. Empty/whitespace provisions are
  refused. A missing, corrupt, or whitespace-only stored brief
  reads as null → the existing `noBrief` behavior (goal stays due,
  retries next tick).

## Human provision routes (src/server.ts)

- `POST /api/social/brief` — JSON `{ text }`, optional `{ date }`
  (default: today NY). Returns `{ ok: true, date }`. 400 on empty
  / whitespace / non-string text, bad JSON, or a malformed date;
  413 on text over 4000 chars; 405 on other methods.
- `GET /api/social/brief` — optional `?date`, returns
  `{ ok: true, date, brief }` with `brief: null` when nothing is
  stored. Operator visibility only; it never creates content.
- Gating: session-required (unauthenticated → 401) — unlike
  `/api/schedule/*`, whose handler performs no session check (see
  its catalog authNote). Any signed-in user may provision;
  admin-only provisioning is a LATER item (the IAAA admin panel
  could own it) and is NOT silently assumed here. Both routes are
  in the IAAA endpoint catalog (pin rule).

## NLQ intake

- New NLQ domain `social` with `socialData { action: "set_brief",
  text, dayOffset }` (schema + rule planner + LLM planner prompt,
  which says "ONLY when the user explicitly asks" and "never infer
  a brief from a general question").
- Rule fastpath (planning.ts 0g): ONLY imperative forms match —
  "set [the] [today's|tomorrow's] social brief|post [for
  today|tomorrow] to|as|: <content>" and the "use ... as|:"
  variant. "Use the social brief to explain X" deliberately does
  NOT match (instrumental use of the existing brief, not a set).
  Questions, discussions, and report requests never match; empty
  content falls through. Broader phrasings ("post this to social",
  "tweet this") deliberately do NOT match.
- Executor (async only; the sync executor refuses honestly): the
  plan's text is written verbatim through the injected
  `NLQSocialBriefPort` — the same narrow-port pattern as the
  scheduling (#109) and stock-screen (#982) ports. No port means
  an honest error, never a fallback write. The result summary
  names the date only; the brief text is never echoed into result
  envelopes (they are audited and, on the webhook path, emailed).
- Port binding (trusted chat only): the agent `/nlq` route binds
  the port from SESSION_STORE — EXCEPT webhook-originated requests
  (`x-nlq-source: webhook`), which never get it. Webhook bodies
  are untrusted external content, and a brief is a public-post
  input: autonomous channels would publish it with no human
  approval. The MCP facade, Slack, async jobs, and the fallback
  path carry no port and fail honestly. Whether Slack NLQ should
  count as trusted for social writes is a follow-up decision.
- The funnel (`executeNaturalLanguageQuery`) passes
  `socialBriefPort` through to the executor like the other ports;
  without it, an explicit set still plans as `social` but fails at
  execution with the port error — planning and execution stay
  honest with each other.

## What slice 2 does NOT do

- No default text, no fallback digest, no generated brief, no
  auto-conversion of general NLQ queries into briefs — anywhere.
- No change to the goal's disabled state, the posting switch
  defaults, any channel gating/disposition, or any token/secret
  handling. The goal still needs owner activation (see slice 1).
- No admin gate on provisioning (documented above, not assumed).
- Publish-on-approve and the catch-up sweep are slice 3 (below),
  not slice 2.

# Social posting — Phase 5b slice 3 (Slack approval delivery + publish-on-approve/catch-up)

Issue #1077, Phase 5b slice 3: the slice-1 limitations are fixed.
A pending approval is delivered as a Slack card, an approval
publishes promptly instead of waiting for the next 09:00 firing,
and every firing sweeps the prior week for approved-but-unposted
drafts and failed publishes. No channel gating, disposition list,
config default, token handling, or goal enabled-state changes:
the goal stays DISABLED until owner activation, dry-run stays
the default, and production still passes no live transport (the
Phase 5a gap — live publish fails honestly, dry-run works end to
end).

## Delivery channel (delivery.ts)

- When `publishDueDrafts` records a pending approval, the next
  social tick's delivery pass sends a Block Kit card to Slack.
  The card shows date, channel, and the draft text — exactly what
  would be approved, nothing more. The text renders as
  `plain_text`, so user content can never inject mrkdwn. Buttons:
  Approve (`social_approve`, primary) and Reject
  (`social_reject`, danger), both valued `date|channel|draftId`.
- Destination, exactly one per attempt: `SLACK_WEBHOOK_URL` when
  configured, else `chat.postMessage` via `SLACK_BOT_TOKEN`.
  cfpay `slack.post` is NOT used — it carries text only, no
  blocks, so it cannot carry buttons. Channel resolution:
  `SOCIAL_SLACK_CHANNEL`, then `SLACK_CHANNEL_ID`, then
  `SLACK_CHANNEL` (the screener/trading convention) — never a
  hardcoded id. A webhook failure falls back to the bot token;
  a bot failure is judged by Slack's own `{ok}` field, not just
  the HTTP status. No webhook AND no token is an honest error at
  the delivery unit — but see the onCron rule below.
- Idempotency per (date, channel, draftId): the pending record
  carries `deliveredDraftId` (backward-compatible: records written
  before slice 3 lack it and are treated as undelivered, delivered
  once). A pass skips records whose `deliveredDraftId` already
  equals their `draftId`, skips missing/non-draft drafts (posted,
  failed, approved, dry-run-posted) and draft-id mismatches
  (stale pending), and never marks
  a failed delivery — the next pass retries it. `publishDueDrafts`
  preserves `deliveredDraftId` when it re-records an unchanged
  pending request, so a catch-up sweep cannot wipe the mark and
  re-deliver. One bad record never takes down a pass: failures
  are result entries, and the pass never throws for per-record
  problems.

## onCron delivery pass (scheduled-agent.ts)

- After the goal executes (fired OR not-fired — delivery is
  independent of the day's brief, so a `noBrief` tick can still
  carry undelivered backlog), the pass runs over the firing date
  plus the 7-day catch-up lookback. The one exception is posting
  disabled: the kill switch gates delivery too.
- When NO Slack destination is configured at all (neither webhook
  nor bot token), the pass is skipped silently: Slack delivery is
  opt-in by configuration, and the session-gated route below
  remains the approval path. A configured destination that fails
  DOES record tick errors — non-fatal, never unfiring the goal.
- Production poster is a fetch wrapper; tests inject
  `ScheduledAgentCronOpts.socialSlackPost`.

## Approval paths (which is live)

Both paths share one core (`approvalActions.ts`): approve →
`approveDraft`, then the date's FULL `publishDueDrafts` pass (so
other approved/failed drafts for that date resolve too); reject →
`rejectDraft`, publishes nothing, record retained as failed.

1. Slack buttons (LIVE, signature-verified). `POST
   /slack/interactions` already runs the #147 gate
   (`gateSlackRequest`: missing signing secret → loud 503, bad
   signature → 401) and only then scans for `social_approve` /
   `social_reject`. A social action never reaches trading; any
   other action_id falls through to trading exactly as before.
   The handler (`interactions.ts`) verifies the card's draftId
   against the pending record — a stale card (rebuilt draft) is
   refused with nothing changed, as is a missing pending record.
   The approver is recorded as `slack:<userId>` (stable;
   usernames change), following the trading authorizerDid
   convention. The response replaces the card (trading
   convention: `replace_original: true`, header with the outcome,
   fields, draft text as plain_text, outcome context). A publish
   failure still counts as approved, and the message says so with
   the reason — catch-up retries it. Trust model, same as trading
   HITL: any workspace member who can click the button can
   approve. There is NO per-user allowlist, and no Slack
   verification scheme was invented: the gate is the repo's
   existing #147 pattern.
2. Session-gated route (LIVE, fallback). `POST
   /api/social/approval` `{date, channel, action}` — 401
   unauthenticated, 400 bad date/channel/action, 404 no draft,
   409 already posted/rejected or posting disabled. Approve
   publishes promptly and returns the channel publish outcome;
   reject publishes nothing. `GET /api/social/approvals`
   (`?date`, default today NY) lists pending approvals with draft
   text for review without Slack. Any signed-in user may decide;
   admin-only approval is a later item, not silently assumed.
   Both routes are in the IAAA endpoint catalog (pin rule).

## Publish-on-approve semantics

- Approval triggers the date's full publish pass under the same
  gates as the goal path (posting switch, live/dry-run
  resolution, token/account checks) — never a second publish
  implementation. Posting disabled refuses approval outright,
  leaving the draft untouched for a later decision.
- A publish failure leaves the draft APPROVED with the error in
  the result: retryable via catch-up, never silently dropped,
  never marked posted on failure. The approval action returns the
  draft's final stored state (posted on live success,
  dry-run-posted on dry-run success, or still approved on
  failure).
- The handler awaits publish before answering Slack (repo
  convention, like trading execution). Known wart: a slow
  platform call may exceed Slack's 3s interaction window — the
  user sees a timeout even if the publish later succeeds. Draft
  status is the source of truth, and catch-up will NOT duplicate
  a posted draft.

## Catch-up sweep + goal-run semantics (goalExecutor.ts)

- Every firing sweeps the 7 prior dates (`priorDates`, newest
  first, `SOCIAL_CATCH_UP_LOOKBACK_DAYS = 7`) through the same
  `publishDueDrafts` path — no second publish implementation.
  Only dates with at least one posted or error result are
  reported in `catchUp`; skipped-only dates are omitted.
  Unapproved approval drafts are re-recorded pending and skipped
  (never published); posted/failed drafts are skipped; dates
  older than 7 days are never auto-published (staleness beyond a
  week is a human decision). Posting disabled short-circuits
  catch-up too.
- Fired rule, extended from slice 1: the goal counts as run when
  the day produced drafts OR catch-up published something. A
  catch-up-only firing (no brief today, backlog published) counts
  and sets `lastRun` with the firing date. A firing with nothing
  to do stays not-fired (`noBrief` / `noDrafts`) and the goal
  stays due. Publish errors do NOT unfire a run; catch-up errors
  land in the tick record via `onCron`.
- Note on the brief's "for the firing date" phrasing: the test
  statements ("catch-up publishes late approvals on the next
  firing; failed publish retried on the next firing") require
  cross-date coverage — a next-day firing cannot retry yesterday's
  drafts if it only looks at the new date — so the sweep covers
  the prior 7 days, not just the firing date.

## What slice 3 does NOT do

- No change to channel gating/disposition lists, config defaults,
  token/secret handling, posting-switch defaults, or the goal's
  disabled state. Activation remains owner-gated.
- No live transport: production publish (goal path AND
  publish-on-approve) still fails honestly with "no transport
  provided for live publish" until activation wiring lands.
- No per-user approval allowlist; no admin gate on the route.
- No retry of drafts older than 7 days; no re-delivery of an
  unchanged pending record; no duplicate cards on tick replay.

## Token health + rotation runbook (#1160)

`tokenHealth.ts` reports per-channel status only: `configured` /
`unconfigured` from env presence, and `valid` / `invalid` /
`unknown` from a live probe over an injected transport. The
session-gated route `GET /api/social/token-health` (401
unauthenticated, 405 other methods, catalog entry
`social-token-health-get`) serves that report. Its response never
contains a token value, a token prefix, or platform error text —
the transport surface carries status numbers only, so a body can
never leak through. `unknown` is a real answer, not a euphemism:
it means "no probe ran" (no transport, or unconfirmed endpoint)
or "the probe could not conclude" (unexpected status, transport
error). Only `invalid` means the platform rejected the token.

### Where tokens live

Platform portal → GitHub repository → Settings → Environments →
PROD secrets → the deploy workflow's `sync-secrets` job
(non-blocking, runs after deploy; `scripts/ci/put-secret.sh` with
`require_secret` / `optional_secret`) → Cloudflare Worker secrets.
That is the same journey the Google OAuth secrets already use.
Two consequences: (1) setting a GitHub PROD secret alone does NOT
reach the Worker until a deploy runs the sync job — and a token
name must first be added to the sync job itself, which is a
workflow-file edit the owner makes in the web UI (the GitHub API
cannot write `.github/workflows/*`); (2) a direct
`wrangler secret put` persists but is NOT re-synced on later
deploys, so it is a stopgap, not the durable route. Tokens are
never committed to the repo, never pasted in chat, and never
returned by any route.

### How to rotate each token (no code change, ever)

Rotating a token is a secrets operation, not a code change: the
route and the publisher layer read env per call, so a new value
takes effect on the next deploy that syncs it. Per channel:

- **X** (`X_ACCESS_TOKEN`): regenerate in the X developer portal
  for the app, update the PROD secret, redeploy. Re-check this
  route afterwards: X reports presence only — its validity probe
  is unconfirmed (below), so confirm the new token in the X
  portal, not from this route.
- **Threads** (`THREADS_ACCESS_TOKEN`): regenerate in the Meta app
  (Threads use case, `threads_basic` + `threads_content_publish`),
  update the PROD secret, redeploy. Long-lived token lifetimes
  vary — confirm the expiry in the portal at rotation time and
  re-check this route afterwards; it should flip to configured,
  and to valid once a live transport is wired.
- **Facebook Page** (`FACEBOOK_PAGE_ACCESS_TOKEN`): this must be a
  Page token, not a user token (the publisher posts to `/me/feed`,
  which resolves to the Page only with a Page token). Regenerate
  via the Page / Meta app, update the PROD secret, redeploy.
- **Instagram** (`INSTAGRAM_ACCESS_TOKEN`): business/creator
  account linked to a Facebook Page, Instagram Graph API.
  Regenerate via the Meta app, update the PROD secret, redeploy.
- **LinkedIn** (`LINKEDIN_ACCESS_TOKEN` + `LINKEDIN_AUTHOR_URN`):
  regenerate via 3-legged OAuth in the LinkedIn developer portal,
  update the PROD secret, redeploy. The author URN does not rotate
  with the token, but if it is missing the channel still fails
  closed — this route reports its presence separately so a missing
  URN is visible instead of mysterious.

After any rotation: redeploy (so the sync job pushes the new
value), then query this route. `configured` confirms the Worker
sees the value; `valid` (once a live transport is wired)
confirms the platform accepts it. If the route still says
`unconfigured` after a deploy, the secret did not sync — check
the sync-secrets job summary before assuming the token is wrong.

### How expiry surfaces, and what happens then

- **This route:** a configured token the platform rejects reads
  `invalid`. An expired token is an `invalid` token — expiry is
  not a separate state.
- **Publish path:** expiry fails per channel, never silently.
  A live publish attempt with an expired token gets a platform
  401/403, which becomes an error entry; the draft is NOT marked
  posted and stays retryable — approval channels keep the draft
  APPROVED, and the goal's 7-day catch-up retries it on later
  firings. A failed live gate is never silently downgraded to a
  dry run: an operator who asked for live sees the failure.
  Other channels are unaffected (per-channel try/catch).
- **Rotation window:** rotate BEFORE expiry when the portal
  shows one approaching. There is no automatic renewal in this
  slice — no refresh flow, no expiry alerting. A token that
  expires mid-day fails that day's publish for its channel only;
  it does not block other channels, and it does not post
  anything stale.

### Validity endpoints: confirmed vs unconfirmed

Confirmed (2026-10-23, against publisher definitions + platform
docs): Threads `GET graph.threads.net/v1.0/me`; Facebook
`GET graph.facebook.com/v21.0/me`; Instagram
`GET graph.instagram.com/v21.0/me`; LinkedIn
`GET api.linkedin.com/v2/me` (requires the
`X-RestLi-Protocol-Version: 2.0.0` header, which the probe
sends). UNCONFIRMED: X — the candidate `api.twitter.com/2/users/me`
could not be confirmed against X's own docs in this slice's
checks, so it is not asserted anywhere and no live call is made
for X. X validity stays `unknown` until that endpoint is
confirmed against current X docs; do not treat X `unknown` as
either healthy or broken.

### What this slice does NOT do

- No live transport is wired: production validity is `unknown`
  by design until activation wiring passes a real GET transport.
  Wiring one does not change this module's contract.
- The goal executor does NOT call the health check — health is
  an operator query, not a publish gate, in this slice.
- No new secrets, no token storage change, no wrangler.jsonc /
  deploy.yml change, no publish-path change.
- The dry-run "posted" status fix is NOT part of the token-health
  slice itself — it landed separately as #1171, after which a
  dry-run publish marks its draft "dry-run-posted" and flipping
  live mid-day live-publishes that day's drafts instead of
  skipping them.
