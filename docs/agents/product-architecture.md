# Product and Architecture Blueprint: Multi-Tenant, Multi-User Agentic SaaS

This document is intended for a product manager and an implementation agent working together. It defines the product structure, architecture boundaries, delivery lifecycle, backlog, and release gates needed to transform an existing application into a production-oriented agentic SaaS.

The governing principle is **traceability**: every implemented capability must connect to an approved user outcome, specification, acceptance criteria, evaluation evidence, and operational owner.

For this document:

- SDD means specification-driven development.
- AI-SDLC means an AI-assisted software development lifecycle, including engineering controls for AI-powered functionality.
- AI-PDLC means an AI-aware product development lifecycle, from discovery through operation and retirement.

These are the working definitions for this program, not a claim that AI-SDLC and AI-PDLC are universally standardized methodologies. The SDD workflow follows the specification → technical plan → reviewable tasks pattern described by GitHub’s Spec Kit guidance. [github](https://github.blog/ai-and-ml/generative-ai/spec-driven-development-with-ai-get-started-with-a-new-open-source-toolkit/)

***

## 1. Product charter

### 1.1 Mission

Build a SaaS product where multiple organizations and their users can securely delegate work to agents, collaborate on tasks and artifacts, approve consequential actions, and monitor outcomes under explicit organizational policies.

The product must support:

- Organization-level isolation.
- Multiple users and memberships.
- Shared and private workspaces.
- Role- and resource-based authorization.
- Durable agent execution.
- Human oversight.
- Tenant-scoped integrations and knowledge.
- Subscription entitlements and usage controls.
- Observable, recoverable operations.
- Evaluated and governed AI improvements.

### 1.2 Non-goals

Unless separately approved:

- Converting every service into an LLM agent.
- Building a general-purpose agent marketplace.
- Supporting arbitrary customer-supplied executable code.
- Unrestricted autonomous payments, trading, publishing, or deployment.
- Cross-tenant learning from private customer data.
- Autonomous production self-modification.
- Claims of AGI, ASI, or guaranteed correctness.

### 1.3 Initial product hypothesis

> Teams will delegate repeatable, evidence-intensive work when the product makes scope, permissions, progress, approvals, and results understandable—and when successful delegation costs less than the current workflow.

The PM must validate this hypothesis for a specific initial customer segment and workflow before expanding the platform.

***

## 2. Product discovery and decision ownership

### 2.1 Decisions required before implementation

| Decision | Accountable owner | Required output |
|---|---|---|
| Initial customer segment | PM | Ideal customer profile |
| First workflow | PM + design + domain expert | Journey and success criteria |
| Data sensitivity | Security + domain owner | Data classification |
| Permitted autonomy | Product + security + customer representative | Action policy |
| Tenant isolation model | Architecture + security | ADR and threat model |
| Pricing model | Product + finance | Packaging hypothesis |
| Initial deployment regions | Product + architecture + legal | Hosting requirements |
| Launch thresholds | Product + engineering + security | Release scorecard |
| Support model | Product + operations | Support and incident plan |

A delivery agent may recommend decisions but must not silently make material business, legal, security, or pricing decisions.

### 2.2 Initial roles

| Role | Responsibilities |
|---|---|
| Platform operator | Operates the service; no unrestricted customer-data access |
| Organization owner | Manages organization ownership and critical settings |
| Organization administrator | Manages users, policies, integrations, and configuration |
| Billing administrator | Manages subscription and invoices |
| Workspace administrator | Manages workspace access and resources |
| Member | Creates and collaborates on permitted tasks |
| Approver | Authorizes specified action classes |
| Viewer/auditor | Inspects permitted results and records |
| Service principal | Performs scoped machine-to-machine operations |

Roles may overlap. Authorization must evaluate the actual action and resource, not merely the displayed role name.

***

## 3. Product hierarchy and work-item model

Use this hierarchy consistently:

```text
Product objective
  → Initiative
    → Epic
      → Feature
        → User story
          → Engineering task
            → Test / evaluation evidence
```

### Required identifiers

```text
OBJ-###   Product objective
INIT-###  Initiative
EP-###    Epic
FEAT-###  Feature
US-###    User story
REQ-###   Requirement
ADR-###   Architecture decision
TASK-###  Implementation task
TEST-###  Deterministic test
EVAL-###  AI evaluation
RISK-###  Risk
REL-###   Release
```

### Traceability example

```text
OBJ-001 Reduce research turnaround
  → EP-005 Agent task execution
  → FEAT-005.02 Recoverable research workflow
  → US-005.04 Resume after interruption
  → REQ-REC-003 Preserve completed tool results
  → ADR-012 Durable task checkpoint strategy
  → TASK-184 Implement checkpoint persistence
  → TEST-REC-017 Restart recovery
  → EVAL-RES-009 Result quality after recovery
  → REL-003 Pilot release
```

Changes to approved requirements must update affected plans, tasks, tests, and release criteria.

***

## 4. Lifecycle: AI-PDLC, SDD, and AI-SDLC

### 4.1 Integrated lifecycle

| Stage | Product activities | Specification artifacts | Engineering and AI evidence | Exit gate |
|---|---|---|---|---|
| Discover | User research, problem validation | Opportunity brief | Current workflow baseline | Problem validated |
| Define | Scope, outcomes, risks | PRD, feature specs | Feasibility and risk review | Scope approved |
| Design | Journeys, policies, architecture | UX specs, contracts, ADRs | Prototype and threat model | Design approved |
| Plan | Prioritization, dependencies | Stories, tasks, test plans | Evaluation datasets and rollout plan | Ready for implementation |
| Build | Incremental delivery | Updated specifications | Code, tests, evaluation results | Feature verified |
| Validate | Usability and outcome assessment | Acceptance record | Security, accessibility, reliability evidence | Release approved |
| Launch | Pilot, communication, support | Release specification | Canary and rollback evidence | Launch criteria met |
| Operate | Monitoring, support, incident handling | Runbooks and service reports | Production quality and cost monitoring | Continued operation |
| Improve/retire | Experiments or decommissioning | Change or retirement specification | Comparative evaluations or deletion evidence | Change approved |

AI risk management must continue after launch, not stop at initial acceptance. NIST’s AI RMF guidance explicitly includes ongoing monitoring and management of risks and benefits throughout the lifecycle. [airc.nist](https://airc.nist.gov/airmf-resources/playbook/manage/)

### 4.2 SDD rules

1. Write the observable behavior before implementing it.
2. Separate product requirements from technical implementation choices.
3. Resolve material ambiguity before coding.
4. Version specifications with code.
5. Link tasks to acceptance criteria.
6. Update specifications when intended behavior changes.
7. Treat implementation/specification disagreement as a review item.
8. Do not accept generated code solely because it compiles.

### 4.3 AI-assisted engineering controls

For AI-generated changes:

- Record the responsible human reviewer.
- Require tests appropriate to the change.
- Scan for secrets and vulnerable dependencies.
- Review permissions, migrations, and external side effects.
- Validate imported APIs against installed versions.
- Do not send restricted customer data to unapproved development tools.
- Require separate authorization for deployment or destructive operations.

***

## 5. Target product architecture

### 5.1 Logical architecture

```text
Web application / approved API clients
                  │
Authentication and tenant-context resolution
                  │
Application authorization and policy enforcement
                  │
         ┌────────┴────────┐
         │                 │
   Control plane      Application plane
         │                 │
 Organizations        Workspaces
 Memberships          Tasks and collaboration
 Plans/entitlements   Agent orchestration
 Billing              Approvals and tools
 Policies             Knowledge and artifacts
 Provisioning         Tenant integrations
         │                 │
         └────────┬────────┘
                  │
       Persistence and event infrastructure
                  │
       External providers and customer systems

Cross-cutting:
Audit • Observability • Evaluation • Secrets • Retention • Recovery
```

These are logical boundaries, not a requirement to create a microservice for every box.

### 5.2 Existing-system transformation

Before designing replacements:

1. Inventory current functionality and data.
2. Map existing classes, services, agents, and workflows.
3. Identify reused, adapted, retired, and newly required components.
4. Select one end-to-end workflow.
5. Introduce tenant and authorization boundaries before exposing shared execution.
6. Migrate incrementally with rollback.

For the existing Think direction, designated agent roles should use `@cloudflare/think`, while deterministic services and infrastructure components may remain services.

***

## 6. Tenant, user, and resource model

### 6.1 Canonical entities

| Entity | Purpose |
|---|---|
| User | Global human identity |
| Organization/tenant | Customer security and commercial boundary |
| Membership | User’s relationship to an organization |
| Workspace | Collaboration and resource-access scope |
| Workspace membership | Access within a workspace |
| Service principal | Non-human identity |
| Subscription | Commercial agreement |
| Entitlement | Allowed capability or limit |
| Integration connection | Scoped connection to an external system |
| Task | Durable unit of delegated work |
| Agent run | Execution instance participating in a task |
| Action proposal | Exact proposed external or internal change |
| Approval | Authorization for a proposal/version |
| Artifact | Versioned output |
| Knowledge record | Scoped source or retained information |
| Usage event | Metered consumption |
| Audit event | Security or business-relevant event |

### 6.2 Membership rules

- A user may belong to multiple organizations.
- Active organization selection must be explicit.
- Switching organizations must invalidate or segregate cached tenant data.
- Invitations must bind to the intended organization and expire.
- Removing a user must revoke future access and address active sessions.
- Ownership transfer and deletion require defined safeguards.
- The last owner cannot be removed without an approved ownership policy.

### 6.3 Tenant context

Resolve tenant identity from authenticated membership or a trusted machine credential.

Never trust a request-body `tenantId` as sufficient authorization.

Carry validated context through:

```text
API request
→ background task
→ agent delegation
→ tool execution
→ storage access
→ artifact retrieval
→ notification
→ audit record
```

Tenant isolation is a distinct architectural concern, not simply the presence of authentication or a tenant column. AWS SaaS guidance treats isolation constructs as necessary to protect each tenant’s resources. [docs.aws.amazon](https://docs.aws.amazon.com/wellarchitected/latest/saas-lens/tenant-isolation.html)

***

## 7. Isolation and authorization requirements

### 7.1 Required isolation coverage

The architecture must address:

- Database queries and writes.
- Object storage.
- Search and vector retrieval.
- Caches.
- Queue messages.
- Agent state and conversation history.
- Generated artifacts.
- Integration credentials.
- Logs and traces.
- Exports.
- Notifications.
- Support tooling.
- Backups and restore procedures.

### 7.2 Authorization model

Use roles for broad capabilities and resource policies for contextual restrictions.

Example decision inputs:

```text
Actor
Organization membership
Workspace membership
Requested action
Resource ownership/scope
Organization policy
Subscription entitlement
Approval requirement
Current resource version
```

Plan entitlements do not replace security authorization.

### 7.3 Agent authority

An agent receives bounded delegated authority.

Its effective permissions must not exceed:

```text
Initiating authority
∩ organization policy
∩ resource policy
∩ tool policy
∩ current approval
```

Recheck authorization before consequential execution, especially after delays, membership changes, or delegation.

### 7.4 Support access

Customer-data access by platform staff must be:

- Restricted.
- Time-bounded.
- Justified.
- Audited.
- Approved where policy requires.

Do not implement silent, unrestricted impersonation.

***

## 8. Agentic execution model

### 8.1 Core execution loop

```text
Goal
→ validated scope
→ plan
→ delegated work
→ tool execution
→ evidence/artifacts
→ evaluation
→ approval if required
→ outcome
```

### 8.2 Agent allocation

| Component | Responsibility |
|---|---|
| Coordinator | Owns task plan, dependencies, budgets, and completion |
| Domain agent | Handles bounded domain reasoning and tools |
| Micro-agent | Performs narrow judgment tasks when justified |
| Evaluator | Checks artifacts against defined criteria |
| Deterministic service | Calculates, validates, authorizes, persists, and executes exact rules |

No tier is mandatory merely to claim a multi-agent architecture.

### 8.3 Execution guarantees to specify

- Task-state transitions.
- Checkpoint strategy.
- Retry boundaries.
- Duplicate handling.
- Tool idempotency.
- External-action reconciliation.
- Cancellation semantics.
- Agent concurrency.
- Delegation depth.
- Cost and time limits.
- Recovery after provider or runtime failure.

Do not claim exactly-once external execution without explicit supporting mechanisms and evidence.

***

## 9. Commercial model and tenant lifecycle

### 9.1 Separate three concepts

| Concept | Meaning |
|---|---|
| Entitlement | What the plan permits |
| Operational quota | What execution is allowed to consume |
| Billing usage | What is charged under the commercial agreement |

A token counter is not automatically an accurate invoice.

### 9.2 Required lifecycle states

```text
Provisioning
→ active
→ restricted / suspended
→ closing
→ deleted or retained under policy
```

Support trial, payment-failure, cancellation, export, and retention rules as explicit product decisions.

### 9.3 Onboarding workflow

```text
Registration
→ organization creation
→ owner membership
→ policy and isolation setup
→ subscription/entitlement setup
→ workspace provisioning
→ readiness checks
→ welcome journey
```

Onboarding must be restartable and recover from partial failure. AWS SaaS guidance identifies onboarding as an end-to-end process covering tenant creation, identity, isolation policies, billing, and configuration. [wa.aws.amazon](https://wa.aws.amazon.com/saas.question.OPS_3.en.html)

### 9.4 Usage controls

- Reserve budget before expensive fan-out where needed.
- Attribute usage to tenant, task, and billable category.
- Deduplicate metering events.
- Reconcile late or corrected usage.
- Distinguish provider cost from customer charges.
- Explain how quota reductions affect active tasks.
- Define grace-period and suspension behavior.

***

## 10. Epic and feature backlog

### Release labels

- R0: foundation and discovery.
- R1: controlled pilot.
- R2: production SaaS.
- R3: enterprise and governed improvement.

These labels represent dependency-based increments, not promised dates.

| Epic | Features | Representative stories | Target |
|---|---|---|---|
| EP-001 Product specification foundation | PRD, glossary, IDs, ADRs, traceability | US-001.01: PM can trace a feature to outcome and acceptance evidence | R0 |
| EP-002 Organizations and identity | Registration, memberships, invitations, tenant switching | US-002.01: Owner invites a member; US-002.02: user switches organizations safely | R1 |
| EP-003 Authorization and isolation | Role policies, resource access, service principals, negative isolation tests | US-003.01: member cannot retrieve another tenant’s artifact | R1 |
| EP-004 Tenant provisioning | Restartable onboarding, readiness status, lifecycle transitions | US-004.01: failed provisioning resumes without duplicate organizations | R1 |
| EP-005 Agent task execution | Goal capture, planning, delegation, checkpoints, budgets | US-005.01: member submits a bounded task; US-005.02: interrupted task recovers | R1 |
| EP-006 Collaboration and approvals | Assignment, comments, review, version-bound approval | US-006.01: approver reviews an exact action; US-006.02: changed proposal requires reapproval | R1 |
| EP-007 Knowledge and integrations | Scoped ingestion, retrieval, credentials, revocation | US-007.01: workspace retrieves only authorized sources | R1–R2 |
| EP-008 Artifacts and provenance | Versioning, evidence links, exports, retention | US-008.01: reviewer traces a conclusion to its source and artifact version | R1 |
| EP-009 Subscriptions and metering | Plans, entitlements, quotas, usage ledger, billing integration | US-009.01: administrator sees attributable usage and limits | R1–R2 |
| EP-010 Operations and recovery | Dashboards, alerts, audit, runbooks, backups | US-010.01: operator diagnoses a stuck task without unrestricted data access | R1–R2 |
| EP-011 AI evaluation and release governance | Datasets, quality gates, model/prompt registry, canaries | US-011.01: release owner compares a candidate against baseline | R1–R2 |
| EP-012 Enterprise administration | SSO, provisioning integration, advanced policies, export | US-012.01: administrator revokes access through approved enterprise identity flow | R3 |
| EP-013 Controlled adaptation and improvement | Bounded replanning, experiment pipeline, rollback | US-013.01: evaluated improvement is promoted only after approval | R3 |
| EP-014 Privacy and offboarding | Data inventory, export, deletion, retention, tenant closure | US-014.01: owner closes an organization under documented retention rules | R1–R2 |

### MVP boundary

R1 must include at least:

- One organization model.
- Multiple users.
- One workspace model.
- Enforced isolation.
- One complete agentic workflow.
- Human approvals.
- Evidence-backed artifacts.
- Usage limits.
- Audit events.
- Recovery.
- Minimum evaluation gates.
- Documented offboarding handling.

Do not launch a “multi-tenant MVP” that postpones tenant isolation until a later release.

***

## 11. Detailed story examples

### US-003.01 — Cross-tenant artifact isolation

As an organization member, I can access only artifacts authorized for my organization and workspace.

Acceptance criteria:

```gherkin
Given a user authenticated in Organization A
And an artifact belonging to Organization B
When the user requests that artifact by ID
Then the request is denied
And no artifact content is returned
And the response follows the approved resource-disclosure policy

Given an agent task operating for Organization A
When it searches knowledge or artifact indexes
Then Organization B resources are excluded by enforced access controls
And not merely removed from the displayed results
```

Required evidence:

- API authorization test.
- Storage-access test.
- Retrieval-isolation test.
- Cache-isolation test.
- Background-execution test.

### US-006.02 — Approval invalidation

As an approver, I authorize a specific action, not an open-ended future action.

```gherkin
Given proposal version 3 is approved
When its target, amount, material content, or permissions change
Then a new proposal version is created
And the prior approval cannot authorize the changed action

Given an approval has expired or been revoked
When execution is attempted
Then execution is blocked
And the task requests a new decision
```

### US-005.02 — Recoverable execution

As a requester, I can recover a task after interruption without losing confirmed progress or blindly repeating side effects.

```gherkin
Given a task has completed a read operation and an external write
When execution restarts
Then confirmed outputs are restored
And the external write is reconciled before any repeat attempt
And uncertain outcomes are visible
```

### US-009.02 — Concurrent budget enforcement

As a billing administrator, I can set a tenant spending limit respected by concurrent agent tasks.

```gherkin
Given several tasks request expensive work simultaneously
When the remaining budget is insufficient for all requests
Then budget admission uses an atomic or equivalent safe mechanism
And the configured overspend policy is enforced
And blocked work explains the reason
```

### US-002.03 — Membership revocation

As an administrator, I can revoke a user’s access and prevent further unauthorized actions.

Acceptance criteria must define:

- Session revocation timing.
- API credential handling.
- Pending approval invalidation.
- Treatment of already-running tasks.
- Ownership reassignment.
- Audit evidence.

***

## 12. Feature specification template

Use this template for every feature before implementation:

```markdown
# FEAT-XXX: Feature title

## Ownership
Product owner:
Engineering owner:
Design owner:
Security reviewer:

## Outcome
User problem:
Target users:
Expected benefit:
Success metric and baseline:

## Scope
Included:
Excluded:
Dependencies:

## User journeys
Primary:
Failure:
Recovery:
Accessibility:

## Requirements
Functional:
Tenant isolation:
Authorization:
Privacy:
Billing/usage:
Operational:
AI-specific:

## Agent behavior
Allowed tools:
Delegation:
Memory:
Budgets:
Approval boundaries:
Failure and escalation:

## Contracts
API:
Events:
Data model:
State transitions:

## Acceptance
Deterministic tests:
AI evaluations:
Usability evidence:
Performance/reliability evidence:

## Rollout
Migration:
Feature flag:
Canary:
Rollback:
Support:

## Open decisions
Decision:
Owner:
Due before:
```

***

## 13. Evaluation and release requirements

### 13.1 Evaluate the whole system

Evaluate:

- Task completion.
- Evidence quality.
- Calculation correctness.
- Tool selection.
- Permission compliance.
- Delegation usefulness.
- Recovery behavior.
- Latency.
- Cost.
- User comprehension.
- Domain-specific harm.

A model’s answer quality alone does not establish product readiness.

### 13.2 Evaluation datasets

Maintain separate categories:

- Representative workflows.
- Difficult edge cases.
- Adversarial instructions.
- Cross-tenant access attempts.
- Permission changes during execution.
- Tool/provider failures.
- Ambiguous requests.
- Budget exhaustion.
- High-consequence actions.

Use held-out cases for promotion decisions. Restrict customer-data use according to approved policies.

### 13.3 Release gate

A release requires:

1. Approved specification.
2. Reviewed implementation.
3. Passing deterministic tests.
4. Passing required AI evaluations.
5. Tenant-isolation evidence.
6. Security and accessibility review.
7. Defined operating limits.
8. Tested rollback or compensating procedure.
9. Support and incident readiness.
10. Named release owner.

Numerical quality, latency, recovery, availability, and cost thresholds must be approved before release—not invented after results are known.

***

## 14. Nonfunctional requirements register

| Area | Required specification |
|---|---|
| Availability | Critical journeys, measurement window, target, exclusions |
| Performance | Interactive-response and task-completion targets by workflow |
| Recovery | RPO/RTO by data and service class |
| Isolation | Testable access and execution invariants |
| Scalability | Tenant/user/task limits and concurrency policy |
| Fairness | Noisy-neighbor controls and scheduling policy |
| Security | Credential handling, authorization, patching, threat model |
| Privacy | Retention, deletion, residency, provider data handling |
| Accessibility | Complete-journey WCAG 2.2 AA target |
| Operability | Alerts, dashboards, audit, runbooks |
| Portability | Explicit exit/export requirements |
| Cost | Per-task budgets and tenant-level guardrails |

Mark unresolved values as release-blocking where material.

***

## 15. Governed adaptation and improvement

Separate:

1. Replanning within a task.
2. User-approved personalization.
3. Product-level configuration changes.
4. Code or model changes.

For product-level improvement:

```text
Observed issue
→ hypothesis
→ isolated candidate
→ unchanged evaluation criteria
→ comparison with baseline
→ independent review
→ approval
→ limited rollout
→ monitoring
→ promotion or rollback
```

The candidate must not be allowed to weaken its own security policy, evaluation criteria, or approval requirements.

Do not use “self-improving” as a marketing claim unless the specific mechanism and measured outcomes can be explained.

***

## 16. Delivery organization and governance

### Decision rights

| Area | Accountable role |
|---|---|
| Product outcomes and priority | PM |
| User experience | Design lead |
| Architecture | Engineering lead |
| Security and isolation | Security owner |
| AI evaluation | Evaluation owner |
| Commercial rules | Product + finance |
| Release readiness | Named release owner |
| Production operation | Operations owner |

AI agents may prepare artifacts and execute authorized tasks. Human accountability remains explicit.

### Definition of Ready

A story is ready when:

- User and outcome are clear.
- Scope and dependencies are understood.
- Acceptance criteria are testable.
- Tenant and permission implications are specified.
- Relevant AI evaluations are identified.
- Material open decisions are resolved.

### Definition of Done

A story is done when:

- Behavior matches the approved specification.
- Required tests and evaluations pass.
- Isolation and permissions are verified.
- Documentation and telemetry are updated.
- Migration and rollback implications are addressed.
- Limitations are recorded.
- Product acceptance is documented.

***

## 17. Repository artifact structure

Suggested structure; adapt to existing conventions:

```text
docs/
  product/
    charter.md
    personas.md
    roadmap.md
    metrics.md
    glossary.md
  architecture/
    overview.md
    tenancy.md
    identity-authorization.md
    agent-runtime.md
    data-governance.md
    billing-metering.md
    adr/
  ux/
    architecture.md
    journeys/
  governance/
    ai-risk-register.md
    release-gates.md
    data-policies.md
  operations/
    runbooks/
    incident-response.md
    recovery.md

specs/
  FEAT-xxx-name/
    spec.md
    plan.md
    tasks.md
    contracts/
    acceptance.md
    evaluation-plan.md
    rollout.md

evaluations/
  datasets/
  scenarios/
  baselines/
  results/
```

Store no secrets or unrestricted customer records in specifications or evaluation fixtures.

***

## 18. Instructions to the PM and implementation agent

> Begin with discovery and architecture, not a platform rewrite.
>
> Inspect the existing application and map it to this blueprint. Produce a gap assessment, tenant and membership model, authorization model, target architecture, initial product metrics, and dependency-ordered backlog.
>
> Select one workflow that demonstrates multi-user collaboration, isolated agent execution, version-bound approvals, evidence-backed output, usage controls, and recovery.
>
> Prepare feature specifications and acceptance criteria before implementation. Use the approved UX architecture and Think conformance requirements as companion documents.
>
> Do not create external issues, alter infrastructure, deploy, change pricing, or execute consequential customer actions without separate authorization.
>
> Report what exists, what was verified, what is proposed, and what remains undecided. Do not describe a design as an implemented capability.

### First review package

The first deliverable should contain:

1. Current-state assessment.
2. Product charter and initial customer workflow.
3. Tenant, membership, and authorization model.
4. Architecture diagram and major ADRs.
5. MVP boundary.
6. Epic/feature/story backlog with dependencies.
7. One fully specified vertical slice.
8. Evaluation and release scorecard.
9. Risks and unresolved decisions.
10. Recommended implementation sequence.

This package is the approval point for moving from planning into implementation.
