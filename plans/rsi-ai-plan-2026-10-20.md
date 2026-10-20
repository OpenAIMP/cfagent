# cfagent — RSI-AI Plan
### Recursive self-improvement of the AI capabilities, and the user offerings paired to them
Reviewed: 2026-10-20 · Scope: all 43 open issues in OpenAIMP/cfagent, the #232 RSI→ASI epic, the #697 technology tiers, the #571 transformation program, and the capability substrate merged on 2026-10-20 · Plan issue: #752 · Companions: `plans/tech-capability-prioritization-2026-10-20.md` (#697, the platform tiers this runs on) and `plans/rsi-product-plan.md` (#688, the product tiers)

## Method

Every AI/ASI/AGI-related issue was ordered by **recursive leverage in dependency order** — not by importance or visibility. The test for each stage: does finishing it make the next stage's improvements *measurable*, *safe*, or *possible*? A capability that cannot be measured cannot be safely adapted; an adaptation that cannot be remembered cannot compound; a self-modification that cannot be evaluated and rolled back must not ship.

This plan is the AI-capability cut through three existing programs: #232 (Recursive Self-Improvement toward ASI — the vision and phases), #571 (agentic transformation — Phases 4/5 are this plan's P2/P3), and #697 (platform tiers — the substrate ordering). It files the issues those programs named but never created, and sequences the ones that exist.

## Where the loop already stands (shipped, verified on main, 2026-10-20)

The substrate of the loop is built. The system can act, remember, and reflect:

| Capability | Evidence |
|---|---|
| Act — agents on Think, condition-capable | #686 OrchestratorAgent Think cutover (merge f7a0efc); conformance re-scored PASS for both Required roles (#721) |
| Safety envelope | #79 RiskPolicyEngine (closed); hard bounds are non-self-modifiable (#232 constraints) |
| Identity for agent payments | #183 payer/session binding (PR #698, closed); residuals in #700 |
| Remember | #706 learning store (landed); #571 Phase 2/3 durable task ledgers with stale sweeps, heartbeats, retention (merged) |
| Reflect | #705 weekly reflection job (landed) |
| Measure (data) | #340 track record + calibration reporting (landed) |
| Human gate | #653 strategy candidate review (landed) |

What's missing is not more substrate — it's measurement integrity up front, and the connective wiring that closes the loop.

## P0 — Finish measurement integrity

Everything adaptive depends on trusting the numbers. Until calibration is a proven instrument, adaptation is noise-chasing.

| # | Issue | Why here |
|---|---|---|
| 1 | #17 Discovery Phase 3 — calibration reporting, portfolio context, **learned-weighting experiment** | Reporting partially landed 2026-10-20; the experiment is the open core and the template every later adaptation evaluation reuses |
| 2 | #654 Calibration dashboard | The user offering paired to #17 — no capability ships backend-only |
| 3 | #488 Conformance tracker (SOLID/GRASP/GoF, multi-tenancy, SaaS readiness) | The standing scorecard: how the program knows the platform is actually improving |

## P1 — Close the remember → reflect → review loop

The data is already flowing; the loop is open at exactly one joint.

| # | Issue | Why here |
|---|---|---|
| 4 | #16 Discovery data — earnings/dividend event calendar + meaningful eventPolicy | The richest missing signal source for discovery memory |
| 5 | #18 Discovery Phase 2 — event + flow signals, alerts, Strategy Profile biasing | Biasing is the first *consumer* of calibration — the bounded-adaptation prototype |
| 6 | **#753 Wire reflection output into the strategy-review queue** *(filed by this plan)* | Reflection findings become #653 review candidates with #340/#17 evidence attached. The cheapest closed loop available; today reflection dead-ends as insight |
| 7 | #13 / #14 Discovery epic + Phase 1 MVP | Verify-and-close candidates (substantially delivered); closing them makes the backlog reflect reality |

## P2 — Bounded adaptation (= #571 Phase 4 = #232 Phase 2)

Strategies that demonstrably work get more weight; those that don't, less — automatically, inside hard bounds, with every change audited and a kill switch that provably works.

