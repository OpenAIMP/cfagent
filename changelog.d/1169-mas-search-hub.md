### Added

- Search hub gains a seventh tab, MAS Search (#1169 S4-2, revised scope): the MAS `searchKnowledge` tool is kept and given a UI instead of being retired. New route POST `/search/mas` invokes the tool itself and returns its native merged shape (scheduled-report chunks first, then AI Search index chunks, capped at 5), with an honest 500 when the report store is absent rather than instance-only results standing in for the full answer. The tab renders each chunk with a per-chunk source label and the tool's message/source honestly, including the upstream-unavailable local-only message.
