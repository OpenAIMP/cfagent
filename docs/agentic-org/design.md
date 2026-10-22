Below are two companion documents you can give your agents:

- `design.md`: how to discover, specify, and validate product and system behavior.
- `architecture.md`: how to structure, secure, operate, and evolve the implementation.

Both explicitly depend on your existing `documentation.md` policy. They do not replace it.

The governing principle is **evidence**: frameworks guide decisions, but implemented controls, tests, independent reviews, and observed outcomes establish whether requirements are met.

These documents define a proposed target and implementation policy—not a claim that your current repository already conforms to them.

***

# Document 1 — `design.md`

## 1. Document status and authority

| Field | Value |
|---|---|
| Purpose | Design policy and target design specification |
| Scope | Multi-tenant, multi-user, agentic SaaS and its agentic operating organization |
| Primary coordinators | CPO, CAIO, CTO |
| Required contributors | CDO, CISO, COO, Design, independent Evaluation |
| Approval | Designated human product/technology owners |
| Documentation policy | Existing `documentation.md` at its canonical repository path |
| Implementation status | Proposed until verified through approved delivery |

### Mandatory first action

Before implementation:

1. Locate and read `AGENTS.md`, `documentation.md`, and applicable nested instructions.
2. Identify existing canonical specifications and design assets.
3. Reconcile conflicts rather than creating competing documents.
4. Establish the current-state baseline.
5. Propose an incremental implementation sequence.

This document grants no additional access, spending, or deployment authority.

## 2. Purpose

Design a platform that lets authorized users and agents:

- Define goals and constraints.
- Select appropriate execution methods.
- Delegate bounded work.
- Coordinate dependencies.
- Inspect evidence and artifacts.
- Approve consequential actions.
- Recover from interruption.
- Evaluate outcomes.
- Propose and adopt improvements safely.

The platform must support deterministic, agentic, and hybrid workflows.

“Solves any problem” and “achieves ASI” are not acceptance criteria.

## 3. Design principles

1. Start with a user or organizational problem.
2. Prefer the simplest sufficient solution.
3. Preserve human accountability.
4. Separate proposing from authorizing.
5. Make consequential behavior understandable.
6. Keep exact rules outside model discretion.
7. Preserve tenant and resource boundaries.
8. Design failure and recovery before launch.
9. Evaluate actual outcomes, not agent activity.
10. Make improvement reversible or explicitly compensatable where practical.
11. Treat unknown and inconclusive outcomes as legitimate.
12. Build documentation and verification into delivery.

## 4. Standards, frameworks, and applicability

Adopt approved editions and profiles through the repository’s standards register.

| Reference | Design application |
|---|---|
| WCAG 2.2 AA | Accessibility requirements for complete supported journeys |
| WAI-ARIA Authoring Practices | Custom widget interaction and keyboard guidance |
| OWASP ASVS | Testable application-security requirements |
| NIST AI RMF and Generative AI Profile | AI risks, oversight, evaluation, monitoring |
| NIST SSDF | Secure development expectations |
| COBIT | Value, accountability, resources, risk, and assurance |
| TOGAF | Stakeholder concerns, architecture alternatives, transitions |
| ITIL | Service experience, change, incidents, continuity, improvement |
| PMI/approved PMBOK guidance | Scope, stakeholders, resources, risk, delivery, benefits |
| CISSP knowledge domains | Security-review coverage—not software certification |
| Design thinking / Double Diamond | Problem exploration, definition, alternatives, validation |
| Diátaxis | Tutorials, how-to, reference, and explanation documentation |

Tailor these references. Do not claim that implementing a checklist establishes certification.

The Double Diamond separates Discover, Define, Develop, and Deliver, encouraging problem understanding before solution commitment and small-scale testing before adoption. [1001]

