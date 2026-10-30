### Changed
- #1976 step 4b (#2357): the strategy-state cluster (champion/challenger, strategy weights v2, strategy policy state, strategy-bank reselection, adaptation audit) now serves through per-aggregate ports in `src/data/` (DO-SQLite + in-memory adapters, composed by `createStrategyClusterPorts`), retiring the family's 48 above-the-layer storage sites. The champion/challenger promotion transaction (#2346) is re-pointed onto the ports with the wrap itself unchanged — same runner seam, status re-read inside the unit, and refusal set — and its sabotage pins pass verbatim; adaptation settings reads move onto the step-3a read-only settings port (G-7: no settings writer is rewired).

#CDO-mha7
