# What is being built, how it integrates, what it enables, and how the user uses it

**Scope:** epics #1096 (capability layer, complete), #1151 (consolidation, in
execution), #1204 (chain-fetch reliability, in execution), and the adjacent
#1173/#1200 reliability program (owned by #CTO-mbshr).
**Status date:** 2026-10-23. Every claim below is stated as *today* (verified
on `main` and in git history) vs *target* (what #1151 delivers). Where the two
differ, this document says so — that difference is the current problem.

---

## 1. Correction of record: the discovery paths

The user is right about the architecture, and an earlier report from this
agent ("the discovery panel runs a client-local engine") was imprecise.
The verified facts:

- On **2026-10-14/15**, issue #29 made the Discovery view **server-backed**:
  `src/client/options/serverDiscovery.ts` is a thin client of
  `POST /api/trading/options/strategies` → `OptionsAgentPipeline`. The server
  evaluates the live E*TRADE chain against the strategy registry, enforces
  acceptance rules, and ranks deterministically. Commit `54a923d`
  (2026-10-15): *"synchronize 74 strategies with backend catalog and make UI
  a pure display layer."*
- The local engine that remains (`strategyDiscoveryEngine`) is local **by
  design and by scope**: it is the Builder's interactive modeling layer for
  legs the user is actively editing (payoff matrices, greeks, strike edits).
  It does not rank or discover.
- **No #1096 phase touched any of this.** `git log` shows
  `serverDiscovery.ts` and `strategyDiscoveryEngine.ts` unchanged since
  before 2026-10-22. This agent did not rebuild a client engine.

The actual duplication — the one that matters — is **server vs server**:

| Discovery path | Built by | What it does | Who consumes it today |
|---|---|---|---|
| `OptionsAgentPipeline` (#29) | pre-existing | ranks catalog strategies for one symbol over the live chain, acceptance rules, deterministic ranking | the options Discovery **panel** (the UX) |
| `researchDiscovery` (#1096 Phase 2) | this program | bidirectional discovery as a `researchPipeline` mode: name→strategies **including composed structures** (condor+butterfly etc.), strategy→names across a universe, research gates/economics/falsification governance | **NLQ chat only** — the panel never calls it |

So the UX's discovery and the #1096 discovery are two different backends
answering overlapping questions. Converging them — one server discovery
path behind the panel, with an explicit decision on which engine survives
and how composition/reverse-discovery fold in — is an open decision that
belongs to #1151 (slices C2/C4). It has **not** been made yet, and this
document does not pretend otherwise.

The same pattern repeats across the program (see §4): #958 had already
unified the legacy surfaces (ScreenersHub, Runs API, one schedule store);
#1096 unified the provider/data layer and added services; the two
unifications were never merged into each other. #1151 exists to merge them.

---

## 2. What is actually being built

Three workstreams, in dependency order:

### 2.1 Capability layer — epic #1096 (DONE, closed 2026-10-23)

A governed, self-improving screening capability layer, built by reusing the
existing research stack (research agent #319, researchPipeline, providers,
gates, economics, falsification, track record, eval datasets, task ledger)
rather than a parallel system:

| Component | What it is |
|---|---|
| Unified screening provider + goal/scenario/outcome stores | one provider interface over E*TRADE/Yahoo/options screeners; `mas_goals` / `mas_scenarios` / `mas_outcomes` persistence |
| Goal/scenario engine | a 9-goal taxonomy; scenario grids priced **only** by the existing economics core; auto-discovery that persists candidate goals as *proposed-only* |
| Strategy composition algebra | leg-graph model over the catalog; overlay / combine / transform / repair / roll operators; defined-risk by default; composes structures the catalog doesn't contain (e.g. condor + butterfly) |
| Bidirectional discovery | name→strategies and strategy→names, as a researchPipeline mode (see §1 for its reach problem) |
| Goal-driven screens + backtest-on-screen | screens driven by goals/scenarios instead of fixed parameters; walk-forward, portfolio-level, options-aware backtest of a screen before trusting it |
| Strategy-bank re-selection | nightly, on the existing */30 tick, proposals recorded as `proposal_only_not_promoted` — nothing self-activates |
| Recommendation bundles | **every** recommendation = trade + falsification (none ⇒ Unqualified, confidence capped LOW) + post-trade Greeks + CVaR-penalized optimizer verdict + hedge/repair plans + ranked alternatives **including an explicit no-trade** |
| Outcome tracking | append-only ledger to expiry; missing data recorded as **Unverified**, never fabricated |
| Weights v2 + champion/challenger gate | regime-conditioned, after-cost strategy weights; promotion requires frozen-set out-of-sample evaluation **plus** a distinct human approver; reversible; kill switch |
| Channel parity + governance surfaces | bundle/discovery delivery over Slack, email, HMAC-signed webhooks (draft-only); screening activity log; fail-closed pause control; runbook; rollout staged **internal** with flags default off |

### 2.2 Consolidation — epic #1151 (IN EXECUTION)

One holistic screening system: one execution path, one hub, one scheduling
capability, one generate/store/serve/deliver pipeline.

- **C1 — converge execution path** (in flight): give the #1096 stack real
  production callers through the existing hub / Runs API / scheduled
  callbacks; backtest gets its first production entry point; the two
  hand-mirrored provider registries become one source of truth.
- **C2 — one nav entry / one hub**: collapse five screening-adjacent nav
  entries and parallel sub-surfaces into the single hub; this is where the
  discovery inbox and decision surfaces live; includes the §1 discovery
  convergence decision.
- **C3 — one scheduling capability**: screens schedulable in exactly one
  place, over the existing tick/cron substrate.
- **C4 — one generate/store/serve pipeline**: one report path from run →
  artifact → served/downloadable in the UX → delivered (today: four report
  generators, plural run stores, three delivery wirings).
- **C5 — bundles through the pipeline**: the bundle becomes *the*
  recommendation format everywhere; candidates flow from screen/discovery
  results into bundles — no hand-pasted JSON (the current PortfolioRiskPanel
  paste box is the interim state a narrow fix is making honest while C5 is
  pending).

### 2.3 Reliability — the unblocker

Nothing above produces value while the data feed fails:

- **#1204** (this agent, in flight): options chain-fetch fans out unbounded
  (1 expiry call + up to 100 chain calls per symbol, doublable on fallback →
  ~1,000+ subrequests per 100-symbol run vs the Workers cap; the run dies
  100/100). Fix: bound the fan-out, defer honestly, publish qualified
  partials. Stock-side fan-out was fixed long ago (#495/#497, #806); the
  options path never was.
- **#1173 / #1200** (#CTO-mbshr): session lifecycle (S1 preflight
  renew+verify + deduped reconnect alert already merged via PR #1177;
  #1200 = the no-stored-session preflight gap, building), delivery
  observability, PDF resilience + regenerate, the final-mile report/email
  gap (completed runs with no downloadable report and no email — incl. a
  delivery hold with no "waiting" signal in the UX).

---

## 3. How it integrates into the existing system

Nothing in #1096 is a new island by design; the integration points are the
pre-existing systems:

| Existing system | Integration |
|---|---|
| Research agent (#319) + researchPipeline | hosts discovery runs and the discovery mode; scheduled tick invokes discovery; goals/scenarios priced by researchEconomics only |
| Strategy catalog + strategy engine | composition algebra operates over the catalog; candidates are strategy-engine JSON end-to-end |
| E*TRADE services (quotes, chains, portfolio) | unified provider wraps the existing adapters unchanged; bundles compute against the live book via the #34 portfolio-risk path |
| Scheduled tasks + worker ticks (0 3, */30, 0 4) | re-selection, weights jobs, discovery ride the existing */30 tick — no new cron was added |
| `mas_reports` (#308) | the canonical report store; bundle formatter targets this seam |
| ScreenersHub + Runs API (#958) | the intended single surface; C1 routes hub/Runs/scheduled execution through the unified path |
| PortfolioRiskPanel (#63) | hosts the bundle section (Best Trade v2) against `POST /api/etrade/portfolio-risk/bundle` |
| Slack / email / signed webhooks | channel parity for bundles and discovery output, draft-only, per-channel failure isolation |
| NLQ layer | `options_fit_discovery` phrases reach the server discovery from chat |
| Screening activity + controls API | one feed for discovery runs, re-selection, promotions, deliveries; fail-closed pause |

**Integration debt that remains (the reason #1151 exists):** the panel's
discovery still runs on the #29 pipeline, not the research discovery; the
goal-driven screen's only production consumer is the delivery service;
outcome tracking's only consumer is the weights service; promotion
approve/decide endpoints have no client caller; backtest had zero callers
until C1. §4 makes this per-service and explicit.

---

## 4. Who consumes each capability — today vs target

| Capability | Consumer today (verified on main) | Consumer after #1151 |
|---|---|---|
| Goal/scenario discovery | delivery service only (Slack/email/webhook out); proposed goals rendered nowhere | review/approve **inbox in the one hub** (C2) |
| Strategy composition | NLQ chat path only; panel uses the #29 pipeline (see §1) | the hub's discovery surface, one server path (C2/C4) |
| Goal-driven screens | delivery service; scheduled callbacks being wired by C1 | hub + Runs API + schedules (C1/C3) |
| Backtest-on-screen | **nobody** (zero importers on main) | hub entry point (C1) |
| Recommendation bundles | PortfolioRiskPanel section (paste-a-candidate interim) + channel delivery | the single decision card in web/Slack/email, fed by results (C5) |
| Outcome tracking | the weights-v2 service only; visible to no one | track-record view in the hub (C2/C5) |
| Champion/challenger | read-only log lines in the activity panel; approve/decide endpoints uncalled by any client | approval actions in the hub with the frozen-set verdict beside the decision (C2) |
| Weights v2 | fit-discovery ranking behind a flag (off at internal rollout) | same consumer, enabled by rollout advancement after evidence (runbook) |
| Activity log + pause | ScreeningActivityPanel (live) | unchanged — already the target shape |

---

## 5. Competencies and capabilities this enables

For the **system**:

1. **Goal-directed screening** — screens specified by intent and scenario,
   not fixed parameter sets; the system can propose goals itself, as
   proposals a human approves.
2. **Bidirectional fit** — answer both "what strategies fit this name?"
   and "which names fit this strategy?", including structures composed on
   the fly that exist in no catalog.
3. **Decision-grade recommendations** — no bare tickers: every output
   carries its falsification criteria, its effect on the actual portfolio,
   a hedge/repair plan, and no-trade as a first-class outcome.
4. **A governed learning loop** — outcomes tracked to expiry, weights
   adapted on after-cost risk-adjusted evidence, promotions gated by
   frozen out-of-sample sets + human approval, everything reversible,
   pausable, and logged.
5. **Honesty under failure** — partial data produces qualified partials;
   missing data is labeled Unverified; a dead broker session produces one
   actionable state, not a fabricated report or an hourly spam of failures.

For the **user**: see §6.

---

## 6. How the user uses it to solve their problems

| Problem | How the user solves it with this | Available |
|---|---|---|
| "I get ticker lists, not trades I can judge." | Open the hub; every recommendation is a bundle card: trade, falsification, post-trade risk, optimizer verdict, hedge/repair, no-trade alternative. Approve-as-draft is the only action — nothing trades itself. | Bundle engine live; card-in-hub is C5; today: panel section + channel delivery |
| "What fits AAPL into earnings if IV crushes?" | Ask in chat (NLQ fit discovery) or in the hub discovery surface; get ranked, gate-checked structures incl. composed ones, without knowing the catalog. | Chat: live. Hub surface: C2 |
| "Is this screen any good before I trust it?" | Run the screen's backtest from the hub: walk-forward, after-cost, limitations labeled. | Service live; hub entry point: C1 |
| "What did the system do last night, and why?" | Screening activity feed: discovery runs, re-selection proposals, promotions, deliveries — one glance; pause it in one click (fail-closed). | **Live today** |
| "Your recommendations — did they actually work?" | Track-record view: every approved recommendation against its own falsification criteria, outcomes to expiry, Unverified where data is missing. | Ledger live; the view is C2/C5 |
| "Let the system improve, but nothing changes without me." | Review queue: proposed goals and strategy promotions arrive with their evaluation evidence; approve / edit / dismiss. A promotion cannot be confirmed without the frozen-set verdict shown next to it. | Gate live as a service; the queue UX is C2 |
| "The overnight screens failed and I heard nothing / got spammed." | Preflight session check before any fan-out; one notification per failure signature, then only on state change — recovery included; delivery state (sent / held / failed + reason) visible on the run itself. | #1173/#1200/#1204 in flight |

---

## 7. Sequencing and what "done" means

1. **Reliability first** (#1204 + #1173/#1200): a dead feed makes every
   surface a failure surface.
2. **C1 → C5 in order**: execution convergence, one hub, one scheduling
   capability, one pipeline, bundles through it; C5 closes #1151.
3. **Rollout advancement last**: flags and channel delivery move beyond
   *internal* only on outcome evidence, manually, per the runbook.

"Done" for this program is not "services merged." It is: a user opens one
hub, runs or schedules a screen in one place, receives a decision-grade
bundle through one pipeline in the app and on their channels, can see what
the system proposed, did, and earned — and can stop it. Measured against
that bar, today the program is: capability layer complete, consolidation
at slice 1 of 5, reliability in flight.

## 9. Channels: which capabilities, delivered what, manual vs automated

A capability only counts as delivered on a channel if a user can receive
*and act on* it there. "Delivered" below means the content actually arrives
on that channel; "act" today is limited to the web app and chat — channels
are **draft-only** (human approval happens in the app; nothing trades from
a message). Status is today-on-main unless marked *target (#1151)*.

| Capability | Web app | Chat / NLQ | Slack | Email | Signed webhook | Voice |
|---|---|---|---|---|---|---|
| Stock / options screens | **Manual:** run from hub/panels. **Automated:** scheduled runs execute; results listed in Runs | **Manual:** NLQ run requests | **Automated:** run notifications + report PDF via agent-to-agent delivery. **Manual:** — | **Automated:** report delivery (currently impaired — see below) | **Automated:** run events | Conversational only |
| Discovery (name↔strategy, composed) | Panel discovery runs on the #29 pipeline (manual) — *not* the research discovery (see §1) | **Manual:** fit-discovery phrases return ranked structures as chat text. **Automated:** research-agent discovery runs on the tick | **Automated:** discovery output via the delivery service | **Automated:** same delivery service | **Automated:** same, HMAC-signed | Conversational only — no voice transport for results |
| Recommendation bundles | **Manual:** Best Trade v2 panel (paste/example candidate → bundle) | **Manual:** bundle content in chat replies | **Manual + automated:** opt-in delivery of bundle text, draft-only footer | Same, with recipient validation | Same, refuses unsigned dispatch | — |
| Reports (PDF/XLSX) | **Manual:** download from run/report surfaces (impaired for scheduled runs — #1209) | — | **Automated:** PDF uploaded (XLSX dropped on this path today — #1209) | **Automated:** intended with attachments; since the #277/#1144 hold, deliveries sit as pending confirmations — only a text "completed" note goes out (#1209) | **Automated:** report events | — |
| Proposals & approvals (goals, promotions) | **Today:** no approval surface — activity log shows promotions read-only; approve/decide endpoints have no client caller. **Target (#1151 C2):** review inbox with approve / edit / dismiss | **Manual:** proposals visible in chat exchanges | **Automated:** proposal notifications via delivery service | Same | Same | — |
| Track record / outcomes | **Today:** only the older research track-record tab (a different store). **Target (C2/C5):** the outcome ledger rendered per recommendation | Same tab | — | — | — | — |
| Activity & control (what ran, pause) | **Live:** activity panel + fail-closed pause toggle | — | **Automated:** failure/recovery alerts (deduped per episode since #1177) | — | **Automated:** screening events | — |

Two channel truths worth stating plainly:

- **Email and report download are currently impaired**, not by this program
  but by the delivery hold + pipeline gaps tracked as **#1209** under
  #1173 (see §2.3). The matrix above describes the *designed* delivery;
  #1209 is where the gap between designed and actual is being closed.
- **No channel can complete a trade.** Every channel is draft-only by
  design (compliance posture); approval-gated execution lives behind the
  trading competency's own approval flow (see §11).

## 10. Stage-layered scheduling over feed → generate → store → serve → deliver

**Owner's question:** can each pipeline stage be scheduled, so the feed is
scheduled, and when it completes the generation is scheduled, then
storage, then serving, then delivery?

**Answer: not today — and it is being enabled**, tracked as **#1236**
under epic #1151. Verified on main (independently re-checked at filing;
this section carries the corrected findings):

- The early stages are **fused inside the run**: `runReportPipeline`
  (`unifiedReportPipeline.ts`, #914) spans **generate → store** in one
  invocation (PDF delegated to the ReportAssetAgent); **serve and deliver
  are not stages of that function** — they are wired by its callers and
  the follow-up chain. You can schedule the *run*; you cannot schedule,
  retry, or inspect any stage separately. (This fusion is also why the
  feed's subrequest budget is shared with everything downstream —
  see #1204.)
- A **multi-hop completion chain does exist** — the #1123 system, over
  the async-job graph (`mas_async_jobs.parent_job_id`): main job
  completes → report sub-job + lifecycle notifications → per-channel
  delivery sub-jobs → "delivered" notifications. But three limits keep
  it from being stage-layered scheduling: the report hop does not
  generate — it *adopts* the artifact the fused run already generated
  and stored; every hop fires **immediately** at parent completion (no
  run-at/delay field exists anywhere in the substrate — a stage cannot
  be given its own timing); and the chain shape is **hard-coded per
  capability**, not composable or user-configurable. The feed,
  generation, and storage stages are not in the chain at all — they
  happen inside the run.
- Scheduled work is **typed jobs** (`scheduledTasks.ts`: market_screen,
  options_analysis, strategy_discovery, token renewal, …) on ticks and
  callbacks, with no dependency fields and no per-stage schedule
  records. A generic step-DAG does exist in `src/orchestrate.ts`
  (LLM-planned steps with `dependsOn`) — but it is in-memory within one
  orchestration invocation: not durable, not scheduled, not connected
  to the pipeline. The research task ledger is a status/heartbeat
  ledger, not a chaining mechanism.
- Adjacent decision, delineated in #1236: **#1224** enables ordered
  stages *inside* one scheduled firing for the social pipeline on the
  ScheduledAgent substrate, explicitly rejecting cross-job chaining
  there — a different substrate and domain, not a duplicate.

**The enablement** (#1236, sub-issue of #1151; implementation home is
C3 one-scheduling-capability + C4 one-pipeline, sequenced after C1 — a
generalization of what exists, not a new scheduler):

1. Each stage — **feed, generate, store, serve, deliver** — becomes a
   schedulable job on the existing scheduled-tasks / async-jobs substrate.
2. A stage's completion schedules the next stage (the #1123 async-job
   chain, generalized from its hard-coded report→deliver→notify shape
   to the full feed→…→deliver chain, and given per-stage timing), with
   the run's identity and artifacts carried stage to stage.
3. Every stage is independently schedulable (its own timing), retryable
   in isolation (a failed delivery never re-runs the feed), and visible
   (stage status in Runs/activity; a held or failed stage says why —
   the #1209 invisibility failure is the anti-pattern).
4. The honesty contract applies per stage: a stage that cannot complete
   fails or holds explicitly; downstream stages never fabricate inputs.
5. The fused pipeline remains as the degenerate case — a single schedule
   that chains all stages immediately — so existing manual/scheduled
   behavior is preserved.

## 11. Alignment with the platform agent card

The platform publishes its agentic capabilities as an A2A agent card
(`agent.openaimp.com/.well-known/agent-card.json`): six agents —
**orchestrator, search, payments, tasks, memory, trading**. This solution
is not a seventh system beside them; it is built *on* that competency
model, and in one case it *is* the competency's substance:

| Agent (card) | Card capabilities / operations | How this solution aligns and leverages it |
|---|---|---|
| **trading** | stock-screening, options-screening, stock-trading, options-trading; `trading.screen_stocks`, `trading.screen_options`, `trading.trade_stock`, `trading.trade_options`; "provider-neutral … across registered broker providers", approval-gated | **This program is the screening competency's engine room.** The unified ScreeningProvider is the provider-neutral layer the card describes (E*TRADE/Yahoo today, registry-extensible); goal-driven screens and discovery are what `screen_stocks` / `screen_options` return when the caller asks better questions. Bundles wrap every screening result in falsification + portfolio risk *before* anything approaches the approval-gated trade operations — the card's approval gate and this program's draft-only posture are the same rule at two layers. |
| **orchestrator** | planning, supervision, parallel-execution; `nlq.execute`, `tasks.create`, `search.query`, `memory.remember` | The NLQ discovery path executes through the orchestrator's NLQ operation; scheduled callbacks and the nightly loop run under its supervision model. Stage-layered scheduling (§10) extends its task creation from single jobs to dependency-chained stage jobs. |
| **tasks** | task-create, task-list, task-update; `tasks.create` | The scheduled-tasks substrate (screen jobs, renewals, follow-up jobs, the research task ledger idiom) is this competency in operation; §10's per-stage schedule records make pipeline stages first-class tasks with listable, updatable state. |
| **memory** | remember, recall; "long-term vector memory for agent outcomes" | Outcome tracking is the outcomes record this competency recalls from: every bundle and screen outcome is written append-only with provenance (run, scenario, weights/eval versions) and honest Unverified states — memory is only as good as the outcomes ledger beneath it, and the ledger never fabricates. |
| **search** | web-search, opportunity-hunt; `search.query` | Bidirectional discovery is opportunity-hunt applied to the tradable universe: the research data fabric (providers, market-data research fallback with provenance labels) is the search competency's sourcing, pointed at names and strategies instead of web pages. |
| **payments** | payment-draft, payment-process, budget-check; `payments.draft` | **Not used by screening** — screening spends no money and drafts no payments. The alignment is the governance pattern, shared deliberately: budget-checked execution. Research/screen runs carry explicit cost caps and budget guards (subrequest budgets, schedule guards) the way payments carry budget checks — no unbounded spend of compute or money anywhere in the loop. |

Net: the screening system strengthens the card's trading competency from
"can screen" to "screens against goals, explains itself, proves its track
record, and improves under governance" — while consuming orchestrator,
tasks, memory, and search as platform services rather than rebuilding
them, and inheriting payments' budget-guard discipline without touching
payments itself.

## 12. Issue index

- #1096 — capability epic (closed/completed). Phases: #1098, #1107, #1114,
  #1122, #1135, #1140, #1162; PRs #1103, #1112, #1120, #1127, #1138, #1142,
  #1193.
- #1151 — consolidation epic (open): C1–C5.
- #1204 — chain-fetch subrequest budget (open, this agent).
- #1173 (+ #1174/PR #1177 merged; #1200 building) — screener trust program
  (#CTO-mbshr): session lifecycle, delivery observability, PDF resilience.
- Plan of record: epic #1096 on GitHub — the screening program's plan of record is maintained with the epic.
