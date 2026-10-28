# AI search agent activation survey — #1169 S3/S4

Read-only survey, local only. No branches, no writes, no live service touched.
Base: OpenAIMP/cfagent main `ac29afbac69094247d3c331200212db59f170456` (2026-10-28).
Method: `git show <sha>:<path>` and `git grep -n <pattern> <sha> -- 'src/*'`.

Rule followed throughout: a claim is code-verified only if a file:line above
shows it. Anything about the live Cloudflare AI Search instance's configured
sources, its provisioned state, or bucket contents is dashboard/live evidence,
not code evidence, and is marked as such.

## 0. Disambiguation: what "aisearchagent" names in this repo

There is no single thing called `aisearchagent`. The name collides with four
distinct things, and every answer below says which one it means:

1. The Worker itself: `wrangler.jsonc` `"name": "ai-search-agent"`.
2. The search service: `ETradeAISearchService` in `src/services/aiSearch.ts:226`.
3. The MAS tool: `searchKnowledge` in `src/agents/mas.ts:26` (defined, see §3).
4. The DO binding with no class: `wrangler.jsonc` binds `SEARCH_AGENT` to
   class `SearchAgent`, but no `SearchAgent` class exists anywhere in the
   repo at this SHA (whole-tree grep for `class SearchAgent` returns
   nothing). The binding cannot be verified from code to do anything.

The user-visible "search agent" behavior is (2) + (3) + the MCP tools in §3,
all reaching one Cloudflare AI Search instance over HTTPS (see §8 for the
Vectorize distinction).

## 1. What the agent is in code

- `ETradeAISearchService` — `src/services/aiSearch.ts:226`, method
  `searchFinancialDocs(query, limit=5)` at `:232`. It POSTs to the instance:
  > `const resp = await fetch(this.env.AI_SEARCH_ENDPOINT, { method: "POST", ... body: JSON.stringify({ messages: [{ role: "user", content: cleanQuery }], ai_search_options: { retrieval: { max_num_results: Math.min(limit, 10) } } }) })` (`aiSearch.ts:237-251`)
  On `resp.ok` + `json.success` + `json.result?.chunks` it returns
  `mapAiSearchChunks(chunks, flagOn)` with `provider: "cloudflare_ai_search"`.
  On ANY other outcome (no endpoint var, non-ok, no chunks, exception)
  it falls through to the hardcoded matcher — except a flag-ON mapping
  error (`AiSearchMappingError`), which is rethrown past the fallback
  (`aiSearch.ts:274-291`).
- The hardcoded fallback — `FINANCIAL_KNOWLEDGE_BASE`, `aiSearch.ts:182`,
  five entries (NVIDIA 10-K, E*TRADE order types, FINRA 4210, OCC ODD,
  Apple 10-Q) with fixed scores 0.95/0.92/0.89/0.88/0.85 and
  `provider: "semantic_cache"`. Zero-term-match floor `doc.score × 0.4`
  (`aiSearch.ts:298-313`). This is the S3 deletion target. It is still
  present and still the fall-through for every primary-path failure.
