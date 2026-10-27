# ADR 0019: Daily enrichment + minute bars — Yahoo live, Alpaca flag-gated, manual killswitch

- Status: Accepted
- Date: 2026-10-27
- Deciders: owner (direction 2026-10-27), #CAIO-quns
- Issue: #1888
- Implementing PR: (this slice's PR; main commit, when merged)
- Related: #1742 (telemetry/calibration, governed pattern), #1743
  (observability stream, counts + ids only), #1745 (breakers),
  #1739 (CloudEvents envelopes), #1737 (stage model, Feed/Gather),
  #1815 (feature-flag port), #756 (global halt)

## Context

Daily enrichment + minute bars existed only as groundwork: the
Yahoo and Alpaca provider implementations served bars (including
minute intervals, added by #1654 slice 8 — the corrected issue's
"no minute handling" note predates that work; this slice adds
enrichment-level minute validation and serving on top of the
adapters, not a duplicate mapping), Alpaca snapshots carried a
minute bar, but there was no provider-selectable enrichment system
with reporting or a manual stop. The owner directed 2026-10-27:
implement BOTH Yahoo and Alpaca, enable Yahoo now through the
existing feature-flag capability, and run the system as part of
the repo's recursive-self-improvement (RSI) loop — measure,
report, calibrate — with full dashboard reporting and a manual
killswitch. RSI here is that loop, NOT the Relative Strength Index
indicator; no indicator is built.

Naming (owner direction 2026-10-27): providers are always NAMED
(Yahoo, Alpaca). Nothing this slice builds or names uses a generic
group label for providers — modules, functions, routes, events,
dashboard labels, docs, and PR text. The pre-existing
generically-named surfaces this slice touches (the market-data
research service module, the legacy bars route) are renamed only
where this slice owns them; the full sweep of remaining
generically-named files (~121 files mention the legacy name) is a
recorded follow-up, NOT a blind system-wide find-replace.

## Decision

1. **Provider selection rides the existing flag port.** A new flag
   name, `enrichment_alpaca`, joins the existing `FeatureFlag`
   union — no new flag system. Production wires
   `createFeatureFlagPort(env)`: Cloudflare Flagship (`env.FLAGS`,
   wrangler `flagship` binding, app IROS) when present, else the
   env adapter (`FEATURE_FLAGS` JSON or `FEATURE_ENRICHMENT_ALPACA`),
   else in-memory (tests). Default off (fail-closed) means Yahoo
   is active — Yahoo is "enabled now" by default selection, not by
   a second flag. **Flip path (no code change):** set
   `enrichment_alpaca` on in Flagship, or
   `FEATURE_ENRICHMENT_ALPACA=1` / `FEATURE_FLAGS='{"enrichment_alpaca": true}'`
   in env. Flag on + Alpaca configured selects Alpaca-primary with
   Yahoo fallback (`alpaca-fallback`); flag on + Alpaca
   unconfigured fails safe to Yahoo.
2. **Alpaca fundamentals are Yahoo-covered, never faked.** Alpaca
   exposes no live fundamentals. In every mode, fundamentals come
   from Yahoo by design (recorded per symbol as
   `fundamentalsProvider: "yahoo"`), not counted as a failure
   fallback. The limitation is documented here, in the module, and
   in the §15 — never papered over with synthetic data.
3. **Minute bars are validated per provider before any fetch.**
   Yahoo: 1/2/5/15/30/60/90 minutes (60Min aliases to 1h). Alpaca:
   1–59 minutes. Anything else fails explicit with the supported
   set named — never a silent collapse to daily bars. Only the MIN
   suffix denotes minutes ("15M" stays monthly).
4. **Failure degrades to fallback or qualified partial, via #1745.**
   The providers are already breaker-wrapped; enrichment adds
   per-symbol Yahoo retry on Alpaca failure. A symbol whose
   providers all fail is recorded as unserved with its errors, and
   the run completes partial — the run never throws for provider
   failure. Only validation errors (bad timeframe, empty symbols)
   reject the request.
5. **Runs persist as stage-persisted output.** `mas_enrichment_runs`
   in the orchestrator's storage SQL, one record per job + stage
   (Feed/Gather per #1737), addressable by job + stage. The record
   is coverage + accounting (requested vs served, bars fetched,
   fallbacks, errors, breaker state, killswitch state); bar payloads
   ride the existing stage output, not this table.
6. **Dashboard = existing dashboard + route surface.** DO routes
   `GET /enrichment/status` (provider, mode, coverage, fallbacks,
   errors, breaker state, killswitch state, quality, recent runs),
   `GET /enrichment/runs[/:id]`, `POST /enrichment/run`,
   `POST /enrichment/killswitch`, `GET /enrichment/calibration`
   (externally `/api/enrichment/*` via the generic forwarder), plus
   the `EnrichmentDashboard` panel in the ScreenersHub track-record
   tab, built only from shared UI primitives. Every run emits a
   `enrichment.completed` CloudEvents envelope (counts + ids only)
   to the #1743 observability stream; killswitch changes emit
   `enrichment.killswitch_changed` and are audit-logged.
7. **Quality feeds the telemetry summary.** The status route's
   quality block (per-provider success/failure, coverage, bars,
   fallbacks) is wired into `GET /api/telemetry/summary` as the
   optional `enrichment` field: server.ts best-effort reads the
   session user's DO enrichment status (3s bound, swallowed on
   failure — the field is absent, never a failed summary).
8. **Calibration is propose-only, governed by #1742's pattern.**
   `GET /enrichment/calibration` returns a proposal (or null) when
   a provider's failure rate clears 50% over ≥5 judged runs; it
   never applies anything. Application is a human flag flip by the
   operator. While the loop is stopped, the endpoint refuses with
   409 — no proposals, no applications, from a stopped loop.
9. **Dedicated manual killswitch.** Key `enrichment.killSwitch`
   in the settings table (same table as the global #756
   `adaptation.killSwitch`, a different key). Thrown → no new
   enrichment runs (attempts are recorded as stopped records,
   never fetched) and no calibration proposals/applications.
   Manual on/off only — no auto-reset, and isolate recycle cannot
   clear it because the state is durable in settings, not memory.
   Reads fail closed to halted, mirroring `isAdaptationHalted`.
   State changes are audit-logged and visible on the dashboard.
   **Interaction with the global halt: either switch stops this
   loop.** The global halt stops all governed firing (including
   this loop); the dedicated switch stops only this loop.
10. **Bars route rename (naming rule).** The bars route's canonical
    path is now `/market-data/bars`; the legacy path is retained as
    a backwards-compatible alias serving the same handler and
    response. No other legacy route or module file is renamed in
    this slice — that sweep is a follow-up (see below).

## Consequences

- Yahoo enrichment is live at landing with zero operator action;
  Alpaca needs no code to enable, only the flag — plus keys (see
  owner-side activation).
- The killswitch and the flag are both operable without a deploy.
- No D1 schema change, no new dashboard framework, no new flag
  system, no new metrics store, no trading-path change, no #759
  weights change.
- The single legacy-identifier reference this slice adds is the
  boundary import of the pre-existing provider service in
  `src/agents/routes/enrichment.ts` (required to consume Yahoo and
  Alpaca); every new label, module, route, event, and document in
  this slice is provider-named or provider-neutral.

## Owner-side activation

Alpaca market data needs `ALPACA_API_KEY` (or `ALPACA_API_KEY_ID`)
+ `ALPACA_SECRET_KEY` (or `ALPACA_API_SECRET_KEY`) as Worker
secrets/vars, and `enrichment_alpaca` on in Flagship (or
`FEATURE_ENRICHMENT_ALPACA=1`). Without keys, flag-on fails safe
to Yahoo; nothing is invented or stubbed. This activation is
owner-side and is NOT done by this slice.

## Alternatives considered

- **A second flag system or a per-provider flag pair:** rejected —
  the existing port already spans Flagship/env/memory, and one
  flag (Alpaca on/off, Yahoo as default) covers the flip matrix
  including the fail-safe.
- **Pure-Alpaca mode (no fallback):** rejected — an unconfigured
  or failing Alpaca must degrade, not die; the flag-on shape is
  Alpaca-primary-with-Yahoo-fallback by construction.
- **Storing bar payloads in the run record:** rejected — payloads
  ride stage output; run records stay small accounting rows.
- **In-memory killswitch:** rejected — isolate recycle would
  auto-clear it, violating manual-only semantics.
- **Blind system-wide rename of the legacy name:** rejected by
  owner direction — the full sweep (~121 files) is a separate
  follow-up; this slice renames only what it owns (bars route
  path) and keeps the legacy path as an alias.

## Follow-ups (recorded, owner-sequenced)

- Full legacy-name sweep: rename the market-data research service
  module and remaining legacy routes, updating all import sites —
  its own issue, NOT done here.
- Live-production verification of the telemetry `enrichment`
  field on first real traffic (the wiring is best-effort; the
  field is absent until the first DO status read succeeds).
- Scheduled-screen cutover: wire enrichment runs into scheduled
  Feed/Gather stage jobs (this slice serves on-demand + route
  runs; no scheduler job is added).
