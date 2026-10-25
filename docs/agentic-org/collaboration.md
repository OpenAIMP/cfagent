Hashtags are useful for readability, but they are not enough for reliable fleet collaboration. Add **structured** identity, task ownership, explicit handoffs, durable execution state, independent review, and event-driven activation.

Role-prefixed branches are a good convention—for example, `cto/fix/812-recovery-checkpoints`—but branch names do not establish identity, permissions, or ownership.

Below is a collaboration plan designed for your executive agents and their implementation fleets. It preserves your existing rule: finish the current implementation issue, merge it, and verify required CI/CD before starting the next implementation issue.

# GitHub Collaboration Plan for a Governed RSI Agent Fleet

## 1. Mission and operating principles

Use GitHub as the fleet’s shared engineering workspace and decision record.

Use a separate orchestration runtime to receive events, activate agents, claim work, enforce budgets, and maintain durable execution state.

```text
Human-approved objectives
          ↓
GitHub issues, specifications, and dependencies
          ↓
Fleet coordinator and durable task ledger
          ↓
Role-specific agents and bounded workers
          ↓
Branches, tests, pull requests, and reviews
          ↓
Authorized integration and release
          ↓
Observed outcomes and next improvement hypothesis
```

### Core rules

1. Every implementation change has an issue and PR.
2. Every task has one execution owner.
3. Every material decision has an authorized decision-maker.
4. Every handoff names a recipient and expected response.
5. Every candidate is bound to an exact version.
6. Required review remains independent of authorship.
7. Progress is based on evidence, not comment volume.
8. Adaptation stays inside approved authority and resource limits.
9. Improvements cannot weaken their own passing criteria.
10. ASI remains a research aspiration, not a permission to bypass controls.

***

## 2. Agent identity: move beyond hashtags

### Recommended identity model

Use three identifiers:

| Identifier | Purpose | Example |
|---|---|---|
| Executive role | Organizational responsibility | `cto` |
| Agent instance | Specific worker/process | `cto-impl-03` |
| Run ID | Particular execution attempt | `run-20261021-0042` |

Example comment header:

```text
Role: CTO
Agent: cto-impl-03
Run: run-20261021-0042
Task: #812
Action: implementation-handoff
Commit: abc123...
```

Keep hashtags optional:

```text
#agent-cto #handoff
```

### Authentication is separate

Prefer GitHub App identities with narrowly scoped repository permissions and installation credentials. GitHub Apps support repository-specific installation, webhook subscriptions, and granular permissions. Installation tokens cannot grant permissions beyond those granted to the app. [docs.github](https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/about-creating-github-apps)

Options:

- Small fleet: one narrowly scoped collaboration app plus authenticated internal agent identities.
- Stronger separation: separate apps or credentials for implementation, evaluation, and release functions.
- Human approvals: identifiable human accounts with the appropriate authority.

If several agents share one GitHub identity, record that limitation. Different hashtags or role headers do not make their GitHub reviews independently attributable.

Never place access tokens in comments, issue bodies, or task metadata.

***

## 3. Role ownership and collaboration boundaries

| Role | Owns | Typical GitHub contribution |
|---|---|---|
| CEO | Objective alignment and portfolio decisions | Initiative briefs, priorities, decision requests |
| CPO | Customer outcomes and acceptance requirements | Feature specifications, user stories, product acceptance |
| CAIO | AI capability and improvement design | Agent contracts, evaluation proposals, capability experiments |
| CTO | Technical implementation | ADRs, branches, PRs, integration evidence |
| CDO | Data integrity and governance | Data contracts, provenance findings, migration requirements |
| CISO | Security assessment | Threat models, security findings, control reviews |
| COO | Execution and operational readiness | Dependency coordination, recovery evidence, runbooks |
| Independent Evaluation | Candidate assessment | Version-bound evaluation reports and recommendations |
| Authorized human/release owner | Reserved decisions | Risk acceptance, material approvals, promotion decisions |

Executive agents should not all modify the same files independently.

For each implementation issue:

