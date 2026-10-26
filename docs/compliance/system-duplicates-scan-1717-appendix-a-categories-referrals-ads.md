# Scan appendix (a) — Categories / referrals / external ads — parent #1717

## Agent

#CISO-bhdm

Scan head: `23de3ce`. Main doc: `docs/compliance/system-duplicates-scan-1717.md`.
Standing rules (see main doc): NEVER EITHER/OR ALWAYS CONFIGURABLE (one switch per
pair); scoped defaults run > session > user > global env > built-in (public route
behavior); default where the owner has not decided = current public route behavior,
recorded explicitly; never remove an endpoint; never delete a code path; Security
Guard: scoping is for behavior variants, never for disabling enforcement.

Common facts (all three pairs): same tables (`mas_categories`, `mas_referrals`,
`mas_external_ads`) via `DatabaseORM` (`src/orm/index.ts`) — divergence is in the
two adapters (REST route vs MCP command), not storage. REST routes audit; MCP
commands audit NOTHING for any of these three domains. Neither layer adds a
per-handler auth check (both inherit the dispatcher session). Systematic error
split: REST returns HTTP JSON (`{error, status}`); MCP throws `Error` (no status).
Update coverage is systematic too: REST categories + external ads support
update-by-id inside POST; MCP categories supports update with a different field
set; MCP external ads has NO update action; neither layer supports referral update.

## C-1 / M05 — Categories: REST vs MCP — DIVERGENT

- Implementations: `src/agents/routes/adsRevenueReferrals.ts`
  (`handleAdsRevenueReferralsRoutes`, `/categories`) vs `src/mcp/commands.ts`
  (`ManageCategoriesCommand`, list/create/update/delete).
- Id: route create `cat_<slug[0:16]>_<uuid4>` (random suffix, unique per create);
  command create caller-supplied `id` if given, else deterministic
  `cat_<name.toLowerCase().replace(/[^a-z0-9]/g, "_")>` — no random suffix, so
  creating the same name twice yields the same id (collision-prone; no dedup).
- Slug: route create from name (or supplied slug), lowercased, non-alphanumerics
  → `-`, leading/trailing `-` stripped, truncated to 32 chars. Command create from
  name only (supplied slug ignored — no slug input), lowercased, `[^a-z0-9]+` →
  `-`, no trim, no truncation. Route UPDATE recomputes slug from supplied slug or
  name (`[^a-z0-9]+` → `-`, no trim, no 32-truncation — route update slug rules
  differ from route create slug rules). Command update NEVER touches slug —
  renaming via MCP leaves the old slug in place.
- Defaults: description route `` `Category for ${name} partner links` `` vs command
  `` `${name} category tools and services` ``. Sort order route `(count() || 0) + 1`
  (append at end) vs command `Number(sortOrder) || 10` (fixed 10; an explicit 0
  also becomes 10). Icon both `"🏷️"` — identical. isActive: route honors supplied
  value (default true); command forces `true` (no input).
- Update field set: route name/slug/description/icon/isActive/sortOrder + `updatedAt`;
  missing → 404. Command name/icon/description/sortOrder only (no slug, no
  isActive) + `updatedAt`; missing id → throw `"Category id is required"`;
  missing row → whatever the ORM update returns (no explicit not-found error).
- List: both `sort_order ASC` — identical ordering. Delete: route DELETE requires
  `?id` (400 without it), deletes unconditionally, audits `category.deleted`,
  returns `{success: true}` even if the row did not exist. Command delete requires
  `id` (throw without it), returns `{success, deleted, id}` with the ORM's deleted
  flag, no audit.
- Audits: route `category.created` / `category.updated` / `category.deleted`
  (agent `orchestrator`); command none.
- Slice guidance: one switch for the pair; default = route behavior (route id
  scheme, route slug rules, route defaults); pin both modes; MCP audit parity is
  part of the slice (a switch does not excuse audit silence on one surface).

## C-2 / M06 — Referrals: REST vs MCP — DIVERGENT

- Implementations: `src/agents/routes/adsRevenueReferrals.ts`
  (`handleReferralsAdsRoutes`, `/referrals`, raw SQL over `mas_referrals`) vs
  `src/mcp/commands.ts` (`ManageReferralsCommand`, list/create/track_click/delete).
- Id: both `ref_<uuid8>` — identical.
- Defaults: category route `"AI & Dev Tools"` vs command `"AI Tools"`. Reward-text
  route `"Community referral reward"` vs command `"$10 Free Credits"` — a concrete
  monetary promise on one surface, a generic label on the other.
- List: route `created_at DESC LIMIT 100`, mapped to camelCase (`userLogin` from
  `session_id`, `rewardText`, `createdAt`); command ORM `findMany` ordered by
  `clicks DESC`, no limit, raw ORM record shape.
- Click: route `POST /referrals/click` increments via raw SQL, returns
  `{success: true}` even with no id or a nonexistent id, with NO audit. Command
  `track_click` throws if id is missing and throws `Referral <id> not found` if
  absent, returns `{success, clicks}` (new count), with NO audit.
