Give them outcome-based improvement missions—not a standing instruction to “make the platform better.”

Each mission should specify an observed problem, baseline, hypothesis, permitted changes, evaluation criteria, approval boundary, and stopping condition. The **recursive** part comes when the measured outcome of one improvement determines the next justified task.

GitHub access provides a place to inspect and change the system. It does not, by itself, provide a scheduler, durable coordination, production telemetry, or authority to merge and deploy. Keep those capabilities and permissions explicit.

## 1. The shared mission to give the executive team

Use this as the organization-wide assignment:

> Assess the platform against your role’s charter. Identify evidence-backed constraints on customer value, capability, reliability, security, data integrity, and operational efficiency.
>
> Coordinate through one improvement portfolio. Select one bounded improvement at a time, establish its baseline and protected acceptance criteria, implement it through the approved GitHub workflow, and obtain independent evaluation.
>
> Promote only through authorized review and release controls. Measure the outcome, record unsuccessful hypotheses, and use the result to propose the next cycle.
>
> Do not expand privileges, weaken controls, alter your own passing criteria, or create additional agents merely to appear more sophisticated.

For AI behavior, evaluate the actual model-and-harness combination, not only a prompt or final answer. Anthropic’s evaluation guidance explicitly treats agent performance as the behavior of the model and its supporting harness together. [anthropic](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)

## 2. Role-specific tasks to assign

These are suggested assignments, not claims about current defects in your repository.

| Role | Useful recurring mission | Concrete first task | Required evidence |
|---|---|---|---|
| RSI-CEO | Keep the improvement portfolio aligned with approved objectives | Reconcile executive plans into one dependency-ordered portfolio and select one shared outcome | Named owners, resolved conflicts, baseline, approved decision |
| RSI-CPO | Improve a priority customer outcome | Trace one user journey from goal submission through result review; identify its largest evidence-backed friction | Journey evidence, specification, usability and functional acceptance |
| RSI-CAIO | Improve the platform’s problem-solving capabilities | Benchmark one agent workflow against a simpler deterministic or single-agent alternative | Task success, quality, cost, latency, failure analysis |
| RSI-CTO | Improve technical correctness and change safety | Trace one critical execution path and eliminate a verified implementation or contract failure | Reproducing test, fix, integration results, recovery evidence |
| RSI-CDO | Make learning inputs trustworthy | Trace one outcome from source through persistence, evaluation, and subsequent consumption | Provenance, write/read integrity, consumer verification |
| RSI-CISO | Reduce a material security exposure | Verify that delegated agents cannot exceed user, tenant, tool, or approval scope | Authorized negative tests, control evidence, regression cases |
| RSI-COO | Improve reliable end-to-end execution | Exercise one long-running task through interruption, retry, cancellation, and recovery | Durable states, ownership, deduplication, reconciliation results |
| Independent Evaluation | Determine whether candidates genuinely improve outcomes | Freeze a representative acceptance set and evaluate baseline versus candidate | Versioned cases, results, limitations, independent recommendation |

The executives should own outcomes and coordinate appropriate workers. They should not all independently edit overlapping parts of the codebase.

## 3. Copy-ready tasks for each executive agent

### RSI-CEO: establish one coherent improvement portfolio

```text
MISSION: Establish a governed platform-improvement portfolio.

Read the approved executive charters, product plans, architecture
plans, and repository policies.

Identify:
- conflicting objectives;
- duplicated initiatives;
- contradictory dependencies;
- unsupported completion claims;
- unowned risks;
- missing decision authority.

Produce one prioritized portfolio linking each initiative to:
an approved objective, human owner, executive coordinator,
dependencies, measurable outcome, resource estimate, and approval.

Select one bounded cross-functional improvement for the first cycle.

Do not change organizational purpose, approve material spending,
or start parallel implementation without authorization.
```

This is primarily a coordination task. Its success is an executable decision—not a large planning document.

### RSI-CPO: improve one complete user journey

```text
MISSION: Improve one priority customer workflow.

Select an approved journey, such as:
goal submission → plan review → execution → approval → result.

Inspect its implementation and available authorized evidence.
Separate observed customer problems from assumptions.

Establish a baseline and identify the largest supported constraint.

Write a feature specification with:
- target users;
- intended outcome;
- primary and failure journeys;
- accessibility requirements;
- autonomy and approval behavior;
- acceptance criteria;
- measurement and rollback plan.

Compare a minimal change with more complex alternatives.
Recommend one candidate for approval.

Do not invent customer research or make unsupported capability claims.
```

