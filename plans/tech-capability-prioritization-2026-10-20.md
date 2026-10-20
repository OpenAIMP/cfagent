# cfagent — Technology Issue Prioritization
### A recursive capability stack: each tier makes the next one cheaper, safer, or possible
Reviewed: 2026-10-20 · Scope: all 59 open issues in OpenAIMP/cfagent · Companion to #688 (RSI Product Plan — the product-led tiers; this is the technology-led stack those tiers run on)

## Method

Every open issue was classified as: technology (this plan), customer-experience (already queued — #275 in flight, then #223, #264, #424, #218, #277), UX-enablement (#648's UX track, paired to tiers below), or process/meta. The technology issues are then ordered by **dependency, not importance**: a recursive stack where finishing a tier multiplies the value or cuts the risk of everything above it.

## Tier 0 — Production integrity (do first; days, not weeks)

Nothing compounds on a platform that crashes, leaks quota, or lies about its own health.

| Issue | Why here |
|---|---|
| #402 Error 1101 — Worker threw exception on agent.openaimp.com | The production crash class; parent symptom of the KV problem. |
| #329 Workers KV at 50% of daily free-tier limit | The meter running toward the next 1101. Interim relief + measurement for Tier 1. |
| #672 Profile-derived scheduled discovery builds its E*TRADE client without the owner's identity/environment | A live correctness/trust bug: scheduled runs execute under the wrong identity. One construction site + audit of the branch; sibling paths already show the correct pattern (#447/#461). |
| #677 Token gates have blind spots | Named colors escape the #137 coverage gate; four live sub-AA defects in reports.css; contrast audit + token-drift check run nowhere in CI. This is the integrity of the just-completed token program — cheap now, embarrassing later. |
| #408 Mock the LLM call in nlq.test.ts | Test hermeticity; the same class as the #401/#404 fixes. CI you can't trust makes every other tier slower. |
| #623 Branch hygiene — 83 branches not ancestors of main, 18 with unmerged/unknown work | Repo integrity. Needs owner decisions on the 18; the rest is mechanical. Do alongside, not instead. |

## Tier 1 — Platform substrate: storage & cost architecture

Removes the free-tier ceiling that Tier 0 is bleeding against, and fixes the storage shape every later capability inherits.

1. **#338 R2-vs-DO storage split (design-first)** — the decision gate. #688 already flags it "design awaiting acceptance." Nothing below starts until this is accepted.
2. **#605 PDFs → R2 (phase 3 of #415)** — the biggest KV read consumer after sessions.
3. **#606 Remove KV bindings + namespaces (phase 4 of #415)** — closes the #415 epic (phases 1–2, sessions/tokens → DO-SQLite, are already done — cf. SessionStore #604).
4. **#411 Limit KV/external API traffic** — interim guardrails; only worth doing if #415 slips.
5. **#256 Release discipline (CHANGELOG + tags)** — cheap, and it makes every other tier auditable. (Deploy already tags per #321's ask; #321 is a verify-and-close candidate.)

## Tier 2 — Architectural boundaries (the recursion enabler)

These don't add features; they make every future change local instead of surgical. This is the tier that converts the roadmap from linear to compounding.

1. **#290 Trading boundary** — `src/trading/index.ts` as sole entry, `ET_*` secret namespacing, compliance doc. The accepted precursor to any agent extraction (#291's own text says so).
2. **#686 Think cutover** — OrchestratorAgent rebased onto Think under the stable SearchAgent identity. Steps 1–3 are proven (spike, parity harness, shadow); the cutover is the gate for #232 Phase 1 and for condition-driven (not just clock-driven) agents.
3. **#680 ReportAssetAgent** — single owner for the Generate step. Store/Serve/Deliver are already centralized; Generate is scattered across 6 call sites. Completes #479's one-pipeline architecture.
4. **#488 Conformance tracker** (SOLID/GRASP/GoF, multi-tenancy, SaaS readiness) — the measuring instrument for this tier; run it as the scorecard, not a build.
5. **#678 Server-artifact palette unification** — finishes #137's promise for server-rendered surfaces (email, OAuth page, generated HTML): one shared palette module + pin test.

**#479 (one-pipeline epic)** is substantially delivered per its own acceptance matrix; its remaining cells should be verified and the epic closed rather than carried.

## Tier 3 — Autonomy with a real safety envelope

Only safe to widen autonomy after Tier 2's boundaries exist.

1. **#79 RiskPolicyEngine** — make the autopilot policy envelope real. #688 puts it in Trust Tier 1; PR #674 is referenced there. This is the precondition for every later autonomy expansion, including #232 Phase 3.
2. **#183 Agentic wallet routes use a shared anonymous identity** — x402 callers share `agentic_consumer`; a security-correctness fix that must land before payments breadth grows.
3. **#158 ScheduledAgent goal-driven orchestration** — largely built already (goals DO + dashboard exist); remainder is verification and the cron-trigger wiring. Verify-and-close or small completion.
4. **#648 Backend completion epic** — the capability backlog: #337 Vectorize search, #333/#334 PDF fixes, #435 setup catalog, #271 universe selection + sharded runs, #269 Yahoo history, #78 Goal→Verifier loop, #204 LLM strategy generation, #313/#314 advertised-route honesty, #258 eval harness. Sequence inside the epic *after* Tier 2, so new capabilities land inside the architecture instead of beside it. Its UX counterparts (#649–#656) pair per-capability (see Offerings layer).

## Tier 4 — The intelligence flywheel (where recursion becomes visible)

The loop #688 names: track record → calibration → strategy review → self-improvement. #340 (track record) shipped 2026-10-20; the data now exists.

1. **#16 Discovery data: earnings/dividend calendar + eventPolicy** — the data precondition for event-driven signals.
2. **#18 Discovery Phase 2: event + flow signals, alerts, Strategy Profile biasing** — depends on #16.
3. **#17 Discovery Phase 3: calibration reporting, portfolio context, learned-weighting experiment** — depends on #340 data + #18 signals; produces the calibration data #654 renders.
4. **#232 RSI epic, Phases 2–3** — feedback loops (outcome tracking, nightly analysis, weight auto-adjustment within #79's bounds), then self-modification (propose → paper-trade → adopt). Phase 1 is #686 (Tier 2). Do not start Phase 3 before #79 and #653 (strategy candidate review, the human gate) are real.
5. **#13/#14 Discovery epic + MVP** — substantially delivered by the #126/#533/#534 discovery work; verify-and-close, folding any remainder into #16–#18 above.

## Tier 5 — Scale: one agent per competency, SaaS readiness

1. **#291 One agent per platform competency** — explicitly owner-gated ("do not start without explicit owner sequencing"). Becomes a lift instead of surgery once #290 (boundary) and #686 (Think) land. Sequence per competency: trading, screening, NLQ/query, memory/search, scheduling, notifications/reporting, payments.
2. **#488 multi-tenancy/SaaS track** — the tracker becomes the program.
3. **#571 Agentic architecture transformation (tracking)** — the umbrella these extractions report into.

## The offerings layer (UX counterparts, paired to tiers)

Every technology tier should ship its user-facing surface in the same motion (#648's rule: no capability ships backend-only):

- Tier 1 → nothing user-visible (that's the point), except release notes discipline (#256).
- Tier 3 → #651 Autopilot status & controls (needs #79), #652 Agent task queue view.
- Tier 4 → #654 Calibration dashboard (needs #17 data), #653 Strategy candidate review (the human gate for #232), #649 Semantic search UI (needs #337 Vectorize).
- Breadth (from #648/#688 Tier 4) → #650 Setup catalog browser (needs #435), #655 Universe picker (needs #271), #656 Surface newly implemented routes (needs #313/#314).

## Housekeeping (not on the critical path)

- **#219 and #231 are duplicates** — identical "[Self-heal] Muse fixer" issues. Keep one (the fixer is a genuine force multiplier for Tier 0 grunt work); close the other as duplicate.
- **#430 Lane coordination** — a standing thread, not work. Leave open, exclude from queues.
- **#1–#8 Foundational doctrine** (architecture principles, tests/CI, APIs/MCP, harness & safeguards, logging, SDD, reverse-engineering, product lifecycle) — reference documents, not backlog items. Of these, #4 (agent harness and safeguards) and #5 (logging and error handling) feed Tier 2/3 safety work and should be cited by those PRs.
- **#7 Reverse-engineer and plan** — delivered in effect by the assessment + epics; verify-and-close.
- **#457 Durable schedules inventory** — its questions are answered in its own body, and the management gap it pointed at was closed by #273 + #275. Verify-and-close.
- **#143/#237 Assessment epics** — tracking umbrellas; their open items are the Tier 0–2 work above. Keep as scorecards.
- **#115** (cited in #688 Tier 1) — not in the open list; already closed.

## Recommended next five moves

1. **#672** (hours; a live wrong-identity bug) — in parallel with the running CX queue if a second lane is wanted, else first after it.
2. **#677** (a day; protects the #137 investment and fixes live AA defects).
3. **#338 design acceptance → #605 → #606** (closes the KV era; kills #402/#329's root cause).
4. **#290** (the boundary; unlocks Tier 2/5).
5. **#686** (Think cutover; unlocks #232 and condition-driven autonomy).

The CX queue already in flight (#275 → #223 → #264 → #424 → #218 → #277) covers #688's Trust and Breadth tiers; this stack is what to run next, or in a second lane.