- `mapAiSearchChunks` — `aiSearch.ts:120`. Flag-OFF reproduces the pre-S2
  mapping verbatim (defaulted score 0.9, forced category `"sec_filing"`,
  no provenance). Flag-ON preserves the true score/category (absent, never
  defaulted) and stamps `bucketKey`, `servedFileLink`, `indexingState:
  "indexed"` — but ONLY for chunks whose `key` parses as a servable corpus
  key (`knowledge/<category>/<sha256-hex>`), via `servedFileLinkFor`
  (`src/services/knowledgeCorpus.ts:240-260`). The mapping is
  PROBE-DEPENDENT: the assumed chunk shape is documented in
  `tests/r2_knowledge_serving_p1169.test.ts:32-37` ("The real chunk shape
  is UNKNOWN until the owner-dashboard Step 0 probe runs").
- `searchKnowledge` (MAS tool) — `src/agents/mas.ts:26`. Description:
  "Search the organization's knowledge base using Cloudflare AI Search
  RAG." It does TWO things in one call: (a) local lexical
  `searchScheduledReports(sql, query, 5)` over `mas_reports`, then
  (b) POST `${env.AI_SEARCH_ENDPOINT}/search` with a 10 s abort
  (`mas.ts:54-63`). Results combine report chunks first + index chunks,
  sliced to 5. Flag-ON attaches corpus provenance to INDEX chunks only
  via `attachCorpusProvenance` (`mas.ts:95-107`); report chunks are left
  untouched. Upstream failure surfaces local reports honestly, or an
  error when there are none — NO fabricated fallback on this path
  (`mas.ts:64-80`). A 5-minute in-isolate TTL cache
  (`src/services/aiSearchCache.ts`, `AI_SEARCH_CACHE_TTL_MS` 300000 /
  `AI_SEARCH_CACHE_MAX_ENTRIES` 200 in `wrangler.jsonc`) sits in front;
  a flag flip takes effect as entries expire (≤ 5 min, documented limit).
- MCP `ai_search_financial_docs` — `src/mcp/cloudflareAgentCommands.ts:238`,
  description "Perform semantic search across SEC 10-K/10-Q filings,
  broker rules, and options disclosures". It is a thin wrapper:
  `new ETradeAISearchService(context.env)` then `searchFinancialDocs`
  (`:254-256`). Same fallback behavior as §1's service, including the
  silent fall-through to the hardcoded base.
- MCP `knowledge_search` — `src/mcp/commands.ts:421`, description
  "Search the organization's enterprise knowledge base using Cloudflare
  AI Search RAG with Vectorize index retrieval, with automatic fallback
  to platform capabilities and workflows." Mode `search` (legacy
  default) runs `runSearchContract` (`commands.ts:330`): AI endpoint
  attempt → chunks; zero chunks OR a platform-keyword regex match
  (`platform|capability|...|etrade|...|nlq|how\s+to|...|faq`) → the
  platform catalog via `searchPlatformKnowledge` (max 3), mapped to
  chunks with hardcoded `score: 1.0` (`commands.ts:316-323`, comment:
  "score 1.0, legacy verbatim"). Mode `platform` always uses the
  catalog (max 5, optional category). `KNOWLEDGE_MODE` governs these two
  tools ONLY — it does not govern `ai_search_financial_docs`
  (`src/config/cloudflareBrowserMiscModes.ts`, N-aisearch note; also
  `src/config/knowledgeMemoryModes.ts`).
- The instance address — `wrangler.jsonc:144`, vars:
  > `"AI_SEARCH_ENDPOINT": "https://f57a6011-bc38-4d64-856d-69ad4c90042a.search.ai.cloudflare.com"`
  There is NO `AI_SEARCH_INSTANCE` binding anywhere. `vector-memory.ts:9`
  states it: "there is no AI_SEARCH_INSTANCE binding — only the endpoint
  var." (`src/types.ts:61` types the endpoint as a plain string.)

## 2. Reports semantic search tab: full path, and what it actually uses

The tab EXISTS. It uses NEITHER NLQ NOR the search agent. It uses
Vectorize + lexical hybrid — a third, separate system (see §8).

- UI: `src/client/ReportsPanel.tsx`. The panel header (Issue #309, #1057
  consolidation S5) calls it "the single run-history UI"; the list comes
  from `GET /api/runs` (merged `mas_reports` + `mas_opportunity_scans` +
  `mas_discovery_runs` + ScreenerAgent feed), and "semantic search
  remains a canonical-reports feature". The toggle:
  > `const [semanticMode, setSemanticMode] = useState(false);` (`:121`)
  > `// Issue #649: semantic search via Vectorize.` (`:128`)
  > `const res = await fetch(`/api/reports/semantic-search?${params}`);` (`:130`)
  Semantic hits are report ids; the panel then hydrates them via
  `GET /api/reports?limit=100` and keeps only the hit ids (`:131-141`).
  With the toggle OFF, search is a client-side keyword filter over
  `title + summary + runId` on the `/api/runs` rows (`:155-163`).
- Route: `src/agents/routes/reports.ts:806`
  (`GET /reports/semantic-search`, externally `/api/reports/semantic-search`):
  > `const semantic = await semanticSearchReports(env, query, 8);`
  > `const lexical = searchScheduledReports(ctx.ensureTables(), query, 20)...`
  > `const merged = mergeSearchHits(lexical, semantic);`
  > `return Response.json({ hits: merged, semantic: semantic.length > 0, ... })`
  `semanticSearchReports` is `src/services/reportSemanticIndex.ts:114`
  (Vectorize query, filter `kind: "report"`, topK 8); `mergeSearchHits`
  (`:88`) blends lexical presence (rank 0.5) with semantic score.
  `searchScheduledReports` (`src/services/scheduledReports.ts:641`) is
  lexical SQL token search over `LOWER(title) LIKE ? OR LOWER(summary)
  LIKE ? OR LOWER(body) LIKE ?` (tokens > 2 chars, max 8).