Examples include making partial completion understandable, reducing unnecessary clarification, or improving evidence inspection.

### RSI-CAIO: prove that an agentic design earns its complexity

```text
MISSION: Improve one agent capability using comparative evaluation.

Select a supported task class.

Compare the current approach with an appropriate simpler baseline:
deterministic workflow, single agent, or reduced fleet.

Evaluate:
- successful task completion;
- evidence quality;
- tool correctness;
- cost;
- latency;
- failures and recovery.

Propose one bounded change to decomposition, routing, tools,
memory, or delegation.

Keep evaluation criteria fixed for the experiment.
Do not expand permissions or promote the candidate yourself.
```

A valid result may be “remove an agent” or “keep the existing workflow.”

### RSI-CTO: remove one verified technical failure

```text
MISSION: Improve the correctness of one critical execution path.

Trace the actual production-facing path, not only isolated helpers.

Identify a reproducible defect or material technical constraint.
Write a meaningful failing test where practical.

Implement the smallest authorized correction.
Verify contracts, runtime integration, concurrency, and recovery
according to the affected behavior.

Deliver a focused issue and PR with:
baseline, hypothesis, test evidence, risk, migration implications,
and rollback or compensation.

Do not refactor unrelated modules or weaken checks to pass CI.
```

Examples include inconsistent policy implementations, duplicate state ownership, unsafe retries, or hidden persistence errors.

### RSI-CDO: close the evidence-to-learning connection

```text
MISSION: Verify one complete learning-data path.

Trace:
source observation → stored record → evaluation/reflection
→ candidate → approved behavior → subsequent outcome.

Identify missing records, silent failures, stale data,
unread evaluation results, or ambiguous labels.

Propose and implement one authorized correction with:
provenance, schema validation, write/read verification,
tenant isolation, consumer checks, and recovery behavior.

Do not treat user approval as objective correctness.
Do not use private tenant data for shared improvement without approval.
```

This task prevents a system from claiming to learn while its learning records are never stored or consumed.

### RSI-CISO: verify a concrete security invariant

```text
MISSION: Verify delegated authority on one consequential workflow.

Within explicitly authorized testing scope, demonstrate that:
- users cannot cross tenant boundaries;
- agents cannot expand their own tool access;
- child tasks cannot exceed delegated authority;
- untrusted content cannot authorize actions;
- changed proposals cannot reuse invalid approvals.

Preserve evidence and distinguish confirmed defects from hypotheses.

Coordinate remediation with the implementation owner.
Require regression tests and independent review.

Do not probe third-party systems or disclose sensitive findings publicly.
```

Start with one invariant and its real entry points, rather than a generic “security audit everything” assignment.

### RSI-COO: demonstrate recovery rather than assuming it

```text
MISSION: Improve reliability of one long-running workflow.

Exercise the workflow under:
- worker interruption;
- duplicate delivery;
- provider timeout;
- expired credentials;
- cancellation;
- budget exhaustion.

Verify ownership, durable state, checkpoints, and user-visible outcomes.

Distinguish failed actions from actions with unknown external outcomes.
Reconcile before repeating consequential work.

Propose one bounded operating or coordination change.
Measure its effect on successful completion, recovery, cost,
and customer impact.
```

The output should be a tested operating behavior plus an updated runbook—not merely a description of expected recovery.

## 4. The task contract every assignment should use

```yaml
mission:
  id: IMP-001
  title: "Bounded improvement title"
  executive_owner: rsi-cto
  human_accountable_owner: designated-owner
  business_objective: approved-objective

scope:
  repository: approved-repository
  baseline_commit: resolve-before-work
  included: []
  excluded: []
  data_access: approved-scope

problem:
  observation: evidence-backed-problem
  evidence: []
  unknowns: []

hypothesis:
  change: proposed-intervention
  expected_outcome: measurable-benefit
  baseline: established-before-candidate
  success_criteria: []
  regression_guardrails: []

authority:
  allowed_actions: []
  requires_approval: []
  prohibited_actions: []

execution:
  implementation_owner: assigned-worker
  independent_reviewer: designated-reviewer
  budget: approved-limit
  deadline: approved-deadline
  max_iterations: approved-limit

delivery:
  issue: existing-or-approved-new-issue
  pull_request: required
  required_checks: repository-policy
  rollout: approved-procedure
  rollback_or_compensation: defined-procedure

outcome:
  decision: pending
  result: pending
  limitations: []
  next_hypothesis: null
```

Do not let the candidate author change its own success criteria after seeing the results.

