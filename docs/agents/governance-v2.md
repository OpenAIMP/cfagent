# Governance v2 — why it exists, what value it creates, and how agents use it

**Status note:** this document is the map, not the record. Under the
one-document model (`docs/agents/gitops.md` §5), each issue holds its own full
record and its §15 completion report is the single source of truth for that
item. This document summarizes and links; it never replaces an issue, a §15,
or an ADR. If this document and an issue disagree, the issue wins — and this
document gets corrected.

**Program record:** epic OpenAIMP/cfagent#1872 (goal, acceptance, rollout,
rollback). **Policy:** `docs/agents/gitops.md`. **Templates:**
`.github/pull_request_template.md`, `.github/ISSUE_TEMPLATE/`.

## Why this program exists

Issue/PR templates, labels, and governance fields grew piecemeal: one web
issue form, a PR template that was only a pointer, no title or type
conventions, related issues recorded inconsistently, and §15 completion
reports that named follow-ups in prose where nothing tracked them.
Governance frameworks (SAFe, COBIT, ITIL, ISTQB, SQuaRE, EABOK/ABOK,
GoF/SOLID/GRASP) were invoked ad hoc, with no systematic mapping to
issue/PR fields, so reviews could not check them.

Two failures made the cost concrete:

- **Lost work.** Follow-ups buried in §15 prose decayed: #1718 residuals
  (chain-mode delivery, email/webhook legs still sending success on
  below-floor runs), #1785 live proof still owed, #945 smoke tests, DST
  schedule shifts, Flagship flag verification, #1817 close-out. None of
  these were issues; all of them were sentences.
- **Wasted cycles.** PR #1863 burned a whole gate cycle on metadata (blank
  template body, no hashtag, no fragment). A stack was built on the
  assumption #1279 had landed when it had not (#1310). A flag-port
  implementation duplicated a collaborator's work (#1806) because reuse
  was not checkable from the issue.

## Principle: a schema, not documentation

Templates and labels are infrastructure, not paperwork. Their value is
what the structure lets you do afterward: search it, automate over it,
trace through it, measure it. Without consumers, this program is
documentation for its own sake — and must be cut, not defended.

Rules that enforce this (proposed on epic #1872, owner decision pending
where noted):

- **No field without a consumer.** Every template field names who reads it
  and what decision or automation it feeds. Fields with no consumer after
  one quarter are removed.
- **Behavior-change value tests, not merged docs.** Each phase below is
  judged by an observed change (a rate, a count, a time), never by the
  fact that a document merged.
- **Kill criteria.** If a phase fails its value test, it is cut or
  trimmed. The scorecard is the most droppable piece: if no owner
  decision traces to it in a quarter, it goes.
- **Documents don't change behavior; gates, automation, and measured
  outcomes do.** Evidence: gitops §17.4 already said post-merge
  verification matters, yet the 2026-10-22 stale-base incident happened
  anyway.

## Phases: why, value, value test, status

Title conventions (gitops §5): `[Enterprise Architecture] - ` with
`ent-arch` + `architecture`; `[Bug] - ` with `bug`; `[Enhancement] - `
with `enhancement`; `[Fix] - ` with `fix`; `[Hotfix] - ` with `hotfix`
(urgent production fix; emergency rules §18.2 still apply). Title prefix
and type label must match; the `lane:<lane>` label is still required on
top. Conventions are enforced by review, not by Policy Gate code.