- THE WIRING GAP: the route comment at `reports.ts:804-805` states it:
  > "Note: the route context doesn't expose env, so semantic search
  > degrades to lexical-only when the bindings are unavailable."
  The code reads `const env = (ctx as any).env || {};`. The typed
  `ReportsRouteContext` (`reports.ts:27-60`) has NO `env` field, and the
  only caller, `src/agents/orchestrator.ts:2121`, passes no `env`
  either. Therefore via this path `semanticSearchReports({}, ...)`
  returns `[]` (bindings absent guard, `reportSemanticIndex.ts:120`),
  `semantic: false`, and the tab's "Semantic" toggle is lexical-only
  in production TODAY. The semantic half is dead by route-context
  omission, not by flag or by index emptiness. (The route is mounted:
  `orchestrator.ts:2119-2121` delegates to `handleReportsRoutes`.)
- NLQ is not involved anywhere on this path: no NLQ file references
  `searchFinancialDocs`, `ETradeAISearchService`, or `searchKnowledge`
  (grep over `src/agents/nlq/*` and `src/agents/orchestrator/*` returns
  nothing), and no NLQ route is called by the panel or the route.
- The closest existing Reports surfaces, if the toggle is disregarded:
  the Reports panel list itself (`/api/runs` merged run history),
  `GET /api/reports` (canonical list), report detail by `reportId`,
  PDF/XLSX/CSV download links, and the MAS local-reports search
  (`searchScheduledReports` via `mas.ts`) — lexical, not semantic.

## 3. Every surface where the search agent is integrated TODAY, and planned-but-not-wired

WIRED TODAY (code-verified call sites):

1. MCP `ai_search_financial_docs` — `cloudflareAgentCommands.ts:238-257`
   via `ETradeAISearchService`. Live, flag-independent query; flag only
   changes the mapping (see §6). Silent hardcoded fallback on any
   primary failure.
2. MCP `knowledge_search` — `commands.ts:421`, mode `search` default
   via `runSearchContract` (`:330`); platform fallback on zero chunks
   or platform-keyword match; `score: 1.0` platform chunks. Mode
   `platform` always catalog. `query_platform_knowledge` (`:468`)
   mirrors with platform default; both honor `KNOWLEDGE_MODE`.
3. Chat agent tool alias — `src/agents/mcpAdapter.ts:87`:
   > `tools["searchKnowledge"] = tools["knowledge_search"];`
   In chat, the name `searchKnowledge` resolves to the MCP
   `knowledge_search` contract, NOT to the MAS tool below.
   `src/agents/chatPrompt.ts:81` tells the agent both names exist.
4. Reports tab semantic search — Vectorize-based (§2), NOT the AI
   Search agent. Listed here because it is the surface the user asked
   about; it is a different system.
5. Agent memory search — `POST /api/memory/search` (`src/server.ts:908`,
   `VectorMemory.recallForPlan` via `memoryApi.ts` → `MemoryBrowser.tsx`
   #164). Vectorize-based, not the AI Search agent.
6. Serve-leg report reuse — `src/agentic/compositionMemory.ts:207`
   (`resolveStoredReportForServe` via `semanticSearchReports`).
   Vectorize-based, not the AI Search agent.
7. Research-publish indexing — `src/agents/orchestrator/researchPublish.ts:170-175`
   (`indexReport`, best-effort). Vectorize-based write path (see §5).

DEFINED BUT NOT WIRED TODAY:

8. MAS `searchKnowledge` (`src/agents/mas.ts:26`) — `createMAS` is
   imported by `src/agents/orchestrator.ts:56` but NEVER CALLED
   anywhere in `src/` at this SHA (whole-tree grep for `createMAS`
   returns only the definition and the import). The mas_reports-first +
   AI Search behavior, the honest upstream-failure behavior, and the
   flag-gated corpus provenance on this path are therefore unreachable
   until something instantiates it. This is distinct from (3): chat's
   `searchKnowledge` name currently resolves to MCP `knowledge_search`.
9. `SearchAgent` DO (`SEARCH_AGENT` binding) — no class in repo (§0).
   Cannot be verified as a surface at all.
10. `VectorMemory`'s AI-Search leg — the constructor takes an
    `aiSearch` client (`src/memory/vector-memory.ts:40`), but NO method
    in the file reads it, and all five construction sites pass
    `undefined` (`orchestrator.ts:1843`, `chatTurnHelpers.ts:162`,
    `goalChainCommands.ts:241`, `createRetrievalPorts.ts:44`,
    `server.ts:938`). The header's "AI Search HTTP endpoint ... via the
    injected aiSearch client" is aspirational, not wired.

PLANNED BUT NOT WIRED (docs/comments saying so):

- Corpus listing (S4): `knowledgeCorpus.ts` header — "Out of scope for
  S1 (later slices): the serving route (S2), the index (S2), fallback
  removal (S3), consumers + UI (S4), corpus listing (S4 — DO storage
  here has get/put only, no key listing)."
- No index bridge between the R2 corpus and the search tools:
  `knowledgeMemoryModes.ts` (enforcement section) —
  > "the R2 corpus routes (POST /knowledge/corpus, GET /knowledge/file)
  > are a different store from the Vectorize/AI-Search + platform
  > catalog the M01 tools search. Ingesting a corpus doc does NOT make
  > it searchable by these tools, and this slice builds NO index
  > bridge (a new feature, not a unification — stated in the PR, not
  > smuggled in)."
- No REST search route: `knowledgeMemoryModes.ts` — "there is no REST
  search route at all" (grep for `/api/search` in `server.ts` and
  `routes/*.ts` confirms: none).