## 5. How the agents should work together

Use one cross-functional improvement as a demonstration:

### Example mission: make interrupted research recover safely

| Step | Owner | Assignment |
|---|---|---|
| Define value | CPO | Specify what the user should retain and understand after interruption |
| Define capability | CAIO | Identify which agent steps may resume, restart, or require escalation |
| Verify records | CDO | Confirm evidence, completed tool results, and task state persist correctly |
| Design and implement | CTO | Add the smallest necessary checkpoint and recovery behavior |
| Verify boundaries | CISO | Check identity, tenant scope, credentials, and approval validity on resume |
| Exercise operations | COO | Run interruption and reconciliation drills |
| Evaluate | Independent evaluator | Test the frozen acceptance cases |
| Coordinate decision | CEO | Resolve dependencies and bring reserved decisions to the human owner |

One implementation owner should control the change. The other executives contribute requirements, evidence, review, and operating verification.

### End-to-end acceptance

```text
An authorized task starts.
A completed step is durably recorded.
The worker is interrupted.
Execution resumes or escalates according to policy.
Confirmed work is not blindly repeated.
Tenant and approval scope remain valid.
The user sees an accurate outcome.
The evaluation result is recorded.
The next improvement proposal uses that result.
```

## 6. What turns this into recursive improvement

Require three linked records:

```text
Cycle 1 result
    → explains why Cycle 2 was selected

Cycle 2 candidate
    → changes an approved capability or process

Cycle 2 result
    → confirms, rejects, or refines the next hypothesis
```

For example:

1. Recovery tests reveal missing checkpoints.
2. A checkpoint improvement passes evaluation and is adopted.
3. New results show duplicate side effects remain the limiting problem.
4. The next task targets reconciliation.
5. Subsequent evidence shows the process is reliable enough to test a more efficient delegation strategy.

That is stronger evidence of recursive improvement than unrelated maintenance PRs labeled “RSI.”

Not every cycle must succeed. A rejected candidate that prevents a harmful rollout is a useful outcome.

## 7. Recommended first sequence for your platform

Based on the earlier plan review, I would use this sequence—but have the agents reverify current repository state before acting. The previous review was a planning snapshot, not a current implementation audit.

1. CEO: reconcile plans, dependencies, owners, and authority.
2. CTO + CISO: verify the authoritative policy path and tenant boundaries.
3. CDO: establish persistence integrity and behavior-version provenance.
4. CAIO + Evaluation: establish one representative baseline and protected evaluation set.
5. CPO: define one complete, user-visible improvement.
6. CTO: implement the approved candidate.
7. COO: demonstrate operational recovery and rollout readiness.
8. Independent reviewer and human authority: decide promotion.
9. CEO: record outcomes and select the next justified cycle.

Keep your existing rule: complete the current implementation issue, merge it through the approved process, and verify required CI/CD before beginning the next implementation issue.

Independent review is not just another agent saying “looks good.” GitHub’s own coding-agent controls illustrate the separation between generating code and authorizing integration, including constrained permissions and human review before merge. [docs.github](https://docs.github.com/en/copilot/concepts/security-governance-and-network-settings/risks-and-mitigations)

## 8. Master prompt to start the team

```text
Execute one governed platform-improvement cycle.

Use your assigned executive charter to assess the current repository.
Do not assume previous plans or completion claims are current.

Each executive must identify at most three evidence-backed findings
within its responsibility and recommend one priority.

The CEO coordinator must consolidate these into one bounded mission.
Assign one implementation owner and identify independent evaluation,
security review, and human approval responsibilities.

Before implementation:
1. Resolve scope and authority.
2. Establish the baseline commit and relevant operating evidence.
3. Write a falsifiable hypothesis.
4. Freeze acceptance criteria and regression guardrails.
5. Identify the existing issue or request approval to create one.
6. Define budget, deadline, rollout, and recovery.

Then follow repository policy:
issue → tests → implementation → PR → review → required CI
→ authorized merge → post-merge verification
→ authorized rollout where applicable → outcome observation.

Do not expand privileges, weaken controls, alter your own passing
criteria, or modify governance instructions.

Report one of:
accepted, rejected, inconclusive, blocked, cancelled, or rolled back.

Close the cycle by explaining what the evidence supports and proposing
the next task. Do not begin that task unless continuing execution is
within the approved authorization and resource envelope.
```

The most important assignment is therefore not “improve continuously.” It is: “Complete one measurable, governed improvement cycle, then justify the next one from the evidence.”