```text
One implementation owner
One accountable executive
Named contributing reviewers
Named independent evaluator
Named approval authority
```

***

## 4. Issue hierarchy and dependency management

Use:

```text
Mission / initiative
  → Epic
    → Feature or improvement candidate
      → Implementation issue
```

Use sub-issues for decomposition and dependency relationships for execution order. GitHub supports parent/sub-issue hierarchies and “blocked by” relationships. They represent different relationships and should not be substituted for one another. [docs.github](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/adding-sub-issues)

### Required issue fields

| Field | Meaning |
|---|---|
| Objective | Approved organizational outcome |
| Owner role | Executive responsible for coordination |
| Execution owner | Agent assigned to perform the work |
| Human owner | Accountable human |
| Work type | Research, specification, implementation, evaluation, release |
| Status | Lifecycle stage |
| Risk | Approved risk classification |
| Candidate ID | Improvement candidate being tested |
| Dependencies | Blocking issues |
| Baseline SHA | Starting code revision |
| Authority | Approval or policy reference |
| Acceptance | Testable completion conditions |
| Budget/deadline | Execution limits |

Use organization issue fields where available and suitable. Use project fields for project-specific information. GitHub distinguishes organization-wide issue fields from project-scoped fields; verify feature availability in your organization before configuring automation around them. [docs.github](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/managing-issue-fields-in-your-organization)

Avoid maintaining several contradictory copies of the same status.

***

## 5. Label taxonomy

Use a small, controlled vocabulary.

```text
role:ceo
role:cpo
role:caio
role:cto
role:cdo
role:ciso
role:coo

type:discovery
type:specification
type:implementation
type:evaluation
type:incident
type:release
type:improvement

risk:low
risk:moderate
risk:high
risk:governance

needs:decision
needs:security-review
needs:data-review
needs:evaluation
needs:human-approval

rsi:hypothesis
rsi:experiment
rsi:observation
```

Use a canonical field for lifecycle status rather than simultaneously managing status labels, project status, and free-text status.

Labels aid routing. They do not grant authorization.

***

## 6. Branch and commit conventions

### Branch format

```text
<role>/<type>/<issue>-<short-description>
```

Examples:

```text
cto/fix/812-recovery-checkpoints
cdo/fix/813-learning-write-integrity
caio/experiment/814-delegation-policy
cpo/docs/815-approval-journey-spec
ciso/test/816-tool-scope-enforcement
coo/docs/817-recovery-runbook
```

Use the implementing role—not every contributing role—in the branch prefix.

### Branch rules

- One issue-scoped implementation branch by default.
- No permanent executive branches such as `cto-main`.
- No direct changes to protected `main`.
- Start from current, healthy `main`.
- Fetch before assessing divergence.
- Rebase an owned, unshared branch or merge according to repository policy.
- Do not rewrite shared history without authorization.
- After synchronization or conflict resolution, rerun affected checks.

### Workspace isolation

Give each implementation worker its own worktree or isolated checkout.

Do not allow multiple agents to run destructive Git commands in the same working directory.

### Commit messages

Use the repository’s chosen convention:

```text
fix(recovery): persist completed tool results (#812)
test(auth): reject delegated scope expansion (#816)
```

Record agent/run attribution in approved metadata or PR records. Do not fabricate authorship or human approval.

***

## 7. Work claiming and concurrency

An issue comment saying “I’m working on this” is not a reliable lock.

### Durable claim record

```yaml
task: 812
owner_role: cto
agent_instance: cto-impl-03
run_id: run-20261021-0042
claim_version: 7
lease_expires_at: policy-defined
baseline_sha: exact-sha
state: implementing
```

The orchestration service should support:

- Atomic claim acquisition.
- Lease renewal.
- Stale-owner detection.
- Monotonic claim versions or equivalent stale-worker protection.
- Reassignment.
- Cancellation.
- Audit records.

GitHub assignees and comments display ownership. The task ledger enforces execution ownership.

### Preserve your sequential policy

Default:

