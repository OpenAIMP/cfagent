### Fixed

- Run lock is now atomic (#1993): the #828 check-then-act over async KV let two simultaneous screens on the same instance both pass. The lock moved into the ScreenerAgent's own SQLite with synchronous acquire (same user + universe scope, same 5-minute stale takeover, tokenized holder-only release, same "Screen already running" error). Sharded chains, which bypass `runScreen`, now refuse submission while a monolithic run holds the lock or another chain for the same user + universe is active.
