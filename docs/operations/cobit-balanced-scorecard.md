# COBIT balanced scorecard

Owner-approved 2026-10-27 (G3 issue #1875, epic #1872, workflow #1893).

Location: `docs/operations/` — the scorecard is an operations report, so its
definition lives with operations docs, not with agent policy.

Source: G3 issue #1875 (perspectives + domain sketch) + governance-v2.md measurement
definitions. Every number traces to a repo source, every perspective names its
consumer and the decision it feeds (no-field-without-a-consumer).

## Perspectives × COBIT domains

### 1. Financial — value for governance effort

- COBIT: EDM02 (benefits delivery), EDM04 (resource optimization), APO (planning).
- Owner lane: human accountable owner (decides); CEO-aimp coordinates.
- Consumer / decision: the owner — is governance effort proportionate to value?
  Feeds phase keep/kill/adjust decisions (the program's kill criteria).
- Metrics (repo-sourced only):

  - Merged count by type label in window — MEASURED TODAY (script: label counts).
  - First-pass gate rate — MEASURED TODAY (script: first-pass classification).
  - CI minutes in window — TO ADD (script does not collect run timings today;
    source: workflow-run timings via API, summed per month).
  - Paid-service costs where known — GAP, not invented: costs live outside the
    repo (e.g. Cloudflare bills). Reported only when recorded; otherwise the
    scorecard states "not recorded" rather than estimating.
  - CFO operating plan tracking — TRACKED 2026-10-30 (issue #2474): cost drivers
    audited from `wrangler.jsonc` and `package.json` — Workers AI / LLM Judge
    calls, 15 Durable Object classes, ticker/quote polling, Workflows + queues
    + 30-minute ScheduledAgent tick, 100% invocation-log sampling, R2 + D1 +
    Vectorize + AI Search, and Browser Rendering. Paid-service costs remain
    GAP / not recorded until actuals are recorded from Cloudflare billing;
    no estimate is recorded here.

### 2. Customer — delivery serving users

- COBIT: DSS (deliver/service/support), EDM05 (stakeholder transparency).
- Owner lane: CPO-dhmp (customer outcomes) + COO-spr9 (operations).
- Consumer / decision: owner + CPO — is merged work reaching users with a
  stated journey? Feeds prioritization of user-facing work.
- Metrics:

  - Merged value: merged count by type label — MEASURED TODAY.
  - User-journey coverage: share of merged PRs/issues in window carrying a
    User journey field — TO ADD (script does not scan bodies today; source:
    PR/issue body text in window, presence of the journey section).

### 3. Internal process — how well the machine runs

- COBIT: BAI (build/acquire/implement — the delivery pipeline), MEA01
  (performance/conformance monitoring).
- Owner lane: CTO-mbshr (pipeline) + COO-spr9 (operations readiness).
- Consumer / decision: owner + CTO/COO — does the pipeline need a change?
  Feeds gate/labeler/pipeline adjustments.
- Metrics:

  - First-pass gate rate — MEASURED TODAY.
  - Follow-up ledger compliance (share of closed issues with a complete §15
    ledger) — MEASURED TODAY (script: parseLedger).
  - Post-merge red rate: share of merges followed by a red post-merge run —
    TO ADD (script does not track post-merge runs today; source: check-runs
    on main per merge commit).
  - Time-to-merge (issue open → merge, median) — TO ADD (source: issue/PR
    timestamps in window).

### 4. Learning & growth — is the system itself improving

- COBIT: MEA (monitor/evaluate/assess), BAI08 (knowledge), EDM01 (governance
  framework).
- Owner lane: CEO-aimp (coordination) + CISO-bhdm (assurance).
- Consumer / decision: owner + CEO — is governance compounding or just
  accumulating? Feeds retrospective actions recorded on the epic.
- Metrics:

  - ADR count in window (new ADRs under docs/architecture/adr/) — TO ADD
    (script does not count ADRs today; source: files added under that path).
  - Template adoption: share of PRs in window using the v2 template shape
    (Agent/Summary/Type/Linked issue/Checklist) — TO ADD (source: PR body
    structure in window).
  - Audit closure rate: G2 backfill count + ledger compliance — PARTIALLY
    MEASURED (ledger compliance today; backfill count is the manual audit,
    reported when done, never estimated).

## Domain ownership summary (per #1875)

- EDM (evaluate/direct/monitor): owner decisions, epic acceptance — owner + CEO.
- APO (plan/organize): architecture + resource planning (G4) — CTO + CDO.
- BAI (build/acquire/implement): delivery pipeline, gitops — CTO.
- DSS (deliver/service/support): ITIL operations (G5) — COO (+ CPO for customer).
- MEA (monitor/evaluate/assess): audits, G2 ledger + this scorecard — CISO + CEO.
- Evidence artifact for every metric: the scorecard comment on #1872 + the
  linked PR/issue/gate run it traces to. A number without a link does not ship.

## What changes to produce this (done in the collector script)

- The workflow YAML does NOT change for the format — it just runs the script. The balanced format comes from the collector script
  (`scripts/metrics/governance-scorecard.mjs`), which outputs the four perspectives above and, with `--html-dir`, versioned HTML history (`scorecard-<date>.html`,
  `scorecard.html`, `index.html`) for GitHub Pages, alongside the #1872 comment. The workflow change that passes `--html-dir` and publishes to the `gh-pages`
  branch follows as an owner web-UI step after #1911 merges.

- Gaps stay visible: Financial costs "not recorded" until recorded; backfill
  count until the manual audit runs; incident metrics (G6) join only once the
  incident/problem/known-error labels exist and carry data.
- Limits (unchanged): metrics don't prove causation — report PR mix alongside;
  numbers are small, so counts always accompany percentages.

## Acceptance (mirrors #1875)

- Mapping + cadence merged and referenced from gitops §5 (separate step).
- First balanced scorecard posted with all four perspectives, sourced numbers
  only, gaps stated not filled.
- All open epics mapped to milestones or explicitly unmapped with reason
  (separate step).
