# Scan appendix (c) — Knowledge + memory unpaired surfaces — parent #1717

## Agent

#CISO-bhdm

Scan head: `23de3ce`. Main doc: `docs/compliance/system-duplicates-scan-1717.md`.
Standing rules: NEVER EITHER/OR ALWAYS CONFIGURABLE; scoped defaults run >
session > user > global env > built-in (public route behavior); never remove an
endpoint; never delete a code path.

## M01 — knowledge_search vs query_platform_knowledge — DIVERGENT (pair to each other; UNPAIRED vs REST)

- `KnowledgeSearchCommand` (`src/mcp/commands.ts:72`): tries `AI_SEARCH_ENDPOINT`
  (10 s abort) → Vectorize/AI-Search chunks; if zero chunks OR the query matches
  the platform-keyword regex, falls back to `searchPlatformKnowledge` (max 3).
  Returns `{query, count, chunks (≤5), answer?, message}`; on error returns
  `{error, query, count:0, chunks:[]}` (no throw after fallback attempt).
- `QueryPlatformKnowledgeCommand` (`src/mcp/commands.ts:170`): always
  `searchPlatformKnowledge` (max 5, optional `category` filter), returns
  `{query, count, results, answer}` — different shape (`results` vs `chunks`,
  no `message`, scores forced 1.0 only in the other command's fallback).
- No REST read route for either: corpus routes are write/serve (see below), not
  search. Unifying them changes ranking (AI-search chunks vs platform docs), the
  3-vs-5 cap, and the error contract — pin all three in both switch modes.
- Checked and NOT counted as a live duplicate capability: `aiSearch.ts` /
  `aiSearchCache.ts` (knowledge search + cache), `knowledgeCorpus.ts` (corpus
  provenance/serving), and `researchBrowse.ts` (flattening stored reports into
  watchlist/rejected entries) are distinct capabilities, not parallel search
  engines. `ai_search_financial_docs` (appendix (n)) overlaps M01 in purpose but
  uses a different search backend/shape — cross-reference, do not double-count.

## M09 — manage_session_memory vs REST /memory — UNIFIED-partial + UNPAIRED write

- REST `GET /memory` / `DELETE /memory` (`src/agents/routes/memoryReset.ts`)
  execute the command via `runRestTool` (list/delete/clear). Presentation deltas:
  GET caps at 100 rows and remaps to `{key, value, updatedAt}`; DELETE adds
  `memory.deleted` / `memory.cleared` audits the command itself does not emit
  (command emits `memory.remembered` only on remember).
- Gap: `remember` has NO REST route. The only write path is MCP
  `manage_session_memory {action:"remember"}` (`commands.ts:910`, upsert by key on
  `mas_memory`, requires non-empty key+value) or the MCP resource read (below).
  REST can list and delete facts it cannot create.
- Adjacent read, different contract: MCP resource `sqlite://memory/facts`
  (`src/mcp/index.ts`) returns ALL facts uncapped, unfiltered; REST GET caps at
  100. Same for audit: resource `sqlite://audit/recent` filters by `sessionId`,
  limit 30, while `get_audit_events` has no session filter (REST adds the filter
  + 1–100 clamp + 5-field projection, appendix (m) M10).
- Slice guidance: adding a REST `remember` route is new-surface work under the
  "no new stores/engines unless proven" rule — the slice must say so in its
  issue first if it adds one, rather than presenting it as a pure unification.
  The switch (if any) covers list/delete/clear presentation, not the existence
  of the write path: under NEVER-EITHER/OR, do not remove the MCP write path
  when adding a REST one.

## Knowledge corpus routes — adjacent, NOT duplicates

- `POST /knowledge/corpus` + `GET /knowledge/file`
  (`src/agents/routes/knowledgeCorpus.ts`): R2-bucket corpus ingest/serve. POST is
  hash-idempotent (200 + `idempotent:true` + original metadata on repeat bytes,
  first title wins; 201 on fresh ingest), 401 without `x-user-login`, 400 on bad
  base64/category/URL. GET is flag-gated (`KNOWLEDGE_SERVING_ENABLED` off → route
  does not exist, falls through), hash-verified, 404 on absent/tampered doc,
  never logs login/key/bytes.
- `knowledge_search` / `query_platform_knowledge` (M01) search Vectorize/AI-Search
  + the in-code platform-knowledge catalog — a different store from the R2 corpus.
  Ingesting a corpus doc does NOT make it searchable by these tools by any path
  verified in this scan. Do not file corpus-vs-search as a "duplicate pair"; the
  gap, if any, is a missing index bridge, which is a new feature, not a
  unification.
