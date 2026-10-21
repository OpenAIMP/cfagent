# cfagent — RSI-InfoSec Plan
### Recursive self-improvement of the information-security capabilities, and the user offerings paired to them
Reviewed: 2026-10-20 · Scope: all 51 open + 293 closed issues in OpenAIMP/cfagent, the #143/#237 Assessment hardening trackers, `docs/Assessment.md` (B+ overall, B security), `SECURITY.md`, `docs/THREAT_MODEL.md`, `docs/COMPLIANCE.md`, and the security substrate merged through 2026-10-20 · Plan issue: #764 · Companions: `docs/plans/rsi-ai-plan-2026-10-20.md` (#752, the AI-capability cut) and `docs/plans/rsi-product-plan.md` (#688, the product tiers)

## Method

Every information-security issue — AppSecOps, DataSecOps, AISecOps, MLSecOps, AgentSecOps, DevSecOps, identity — was ordered by **recursive leverage in dependency order**, not by severity or visibility. The test for each stage: does finishing it make the next stage's security improvements *measurable*, *detectable*, or *possible*? A finding that is not detected cannot be fixed; a fix that is not verified cannot compound; a security loop that does not feed itself new findings is a checklist, not a loop.

This plan is the security cut through three existing programs: #143/#237 (the Assessment hardening backlog — the findings source), #232 (RSI→ASI — whose constraints and Phase 4/5 machinery are AgentSec's subject), and #571 (agentic transformation — Phases 4/5 are this plan's AgentSec track). It files the issues those programs imply but never created (#765–#769), sequences the ones that exist, and names the verify-and-close candidates honestly: several tracked security items are already fixed in code, and the backlog should say so.

The recursion metric, stated up front so every stage can be measured against it: **findings mean-time-to-remediate (MTTR)** and **recurrence rate** per finding class, read from the audit/accounting stores (`mas_events`, /api/audit) — the same stores the fixes themselves write to.

## Where the loop already stands (shipped, verified on main, 2026-10-20)

The substrate is strong — stronger than the open-issue list suggests. The system verifies, binds identity, and scans:

