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
3. Approval-channel posts still need an approval action:
   `approveDraft` over the durable stores, then a re-fire of the
   same day's goal publishes them. Slack approval-card delivery
   is still a later wiring step.

## Known limitation (follow-up, not slice 1)

Each goal firing publishes ONLY its own date's drafts. An approval
that arrives after the day's firing is therefore not published by
any later firing (the next day builds new drafts). The fix belongs
in a later slice: publish-on-approve (the approval action itself
publishes), or a catch-up sweep in the executor. Do not silently
widen the executor's date scope to paper over this.

## What still gates the first live post (after slice 1)

- Real tokens as Worker secrets + the per-channel account mapping
  (which Page, which LinkedIn author URN, which Threads/Instagram
  identities).
- A content source for the brief provider is slice 2 (below); the
  voice/style rules for brief content are still open.
- Posting-time/weekday confirmation (defaults 09:00 ET Mon–Fri stand
  until the owner changes them — now as the seeded goal, editable
  via the dashboard).
- A live transport behind the injected-transport seam, Slack
  approval-card delivery for pending approvals, and the
  approval-latency fix above.
- Re-confirmation of every payload shape against current platform
  docs, plus a token-expiry health check and rotation runbook
  (tokens expire; expiry must warn before it breaks posting).

# Social posting — Phase 5b slice 2 (NLQ/human content intake)

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
- No publish-on-approve / catch-up sweep (the slice 1 limitation
  stands: a same-day approval arriving after that day's firing is
  still not published by a later firing).