```text
One active implementation issue
→ review
→ authorized merge
→ required post-merge verification
→ next implementation issue
```

Other roles may contribute bounded analysis or review to that active issue. They must not quietly open competing implementation streams.

Parallel implementation requires an explicit exception defining independent scopes, resource limits, reviewers, and integration order.

***

## 8. Structured communication and handoffs

Do not rely on vague mentions such as:

> @agent please review.

Use explicit message types:

```text
PROPOSAL
DECISION_REQUEST
TASK_ASSIGNMENT
BLOCKER
HANDOFF
REVIEW_REQUEST
EVALUATION_RESULT
RELEASE_REQUEST
OUTCOME_REPORT
```

### Handoff template

```markdown
## HANDOFF

From role:
To role:
Task:
Candidate:
Commit/artifact version:

### Completed
...

### Evidence
...

### Requested action
...

### Acceptance condition
...

### Constraints
...

### Respond by
...

### Escalation
...
```

The recipient must acknowledge one of:

```text
Accepted
Needs clarification
Rejected — reason
Blocked — dependency
```

Acknowledgment is not completion.

### Comment discipline

- Post on meaningful state changes.
- Link to evidence rather than copying large logs.
- Update a pinned/index comment when appropriate.
- Avoid repetitive “still working” messages.
- Keep security-sensitive details in the approved private channel.
- Preserve decision history rather than silently rewriting past conclusions.

***

## 9. Event-driven activation

GitHub comments do not wake an idle agent unless a runtime is listening.

### Recommended architecture

```text
GitHub webhook
      ↓
Signature validation
      ↓
Event deduplication and durable queue
      ↓
Authorization and routing policy
      ↓
Task claim
      ↓
Agent activation
      ↓
Results projected back to GitHub
```

GitHub Apps can subscribe to events permitted by their configured access, and webhooks can activate an external integration. [docs.github](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/using-webhooks-with-github-apps)

### Useful event routes

| Event | Proposed reaction |
|---|---|
| Issue becomes ready | Coordinator evaluates eligibility |
| Dependency resolves | Reassess blocked task |
| PR opened or updated | Run checks and route reviews |
| Required check fails | Activate bounded triage |
| Review requests changes | Return work to implementation owner |
| PR merges | Verify post-merge state |
| Approved rollout completes | Begin observation window |
| Incident evidence arrives | Route to authorized incident process |

### Prevent automation loops

Require:

- Event IDs and deduplication.
- Causation/correlation IDs.
- Retry limits.
- Per-task activation limits.
- Handling of out-of-order events.
- No reactivation for an agent’s own no-op updates.
- Scheduled reconciliation for missed events.
- Dead-letter/intervention handling.

A comment or label from an untrusted actor must not directly authorize code execution.

***

## 10. Canonical state and GitHub projection

Use a durable task ledger as the authority for machine execution. Use GitHub as the human-readable work and engineering record.

GitHub is authoritative for facts such as PR commits, reviews, and merge results. The ledger must reconcile against those facts rather than inventing them.

### Suggested lifecycle

```text
Proposed
→ Specifying
→ Ready
→ Claimed
→ Implementing
→ Reviewing
→ Awaiting approval
→ Merge ready
→ Merged
→ Verifying
→ Observing
→ Done
```

Additional states:

```text
Blocked
Rejected
Inconclusive
Cancelled
Rolled back
Outcome unknown
```

Do not mark an issue “Done” merely because GitHub auto-closed it after merge. Post-merge and outcome verification may still be pending.

***

## 11. Pull requests and independent review

### PR requirements

Each PR includes:

- Linked issue.
- Objective and hypothesis.
- Baseline and candidate versions.
- Scope.
- Acceptance criteria.
- Tests actually run.
- Security/data implications.
- Evaluation results.
- Migration and recovery.
- Required reviewers.

### Review by concern

| Change | Review focus |
|---|---|
| Product behavior | CPO/design |
| Agent routing or prompts | CAIO plus Evaluation |
| Data contracts or retention | CDO |
| Identity, tenancy, secrets, permissions | CISO |
| Runtime, architecture, dependencies | CTO |
| Recovery, deployment, runbooks | COO/Operations |