- Delete: route DELETE returns `{success: true}` even with no id (audit only when
  an id was supplied). Command delete throws without id, returns
  `{success, deleted, id}`, no audit.
- Create audits: route audits `referral.created` (`{id, title, targetUrl}`);
  command audits nothing. Neither layer has a referral update path (route POST
  ignores any id in the body; command has no update action). Field naming on
  create: both use `url` — identical (the sponsored-ads surface uses `url` on REST
  and `targetUrl` on MCP for external ads; referrals do not have that split).
- Slice guidance: default = route behavior (route category/reward strings, route
  list order/limit); the reward-text delta is owner-overturnable — record the
  default explicitly, don't decide it in the slice.

## C-3 / M07 — External ads: REST vs MCP — DIVERGENT (largest money delta in the scan)

- Implementations: `src/agents/routes/adsRevenueReferrals.ts` (`/external-ads`,
  `/external-ads/impression`, `/external-ads/click`) vs `src/mcp/commands.ts`
  (`ManageExternalAdsCommand`, list/create/impression/click).
- Id: route `ext_<network>_<uuid6>` (network raw from body, `"net"` fallback) vs
  command `ext_ad_<uuid8>` (no network segment, different prefix).
- Money defaults (headline delta): route create `cpmRate = Number(cpmRate) || 15.0`,
  `cpcRate = Number(cpcRate) || 1.25`. Command create `cpmRate = Number(cpmRate) || 2.5`,
  `cpcRate = Number(cpcRate) || 0.45`. An ad created with no rates earns 6× more
  per impression and ~2.8× more per click on REST than on MCP. Both use the `||`
  fallback, so an explicit `0` rate also collapses to the default on both layers.
- Initial ledger state: route create `impressions: 1`, `clicks: 0`,
  `earnings: cpmRate/1000` (creation itself counts as one paid impression).
  Command create `impressions: 0`, `clicks: 0`, `earnings: 0`.
- Field defaults: route `network` default `"direct"`, `placement` default
  `"header_leaderboard"`, `tagline` default `""`, `ctaText` default `"Learn More →"`,
  `name` defaults to title, `bannerImageUrl` default `""`, `isActive` forced `true`
  (body value ignored), no `updatedAt` set. Command `network` default `"ethicalads"`,
  `placement` default `"in_stream"`, `tagline` default
  `` `Verified developer partner: ${title}` ``, `ctaText` default `"Learn More"`
  (no arrow), `name` = title, no `bannerImageUrl` field. Command constrains
  network/placement by zod enum (not enforced at execution — see main doc
  auth-gate note); the route constrains neither.
- List ordering: route `earnings DESC`; command `created_at DESC`.
- Update: route POST with `id` updates title/name/network/placement/tagline/ctaText/
  targetUrl/cpmRate/cpcRate/isActive (missing → keep existing; missing row → 404;
  audits `external_ad.updated`; no `updatedAt` written). Command has NO update
  action — an MCP update attempt throws `Unsupported action: update`.
- Impression math: route increment `cpmRate || 15.0` / 1000, earnings rounded to
  3 decimals (`Math.round(x*1000)/1000`), returns `{success, impressions,
  earnings}` or `{success: false}` when missing, NO audit. Command increment
  `cpmRate || 2.5` / 1000, earnings rounded to 4 decimals
  (`Number((…).toFixed(4))`), throws when id is missing or the ad is not found,
  NO audit. Same ad, same impression, different earnings increment (rate
  fallback) and different rounding.
- Click math: route increment `cpcRate || 1.25`, earnings rounded to 2 decimals,
  audits `external_ad.clicked`. Command increment `cpcRate || 0.45`, earnings
  rounded to 4 decimals, throws when missing/not-found, NO audit.
- Create audits: route audits `external_ad.created`; command audits nothing.
- Slice guidance: default = route behavior (cpm 15.0 / cpc 1.25, route rounding,
  route initial ledger) unless the owner overturns it — record, don't decide.
  Mixed-path traffic accruing at different rates is the reason this slice pins
  both modes and the fallback-rate behavior explicitly.

## C-4 / M08 — Revenue summary: REST vs MCP — IDENTICAL

- `GET /revenue` executes `get_revenue_summary` via `runRestTool` and passes the
  result through unchanged; the command returns `orm.getRevenueSummary()`
  directly. One computation, two transports. Note: the summary aggregates the
  divergent ad/referral/payment rows above, so its INPUTS diverge by creation
  surface even though the summary function itself is single. No slice work here
  beyond the (a) pair slices themselves.

## Clarified non-pair

Sponsored `/ads` (`mas_ads`, marketplace offers with seed data + impression-on-fetch
+ `LIMIT 20`) is a DIFFERENT surface from external ads, with no MCP counterpart.
Do not merge `/ads` into `manage_external_ads` without a separate decision.
