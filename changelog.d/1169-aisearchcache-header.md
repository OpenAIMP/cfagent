### Fixed

- Corrected the `aiSearchCache` module header, which named a nonexistent `src/agents/search.ts` reader: the cache's reader is `src/agents/mas.ts` `searchKnowledge`, invoked by the SearchHub MAS Search tab via `POST /search/mas` (#1169 S4-2). Pinned by a source assertion in `tests/ai-search-cache.test.ts`.