Configure CODEOWNERS using actual GitHub identities or teams—not role hashtags.

Where supported and configured, repository rules can require code-owner approvals, status checks, and merge queues. Agents should not have bypass privileges merely for convenience. [docs.github](https://docs.github.com/enterprise-cloud@latest/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets)

### Version-bound review

Every evaluation report must identify the reviewed commit or artifact digest.

New material changes require renewed checks and review according to policy. A passing report for an earlier candidate cannot authorize a changed candidate.

***

## 12. CI/CD and integration discipline

Required behavior:

1. Run local applicable checks.
2. Run PR checks.
3. Resolve failures.
4. Obtain required independent review.
5. Obtain merge authorization.
6. Merge through the configured strategy.
7. Verify required checks on the merged result.
8. Verify applicable delivery state.
9. Proceed to the next issue only after the gate passes.

If a merge queue is configured, support its temporary integration commits. GitHub Actions workflows need the appropriate `merge_group` trigger for queue checks. [docs.github](https://docs.github.com/enterprise-cloud@latest/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets)

### Stop-the-line rule

When required CI/CD fails:

- Freeze normal feature progression.
- Classify the failure.
- Assign bounded remediation.
- Repair or safely revert.
- Reverify.
- Record the result.

Do not rerun indefinitely, disable a check, or edit assertions merely to obtain green status.

***

## 13. RSI collaboration protocol

Use one candidate record connecting the full cycle:

```text
Observation
→ hypothesis
→ specification
→ implementation issue
→ candidate PR
→ evaluation
→ approval
→ release
→ outcome
→ next hypothesis
```

### Candidate metadata

```yaml
candidate_id: IMP-0042
objective: approved-objective
sponsor_role: caio
implementation_owner: cto
human_owner: designated-owner

baseline:
  commit: exact-sha
  configuration: version-reference
  results: evidence-reference

hypothesis:
  proposed_change: bounded-change
  success_criteria: []
  protected_guardrails: []

evaluation:
  reviewer: independent-reviewer
  candidate_sha: exact-sha
  result: pending

promotion:
  authority: approval-reference
  rollout: procedure-reference
  rollback: procedure-reference

outcome:
  decision: pending
  evidence: []
  next_hypothesis: null
```

### Independence rule

The candidate author must not control all of:

```text
Implementation
Evaluation data
Passing criteria
Risk acceptance
Production approval
```

### Adaptive behavior allowed

Within policy, the fleet may:

- Reassign unstarted work.
- Select an approved alternative tool.
- Split an oversized task before implementation.
- Request clarification.
- Replan dependencies.
- Stop an unproductive experiment.
- Propose a simpler design.

It may not adapt by removing approvals, increasing budgets, expanding data access, or weakening controls.

***

## 14. Autonomy envelopes

Make authorization explicit.

| Envelope | Permitted activity |
|---|---|
| A — Observe | Read approved sources and report |
| B — Propose | Draft plans, specifications, and exact proposed writes |
| C — Sandbox | Run approved isolated experiments |
| D — Implement | Make approved code changes and prepare PRs |
| E — Integrate | Merge only under specified rules and authorization |
| F — Release | Deploy only within an explicitly granted release policy |

These are capability envelopes, not a ladder agents automatically climb.

Tool-level confirmation and organizational approval requirements still apply. This plan does not authorize external writes by itself.

Governance, credentials, workflow privileges, destructive migrations, and consequential business actions require their separately defined controls.

***

## 15. Operational controls

Track:

- Unclaimed ready tasks.
- Stale claims.
- Duplicate work.
- Review age.
- Blocked time.
- Failed checks.
- Merge conflicts.
- Recovery failures.
- Experiment cost.
- Rejected candidates.
- Post-release regressions.

Escalate when:

- Ownership is ambiguous.
- A lease expires during consequential work.
- Approval is missing.
- Candidate/evaluation versions differ.
- Required checks are unhealthy.
- Outcome is unknown.
- Authority or budget is exceeded.

Keep audit trails, but do not expose secrets or unnecessary customer data in GitHub.

***

## 16. Suggested repository layout

Adapt to existing conventions rather than creating duplicate structures.

```text
AGENTS.md

.agents/
  roles/
  schemas/
  routing/
  policies/

.github/
  ISSUE_TEMPLATE/
  PULL_REQUEST_TEMPLATE.md
  CODEOWNERS
  workflows/

docs/
  collaboration/
    operating-model.md
    authority-matrix.md
    handoff-protocol.md
    state-model.md
  architecture/
    adr/

specs/
  improvements/
    IMP-0042/
      hypothesis.md
      spec.md
      evaluation-plan.md
      outcome.md
```

Do not store runtime leases, secrets, or rapidly changing task state in Git commits.

Protect role definitions, routing policies, approval rules, and workflow files through appropriate ownership and review.

***

## 17. Implementation rollout

| Phase | Deliverable | Acceptance |
|---|---|---|
| 1 | Identity, branch, issue, and handoff conventions | Every active task has attributable ownership |
| 2 | Templates, fields, dependencies, review routing | One issue progresses without ambiguous handoffs |
| 3 | App authentication, webhook routing, durable ledger | Events activate only eligible, authorized work |
| 4 | Claims, leases, deduplication, recovery | Duplicate delivery and worker crash do not duplicate execution |
| 5 | CI/review/merge enforcement | No protected change bypasses required gates |
| 6 | Improvement candidate and evaluation pipeline | Bad candidate rejected; passing candidate version-bound |
| 7 | Controlled adaptation | Replanning respects authority, budgets, and stopping conditions |
| 8 | Meta-improvement | Collaboration changes evaluated without weakening their controls |

Start with one repository and one implementation stream. Expand only after demonstrating recovery and coordination.

## 18. First fleet exercise

Use a deliberately bounded mission:

> Improve recovery of one agent workflow after worker interruption.

The exercise passes only if the fleet demonstrates:

1. CPO specifies the user outcome.
2. CAIO defines agent behavior.
3. CDO verifies persisted evidence.
4. CTO owns one implementation branch.
5. CISO reviews authority and tenant boundaries.
6. COO runs recovery drills.
7. Independent Evaluation reports against the exact candidate.
8. Authorized merge and release controls apply.
9. A bad candidate is rejected.
10. The resulting evidence determines the next proposed improvement.

Also inject a duplicate webhook, stale claim, changed commit after review, and failed check. The collaboration system must handle those cases without double execution or bypass.

## 19. Master collaboration instruction

```text
Collaborate through GitHub using explicit identity, structured tasks,
durable ownership, version-bound evidence, and authorized handoffs.

Use role-prefixed, issue-scoped branches:
<role>/<type>/<issue>-<description>.

Hashtags are display aids, not identity or authorization.

Before acting:
- read repository and role instructions;
- resolve the task and authority;
- verify dependencies;
- claim work through the approved coordinator;
- establish the baseline.

Use one implementation owner per issue.
Contribute requirements and reviews without creating competing edits.

Follow:
issue → specification → tests → implementation → PR → review
→ required checks → authorized merge → post-merge verification
→ authorized rollout → outcome observation.

Do not begin the next implementation issue until the current issue
passes the required completion gate, unless an explicit exception
authorizes parallel work.

Use structured handoffs naming recipient, requested action,
candidate version, evidence, and escalation.

Never approve your own material promotion, alter your own passing
criteria, expand privileges, or bypass CI and security controls.

Adapt within approved capabilities, budgets, and policies.
Stop and escalate when authority, ownership, evidence, or outcome
is uncertain.

Close each improvement cycle with an evidence-backed decision and
a justified next hypothesis. Respect all required confirmations
before external actions.
```

The target is not agents posting more comments. It is a fleet where the right agent receives the right work, only one authorized worker owns execution, reviewers assess the exact candidate, and each completed cycle produces trustworthy evidence for the next.