- S4 consumers + UI: named in the `knowledgeCorpus.ts` header scope
  note and in the #1169 S4 brief (provenance into answers,
  Research-area UI, degraded/indexing states, schedulable sync +
  downloadable export or tracked deferral). None of that UI exists at
  this SHA; the only corpus-serving UI affordance is the served-file
  link (`/api/knowledge/file?key=...`) returned inside flag-ON search
  results, which no UI component consumes yet (grep for
  `knowledge/file` in `src/client/*` returns nothing — verify before
  building; the route exists server-side only).
- The stale `src/agents/search.ts` reference in `aiSearchCache.ts`
  ("both agent search surfaces (src/agents/mas.ts `searchKnowledge`,
  src/agents/search.ts SearchAgent) read through it") — that file does
  not exist at this SHA (confirmed: `git show` fails). Known S4
  residual: fix the header.

## 4. Index state: what the instance indexes

CODE-VERIFIABLE:

- The instance address is a wrangler var (`wrangler.jsonc:144`). The
  instance's configured sources are NOWHERE in code. No file configures
  an AI Search data source, R2 source, or document set. Assessment docs
  describe it only generically ("RAG search over indexed documentation
  and knowledge bases", `docs/architecture/data/assessment/assessment-01.md:122`).
- NO code path writes/indexes anything into the AI Search instance.
  All three `AI_SEARCH_ENDPOINT` call sites in `src/` are POST reads
  (`mas.ts:54`, `mcp/commands.ts:339`, `aiSearch.ts:239` — the last
  posts to the endpoint root, the others to `/search`). There is no
  indexing job, sync, or upload hook targeting the instance.
- The assumed upstream chunk shape (what S2's mapping expects) is
  documented in `tests/r2_knowledge_serving_p1169.test.ts:32-37` and in
  `aiSearch.ts:120` comments: chunks with `item.id`,
  `item.metadata.title/description/category`, `snippet`, `url`, `key`,
  `score`. The test header states the real shape is UNKNOWN until the
  owner-dashboard Step 0 probe runs.
- The R2 corpus (`knowledge/<category>/<sha256>` in the SAME `screener`
  bucket, `knowledgeCorpus.ts` header) is storage, NOT index. Upload
  (POST `/api/knowledge/corpus`, session-gated, hash-idempotent,
  hash-verified reads) does not make a document searchable by any
  search tool (§3, knowledgeMemoryModes boundary). The corpus and the
  instance index are two unrelated systems until someone configures the
  instance (dashboard) or builds a bridge (code, not planned).

DASHBOARD-ONLY (owner-must-confirm, NOT in code):

- Whether the instance at
  `f57a6011-bc38-4d64-856d-69ad4c90042a.search.ai.cloudflare.com` is
  provisioned and serving at all.
- What sources it is configured with: is `knowledge/` an R2 source?
  Is any report family a source? Is it a static document set?
- Whether it currently returns any chunks for any query (only a live
  probe shows this).

## 5. Are bucket reports indexed?

For the CLOUDFLARE AI SEARCH INSTANCE: NONE. Plainly: no code path
submits report blobs (`report:pdf/xlsx/csv` keys; `stocks/`/`options/`/
`goals/` families via `reportBlobStore.ts`), `mas_reports` rows, or
report content to the instance. The instance is read-only from
cfagent's side (three POST `/search` reads, §4). The bucket existing
does not imply indexing, and no inference is drawn from it.

For the VECTORIZE report index (a different system, §8): PARTIALLY,
and only one writer exists:

- `src/services/reportSemanticIndex.ts` (`#337`): `indexReport`
  embeds `title + text` (Workers AI `@cf/baai/bge-base-en-v1.5`,
  truncated to 8000 chars) and upserts `report:<id>` with
  `metadata: { kind: "report", reportId, title, source }` into the
  shared `vector-memory` index (`:43-66`). `semanticSearchReports`
  queries it with filter `kind: "report"` (`:114-140`).
- The ONLY production caller of `indexReport` is research publish:
  `researchPublish.ts:170-175` indexes options-research reports
  (summary + first 5 ideas' `symbol outlook structure: thesis`),
  best-effort, never failing the run.
- Screener, goal-screen, and options-screen canonical report paths do
  NOT call `indexReport` (whole-tree caller grep returns only
  researchPublish + the two read sites). Their reports are therefore
  NOT in the Vectorize semantic index.
- DISAGREEMENT, reported not resolved: `reportSemanticIndex.ts`'s
  header claims "each canonical report is embedded at generation time
  ... every stored report is indexed, not just research ones", while
  the R-6 finding in `src/config/reportGeneratorModes.ts:236` states
  "Research publish, and only research publish, was found indexing at
  generation; no second indexing pipeline was found", and the caller
  list confirms R-6. The header claim is aspirational; the caller list
  is the behavior.
- What IS searchable for every report TODAY (no embedding needed):
  lexical SQL search over `mas_reports` title/summary/body
  (`searchScheduledReports`, `scheduledReports.ts:641`), used by the
  MAS local-first path and by the semantic-search route's lexical side,
  and the Reports tab keyword filter over `/api/runs` rows. That is
  LIKE-matching, not semantic indexing.

## 6. Activation, in order

Prerequisite tags: [code] = in-repo code/config change; [dashboard] =
Cloudflare dashboard / owner action; [login] = user app login;
[probe] = live probe against production.

Step 0 — [dashboard] Confirm the instance exists and what it indexes.
  Read the AI Search instance's configured sources in the Cloudflare
  dashboard. Until this is known, every downstream claim about "indexed"
  is unverified. This is also the Step 0 probe the S2 test header
  requires (real chunk shape).
Step 1 — [login] Seed the corpus (OCC-only per the 2026-10-27 call):
  POST `/api/knowledge/corpus` with the verified OCC bytes, then
  hash-check the returned `contentHash` against the manifest
  (`docs/knowledge-corpus-seed-manifest.json`: OCC `8325c286...`,
  621,097 B; FINRA/E*TRADE deferred, NOT re-pinned; NVIDIA
  `blocked-by-source-bot-gate`, human-browser ingest only). The
  manifest is INTENT, not state: code records no completed upload for
  any entry, and whether any doc is in the bucket is a live-storage
  read (GET `/api/knowledge/file` hash verification), not a code fact.
  Note: seeding stores bytes; it does NOT index them for search (§4).
Step 2 — [dashboard] Configure the instance's sources (if the corpus
  is meant to be searchable) or accept that instance search and corpus
  storage stay separate systems. No code change substitutes for this.
Step 3 — [code] Set `KNOWLEDGE_SERVING_ENABLED` to `1`/`true`/`on` and
  redeploy. The var is deliberately NOT in `wrangler.jsonc`
  (`knowledgeCorpus.ts:207-216`); absence = OFF. Rollback is unsetting
  it (or `0`) + redeploy. This flips ONLY the flag-gated behaviors
  below; it does not provision, index, or seed anything.
Step 4 — [probe] Live probe via BOTH surfaces with ≥1 result carrying
  bucket-key provenance + served-file link, served bytes hash-verified
  against the manifest. Only then is S2's mapping proven (see §7).
Step 5 — [code] Wire the dead surfaces (S4 scope, §7): Reports route
  ctx `env`, MAS instantiation (or a decision to retire `mas.ts`),
  `SearchAgent` binding resolution, `aiSearchCache` header fix.

What each surface does OFF vs ON (flag = KNOWLEDGE_SERVING_ENABLED):

| Surface | Flag OFF (today) | Flag ON |
|---|---|---|
| `ai_search_financial_docs` / `ETradeAISearchService` | Queries instance if endpoint set; lenient mapping (score defaults 0.9, category forced `sec_filing`, no provenance); any primary failure → hardcoded base silently | Same query; true scores/categories (absent, never defaulted) + `bucketKey`/`servedFileLink`/`indexingState` on servable corpus keys; malformed chunks throw `AiSearchMappingError` visibly |
| MAS `searchKnowledge` | (Unreachable — no instantiation, §3.) If wired: mas_reports-first + instance chunks verbatim, no provenance | Same + corpus provenance on index chunks; report chunks untouched; TTL cache shape changes as entries expire (≤ 5 min) |
| MCP `knowledge_search` / `query_platform_knowledge` | Flag-irrelevant: `KNOWLEDGE_MODE` governs, not this flag | Same (flag-irrelevant) |
| GET `/knowledge/file` | Route does not exist (handler returns null, fall-through) | Session gate + hash-verified corpus bytes; 404 on absent/tampered |
| POST `/knowledge/corpus` | Works (not flag-gated) | Same |
| Reports tab semantic toggle | Flag-irrelevant: Vectorize path; semantic half dead via env-less route ctx (§2) | Same (flag-irrelevant) |
| VectorMemory / MemoryBrowser | Flag-irrelevant, live | Same |

What each surface returns when the instance is unconfigured/empty:

- `ETradeAISearchService` / `ai_search_financial_docs`: the hardcoded
  `FINANCIAL_KNOWLEDGE_BASE` with `provider: "semantic_cache"` —
  silently, in production, with invented-looking scores. There is NO
  degraded/honest state on this path today. (This is precisely the S3
  problem.)
- MAS `searchKnowledge` (if wired): local `mas_reports` hits honestly,
  or `{ error }` when upstream fails and no local hits — honest.
- MCP `knowledge_search` (search mode): platform catalog chunks
  (`score: 1.0`) when zero AI chunks or on platform-keyword match; the
  no-throw `{error, query, count:0, chunks:[]}` shape only when the
  catalog also yields nothing. The catalog fallback is disclosed in
  the message ("platform capability documentation guides"), not
  silent — but it is still hardcoded content standing in for index
  results.
- Reports semantic route: `{ hits: <lexical-only>, semantic: false }`
  (bindings absent) — honest about the semantic half being absent.
- GET `/knowledge/file` (flag ON, key absent/tampered): 404, never
  served bytes. (Flag OFF: route absent entirely.)

## 7. S3/S4 scoping impact

S3 (delete the fallback inside `aiSearch.ts`):

- The S3 proof bar does NOT pass on code evidence, and is NOT
  disproven by code either — it remains UNPROVABLE from code alone.
  What code shows: the fallback is present (`aiSearch.ts:182,298`);
  the instance endpoint is configured as a var (`wrangler.jsonc:144`);
  the mapping is probe-dependent (chunk shape unknown until the Step 0
  probe); the corpus has no code-recorded completed seed; the
  instance's sources are dashboard-only (§4). None of the four proof
  elements (live indexed queries via BOTH surfaces; hash-verified
  served bytes; degraded state when unconfigured; absence-pin test)
  can be satisfied by reading code. The probe gate therefore STANDS:
  S3 deletion before the probe would remove the only results the
  `ai_search` path returns when the instance is empty — replacing
  silent stubs with errors/empties is the honest outcome, but it must
  be a deliberate, probe-informed decision, not a code-only deletion.
- S3's §22 position is unchanged: check (i) is file-level only, and
  S3 removes code inside `aiSearch.ts` (no file deletion), so it does
  not trip the gate. The absence-pin test stays (it asserts no
  `FINANCIAL_KNOWLEDGE_BASE` matches in served results). The #1917
  test-rename allowance matters only if S3 renames a test file (titles
  must be preserved) — not expected here.
- One scope note: S3's deletion affects ONLY the `ai_search` path
  (`ETradeAISearchService` + `ai_search_financial_docs`). It does NOT
  affect the MCP `knowledge_search` platform catalog (separate
  hardcoded corpus, decision-gated separately), the MAS honest-failure
  path (no fallback to remove), or the Reports Vectorize path (no
  fallback involved). Do not let S3's diff sprawl into those.

S4 (consumers + UI), concretely:

- WIRE (exists, broken/unreached — fix, don't rebuild):
  (a) Reports route ctx `env` (`reports.ts:806` + `orchestrator.ts:2121`)
      so the semantic half actually runs; without this, the tab's
      Semantic toggle stays lexical-only regardless of flag or index.
  (b) MAS `searchKnowledge` instantiation (or an explicit decision to
      retire `mas.ts` — its import in `orchestrator.ts:56` with no call
      site is either dead code or an unwired surface; S4 must pick
      one, not leave it ambiguous).
  (c) `SearchAgent` DO binding resolution (class missing) or removal
      of the binding; `aiSearchCache` header fix (`search.ts`
      reference).
  (d) Corpus listing (DO storage has get/put only, no key listing —
      per the `knowledgeCorpus.ts` header) if any UI needs to browse
      the corpus.
- INDEX COVERAGE DECISION (not a build, a decision with a build
  attached): screener/goal-screen/options-screen reports are NOT in
  the Vectorize report index (§5). If "reports searchable from the
  Reports tab" means semantically, S4 must either extend `indexReport`
  call sites to the canonical report paths (a new capability per R-6,
  not a dedup) or explicitly defer it and keep lexical-only for those
  families. Research reports are already indexed.
- BUILD (new, not a wiring fix): surfacing AI SEARCH AGENT results
  inside the Reports tab. The tab's semantic search is Vectorize-based;
  the agent's results come from the Cloudflare AI Search instance over
  HTTP. Those are different systems with different result shapes
  (Vectorize hits are report ids hydrated from `/api/reports`; agent
  results are corpus chunks with `bucketKey`/`servedFileLink`). Putting
  agent results in the tab is a new integration (new result rendering,
  provenance display, served-file links), not flipping a switch.
  The same applies to any other surface where agent results are
  "already integrated": they are NOT — the integrated surfaces are
  MCP tools + (unwired) MAS + the served-file link inside flag-ON
  results, which no UI consumes yet.
- Other S4 items from the brief (unchanged by this survey): provenance
  into answers, Research-area UI, degraded/indexing states, schedulable
  sync + downloadable export or tracked deferral. "Schedulable sync"
  needs a scope ruling: sync of WHAT to WHERE — the corpus has no
  index bridge (§3), so a sync slice must first decide whether it
  syncs corpus→instance (dashboard or new bridge) or reports→Vectorize
  (extend `indexReport` call sites). Do not scope it as one vague item.
- Constraint honored: no new store and no second system of record is
  proposed anywhere above. `mas_reports` stays the run record,
  `mas_data_captures` the data record; the Vectorize report index is a
  derived search index (report ids + embeddings), not a record, and
  the R2 corpus is storage for knowledge documents, not reports.

## 8. Vectorize: direct or indirect?

ANSWER: BOTH — split by subsystem. cfagent code uses Vectorize
DIRECTLY in two subsystems, and NOT AT ALL in the AI Search agent
path, where Vectorize appears only INDIRECTLY (inside Cloudflare's
AI Search product, which cfagent reaches over its HTTP API).

(a) Wrangler binding — DIRECT, present:
> `"vectorize": [{ "binding": "VECTOR_MEMORY", "index_name": "vector-memory" }]` (`wrangler.jsonc`, PR #6)
> `VECTOR_MEMORY: any; // Vectorize binding` (`src/types.ts:60`)

(b) Direct Vectorize API usage in `src/` — YES, two subsystems:

1. Report semantic index (`src/services/reportSemanticIndex.ts`):
   - Write: `await env.VECTOR_MEMORY.upsert([{ id: \`report:${input.reportId}\`, values, metadata: { kind: "report", reportId, title, source } }])` (`:50`)
   - Read: `await env.VECTOR_MEMORY.query(values, { topK, filter: { kind: "report" }, returnMetadata: true })` (`:123`)
   - Writer (only production caller): `researchPublish.ts:170-175`
     (options-research reports, best-effort).
   - Readers: Reports semantic-search route (`routes/reports.ts:808-815`);
     serve-leg reuse (`compositionMemory.ts:207-213`,
     `resolveStoredReportForServe`).
2. Agent memory (`src/memory/vector-memory.ts`):
   - Write: `remember` upserts job-outcome vectors (`:47`);
     `rememberPlan` upserts `kind: "plan"` vectors (`:143`).
   - Read: `recallForPlan` (`:67`), `recallPlans` with
     `filter: { kind: "plan" }` (`:171`), `searchDense` generic dense
     search for #1740 hybrid RAG (`:101`).
   - Construction sites (all pass `undefined` as the aiSearch client):
     `orchestrator.ts:1843`, `chatTurnHelpers.ts:162`,
     `goalChainCommands.ts:241`, `createRetrievalPorts.ts:44`
     (`VectorMemorySearchAdapter`), `server.ts:938` (route
     `POST /api/memory/search`, `server.ts:908`, client
     `memoryApi.ts` → `MemoryBrowser.tsx` #164).

(c) Direct embedding generation in code — YES, in exactly the two
    subsystems above, both via Workers AI with the SAME model:
> `const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";`
> (`vector-memory.ts:28`, `reportSemanticIndex.ts:16`)
> `const res = await ai.run(EMBEDDING_MODEL, { text });`
> (`vector-memory.ts:30`, `reportSemanticIndex.ts:20-22` with
> `text.slice(0, 8000)`)
    No `getEmbeddings` helper exists; no other embedding model is
    referenced in `src/`. Embeddings are generated by cfagent code
    (Workers AI `ai.run`), and the resulting vectors are written to
    Vectorize by cfagent code — that is direct use, end to end.

(d) How `aiSearch.ts` calls the AI Search instance — HTTP API ONLY:
> `const resp = await fetch(this.env.AI_SEARCH_ENDPOINT, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ messages: [...], ai_search_options: { retrieval: { max_num_results: ... } } }) });` (`aiSearch.ts:237-251`)
    No Vectorize binding, no `VECTOR_MEMORY` reference, no `ai.run`
    embedding call anywhere in `aiSearch.ts`, `mas.ts`'s search path,
    or `mcp/commands.ts`'s search contract. The `AISearchQueryResponse`
    provider union (`aiSearch.ts:171`) lists `"vectorize"` as a
    possible value, but NO code path returns it (returns are
    `"cloudflare_ai_search"` or `"semantic_cache"`). The file header's
    claim of "Cloudflare AI Search endpoint and Vectorize binding
    integration" (`aiSearch.ts:8`) is NOT implemented in that file:
    the only Vectorize touch is the docstring and the union member.
    Likewise, `vector-memory.ts:9` ("Uses the AI Search HTTP endpoint
    ... via the injected aiSearch client") is aspirational: the
    injected client is never read by any method and is `undefined` at
    every construction site (§3.10).

CONCLUSION on Vectorize: DIRECT for (i) the Reports-tab semantic
search + serve-leg reuse (report vectors in `vector-memory`) and (ii)
agent memory (outcome/plan vectors in the same index). INDIRECT-ONLY
for the AI Search agent: cfagent talks to Cloudflare's AI Search
product over HTTPS, and whatever vector store that product uses
internally is Cloudflare-side and invisible to this codebase. The two
must not be conflated: "the AI Search instance indexes X" and "the
Vectorize index contains Y" are claims about different systems, and
the doc phrasing that merges them (e.g. `knowledge_search`'s
description "using Cloudflare AI Search RAG with Vectorize index
retrieval", `commands.ts:422`; `knowledgeMemoryModes.ts`'s
"Vectorize/AI-Search chunks") describes two mechanisms behind one
tool description, not one mechanism. Concretely: the Reports tab's
semantic search NEVER touches the AI Search instance, and the search
agent NEVER touches the Vectorize binding.

## 9. Residuals: questions code cannot answer

1. Is the AI Search instance provisioned and serving? — Needs:
   dashboard read of the instance
   (`f57a6011-...search.ai.cloudflare.com`) + a live probe POST.
2. What sources is the instance configured with (is `knowledge/` an
   R2 source? any report family? a static set)? — Needs: dashboard
   read of the instance's source configuration. Code is silent.
3. What is the real upstream chunk shape? — Needs: owner-dashboard
   Step 0 probe (the S2 test header requires it before S2's mapping
   counts as proven).
4. Is any corpus document actually in the bucket today (OCC or
   otherwise)? — Needs: live storage read (GET `/api/knowledge/file`
   with a manifest key + hash check, or a DO-storage metadata read).
   The manifest is intent, not state.
5. Does the Reports semantic-search route receive `env` through any
   path other than `orchestrator.ts:2121`? — Code says no (only caller
   found, no `env` in ctx or interface). Needs: live request trace
   to confirm the toggle is lexical-only in production (expected:
   `semantic: false` on every response).
6. Is `createMAS` / MAS `searchKnowledge` invoked dynamically
   (string-built call) anywhere? — Static grep finds no call site;
   a runtime trace would be needed to fully exclude dynamic
   invocation. Treat as unwired unless a trace shows otherwise.
7. Does the `SEARCH_AGENT` DO binding resolve to a framework class
   at runtime? — Needs: runtime/binding inspection; no class exists
   in the repo.
8. Which reports (beyond research-published ones) are in the
   Vectorize `vector-memory` index in production (e.g. from older
   indexers or manual upserts)? — Needs: live Vectorize query
   (filter `kind: "report"`, list ids). Code shows only research
   publish writing today.
9. Are there corpus documents indexed by the instance under keys
   that are NOT `knowledge/<category>/<sha256>` (which would make
   `servedFileLinkFor` return no link for genuine index hits)? —
   Needs: live probe result inspection (chunk `key` values).
10. What does "fully activated" mean for the user — instance search
    over the corpus, over reports, or both, and in which UI? — Needs:
    a user decision. The survey's answer differs per choice (§7):
    corpus search needs dashboard source config (+ possibly a bridge);
    report semantic search needs route-ctx wiring + index-coverage
    work; agent results in the Reports tab need a new integration.
