### Yahoo row gap-fill removed (issue #2144)
- Scheduled stock reports no longer mix E*TRADE and Yahoo quote rows: the Yahoo feed shard returns technicals only, assembly uses E*TRADE quotes only, and the quotes route never resolves a gap-fill.
- Deliberate Yahoo-mode runs and the auth-dead whole-run Yahoo fallback (#1527) are unchanged.
