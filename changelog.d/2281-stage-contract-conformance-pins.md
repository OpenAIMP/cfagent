### Added
- Stage-contract conformance pins for #1999 Phase 4 (the unbuilt pin half of the folded #2039 claim): `tests/stage_contracts_conformance_p1999.test.ts` pins D5 (chain-bridge retry under the report policy + `followup.schedule_failed` audit on exhaustion, goal and discovery bridges), D8 (goal-path audit rows land in mas_events, telemetry in the #1743 stream, never crossed), and the third D2 fixed site (failure-notify audit insert warns on loss). `tests/stage_contracts_d2_register_1999.json` makes the D2 dispositions machine-readable — derived from the record on #1999 (comment 6478545249) — and a shrink-only source-scan pin ties every `Non-critical` swallow site in `src/` to it.

#CDO-mha7
