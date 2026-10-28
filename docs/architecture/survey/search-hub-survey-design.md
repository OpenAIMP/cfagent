# Search hub — survey + design (additive left-nav Search page)

Filed copy (issue #2120 slice 1): survey base main
`296fa9abbe11391014d0f970ac673e413fad7b70` (2026-10-28, post-#2119);
filed from the slice-1 base main `a7ba73caa3866081ee2c11f10347914655b5b4eb`
(post-#2120 slice 0, PR #2126). Slice-0 passages are corrected to the
as-shipped reality (404-shadowing guard first, env wiring second);
the workspace working file carries the same corrections, so the two
copies do not diverge on substance.
Method: `git show <sha>:<path>` and `git grep -n <pattern> <sha> -- 'src/*'`.
Prerequisite reading: `~/workspace/w1169/ai-search-activation-survey.md`
(three separate search systems, not one — carried forward below, re-verified
where this report leans on it).

Standing constraint honored throughout: ADDITIVE ONLY. The hub adds a surface
reusing existing backends. Nothing below removes, rewires, or retires any
existing capability from anywhere else. Where an existing backend is broken
(the Reports semantic env gap), the fix is a minimal additive wiring change
that leaves the working half untouched, and it is scoped as its own preceding
slice (§6), not smuggled into the hub diff.

## 0. The three systems (framing — do not conflate)

1. **NLQ** — natural-language records analytics over enterprise data
   (`src/agents/nlq/*`, route POST `/nlq`). Answers about records, plus
   record actions (scheduling, discovery) — not document retrieval.
2. **AI Search agent** — `ETradeAISearchService` (`src/services/aiSearch.ts:226`)
   + MCP `ai_search_financial_docs` (`src/mcp/cloudflareAgentCommands.ts:238`)
   + MCP `knowledge_search` (`src/mcp/commands.ts:421`), all reaching one
   Cloudflare AI Search instance over HTTPS (`wrangler.jsonc:144`). No
   Vectorize touch, no REST route, no UI consumer today.
3. **Vectorize-direct** — `VECTOR_MEMORY` binding (`wrangler.jsonc`, PR #6)
   + Workers AI `@cf/baai/bge-base-en-v1.5` embeddings, in two subsystems
   sharing one `vector-memory` index: report vectors
   (`src/services/reportSemanticIndex.ts`) and agent memory
   (`src/memory/vector-memory.ts`).

Plus two lexical/client-side mechanisms that are search-*like* but are not
semantic systems: SQL LIKE search over `mas_reports`
(`searchScheduledReports`, `src/services/scheduledReports.ts:641`) and the
nav command palette (`src/client/components/StockSearchBar.tsx`).

## 1. Inventory — every search-like capability

| # | Capability | Today's UI entry | API route | Backend service | System | Status |
|---|---|---|---|---|---|---|
| 1 | NLQ records analytics | Left-nav "Records & Ledger Explorer" (`routes.ts:181`, id `nlq`) → inline Chat view (`Chat.tsx:1146`, `nlq-view` + presets + `nlqInput` state) | POST `/nlq` (`src/agents/routes/mcpChatNlq.ts:284`; body `{query, context?, validateWithLLM?, mode?}`; `x-user-login` gate, shared 401) | `executeNaturalLanguageQuery` (`src/agents/nlq.ts`, via `mcpChatNlq.ts:51`) | NLQ | WORKING, but Chat-local: the view is inline Chat state, not an extracted component. Hub NLQ tab must be a new small component posting to POST `/nlq`, not an import of the Chat view. |
| 2 | Search agent — financial docs | NONE (no UI consumes it; no REST route exists — grep for `ETradeAISearchService` in `routes/*.ts` + `server.ts` returns nothing) | MCP only: `ai_search_financial_docs` (`cloudflareAgentCommands.ts:238-257`) | `ETradeAISearchService.searchFinancialDocs` (`aiSearch.ts:232`, POST to `AI_SEARCH_ENDPOINT`) | AI Search HTTP | WIRED-VIA-MCP-ONLY, UI-unwired. Silent hardcoded `FINANCIAL_KNOWLEDGE_BASE` fallback on any primary failure (`aiSearch.ts:182,298`) — S3 target, probe-gated, user decision 2026-10-28 is probe-first: the hub build MUST NOT delete or alter the fallback. |
| 3 | Search agent — knowledge / platform catalog | NONE in UI; chat alias only (`mcpAdapter.ts:87`: chat `searchKnowledge` = MCP `knowledge_search`, NOT the MAS tool) | MCP only: `knowledge_search` (`commands.ts:421`), `query_platform_knowledge` (`:468`) | `runSearchContract` (`commands.ts:330`): AI endpoint attempt → zero chunks or platform-keyword match → `searchPlatformKnowledge` (`src/services/platformKnowledge.ts`, imported at `commands.ts:90`), mapped to chunks with hardcoded `score: 1.0` (`commands.ts:316-323`, "legacy verbatim"). `KNOWLEDGE_MODE` governs these two tools only. | AI Search HTTP + hardcoded catalog | WIRED-VIA-MCP-ONLY. Catalog fallback is disclosed in-message, not silent — but it is still hardcoded content standing in for index results (separate decision gate G1, NOT folded into S3). |
| 4 | MAS searchKnowledge | NONE | NONE (no instantiation) | `searchKnowledge` (`src/agents/mas.ts:26`): lexical `mas_reports` first + POST `${AI_SEARCH_ENDPOINT}/search`, honest upstream failure, flag-gated corpus provenance on index chunks only (`mas.ts:95-107`) | AI Search HTTP + lexical | DEFINED-BUT-UNWIRED: `createMAS` imported by `orchestrator.ts:56`, never called anywhere in `src/`. NOT a hub tab (see §5c: instantiate-or-retire is an S4 decision, not hub work). |
| 5 | Semantic report search | ReportsPanel "Semantic" toggle (`ReportsPanel.tsx:121-141`; also reachable via ScreenersHub reports tab, which renders `<ReportsPanel />` at `ScreenersHub.tsx:1218`) | GET `/api/reports/semantic-search` (`src/agents/routes/reports.ts:806`; param `q`; returns `{hits: merged, semantic: bool}`) | `semanticSearchReports` (`reportSemanticIndex.ts:114`, Vectorize `kind: "report"` topK 8) merged with lexical `searchScheduledReports` (20) via `mergeSearchHits` (`:88`) | Vectorize-direct + lexical SQL | FIXED in #2120 slice 0 (PR #2126). Root cause, corrected: FIRST defect — the detail branch (`reports.ts:704`) matched `/api/reports/semantic-search` before the semantic branch (`:806`) and 404'd, so production showed an error state, not lexical-only; SECOND defect — the env omission (route read `(ctx as any).env || {}`, no `env` field, caller passed none) would have forced `semantic: false` if the branch had been reached. Slice 0 fixed both (detail-branch guard + `env` wiring); the lexical half is unchanged. |
| 6 | Agent memory search | MemoryBrowser (`src/client/MemoryBrowser.tsx`, via `memoryApi.ts:searchMemory`) | POST `/api/memory/search` (`src/server.ts:909`) | `VectorMemory.recallForPlan` (`vector-memory.ts:67`; also `recallPlans` `:171`, `searchDense` `:101`) | Vectorize-direct (`vector-memory` index, `kind: "plan"`/outcome vectors) | WORKING. |
| 7 | Lexical report search | ReportsPanel keyword filter (client-side over `/api/runs` rows, `ReportsPanel.tsx:155-163`); semantic route's lexical side (row 5) | GET `/api/reports` (`reports.ts:751`), GET `/api/runs` (`:603`) | `searchScheduledReports` (`scheduledReports.ts:641`, SQL `LOWER(title/summary/body) LIKE`, tokens > 2 chars, max 8) | Lexical SQL | WORKING. Not a separate hub tab: the semantic-search tab already merges it (row 5). |
| 8 | Knowledge corpus storage/serving | NONE (no UI consumes `knowledge/file`; grep for `knowledge/file` in `src/client/*` returns nothing) | POST `/api/knowledge/corpus` (works, NOT flag-gated); GET `/knowledge/file` (flag-gated, session + hash-verified) | `src/services/knowledgeCorpus.ts` (R2 `knowledge/<category>/<sha256>` in bucket `screener`) | R2 storage, NOT an index | STORAGE-ONLY. Seeding ≠ indexing; no index bridge exists (`knowledgeMemoryModes.ts` enforcement section: "Ingesting a corpus doc does NOT make it searchable"). NOT a hub tab (no listing API — DO storage has get/put only, per `knowledgeCorpus.ts` header; corpus listing is S4). |
| 9 | Tools / endpoints catalog search | Left-nav "endpoints" → EndpointsTab (`src/client/chat/tabs/EndpointsTab.tsx:8`, renders `<McpApiExplorer />`) | NONE (client-side filter) | `McpApiExplorer.tsx` `toolSearch` state filtering `MCP_TOOLS_CATALOG` / resources / prompts / REST (`src/client/mcpEndpointsData.ts:40,483,534,560`) | Client-side catalog filter | WORKING. |
| 10 | Nav command palette | NavigationMenu header `StockSearchBar` | NONE (client-side) | `SEARCH_SYMBOLS` + `useMarketQuotes` (tickers) + hand-maintained `NAV_SHORTCUTS` (nav jump targets) + actions; pills all/tickers/navigation/actions | Client-side | WORKING as navigation, NOT content search. NOT a hub tab. But: `NAV_SHORTCUTS` is hand-maintained — the new hub entry needs one line there or the palette will not find it (§6). |
| 11 | Runs / artifacts browse | Left-nav "docs" → DocsAndReportsPanel (`Chat.tsx:1136`, renders `DocsAndReportsPanel`, reads GET `/api/runs`) | GET `/api/runs` (`reports.ts:603`) | Run-store read (one row per run, artifact keys or honest "—") | Run-store read | BROWSE, not search. NOT a hub tab (the semantic-search tab already hydrates report ids from `/api/reports`). |
| 12 | Discovery runs browse | StrategyReviewPanel + `src/client/discoveryApi.ts` | GET `/api/etrade/options/discovery-runs` (`discoveryApi.ts:40`, list + detail) | Discovery run store | Run-store read | BROWSE, not search. Discovery execution itself runs through NLQ/kernel, not a search UI. NOT a hub tab. |
| 13 | Screener / scanner filtering | ScreenersHub tabs + ScannerPanel | Screening routes (not search routes) | `screenerPipeline.ts` (`acquireUniverse`, `screenWithQuotes`) | Filter-driven screens | WORKING, NOT search. ScreenersHub owns it. NOT a hub tab — duplicating filters in the hub would split the one-screener rule (#958). |
| 14 | Chat / AskAgent | Chat page; `AskAgentWidget` (`components/AskAgentWidget.tsx`, CapabilityNavBar trigger) | Chat agent path | Agent chat; `searchKnowledge` alias → MCP `knowledge_search` (row 3) | Conversational | NOT a hub tab. Chat owns it. |
| 15 | Serve-leg report reuse | NONE (backend only) | NONE | `resolveStoredReportForServe` (`src/agentic/compositionMemory.ts:207` via `semanticSearchReports`) | Vectorize-direct (read) | Backend reuse, not a surface. NOT a hub tab. |
| 16 | SEARCH_AGENT DO binding | NONE | NONE | `wrangler.jsonc:48` binds `SEARCH_AGENT` → class `SearchAgent`; NO `SearchAgent` class exists in the repo | Dead binding | DEAD. NOT a hub tab. Resolve-or-remove is an S4 decision, NOT hub work. |
| 17 | VectorMemory AI-Search leg | NONE | NONE | Constructor takes an `aiSearch` client (`vector-memory.ts:40`); NO method reads it; all 5 construction sites pass `undefined` (`orchestrator.ts:1843`, `chatTurnHelpers.ts:162`, `goalChainCommands.ts:241`, `createRetrievalPorts.ts:44`, `server.ts:938`) | Aspirational | NOT a hub tab. Wire-or-remove is a later-loop item (§5c). |

## 2. Left-nav: how entries work, and the minimal add

The route table is the single source of truth (#1804 S1, `src/client/routes.ts`
header): "Every left-nav page registers ONCE here; the nav items,
breadcrumbs, active states, and visibility defaults are all derived from
this table."

- **Entry shape** (`routes.ts`, `RouteDef`): `id` (tab id carried in the URL
  as `?tab=<id>`, `router.ts:parseTabFromSearch`), `navGroup` (nav entry
  highlighted when active), `crumb`, `category` (`Execution` |
  `Intelligence` | `Playbooks` | `Platform`), `icon` (key into
  `NAV_ICON_MAP`), `description`, and optional `navEntry: { label,
  shortLabel, navOrder (unique across nav entries), defaultVisible,
  badge?, badgeType? }`. Entries WITHOUT `navEntry` are alias/legacy ids
  that never render in nav. The table stays sorted alphabetically by id
  (concurrent additions land at different positions instead of one
  prepend anchor — the CHANGELOG lesson, applied to nav).
- **Derivation** (`NavigationMenu.tsx:364`): `NAVIGATION_ITEMS =
  ROUTES.filter(hasNavEntry).sort(by navOrder).map(...)` with
  `icon: NAV_ICON_MAP[r.icon]`. Visibility: `isTabVisible` (`:415-417`):
  `isTabFeatureEnabled(id)` AND `visibleTabs[id] !== false`.
- **Feature gate** (`src/client/featureFlags.tsx:56`, `isTabFeatureEnabled`):
  no `TAB_TO_FEATURE_MAP` entry = core / always accessible. A new `search`
  id needs NO flag entry.
- **Visibility defaults** (`routes.ts:496`): `DEFAULT_VISIBLE_NAV_TABS` is
  derived from the table (`defaultVisible`). The `all` preset spreads it
  (`NavigationMenu.tsx:76`), so a new entry with `defaultVisible: true`
  appears in the `all` preset automatically. `traderFocus` / `minimal`
  presets list tabs explicitly — leave them alone (additive: the hub is
  hidden there until a preset decision says otherwise, exactly like `nlq`
  today, which is `false` in both).
- **Shell render** (`Chat.tsx:2142-2150`): `isTabFeatureEnabled(tab)` gate,
  then `TAB_CONTENT[tab] ?? null`. Retained trading-hub ids render via the
  always-mounted `ETradeTradingHub` instead; the hub is NOT one of those —
  it is a standalone page like `docs` (`Chat.tsx:1136-1140`:
  `<ErrorBoundary><DocsAndReportsPanel /></ErrorBoundary>`), which is the
  pattern the hub entry copies.
- **Router** (`router.ts`): `?tab=<id>` is the page; inner views live in
  `?view=<id>` (#1804 S2, #2027; "Validation is the caller's job (each
  page owns its view ids)"). Deep links: `?tab=search&view=<hubtab>`.

**To ADD the entry (4 small touches, no existing entry modified):**

1. `src/client/routes.ts` — one `ROUTES` entry, alphabetically between
   `screeners` (`:371`) and `social` (next entry; `scr < sea < soc`):
   `{ id: "search", navGroup: "search", crumb: "Search",
   category: "Intelligence", icon: <see below>,
   description: "One search hub: NLQ records, AI search agent, semantic
   report search, agent memory, platform knowledge, and tool catalog",
   navEntry: { label: "Search", shortLabel: "Search",
   navOrder: 23 (max today is 22), defaultVisible: true } }`.
   The `search` id is FREE (no `id: "search"` in the table today).
2. `src/client/Chat.tsx` — one `TAB_CONTENT` entry:
   `search: (<ErrorBoundary label="Search"><SearchHub /></ErrorBoundary>)`.
3. `src/client/components/NavigationMenu.tsx` — ONLY if a dedicated icon
   is wanted: one `NAV_ICON_MAP` entry (`Search`). The map today has NO
   `Search` key (keys: Autopilot, Order, Portfolio, Ledger, Options,
   Screeners, Scanner, Research, Copilot, Voice, Omnichannel, Workflows,
   Endpoints, Database, Audit, Payments, Referrals, Ads, Revenue,
   Social). Reusing `Research` avoids even this touch; a missing key
   renders an undefined icon, so do NOT set `icon: "Search"` without
   the map entry.
4. `src/client/components/StockSearchBar.tsx` — one `NAV_SHORTCUTS` line
   (`{ id: "search", label: "Search Hub", category: "Intelligence",
   icon: "🔎" }`) so the palette finds the new page. Recommended, not
   required for the page itself.

## 3. Tabbed-page patterns to reuse

- **ScreenersHub** (`src/client/ScreenersHub.tsx`) — the closest analog and
  the pattern to copy: `SCREENER_HUB_TABS` const + `isValidScreenerTab`
  guard + `useUrlSyncedTabs<ScreenersHubTab>({ param: "view",
  aliases: ["screenerTab", "tab"] })` (`:199-201`) + `CapabilityNavBar`
  (`:626`, `tabs={screenerTabs}`) + per-tab panels. It folds formerly
  separate surfaces (scanner, IV history, goal screen, reports,
  schedules) into one hub WITHOUT removing their standalone behavior —
  the exact additive precedent for this hub.
- **`useUrlSyncedTabs`** (`src/client/useUrlSyncedTabs.ts`, #1804 S2) —
  shared behavior: canonical query param (here `"view"`), legacy aliases
  read-only, back/forward via popstate re-read, retention via
  `visitedTabs` (visited tabs render mounted-hidden so in-flight and
  finished work survives tab switches). The hub uses
  `param: "view"` with NO aliases (it has no legacy param).
- **`CapabilityNavBar`** (`src/client/components/CapabilityNavBar.tsx:40`) —
  props: `tabs: CapabilityTabItem[]` (`{ id, label, icon?, badge?,
  badgeType?, tooltip?, disabled? }`), `activeTabId`, `onTabChange`,
  `ariaLabel?`, `rightContent?`. WCAG tablist semantics, keyboard nav,
  tooltips via `TabHoverItem`. Use it, do not build a tab bar.
- **Page chrome**: `PageShell` + `PageSection` (used by the Chat NLQ view
  and `EndpointsTab`) for page title/scope note; `ErrorBoundary` per
  tab (the `docs` entry pattern) so one tab's failure never blanks the
  hub.
- **Client fetch**: `apiFetch` (`src/client/apiFetch.ts`) for all tab
  calls. Server-side session gating applies: `server.ts` sets
  `x-user-login` from the verified session (`server.ts:2736,2828`);
  browser code does not forge it.

## 4. Proposed tab set

Required tabs (user directive) plus recommended similar tabs. Each tab is
its own result list — NEVER merged across tabs: result shapes and
provenance differ per system, and merging them would repeat the exact
conflation the activation survey had to undo.

| Tab (`?view=`) | Backend reused (no rebuild) | One-line justification | System |
|---|---|---|---|
| `nlq` (required) | POST `/nlq` (row 1) | The records-answers surface users already know from the Records nav entry, now reachable from Search without leaving it. | NLQ |
| `search-agent` (required) | NEW thin REST route → `ETradeAISearchService.searchFinancialDocs` (row 2; route is §6, new module, MCP tools untouched) | The only UI surface for AI Search instance results; today it exists only as an MCP tool. | AI Search HTTP |
| `semantic-search` (required) | GET `/api/reports/semantic-search` (row 5) | The reports users actually produced, searched semantically — once its slice-0 fix landed (PR #2126). | Vectorize-direct + lexical |
| `memory` (recommended) | POST `/api/memory/search` via existing `searchMemory` (`memoryApi.ts`) + `MemoryBrowser` result shape (row 6) | Agent memory (plans, outcomes) is a search users already have but can only reach from the MemoryBrowser page. | Vectorize-direct (different filters: `kind: "plan"`/outcome, NOT `kind: "report"`) |
| `knowledge` (recommended) | NEW thin REST route → `searchPlatformKnowledge` (row 3, platform mode only) | The platform capability catalog is the honest answer to "how do I … / what can the platform do" — disclosed `score: 1.0`, never mixed with AI Search chunks. | Hardcoded catalog |
| `tools` (recommended, last) | `MCP_TOOLS_CATALOG` etc. (`mcpEndpointsData.ts`), client-side filter like `McpApiExplorer.toolSearch` (row 9) | "Which tool does X" is a search question developers ask constantly; the data already exists, no backend needed. | Client-side filter |

**Explicitly NOT tabs** (with reason): MAS `searchKnowledge` (unwired —
S4 instantiate-or-retire decision, §5c); corpus browse (no listing API);
runs/artifacts browse and discovery-runs browse (browse, not search;
reachable from ScreenersHub/Docs pages); screener/scanner filters (the
ScreenersHub owns them; #958 one-screener rule); chat (owns its alias);
SEARCH_AGENT binding and VectorMemory AI-Search leg (dead/aspirational,
§5c).

**Broken backends and their additive fixes (fixes preserve existing
behavior elsewhere):**

- `semantic-search` tab: REQUIRED the slice-0 fix (shipped, PR #2126).
  Fix, as shipped: a detail-branch guard (`reports.ts`, skipping id
  `"semantic-search"` in the detail regex that previously 404'd it)
  + `env?: …` on `ReportsRouteContext` + `env: this.env` at the
  `orchestrator.ts:2121` call site + the route's `{}` fallback guard
  kept. Effect: the semantic half goes from a 404 error state to
  real results when bindings exist; the lexical half and every other
  reports route are untouched. The tab still renders the returned
  `semantic: bool` honestly (false means lexical-only).
- `search-agent` + `knowledge` tabs: REQUIRE the new thin REST route
  (§6). No existing route is modified; MCP tools are untouched.
- `nlq`, `memory`, `tools` tabs: NO backend fix needed (all three
  backends work today).

**Flag note:** the hub must NOT depend on `KNOWLEDGE_SERVING_ENABLED`.
The flag gates mapping/serving, not queries: NLQ, memory, catalog, and
semantic tabs are flag-irrelevant, and the search-agent tab works
flag-OFF (lenient mapping) and shows richer provenance flag-ON
(`bucketKey`/`servedFileLink`/`indexingState`). Render `provider`
honestly per result (`cloudflare_ai_search` vs `semantic_cache`) —
the tab must never hide which system answered.

## 5. RSI-loop analysis — the search system improving itself

### (a) Duplication / overlap map (what is built 2–3 times)

1. **Result shaping, 3 copies**: `mapAiSearchChunks` (`aiSearch.ts:120`),
   `attachCorpusProvenance` (`mas.ts:95-107`), `platformResultToChunks`
   (`commands.ts:316`). Same job (chunks → display + provenance), three
   implementations, three score semantics (true score / absent /
   hardcoded 1.0).
2. **Lexical search, 2–3 copies**: `searchScheduledReports` (used by MAS
   AND the semantic route) plus the ReportsPanel client-side keyword
   filter over `/api/runs` rows — same question ("which reports match
   these words"), three call sites, two mechanisms (SQL vs in-memory).
3. **Two semantic indexes described as one**: AI Search instance vs
   Vectorize `vector-memory` — conflated in `knowledge_search`'s
   description ("AI Search RAG with Vectorize index retrieval",
   `commands.ts:422`) and in `knowledgeMemoryModes.ts`
   ("Vectorize/AI-Search chunks"). The activation survey had to
   separate them by hand; the code still merges them in prose.
4. **Fallback corpora, 2 copies**: `FINANCIAL_KNOWLEDGE_BASE`
   (`aiSearch.ts:182`, S3 target, probe-gated) and the platform catalog
   (`score: 1.0`, G1 decision gate). Both stand in for index results;
   only the first is slated for removal, and only after the probe.
5. **Embedding call, 2 copies, same model**: `vector-memory.ts:28-30`
   and `reportSemanticIndex.ts:16,20-22` both call Workers AI
   `@cf/baai/bge-base-en-v1.5` — the model is shared, the call code is
   duplicated (one truncates to 8000 chars, the other does not).
6. **Search UIs, 3 entry points**: ReportsPanel toggle, MemoryBrowser,
   nav palette — plus chat's alias. No page answers "search everything".
7. **Doc/header drift, 3 cases**: `aiSearch.ts:8` claims "Vectorize
   binding integration" (unimplemented — no Vectorize touch in the
   file); `reportSemanticIndex.ts` header claims "every stored report
   is indexed" (false — research-publish only, R-6 at
   `reportGeneratorModes.ts:236`); `aiSearchCache.ts` header references
   nonexistent `src/agents/search.ts`.

### (b) REUSE plan — what the hub reuses per tab (no rebuild)

| Tab | Reused component/hook | Reused route/service | New code (hub only) |
|---|---|---|---|
| `nlq` | `PageShell`/`PageSection`, `ui` inputs | POST `/nlq` | `NlqSearchTab`: query box + presets (copy the preset VALUES from Chat NLQ view, not its state) + result render |
| `search-agent` | `PageShell`, shared result/provenance display (§5d-4, display-only) | NEW route → `ETradeAISearchService` | `SearchAgentTab` + route module (§6) |
| `semantic-search` | `CapabilityNavBar` (hub chrome, not the panel) | GET `/api/reports/semantic-search` + GET `/api/reports` hydration (same as ReportsPanel `:131-141`) | `SemanticSearchTab`: query box + hit-id hydration + `semantic: bool` display |
| `memory` | `MemoryBrowser` result shape (`MemoryChunk`) | `searchMemory` (`memoryApi.ts`) → POST `/api/memory/search` | `MemorySearchTab`: thin wrapper (query + operation filter + chunk list); do NOT reimplement `MemoryBrowser` |
| `knowledge` | `PageShell`, shared result display | NEW route → `searchPlatformKnowledge` (platform mode) | `KnowledgeTab`: query box + category filter + disclosed-score display |
| `tools` | `McpApiExplorer` filter pattern | `mcpEndpointsData.ts` catalogs (no backend) | `ToolSearchTab`: query box + catalog filter + result list |

Shared hub chrome reused, not rebuilt: `useUrlSyncedTabs`
(`param: "view"`), `CapabilityNavBar`, `PageShell`, `ErrorBoundary`,
`apiFetch`, `TabHoverItem` tooltips.

### (c) CONSOLIDATION candidates for LATER loops (explicitly NOT this build)

1. Single shared result/provenance display component (bucketKey /
   servedFileLink / provider / score / `semantic: bool` rendered one
   way) — display-only, after the hub proves the per-tab shapes.
2. Single lexical search service (fold the ReportsPanel client filter
   into `searchScheduledReports` callers) — behavior-preserving, needs
   its own slice.
3. MAS `searchKnowledge` instantiate-or-retire (S4 decision): either
   wire `createMAS` somewhere real or delete the import + tool; the
   hub does NOT answer it by adding a third `searchKnowledge`.
4. `SEARCH_AGENT` binding resolve-or-remove (class missing) and
   VectorMemory AI-Search leg wire-or-remove (client never read).
5. Index coverage for screener/goal/options reports: extend `indexReport`
   call sites to canonical report paths — a NEW capability per R-6
   (not a dedup), needs its own user decision; until then the
   `semantic-search` tab honestly covers research reports only.
6. Corpus→instance index bridge (dashboard source config OR a new
   bridge build) — decides whether corpus docs ever become searchable
   by the agent; NOT the hub's job.
7. Unifying the two fallback corpora under the G1 decision gate —
   after S3 (probe-first), not before.
8. NLQ view extraction: move the Chat inline NLQ view into a reusable
   component so hub v2 and the Records page share it — hub v1
   deliberately does NOT do this (additive rule: the Chat view stays
   exactly as-is; v1's NLQ tab is a separate small component on the
   same POST `/nlq` backend).

### (d) IMPROVEMENT backlog, ordered by value

1. **Reports semantic env fix** (shipped as slice 0, PR #2126) — made the
   shipped toggle actually work; unblocked the hub's `semantic-search` tab.
2. **Search-agent REST route** (hub slice, §6) — unlocks ALL UI
   consumption of the agent, not just the hub.
3. **Index-coverage decision** for screener/goal reports (§5c-5) —
   makes the `semantic-search` tab cover the reports users produce.
4. **Shared provenance display** (hub slice, display-only) — every tab
   shows provider + score + served-file link (where present) + the
   `semantic: bool` in one visual language; no backend change.
5. **MAS instantiate-or-retire** (§5c-3) — kills the ambiguity that
   produced the chat-alias/MAS name collision.
6. **Cross-tab query comparison** (hub-native, cheap) — one shared
   query box state: "run this query on all tabs" renders each tab's
   answer side by side, which is itself the RSI measurement loop made
   visible (which system answers what, and how well).
7. **Header/doc drift cleanup** (§5a-7) — three header corrections, no
   behavior change; stops the next survey from re-deriving them.

### (e) What the hub MEASURES (hub-local only — no new telemetry system)

No new store, no telemetry pipeline, no `mas_*` table, no new binding.
Everything below is data the tabs already return, rendered in the hub
itself (ephemeral in-memory state) or kept in browser `localStorage`
only (client-local, not a system of record):

1. **Per-tab result line** (in-tab, ephemeral): last query → hit count,
   `semantic: bool` (semantic tab), `provider` (agent tab), latency ms.
   This is the honest signal for the next loop: which tabs answer, and
   whether semantic is actually on.
2. **Hub health strip** (hub chrome, ephemeral): one row per tab showing
   its last response status (ok / empty / error + message). Reuses the
   error shapes the backends already return; adds no instrumentation.
3. **Recent searches** (`localStorage` only, client-local): last N
   queries per tab, re-runnable with one click. No server write, no
   retention policy question, no PII store — queries never leave the
   browser except to the backends they already go to.
4. **Cross-tab comparison counts** (feeds §5d-6): when "run on all tabs"
   is used, show each tab's hit count side by side. The comparison IS
   the measurement: the next loop reads which system answered best
   from the same data the user already saw.

Explicitly NOT measured here: per-user analytics, server-side query
logs, embedding-quality metrics, index-coverage dashboards — all need
their own decision + system, and none is smuggled into the hub.

## 6. Build brief

**Ship order (merge-first, one slice at a time):**

- **Slice 0 (shipped, PR #2126, merge `a7ba73ca`): Reports semantic
  env fix + detail-branch guard.** As shipped, two defects: FIRST,
  the detail branch (`reports.ts:704`) matched
  `/api/reports/semantic-search` before the semantic branch (`:806`)
  and 404'd it (production error state, not lexical-only) — fixed
  with a minimal detail-branch guard, chosen over branch reorder
  because reordering broke the `thin_router_inventory` pinned route
  order; SECOND, the env omission — `env` added to
  `ReportsRouteContext` + `ctx.env` instead of `(ctx as any).env`
  (keeping the `{}` fallback guard) + `env: this.env` at the
  `orchestrator.ts:2121` mount ctx. Pin
  (`tests/reports_semantic_env_p2120.test.ts`): mount pin + route
  pins (`semantic: true` with stubbed bindings, both semantic and
  lexical hits; lexical half byte-identical with `{}`); all three
  fail on the pristine tree (mount pin: no `env`; route pins: the
  404 shadowing). No other reports route touched; ReportsPanel
  untouched.
- **Slice 1 (the hub).** Everything below.

**Files to ADD (slice 1):**

- `src/client/search/SearchHub.tsx` — hub page: `SEARCH_HUB_TABS` const
  (`nlq`, `search-agent`, `semantic-search`, `memory`, `knowledge`,
  `tools`) + `isValidSearchHubTab` + `useUrlSyncedTabs({ param: "view" })`
  + `CapabilityNavBar` + visited-tab retention + per-tab
  `ErrorBoundary` + hub health strip + shared query state (for
  cross-tab comparison) + `localStorage` recent searches.
- `src/client/search/tabs/NlqSearchTab.tsx` — POST `/nlq` query box +
  presets + results (new component; Chat NLQ view untouched).
- `src/client/search/tabs/SearchAgentTab.tsx` — new-route agent query +
  chunk results with `bucketKey`/`servedFileLink`/provider display.
- `src/client/search/tabs/SemanticSearchTab.tsx` — `/api/reports/semantic-search`
  query + `/api/reports` hydration (ReportsPanel's `:131-141` pattern,
  not the panel itself) + honest `semantic: bool` display.
- `src/client/search/tabs/MemorySearchTab.tsx` — thin wrapper over
  `searchMemory` + `MemoryChunk` rendering.
- `src/client/search/tabs/KnowledgeTab.tsx` — new-route platform query +
  category filter + disclosed `score: 1.0` display.
- `src/client/search/tabs/ToolSearchTab.tsx` — client-side filter over
  `mcpEndpointsData.ts` catalogs.
- `src/agents/routes/searchHub.ts` — NEW module:
  `handleSearchHubRoutes(request, url, path, sessionId, { env })`
  following the `knowledgeCorpus.ts` mount pattern: session gate via
  the shared 401 when `x-user-login` is absent (server sets it from
  the verified session); POST `/search/agent` → `new
  ETradeAISearchService(env).searchFinancialDocs(query, limit)`; POST
  `/search/knowledge` → `searchPlatformKnowledge(query, { category,
  maxResults })` (platform mode only, v1 — no AI blend, so the two
  agent tabs never conflate). Returns the services' native shapes;
  no new response envelope, no new store.
- `tests/search_hub_p*.test.ts` — pins (§6 test plan).
- `changelog.d/<issue>-search-hub.md` — fragment at ship time.

**Files to TOUCH minimally (slice 1):**

- `src/client/routes.ts` — one `ROUTES` entry (§2).
- `src/client/Chat.tsx` — one `TAB_CONTENT` entry (§2).
- `src/client/components/NavigationMenu.tsx` — one `NAV_ICON_MAP`
  entry, ONLY if a dedicated Search icon is wanted (else reuse
  `Research`, zero touch).
- `src/client/components/StockSearchBar.tsx` — one `NAV_SHORTCUTS`
  line (recommended).
- `src/agents/orchestrator.ts` — import + one mount call for
  `handleSearchHubRoutes` (position adjacent to the knowledgeCorpus
  mount; new paths `/search/agent`, `/search/knowledge` collide with
  no existing `path.endsWith` suffix).

**Backend reused per tab:** POST `/nlq`; new route → `ETradeAISearchService`
+ `searchPlatformKnowledge`; GET `/api/reports/semantic-search` +
GET `/api/reports`; POST `/api/memory/search`; `mcpEndpointsData.ts`
(no backend). No new bindings, no wrangler changes, no new index.

**What NOT to touch (stays exactly as-is):**

- `src/services/aiSearch.ts` (no fallback change — S3, probe-first),
  `src/agents/mas.ts`, `src/mcp/commands.ts`,
  `src/mcp/cloudflareAgentCommands.ts`, `src/memory/vector-memory.ts`,
  `src/services/reportSemanticIndex.ts`, `src/services/scheduledReports.ts`,
  `src/client/ReportsPanel.tsx`, `src/client/ScreenersHub.tsx`,
  `src/client/Chat.tsx` NLQ view, `src/client/MemoryBrowser.tsx`,
  `src/client/McpApiExplorer.tsx`, `src/client/chat/tabs/EndpointsTab.tsx`,
  `src/services/knowledgeCorpus.ts`, `src/agents/routes/reports.ts`
  (except slice 0's env fix), `src/agents/routes/knowledgeCorpus.ts`,
  `wrangler.jsonc`, `docs/architecture/survey/` (the #2119 filing),
  every existing `ROUTES` entry, every existing `TAB_CONTENT` entry,
  `NAV_TAB_PRESETS`, `TAB_TO_FEATURE_MAP`.
- The hub adds; it does not move the NLQ nav entry, the ReportsPanel
  toggle, the MemoryBrowser page, or the Endpoints page. All four stay
  reachable exactly where they are today.

**Test plan (pins, in the same PR per slice):**

1. Hub renders all six tabs; default tab + each `?view=<tab>` deep link
   lands on the right tab; unknown `?view=` falls back to default
   (mirrors `isValidScreenerTab`).
2. Each tab calls its existing backend and renders its native shape:
   NLQ → POST `/nlq`; agent → POST `/search/agent` (service stubbed at
   the route test); knowledge → POST `/search/knowledge` (catalog
   stubbed); semantic → GET `/api/reports/semantic-search` (route
   stubbed, `semantic: bool` displayed); memory → POST
   `/api/memory/search` (existing `searchMemory` contract); tools →
   catalog filter over `mcpEndpointsData.ts` (no network).
3. Existing surfaces still present and unchanged: `ROUTES` still
   contains every pre-hub id; `TAB_CONTENT` keys are a superset of
   pre-hub keys; ReportsPanel, MemoryBrowser, McpApiExplorer, Chat NLQ
   view render unchanged (component-level smoke pins, no behavior
   assertions on their internals).
4. Slice-0 pin (shipped, PR #2126): mount pin + route pins
   (`semantic: true` with stubbed bindings; lexical half
   byte-identical); all three fail on the pristine tree (mount pin:
   no `env`; route pins: the 404 shadowing).
5. No file deletions: PR diff `name-status` contains no `D`
   (Policy Gate §22).
6. Full suite + typecheck at ship time (parent gate), per the lane's
   merge-first discipline. Local gate notes: docs-only reasoning does
   NOT apply (this touches `src/`); the suite runs.

**Policy Gate notes (at ship time, not this survey):**

- NOT docs-only (touches `src/`), so the docs scope guard does not
  apply — but every other gate check does: linked issue (file a NEW
  §5 issue for the hub, referencing #1169 S4 and #1972 — do NOT close
  #1169 with it, plain reference only), lane label, agent hashtag
  `#CDO-mha7`, `changelog.d/` fragment (preferred over CHANGELOG.md
  edit), §23 `Process documentation impact:` line in the PR body, no
  file deletions (§22), no test deletions (or the #1917 rename
  allowance if a test file is renamed with titles preserved).
- Standing directives noted for the build (not re-litigated here):
  EVERY capability needs a UI — the hub IS the UI for the previously
  UI-less agent surfaces. Schedulable + downloadable: NOT-APPLICABLE
  with reason — search is on-demand, not a scheduled capability, and
  its results are references to reports whose PDF/XLSX/CSV artifacts
  are already downloadable; a hub-level result export is a later-loop
  item (§5c), not this build.

## 7. Residuals — what code could not determine

1. **Chat NLQ tab's exact execution path**: grep for `"/nlq"` in
   `Chat.tsx` returns nothing — the inline NLQ view's submit path was
   not traced (it may go through the chat/agent path rather than POST
   `/nlq` directly). What would answer it: read the NLQ view's submit
   handler in `Chat.tsx` (post-`nlqInput` state usage). Hub impact:
   NONE on scope — the hub NLQ tab reuses POST `/nlq` (the documented
   NLQ route) regardless — but the build should verify whether Chat's
   NLQ path adds anything (e.g. mode carriers, #1722) the hub tab
   should also pass.
2. **Whether the `search` nav id collides with any non-ROUTES usage**:
   `id: "search"` is free in `routes.ts` and `TAB_CONTENT` has no
   `search` key, but a whole-tree grep for `"search"` as a tab/view id
   (e.g. a `?view=search` consumer) was not run. What would answer it:
   that grep at build time; a collision would rename the hub id
   (e.g. `search-hub`) with no design change.
3. **Live index contents**: which reports (beyond research-published)
   are in the production Vectorize `vector-memory` index, and what the
   AI Search instance currently indexes — dashboard/live evidence
   only (activation survey §9, items 1, 2, 8). Hub impact: the tabs
   display what backends return; they do not assert index contents.
4. **The `search-agent` tab's result rendering for non-corpus chunks**:
   flag-ON provenance attaches only to `knowledge/<category>/<sha256>`
   keys; chunks with other keys get no served-file link. Live probe
   results (chunk `key` values) decide whether that gap matters —
   probe-gated, same as S3.
5. **Whether `searchPlatformKnowledge`'s category values match a hub
   category filter's options**: the catalog's category set was not
   enumerated here. What would answer it: read
   `src/services/platformKnowledge.ts` at build time and derive the
   filter options from it (never hardcode a second list).
6. **Preset visibility decision**: whether `traderFocus`/`minimal`
   presets should include `search` — a product decision, not a code
   fact. Default (additive): they do not; the hub shows in `all`.
