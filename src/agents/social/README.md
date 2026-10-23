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