TOGAF and COBIT can complement one another: architecture governance and transitions support enterprise governance decisions rather than replacing them. [isaca](https://www.isaca.org/resources/news-and-trends/industry-news/2020/cobit-resource-optimization-mapped-to-togafs-architecture-review-board)

## 5. Design process

### 5.1 Discover

Gather authorized evidence from:

- Customer research.
- Existing workflows.
- Support cases.
- Product analytics.
- Incidents.
- Architecture assessments.
- Evaluation results.
- Operating cost.

Label synthetic research and assumptions explicitly.

Deliver:

```text
Problem statement
Affected users
Current journey
Evidence
Unknowns
Constraints
Baseline
```

### 5.2 Define

Specify:

- Intended outcome.
- Scope and non-goals.
- Acceptance criteria.
- Authority and approval boundaries.
- Tenant and data implications.
- Quality and service expectations.
- Risks and dependencies.

### 5.3 Develop

Compare alternatives:

```text
No change
Documentation improvement
Workflow simplification
Deterministic automation
Single-agent assistance
Multi-agent coordination
Human-led execution
```

Prototype only what is needed to resolve uncertainty.

### 5.4 Deliver and learn

Validate the candidate, obtain approval, roll out within limits, observe outcomes, and update the next hypothesis.

```mermaid
flowchart LR
    A[Discover evidence] --> B[Define outcome]
    B --> C[Compare alternatives]
    C --> D[Prototype and validate]
    D --> E{Acceptance met?}
    E -->|No| C
    E -->|Yes| F[Authorized delivery]
    F --> G[Observe outcomes]
    G --> H[Record learning]
    H --> A
```

## 6. Users and identities

Design for:

- Organization owners.
- Tenant administrators.
- Workspace administrators.
- Members.
- Viewers.
- Approvers.
- Auditors.
- Platform operators.
- Service principals.
- Delegated agent workloads.

A user may belong to several tenants. A role may differ between tenants or workspaces.

Role names must not substitute for explicit permissions.

## 7. Core product journeys

Each journey requires primary, failure, recovery, accessibility, and unauthorized-access cases.

| Journey | Required outcome |
|---|---|
| Onboarding | Correct identity, tenant, membership, and initial policy |
| Goal creation | Clear objective, inputs, constraints, and output |
| Plan review | Understand proposed work, permissions, cost, and limitations |
| Execution | Accurate progress and bounded delegation |
| Approval | Exact action and consequences are inspectable |
| Result review | Evidence, artifacts, and uncertainty are visible |
| Interruption | Work resumes, reconciles, or escalates safely |
| Cancellation | Remaining work and completed effects are explained |
| Collaboration | Ownership, handoffs, and versions are explicit |
| Improvement review | Baseline, candidate, guardrails, and results are comparable |
| Offboarding | Access, active work, exports, and retention are handled |

## 8. Design system

Use one coherent system rather than several overlapping libraries.

### Required layers

```text
Principles
→ primitive tokens
→ semantic tokens
→ reusable components
→ product patterns
→ page templates
```

### Token dimensions

- Color.
- Typography.
- Spacing.
- Density.
- Borders.
- Elevation.
- Focus.
- Motion.
- Responsive behavior.

Keep theme, density, typography, branding, and reduced motion independently configurable where supported.

Select one canonical token source. Generate other representations; do not maintain competing hand-edited values.

If cross-tool interoperability is needed, assess the Design Tokens Community Group format. It is a Community Group specification, not a W3C Recommendation. [designtokens](https://www.designtokens.org/TR/2025.10/format/)

### Mandatory product components

```text
Goal editor
Plan viewer
Task status
Activity timeline
Evidence panel
Artifact viewer/editor
Approval review
Budget indicator
Error/recovery panel
Memory management
Candidate comparison
Outcome report
```

## 9. Agentic interaction requirements

### Delegation contract

Before material execution, communicate:

```text
What will be done
What will not be done
Which systems will be accessed
What may change
What requires approval
Budget and time limits
Expected outputs
```

### Progress

- Report actual milestones.
- Label estimates.
- Do not fabricate percentages.
- Distinguish waiting, working, blocked, and disconnected.
- Explain material replanning.
- Expose delegation detail progressively.

### Explanations

Provide concise rationales, evidence, assumptions, and limitations.

Do not expose or require private chain-of-thought.

### Controls

Define exact meanings for:

- Pause.
- Resume.
- Cancel.
- Retry.
- Undo.
- Compensate.

Do not offer “undo” for an irreversible action or label an uncertain external outcome as a confirmed failure.

## 10. IAAA and authorization experience

Design Identification, Authentication, Authorization, and Accountability together.

Require:

- Stable identities.
- Secure provider linking.
- Explicit tenant/workspace context.
- Fine-grained permissions.
- Bounded agent delegation.
- Version-bound approvals.
- Audit visibility appropriate to role.
- Clear denial and recovery messages.

Authentication does not establish authorization.

An executive agent’s title does not grant platform-administrator powers.

## 11. Determinism contract

Every workflow must state:

| Question | Required answer |
|---|---|
| Which steps are deterministic? | Exact functions and rules |
| Which steps use model judgment? | Interpretation/planning boundaries |
| What is versioned? | Code, schemas, policy, prompts, tools, configuration |
| What can vary? | Provider behavior, source data, timing |
| What can replay reproduce? | Explicit guarantee and limitations |

Exact calculations, authorization, budget checks, and approval validity must not depend on unconstrained model judgment.

## 12. RSI design requirements

Every improvement must include:

```text
Observation
Baseline
Hypothesis
Candidate
Evaluation
Review
Approval
Rollout
Observed outcome
Next justified hypothesis
```

Separate:

- Task-level adaptation.
- Reusable system improvement.
- Meta-improvement of the improvement process.

A candidate cannot change its own protected acceptance criteria.

### Improvement review interface

Show:

- Baseline and candidate versions.
- Intended benefit.
- Changed behavior.
- Evaluation results.
- Regressions.
- Security and tenancy implications.
- Approval status.
- Rollout stage.
- Rollback target.
- Remaining uncertainty.

## 13. Acceptance and quality

Each feature must identify relevant evidence for:

- Functional correctness.
- Accessibility.
- Usability.
- Security.
- Tenant isolation.
- AI quality.
- Recovery.
- Performance.
- Cost.
- Compatibility.

Set numeric targets through accountable owners before release. Do not invent thresholds to fit observed results.

Automated accessibility checks supplement—not replace—manual journey assessment.

## 14. Documentation integration

Follow `documentation.md` for every task.

Maintain:

- Design intent.
- Journey diagrams.
- Interaction/state diagrams.
- Component and token guidance.
- Acceptance criteria.
- Evidence links.
- Known limitations.

Update affected artifacts in the implementation PR. Explain “no change required” where appropriate.

Do not automatically rewrite strategy for a routine bug fix.

## 15. Required design deliverables

Before coding a material capability:

1. Problem and evidence.
2. Current journey.
3. Alternatives.
4. Proposed behavior.
5. Permissions and data implications.
6. Text and relevant diagrams.
7. Acceptance criteria.
8. Evaluation plan.
9. Rollout and recovery.
10. Open decisions and approvals.

### Definition of Done

Design is complete when behavior is specified, risks are owned, acceptance is testable, diagrams agree with text, and implementation status is represented accurately.

***

# Document 2 — `architecture.md`

## 1. Document status and implementation boundary

| Field | Value |
|---|---|
| Purpose | Target architecture and architecture governance |
| Primary coordinator | CTO |
| Co-owners | CAIO, CDO, CISO, COO |
| Independent verification | Evaluation and designated reviewers |
| Governing documentation | Existing `documentation.md` |
| Status | Proposed target; current-state claims require evidence |

Begin with repository inspection. Reuse sound components and migrate incrementally.

Logical boundaries below do not require separate microservices.

## 2. Architecture objectives

Provide:

- Multi-tenant isolation.
- Multi-user collaboration.
- Fine-grained authorization.
- Durable agent execution.
- Deterministic control.
- Secure tool access.
- Evidence-backed outcomes.
- Governed recursive improvement.
- Observable operation.
- Controlled release and recovery.

Prefer a modular architecture until measured needs justify distributed deployment.

## 3. Architecture views

Maintain:

1. Business/capability view.
2. System-context view.
3. Application/container view.
4. Data and lineage view.
5. Runtime interaction view.
6. Deployment view.
7. Security/trust-boundary view.
8. Improvement-control-plane view.

Use C4 concepts where useful; do not generate every possible diagram merely for completeness. [c4model](https://c4model.com/diagrams)

Separate current, approved target, and transition states.

## 4. Logical platform structure

```mermaid
flowchart TB
    U[Users and approved clients] --> I[Identity and session boundary]
    I --> P[Policy enforcement]
    P --> A[Application API]

    A --> C[Control plane]
    A --> E[Execution plane]

    C --> T[Tenants, memberships and entitlements]
    C --> R[Capability and policy registries]

    E --> O[Durable coordinator]
    O --> AG[Bounded agent workers]
    O --> DW[Deterministic workers]

    AG --> G[Tool gateway]
    DW --> G
    G --> X[Approved external systems]

    O --> S[Task, artifact and evidence stores]

    S --> M[Improvement plane]
    M --> V[Independent evaluation]
    V --> H[Authorized promotion]
    H --> R
```

Trust boundaries must be documented in a dedicated security view; proximity in this diagram does not imply shared trust.

## 5. Plane responsibilities

| Plane | Responsibilities |
|---|---|
| Experience | User interfaces, APIs, notifications, accessible controls |
| Control | Identity, tenants, membership, policy, entitlements, approvals |
| Execution | Task graphs, scheduling, delegation, tools, recovery |
| Data | Operational records, artifacts, knowledge, lineage, retention |
| Improvement | Hypotheses, candidates, experiments, outcome learning |
| Assurance | Independent evaluation, security review, promotion evidence |
| Operations | Telemetry, alerts, incidents, releases, continuity |

Do not permit the improvement plane to bypass the control or assurance planes.

## 6. Cloud-native approach: tailored fifteen-factor profile

Adopt an explicit fifteen-factor interpretation based on *Beyond the Twelve-Factor App*. It is a methodology, not a certification. The referenced formulation includes API-first design, telemetry, and authentication/authorization alongside revised cloud-native factors. [developer.ibm](https://developer.ibm.com/articles/15-factor-applications/)

| Factor | Project interpretation |
|---|---|
| 1. One codebase, one application | Define deployable boundaries; a monorepo may contain several applications |
| 2. API first | Specify contracts before dependent implementation |
| 3. Dependency management | Declare, lock, review, and inventory dependencies |
| 4. Design/build/release/run | Separate stages and identify immutable artifacts |
| 5. Configuration/credentials/code | Separate deploy configuration and secrets from source |
| 6. Logs | Emit structured, redacted events |
| 7. Disposability | Support restart, cancellation, and checkpoint recovery |
| 8. Backing services | Access through explicit interfaces and credentials |
| 9. Environment parity | Minimize and document meaningful differences |
| 10. Administrative processes | Use versioned, authorized operational jobs |
| 11. Port binding | Apply to hosted processes; map to platform entrypoints for Workers |
| 12. Stateless processes | No reliance on accidental process memory; durable state has explicit ownership |
| 13. Concurrency | Bound work and enforce fairness |
| 14. Telemetry | Instrument outcomes, dependencies, and resource use |
| 15. Authentication/authorization | Enforce identity and policy at relevant boundaries |

Stateful agent runtimes are a deliberate adaptation: persistent state belongs in managed, recoverable storage, not undocumented process-local assumptions.

## 7. Agent and capability architecture

### Approved role classes

- Executive coordination agents.
- Meta-agents.
- Deep/task-coordinator agents.
- Domain agents.
- Micro-agents.
- Evaluators.
- Deterministic workers.

These are project responsibilities, not mandatory framework classes.

### Capability registry

Each capability must define:

```yaml
id: approved-capability
version: explicit-version
owner: accountable-owner
implementation: agent-or-deterministic
input_schema: reference
output_schema: reference
tools: []
data_scope: policy-reference
limits: policy-reference
evaluation: reference
approval_status: explicit-status
```

Runtime agents may instantiate approved templates within policy. They may not install arbitrary code or create privileged capabilities from a prompt.

### Framework profile

Where Cloudflare Think is approved:

- Verify installed APIs.
- Use supported top-level/sub-agent mechanisms.
- Avoid duplicate model/tool loops.
- Define durable task state separately from chat history.
- Test actual runtime paths.
- Keep exact services deterministic.

## 8. Task execution and coordination

Persist:

```text
Task ID and parent
Tenant/workspace
Initiating principal
Delegation
Plan version
Dependencies
Owner and claim version
Status
Budget
Checkpoint
Artifacts
Approvals
Failure/recovery state
```

Require:

- Atomic ownership or equivalent coordination.
- Lease/stale-worker handling.
- Fencing or equivalent rejection of stale owners.
- Event deduplication.
- Bounded retries.
- Cancellation propagation.
- Resource accounting across descendants.
- Reconciliation of uncertain external outcomes.

```mermaid
stateDiagram-v2
    [*] --> Proposed
    Proposed --> Ready: Scope and authority validated
    Ready --> Running: Claimed
    Running --> Waiting: Dependency or approval
    Waiting --> Running: Conditions satisfied
    Running --> Verifying: Execution ended
    Verifying --> Completed: Acceptance met
    Verifying --> Inconclusive: Evidence insufficient
    Running --> Failed: Unrecoverable failure
    Running --> Cancelled: Cancellation reconciled
    Failed --> Ready: Authorized recovery
```

Task lifecycle and improvement lifecycle are separate state machines.

## 9. Identity, authorization, and accountability

### Canonical entities

```text
User
External identity
Tenant
Membership
Workspace
Role
Permission
Scoped role binding
Service principal
Agent instance/run
Delegation
Approval
Audit event
```

### Enforcement

Use a policy decision mechanism and enforcement points across APIs, tools, jobs, retrieval, and storage access.

Effective delegated authority must not exceed:

```text
Initiator authority
∩ tenant/resource policy
∩ tool policy
∩ explicit delegation
∩ current approval
```

Require stable identities, controlled account linking, secure sessions, appropriate step-up, revocation behavior, and attributable audit evidence.

Telemetry context is not an authorization credential.

## 10. Data architecture

Define authoritative stores and derived representations.

Separate:

- Conversation history.
- Durable task state.
- Business records.
- Agent memory.
- Knowledge sources.
- Artifacts.
- Evaluation data.
- Audit evidence.

For each asset specify:

```text
Owner
Tenant scope
Source
Schema
Purpose
Quality expectations
Retention
Deletion
Backup
Recovery
Permitted learning use
```

Prevent silent persistence failures. Verify critical writes through appropriate transaction, read-back, reconciliation, or other integrity mechanisms.

Use object storage, relational storage, search, or vector indexes according to measured requirements—not fashion.

## 11. Contracts and integration

Use approved formats as applicable:

- OpenAPI for HTTP APIs.
- JSON Schema for structured payloads.
- AsyncAPI where useful for asynchronous contracts.
- Explicit event envelopes.
- Versioned tool schemas.

Events include identity, version, tenant scope, correlation, and idempotency information where appropriate.

### Emerging protocols

Evaluate MCP for tool/data integration and agent-to-agent protocols only when interoperability is needed.

MCP connectivity does not replace application authorization. Cloudflare’s MCP guidance explicitly distinguishes authentication from delegated resource authorization and supports narrowly scoped integrations. [developers.cloudflare](https://developers.cloudflare.com/agents/model-context-protocol/)

Pin supported protocol versions and test compatibility.

## 12. RSI control plane

```mermaid
flowchart LR
    O[Observed outcome] --> H[Hypothesis]
    H --> C[Isolated candidate]
    C --> E[Protected evaluation]
    E --> D{Decision}
    D -->|Reject or inconclusive| L[Learning record]
    D -->|Pass| A[Required approval]
    A --> R[Limited rollout]
    R --> M[Monitor]
    M -->|Regression| B[Rollback or compensation]
    M -->|Benefit verified| L
    B --> L
    L --> H
```

### Candidate classes

- Parameters/configuration.
- Prompts/models/routing.
- Tools/workflows.
- Architecture/code.
- Improvement policies.

Each class needs an appropriate evaluation path.

### Protected invariants

Candidates cannot alter their own:

- Passing criteria.
- Held-out promotion data.
- Permission boundaries.
- Spending limits.
- Approval requirements.
- Audit integrity.
- Reviewer independence.

Governance changes follow a separate human-governed process.

## 13. Reliability and service management

Define approved:

- Service indicators and objectives.
- Recovery point/time objectives.
- Error budgets where appropriate.
- Capacity and fairness policies.
- Degraded modes.
- Provider-failure handling.
- Incident severity.
- Runbooks.
- Continuity exercises.

Use ITIL-informed distinction between incident restoration, problem investigation, change authorization, release, deployment, and continual improvement.

Maintain PMI-informed ownership, dependencies, scope, resources, risk, and benefit tracking. Pin the adopted PMBOK edition rather than mixing edition-specific terminology. PMI guidance supports tailored predictive, agile, and hybrid approaches. [pmi](https://www.pmi.org/standards/pmbok)

## 14. Observability and audit

Instrument:

```text
Request
Tenant/workspace
Task
Agent run
Tool call
Approval
Candidate
Evaluation
Release
```

Use OpenTelemetry-compatible signals and context propagation where supported. OpenTelemetry separates traces, metrics, and logs and enables correlation through propagated context. [1002][1008]

Apply redaction, access controls, cardinality limits, and retention.

Keep audit evidence distinct from diagnostic logs. Define behavior when mandatory audit persistence fails.

## 15. Secure engineering and supply chain

Require:

- Maintained dependencies.
- Lockfiles.
- Secret scanning.
- Appropriate static/dependency analysis.
- Minimal automation permissions.
- Reviewed workflow changes.
- Artifact identification.
- Provenance/SBOM requirements appropriate to risk.
- Protected release environments.

Generated code is untrusted until reviewed and verified.

Authorized adversarial testing requires scope, methods, limits, stop conditions, and data-handling rules.

## 16. Release, migration, and rollback

Follow:

```text
Issue
→ specification
→ tests
→ implementation
→ PR
→ independent review
→ required CI
→ authorized merge
→ post-merge verification
→ authorized rollout
→ observation
```

Record:

```text
Source SHA
Artifact digest
Configuration version
Schema/migration version
Prompt/model/tool versions
Evaluation evidence
Approval
Environment
Recovery target
```

Prefer incremental migration and compatibility-preserving transitions.

Do not assume code rollback reverses database changes or external actions.

## 17. Emerging technology adoption gate

Evaluate new technologies through a bounded experiment.

| Candidate | Adopt only when it addresses |
|---|---|
| Graph-based orchestration | Explicit dependencies or adaptive branching |
| Sandboxed execution | Approved generated-code or untrusted-workload needs |
| Vector/hybrid retrieval | Demonstrated retrieval requirements |
| Policy engine | Meaningful policy complexity and consistent enforcement |
| Durable workflow runtime | Recovery and long-running coordination |
| MCP/agent protocols | Actual integration or interoperability requirements |
| Specialized models | Measurable quality, latency, or cost needs |

Document maturity, licensing, security, portability, cost, operational burden, and exit strategy.

“Emerging” is not a reason to bypass assurance.

## 18. Architecture verification

Required evidence depends on the change:

| Area | Evidence |
|---|---|
| Function | Unit/integration/end-to-end tests |
| Agent quality | Task-specific evaluations |
| Tenancy | Cross-tenant negative tests |
| Delegation | Scope and approval enforcement |
| Persistence | Integrity and recovery tests |
| Concurrency | Ownership, duplication, and stale-worker tests |
| Migration | Compatibility and rollback/compensation |
| Operations | Monitoring and recovery exercises |
| Performance | Controlled measurements |
| Documentation | Text, diagrams, contracts, and implementation agree |

Support accepted, rejected, blocked, and inconclusive outcomes.

## 19. Documentation and governance integration

Apply `documentation.md` to every task.

Maintain canonical:

- Strategy and roadmap links.
- Architecture views.
- ADRs.
- Contracts.
- Agent registry.
- Security model.
- Data lineage.
- Runbooks.
- Evaluation and outcome records.

Update relevant text and Mermaid source together. GitHub supports Mermaid in Markdown; syntax checks must still be paired with semantic review. [docs.github](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/creating-diagrams)

Historical decisions remain historical. Supersede rather than silently rewrite them.

## 20. Implementation sequence

| Stage | Deliverable | Gate |
|---|---|---|
| 0 | Repository baseline and document reconciliation | Current state understood |
| 1 | Identity, tenant, policy, and data ownership | Boundaries verified |
| 2 | One durable hybrid workflow | Recovery and permissions demonstrated |
| 3 | Independent evaluation and evidence | Bad candidate rejected |
| 4 | Controlled release and observation | Actual outcomes verified |
| 5 | Bounded adaptation | Budgets, audit, stop controls pass |
| 6 | Architecture-improvement candidates | Non-domain capability improved |
| 7 | Governed meta-improvement | Protected criteria remain intact |

Do not enable later-stage autonomy merely because its code exists.

## 21. First assignment to the agent fleet

> Read `AGENTS.md`, the existing `documentation.md`, `design.md`, and `architecture.md`. Assess current implementation against them and return a requirement-to-evidence matrix.
>
> Identify conflicts, missing decisions, and the smallest useful vertical slice. Produce issue-sized work with named owners, acceptance criteria, evaluations, risks, and recovery plans.
>
> Implement only after required authorization. Keep canonical documentation synchronized in the same PR. Complete the current implementation issue’s merge and required verification before starting the next, unless an explicit exception authorizes parallel work.
>
> Do not change governance, expand privileges, weaken evaluations, or claim conformance from documentation alone.

***

## Companion acceptance rule

These documents are successfully adopted when agents can demonstrate one complete, authorized improvement cycle:

> A real problem produces a versioned hypothesis; a bounded candidate is implemented; independent evidence accepts or rejects it; authorized rollout is observed; and the result informs the next decision—with the design, architecture, roadmap, and improvement record accurately synchronized under `documentation.md`.