| Phase | Why it exists | Value it creates | Value test | Status |
|---|---|---|---|---|
| G1 — templates, labels, titles, traceability (OpenAIMP/cfagent#1873) | No title/type taxonomy; related issues inconsistent; only one web form | Fewer wasted gate cycles; findable work (list all hotfixes, all architecture decisions); PRs self-describe type, relationships, surfaces | First-pass Policy Gate rate on new PRs, measured over 20 PRs | DONE — PR #1878 (templates, §5 conventions) + PR #1882 (acceptance test: new issue + PR under the conventions passed first time). Labels `fix`, `hotfix`, `ent-arch` created by owner via web UI 2026-10-27 |
| G2 — §15 follow-up ledger (OpenAIMP/cfagent#1874) | Remaining work exists only in completion-report prose | Nothing discovered gets lost: every follow-up becomes tracked work or an explicit deferral | Backfill audit count of buried follow-ups; then zero unledgered follow-ups at close | OPEN — rule + backfill audit not yet built |
| G3 — work management + COBIT + scorecard (OpenAIMP/cfagent#1875) | Prioritization, cadence, accountability implicit; no program visibility | Owner visibility without interrogation: where effort goes, what is blocked, gate health | Scorecard published monthly for 3 months; a decision traces to it or it is dropped | OPEN |
| G4 — architecture per EABOK/ABOK + patterns (OpenAIMP/cfagent#1876) | Decisions as prose; no trade-off record; no proactive gap analysis | Design errors caught before they become incidents (the #1819 lesson: an unchecked "no cap" assumption + unmeasured resource use); no duplicated parallel work | Architecture-significant issues carry a trade-off matrix; review catches gaps that change decisions | OPEN — starter architecture section already in `enterprise_architecture.md`; full section is this phase |
| G5 — ITIL per-PR service + ISTQB/SQuaRE quality (OpenAIMP/cfagent#1877) | PRs prove code correctness, not service fitness | Catches "tests pass, service wrong" (the #1718 false-success class: technically successful deliveries with wrong content) | Warranty notes verified post-merge; user-facing wrong-output incidents trend down | OPEN |
| G6 — ITIL incident/problem/known-error (OpenAIMP/cfagent#1883) | No incident/problem distinction, severity, workaround, or known-error record | Faster recovery (next incident starts from a record, not from zero); no repeat firefighting (the screener family #1718/#1785/#1789 is one system failing three ways) | Incidents carry severity + workaround + timeline; time-to-workaround-documented | OPEN — needs templates + labels `incident`, `problem`, `known-error` (owner web-UI step) |

Related, not part of the phases: full-automation proposal
OpenAIMP/cfagent#1869 (standing authorization replaces per-case approval
for routine steps; never-list, exceptions, emergencies, releases, and
lane gates stay human-only). Owner decision pending; nothing adopted
until decided.

## Sequencing by value, not framework order

G1 (done) → G2 (lost work is happening now) → G6 (incidents recur) →
G3 scorecard (visibility) → G4/G5 (review discipline). A phase's
dependencies are in its issue; this order is about value, not about the
order the frameworks were named.

## Measurement: definitions, sources, cadence, limits

**Measured today, automatically:** CI check-runs per commit (green/red +
timestamps), deploy runs on push to main, CodeQL alerts, Policy Gate
pass/fail per PR. Nothing else is measured today; everything else has
been ad-hoc API queries, not a system.

**Going to measure** (monthly agent run, posted on epic #1872 — no
dashboard, no new workflow; a dashboard now would be the theater this
program guards against):

- **First-pass gate rate** (G1): share of PRs whose first head gets all
  required checks green with no branch update and no body fix. Source:
  check-runs per PR head. Failures must be classified as §18.2 requires
  (an aggregator-cancel artifact is not a test failure); never report a
  bare total.
- **Ledger compliance** (G2): backfill count, then share of closed issues
  with a complete ledger, and follow-up closure time. Source: §15 text +
  linked issues.
- **Scorecard** (G3): four perspectives, every number traced to a link —
  gate pass rate, post-merge red rate, merged count, template adoption,
  audit closure rate.
- **Architecture coverage** (G4): share of architecture-significant
  issues carrying a trade-off matrix; review-caught gaps that changed a
  decision.
- **Warranty verification** (G5): share of PRs with warranty notes
  verified post-merge; user-facing wrong-output incidents.
- **Incident discipline** (G6): share of incidents with severity +
  workaround + timeline; time-to-workaround-documented; repeat-incident
  rate (incidents sharing one problem).

**Limits, stated not hidden:** metrics don't prove causation (a falling
gate-failure rate could mean easier PRs, not better templates — report
PR mix alongside); numbers are small (a handful of PRs a month), so
counts always accompany percentages.

## How agents use this system

1. **Start from the templates, not from this document.** The governance
   is encoded in the fields: Type, Related issues (parent epic,
   blocks/blocked-by, related, supersedes), Surfaces (UX/CLI/API/MCP),
   Architecture section, Follow-ups ledger. An agent opening an issue or
   PR is guided by the form; this document is the reference when the
   agent asks why a field exists.
2. **Read the phase issue before starting phase work.** The phase issue
   holds scope, acceptance, and dependencies; this document holds the
   why and the value test. Both are needed; neither replaces the other.
3. **Follow the issue workflow agents already follow** (gitops §5, §9,
   §11): claim with the `## Agent` hashtag, branch, PR as a pointer to
   the issue, green gate on the current merge with main, post-merge
   verification, §15 completion report with the follow-ups ledger
   (G2 rule, once landed) before close.
4. **Review against the value tests, not the document count.** A
   reviewer checks: does the title/label match? Are related issues
   roled? Are surfaces named? Is every follow-up ledgered? Is the
   trade-off matrix present on architecture-significant work?
5. **Find work by labels and titles, not by memory.** `ent-arch`,
   `epic`, `incident`, `problem`, `hotfix`, `fix`, `bug`, `enhancement`,
   `lane:<lane>` plus the title prefixes are the query surface. If a
   category cannot be listed by label, the taxonomy has a gap — file it.

## What this system deliberately does NOT rely on

- **Chat history.** Conversations compact and disappear; anything that
  matters must land in an issue, a §15, an ADR, or this document.
- **Any single agent's memory.** Lanes communicate via shared artifacts
  (GitHub issues/PRs/comments, the Drive Doc, event/webhook activation),
  not direct chat. If only one agent's memory holds it, it is lost.
- **A second record.** This document never duplicates an issue's full
  report or an ADR's reasoning; it links to them. Duplicated records
  drift; links don't.

## Related records

- Epic: OpenAIMP/cfagent#1872 · G1 #1873 · G2 #1874 · G3 #1875 ·
  G4 #1876 · G5 #1877 · G6 #1883 · Automation proposal #1869
- Policy: `docs/agents/gitops.md` (§5 templates/metadata, §9 PR
  requirements, §11 merge policy, §15 completion reports)
- Templates: `.github/pull_request_template.md`,
  `.github/ISSUE_TEMPLATE/` (`task.md`, `bug_report.md`,
  `enterprise_architecture.md`)
- Decisions: `docs/architecture/adr/` (hard-to-reverse and cross-cutting
  decisions; this program's own hard decisions belong there as ADRs when
  adopted)