| Capability | Evidence |
|---|---|
| Fail-closed inbound verification | #140 webhook verification fails closed when no secret is configured; #147 Slack routes verify signatures (skip-when-unset removed) |
| Signed action links | #149 /trade/approve performs the HMAC/expiry check its claims advertised |
| Identity, not assertion | #154 session-auth fallback identity removed; #180 MCP caller-asserted `x-user-id` impersonation removed (per-user keys); #181 browser-snapshot routes authenticated; #183 agentic payments bound to the verified payer (PR #698) |
| MCP auth | #160 JWT issuance + scope middleware (`mcp:read`, `mcp:tools:trading`) |
| Outbound safety | #240 SSRF guard on outbound webhook dispatch; #241 rate limiting on NLQ / webhook / memory routes |
| Audit surface | #270 /api/audit endpoints implemented on `mas_events` (the no-fabricated-surfaces fix) |
| Security docs | #276 SECURITY.md + `docs/THREAT_MODEL.md` + DISCLAIMER shipped |
| Trading boundary | #290 `src/trading/index.ts` is the only trading import surface, test-enforced |
| Secret scanning | gitleaks on every PR + GitHub secret scanning; #720's hardcoded wallet fallback literal removed, `signPaymentProof` fails closed (PR #722) |
| Delivery discipline | gitops §18/§19 regression assurance (PRs #747/#749): named-failure classification, bite-proofed pins, fix + coverage, enforcement record |

What's missing is not more substrate — it's audit integrity at one known hole, enforcement that doesn't depend on discipline, detection coverage for the classes review can't see (SAST, dependencies, prompt injection), and the bridge that feeds security findings into the self-heal loop that already fixes everything else.

## P0 — Finish audit & enforcement integrity

Everything downstream trusts two things: the audit trail (it is the evidence every later stage measures from) and the merge gate (it is the only place every change passes). Both have exactly one known hole each.

| # | Issue | Why here |
|---|---|---|
| 1 | #700 residual — scanner `persistAudit` | Points 1 and 3 shipped (#751 session-affinity naming; #763 MPP payer binding). Point 2 is **still broken on main, verified 2026-10-20**: `cloudflareWalletsScanner.ts` constructs `new DatabaseORM(this.ctx.storage as any)` — every other caller passes `ctx.storage.sql` — so the ORM's `sql.exec` is undefined, the write throws, and the surrounding try/catch swallows it. Scanner audit events have silently never persisted. One-line fix + a pin that constructs the ORM the way the scanner does. Until this lands, the audit store has a hole exactly where paid scans happen |
| 2 | #143 / #237 tracker reconciliation | Both trackers mix shipped, superseded, and genuinely-open items (e.g. #237 P0s verified/fixed, #276/#290 delivered). Verify-and-close pass: close what shipped with evidence links, carry only true remainders (branch protection, judge evals, storage lifecycle) as named items. A backlog that overstates open risk mis-prioritizes everything below it |
| 3 | #290 remainder — COMPLIANCE.md open questions | The boundary + secret namespacing are done; the compliance review doc exists with five open questions only the owner can answer. Owner item; listed here so the tracker closes honestly when answered |

**Enforcement (owner, cross-cutting):** required status checks on `main` (gitops §19.4). #695 merged before its CI finished and #712 merged on a red head-CI — discipline held on this lane and demonstrably did not on the other. Branch protection is the one mechanical lever; until it is set, §19.4 records this repo as an open enforcement gap.

## P1 — Close the detection loop (DevSecOps / AppSecOps)

The self-heal loop already fixes what it can see: smoke sections and CI failures file deduped issues, the fixer lane branches, gates, merges, and auto-closes on pass (§19.2). Security findings are invisible to it. This stage gives the loop eyes, then connects them.

| # | Issue | Why here |
|---|---|---|
| 4 | **#765 SAST (CodeQL) + Dependabot configuration** *(filed by this plan)* | Verified gap: no CodeQL workflow, no `.github/dependabot.yml` — SAST-detectable classes and dependency CVEs are found by human review or not at all. Dependabot PRs (#31/#49/#50) arrive ad hoc with no grouping or cadence |
| 5 | **#766 Security findings → self-heal bridge** *(filed by this plan)* | The recursive step. Code-scanning, secret-scanning, and Dependabot security findings auto-file one deduped `[SecOps self-heal]` issue per alert into the existing fixer queue and auto-close on resolution — the same loop shape as smoke/CI, applied to security. Depends on #765 for the code-scanning source |
| 6 | #623 Branch hygiene | 83 branches not on main; 4 carry work needing owner verdicts. A trustworthy merge surface is a security property — stale branches are where stale-base reverts (#115 class) breed. Owner delete verdicts; execution follows |

**Standing posture — Dependabot is reference-only (owner directive, 2026-10-20).** Dependabot alerts and PRs are never merged in either repo; they are a visibility/triage signal only, and a wanted dependency bump is re-implemented as a lane-authored PR under the standard gate. Accordingly, #765's `dependabot.yml` is a *visibility* configuration (it defines what the bot watches and how it batches), and #766's bridge auto-files **code-scanning** alerts only — secret-scanning and Dependabot alerts are reference inputs, not auto-filed fix work.

*User offering paired:* none user-facing — this stage's "offering" is the posture itself, surfaced in P2's per-user audit views and the Assessment grade it moves.

## P1 — AISecOps: the unfiled surface

| # | Issue | Why here |
|---|---|---|
| 7 | **#767 Prompt-injection defense + red-team eval set** *(filed by this plan)* | The largest security surface with no issue at all. Untrusted content (inbound email, webhook payloads, NLQ/chat input, fetched research) reaches prompts whose outputs drive summaries, auto-replies, reports, and tool-adjacent flows — the exact cross-channel expansion the Assessment flagged when it graded security B. Defenses today are incidental (tool boundaries, HITL), not designed, and nothing measures them: a prompt or model change can widen the surface silently |
| 8 | #237 judge golden set + eval metrics (P1 remainder) | The quality-side instrument panel the injection eval set reuses as its harness — precision/recall per intent turns "the judge seems fine" into a pinned number MLSecOps (P3) can gate on |

*User offering paired:* trustworthy automation itself — HITL confirmations users can rely on (#277 pattern: confirmation where money/reports move) only mean something if injected content can't forge the inputs to them.

## P1 — AgentSecOps: governing the self-modifying system

Filed by the #752 RSI-AI plan as its P2/P3; sequenced here as the AgentSec track because every item is a security control on autonomous change. They gate all RSI self-modification — nothing in #232 Phase 2+ is safe to run without them.

| # | Issue | Why here |
|---|---|---|
| 9 | #754 P2-4.1 Bounded adaptation (calibration-driven weight adjustment within RiskPolicyEngine bounds) | The actuator; ships bounded or not at all |
| 10 | #755 P2-4.2 Adaptation budgets + immutable audit trail | #232's "audit everything" constraint as a store: before/after, rationale, per-period budgets, aggregate-drift caps. The AgentSec twin of P0's audit-integrity fix |
| 11 | #756 P2-4.3 Kill switch — verify end-to-end | The halt promise pinned by an entry-point enumeration test, so a future adaptation path cannot silently skip the check |
| 12 | #759 P2-5.3 Promotion gate (held-out significance + human review) | Two non-bypassable conditions; criteria fixed up front. Gated on #758's evaluation harness |
| 13 | #760 P2-5.4 Staged promotion + automatic rollback | Shadow → partial → full, regression drill must roll back unaided. Gated on #759 |

*User offering paired:* #651 autopilot status and controls — the kill switch's UI home; users see and bound what adaptation is doing.

## P2 — DataSecOps

| # | Issue | Why here |
|---|---|---|
| 14 | #415 KV migration → #605 PDFs to R2 → #606 binding/namespace removal | Sessions and E*TRADE tokens move off KV into the per-user SessionStore DO-SQLite (isolation by construction, #604 already removed the dormant fallbacks); PDFs to R2; then the KV bindings come out. Data placement *is* the data-security posture on this platform — and #329's quota incident is what unmanaged placement costs |
| 15 | #338 Report-body storage split (R2 vs DO, design-first) | Report bodies are the largest stored user data; the split decides retention, isolation, and deletion semantics for them |
| 16 | #237 storage lifecycle (`mas_messages` >30d archiving) | Retention is a control, not housekeeping: message history is PII-bearing and currently unbounded |
| 17 | **#768 Secrets inventory + rotation policy** *(filed by this plan)* | Secrets are correctly held (wrangler/GitHub) but uninventoried and never rotated on a policy: no record of what exists, who owns it, or what breaks on rotation. Includes resolving the standing `.agents/mcp_config.json` classification (owner: real → rotate + move; placeholder → scoped allowlist) |

*User offering paired:* per-user data isolation users can be told about truthfully — the SaaS-readiness half of #488 — and the /api/audit read surface (#270, shipped) as the user's window into their own trail.

## P2 — Identity & multi-tenancy conformance

| # | Issue | Why here |
|---|---|---|
| 18 | #488 Conformance tracker (multi-tenancy, SaaS readiness) | The standing scorecard for whether per-user isolation claims stay true as the screener pipeline (#479) grows: per-user DOs, account+environment-scoped execution context, transactional claims — each re-verified, not asserted |

## P3 — MLSecOps: the model/prompt supply chain

**Gated: this stage does not start until the P1 AISec eval substrate exists to gate on** — a gate with no instrument behind it is theater.

| # | Issue | Why here |
|---|---|---|
| 19 | **#769 Model/prompt supply chain: version pins + eval gates** *(filed by this plan)* | Model swaps and prompt edits are self-modifications that land like ordinary code, invisible to unit tests. This makes them pinned, diffable changes that must pass the #237 quality gates + #767 security gates before merge, with results on the PR |

## P4 — Meta-improvement

Measuring the security loop itself: MTTR and recurrence per finding class trended from the audit store; the fixer lane's security-fix success rate; eval-set growth from real incidents (every production security finding becomes a regression case — fix + coverage, §19.2, applied to security). **No issues filed, by design** — this stage consumes P1–P3 outcome data that does not exist yet.

## Parallel track — process security

| Issue | Note |
|---|---|
| #745 (done, PR #749 → `5dfe7878`) | §19 codified detection/response/enforcement; the remaining substance is the owner's branch-protection setting (see P0) |
| #256 / #321 Release discipline | Delivered in substance by PR #660 (per-deploy tag + published Release); verify-and-close candidates in the P0 reconciliation pass |
| #219 / #231 Self-heal fixer duplicates | The fixer lane the P1 bridge feeds; dedupe stands from the #752 plan |

## Hard constraints (inherited, restated because every stage lives under them)

- **Human approval for money, secrets, auth, workflows, new surfaces** (#241 guardrails). The SecOps loop files and fixes; it does not widen its own authority.
- **Audit everything.** Every autonomous change — security fixes included — carries before/after + rationale in the trail (#755's store for adaptations; the issue/PR record for fixes).
- **No fabricated surfaces.** A control that is advertised (docs, UI, this plan) must exist and be verified, or be recorded as an open gap — never silently dropped.
- **Fail closed.** The pattern the substrate already proves (#140, #720): unverified, unconfigured, or ambiguous resolves to refusal, not to a default identity, secret, or permission.
- **Secrets are names, never values**, in every artifact this program produces (issues, inventory, logs).

## Owner decisions embedded

1. **Branch protection / required status checks on main** (gitops §19.4) — the one mechanical enforcement lever.
2. **COMPLIANCE.md's five open questions** (#290 remainder).
3. **`.agents/mcp_config.json` classification** — real keys (rotate + move to secrets) or placeholders (scoped gitleaks allowlist). Routes through #768.
4. **#623 branch delete verdicts** (4 branches carrying work).

## Sequencing in one line

Audit integrity (#700, #143/#237) → detection (CodeQL/Dependabot #765 → bridge #766) + injection surface (#767, #237 evals) + AgentSec gates (#754–#756, #759–#760) → data placement & secrets (#415 family, #768, #488) → gated model/prompt supply chain (#769) → the loop measuring itself.