| # | Issue | Why here |
|---|---|---|
| 8 | #158 ScheduledAgent DO — cron + goal-driven orchestration | The trigger substrate adaptation runs on; verify/complete |
| 9 | **#754 P2-4.1 Calibration-driven strategy-weight adjustment within RiskPolicyEngine bounds** *(filed by this plan)* | The actuator for #232 Phase 2; generalizes the #18 pilot |
| 10 | **#755 P2-4.2 Adaptation budgets and audit trail** *(filed by this plan)* | #232's "audit everything" constraint made real; aggregate drift is budgeted, not just per-change bounds |
| 11 | **#756 P2-4.3 Autonomous-adaptation kill switch — verify end-to-end** *(filed by this plan)* | The halt promise, pinned by an entry-point enumeration test so future paths can't skip it |
| — | #651 Autopilot status and controls (user offering) | Ships with this stage: users see and bound what adaptation is doing |

## P3 — Governed self-modification (= #571 Phase 5 = #232 Phase 3)

The system proposes changes to itself; proposals are evaluated in isolation, gated on held-out statistical significance **and** human approval, then promoted in stages with automatic rollback. **Gated: this stage does not start until P2 is producing adaptation data** — before that, there is nothing real to evaluate.

| # | Issue | Why here |
|---|---|---|
| 12 | **#757 P2-5.1 Improvement candidate generation from reflection + learnings** *(filed by this plan)* | Unstructured insight → structured, falsifiable candidates |
| 13 | **#758 P2-5.2 Isolated paper-trading evaluation harness** *(filed by this plan)* | Candidates never touch live state; boundary pinned by tests |
| 14 | **#759 P2-5.3 Promotion gate: held-out significance + human review** *(filed by this plan)* | Two non-bypassable conditions; gate criteria fixed up front, never tuned per candidate |
| 15 | **#760 P2-5.4 Staged promotion with automatic rollback** *(filed by this plan)* | Shadow → partial → full; a regression drill must roll back unaided |
| — | #652 Agent task queue view (user offering) | Visibility into the loop's work, paired to P2/P3 |

## P4 — Meta-improvement (= #232 Phase 4)

A/B testing of the adaptation strategies themselves; the meta-learner improving the learning algorithm. **No issues filed, correctly** — this stage consumes P2/P3 outcome data that does not exist yet, and the #571 mandate keeps the improvement pipeline last and gated. #232's success criterion for this phase ("the improvement rate itself accelerates") is only measurable once P2/P3 have run long enough to have a rate.

## Parallel track — RSI applied to the engineering process itself

The codebase has its own self-improvement loop; it compounds everything above.

| Issue | Note |
|---|---|
| #219 / #231 Self-heal Muse fixer | Duplicates of each other — keep one, close one |
| #745 Regression-assurance codification | The pin rule (gitops §7) and §18 discipline landed 2026-10-20 (#742/#746); the remaining substance is required-checks enforcement — an owner/settings action |
| #623 Branch hygiene | 18 branches need owner decisions; keeps the merge surface the loop depends on trustworthy |
| #700 /mcp/scanner residuals from #183 | Identity follow-through on the scanner surface |

## Hard constraints (from #232, restated because every stage inherits them)

- **Risk bounds are not self-modifiable.** BudgetGuard caps, position limits, drawdown breakers sit outside every adaptation and promotion path in this plan.
- **Audit everything.** Every autonomous change carries before/after + rationale in the P2-4.2 trail (#755).
- **Human kill switch.** Verified, not assumed (#756).
- **No fake data.** All learning derives from real market outcomes (#340 track record).
- **No capability ships backend-only.** Each stage pairs its user offering (dashboard, controls, queue view, review) in the same stage.

## Sequencing in one line

Measure (#17) → remember/reflect/review loop (#16, #18, #753) → bounded adaptation (#754–#756, #158) → governed self-modification (#757–#760) → meta-improvement — with the engineering RSI loop (#219, #745) compounding in parallel throughout.
