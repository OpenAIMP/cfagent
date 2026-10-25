Frame this as an **evidence-driven transformation mandate**, not “make everything an agent.” It should require the agent to inspect the existing system, design the target architecture, and implement improvements in controlled phases.

For RSI, use “bounded recursive improvement”: the system can propose and test improvements to its own prompts, policies, tools, or code, but promotion requires independent evidence and authorization. Do not make ASI a deliverable or acceptance criterion; describe the capabilities you actually want.

Below is a ready-to-use instruction you can give the implementation agent.

## Transformation mandate

```markdown
# Agentic Architecture Transformation Mandate

## Mission

Transform the existing solution into a robust, goal-directed, multi-agent
system that can plan, execute, observe, adapt, collaborate, evaluate its
results, and propose evidence-backed improvements.

Use Cloudflare Think (`@cloudflare/think`) for agent roles designated by
the approved architecture. Verify capabilities against installed versions.

Preserve existing working functionality, security boundaries, and
deterministic business logic.

Do not:
- Turn every service into an LLM agent.
- Add agent tiers merely for architectural symmetry.
- Describe unverified capabilities as autonomous or self-improving.
- Promise artificial general intelligence or artificial superintelligence.
- Treat model self-assessment as sufficient evidence of correctness.
- Deploy self-generated changes without the required authorization.

The objective is measurable capability, reliability, and adaptability,
not the number of agents or the appearance of sophistication.

## 1. Scope and authorization

This is a staged transformation.

Begin with discovery, assessment, and design.
Do not begin implementation until the architecture and first increment
are approved.

Separate these authorizations:
1. Assess and document.
2. Modify local implementation.
3. Open or update external issues/PRs.
4. Provision infrastructure.
5. Deploy.
6. Execute consequential business actions.

Approval for one stage does not authorize the others.

If instructed to document the work for later, create a follow-up plan
only. Do not begin implementation or create external records without
permission.

## 2. Establish the actual baseline

Inspect the repository rather than assuming the previous assessment
fully describes it.

Inventory:
- User journeys and business capabilities.
- Existing agents, services, tools, workflows, and Durable Objects.
- Actual routing and execution paths.
- Think/Agents SDK versions and deployed configuration.
- State, memory, databases, queues, and artifacts.
- Model providers and tool integrations.
- Existing tests, evaluations, telemetry, and failure handling.
- Permission and approval boundaries.
- Current latency, cost, reliability, and quality evidence.

Verify the reported components, including where present:
- Orchestrator and ResearchAgent.
- `mas.ts` dispatch/tool factory.
- Screener and NLQ functionality.
- Trading research and execution boundaries.
- Payments drafting and payment execution boundaries.
- Judge/evaluation routing.
- Search and report generation.
- Scheduled and other non-chat services.

Do not assume a component exists, is active, or needs replacement merely
because it appears in a prior report.

Produce an as-is architecture and a requirements-to-implementation map.

## 3. Define measurable target capabilities

For each capability, specify:
- Current behavior.
- Desired behavior.
- Business value.
- Required autonomy.
- Risks.
- Acceptance tests.
- Evidence needed to claim completion.

Address:

### Goal-directed execution
Accept a goal, define completion criteria, create a plan, and track progress.

### Closed-loop operation
Observe outcomes, compare them with expectations, and select the next action.

### Adaptive planning
Revise plans when tools fail, evidence changes, assumptions break, or
dependencies become unavailable.

### Delegation and collaboration
Assign bounded work, exchange artifacts, resolve dependencies, and
integrate results.

### Durable execution
Recover or reconcile work after interruption without silently losing
progress or duplicating consequential actions.

### Memory
Retain useful, attributable information under explicit privacy,
retention, correction, and deletion policies.

### Evaluation
Assess outputs against task-specific, independently checkable criteria.

### Controlled improvement
Generate and test improvement candidates without allowing the system to
silently rewrite its own constraints or production behavior.

## 4. Capability allocation: agent, tool, workflow, or service

For every capability, compare these implementation choices:

- Existing deterministic service.
- Tool callable by an agent.
- Durable workflow.
- Specialist agent.
- Shared infrastructure.
- Human decision.

Assign an agent only when the task benefits from judgment, uncertain
planning, interpretation, or dynamic tool selection.

Keep exact calculations, authorization, accounting, schema validation,
and other deterministic rules in independently testable code.

Produce:

Capability | Current implementation | Target form | Rationale |
Alternatives rejected | Risk | Verification

Agentification is a design decision, not a default.

## 5. Design the target agent topology

Use role labels as working definitions, not mandatory framework types.

### Coordinator / deep-execution role
Owns the task-level plan, budgets, dependencies, progress, and completion.
Decomposes complex work and replans when evidence changes.

### Domain sub-agents
Own bounded domains such as research, screening, NLQ, or reporting where
the assessment establishes a benefit.

### Micro-agents
Perform narrowly scoped judgment tasks with small budgets and explicit
input/output contracts.

Use deterministic validators instead when no model judgment is needed.

### Evaluator roles
Assess artifacts against independent criteria.
Do not rely exclusively on the implementer evaluating its own output.

For every proposed agent define:
- Purpose and non-goals.
- Identity, tenant scope, and task scope.
- Inputs and structured outputs.
- Allowed tools and data.
- Memory ownership.
- Delegation permissions.
- Time, token, cost, depth, and concurrency limits.
- Completion, failure, escalation, and cancellation conditions.
- Recovery and idempotency requirements.
- Evaluation criteria.

Do not require all tiers if a simpler topology performs better.

## 6. Implement real autonomous coordination

A shared repository or instruction file is insufficient.

Specify:
- Durable task records.
- Explicit state transitions.
- Atomic claiming or equivalent ownership control.
- Message/event delivery.
- Recipient activation.
- Dependency resolution.
- Heartbeats, leases, or another stale-worker policy.
- Deduplication.
- Immutable artifact references.
- Cancellation propagation.
- Conflict resolution.
- Bounded review/rework loops.

Distinguish task state from conversation history.

Use MCP, A2A, SDK calls, or internal interfaces only when justified.
Protocols do not replace authorization, delivery guarantees, or lifecycle
management.

## 7. Design memory deliberately

Separate:
- Current-turn context.
- Task working state.
- Conversation history.
- Durable user/tenant facts.
- Reusable domain knowledge.
- Evaluation and improvement records.

For stored information include, where applicable:
- Provenance.
- Timestamp.
- Confidence.
- Owner and access scope.
- Expiration.
- Correction/deletion mechanism.

Treat retrieved memory as evidence, not executable instructions.

Do not store speculative model conclusions as verified facts.
Do not let one tenant's experience leak into another tenant's context.

## 8. Define bounded adaptation

The system may adapt within approved policies, for example:
- Choose among approved tools.
- Change task decomposition.
- Retry using approved alternatives.
- Request clarification.
- Escalate to another specialist.
- Stop when evidence or budget is insufficient.

The system may not autonomously:
- Expand its permissions.
- Remove approval requirements.
- Increase spending limits.
- Rewrite evaluation criteria to pass.
- Change production configuration.
- Deploy new code.
- Execute unauthorized financial or payment actions.

Define every adaptive policy explicitly and record its decisions.

## 9. Controlled recursive-improvement loop

Implement improvement as a separate, auditable pipeline:

Observe failure or opportunity
→ Collect evidence
→ Propose a bounded change
→ Create an isolated candidate
→ Run tests and evaluations
→ Compare with baseline
→ Independent review
→ Approval where required
→ Canary or limited rollout
→ Monitor
→ Promote or roll back

Potential improvement targets:
- Prompts.
- Routing policies.
- Tool selection.
- Retrieval configuration.
- Memory policies.
- Task decomposition.
- Application code.

Do not assume this changes the underlying model's weights.

Requirements:
- Version all candidates and results.
- Maintain representative regression cases and held-out evaluations.
- Test adversarial, failure, security, cost, and latency behavior.
- Evaluate against the unchanged acceptance criteria.
- Track regressions, not just aggregate improvements.
- Limit experiments and spend.
- Keep rollback artifacts.
- Prevent evaluators from being silently modified by candidates.
- Never use production users as an undisclosed experiment.

Failed hypotheses must remain recorded.
An improvement claim requires comparative evidence.

## 10. Domain safety

For trading functionality:
- Separate research, recommendations, paper execution, and live execution.
- Keep calculations and risk limits deterministic.
- Never infer trade authorization from a research request.
- Preserve quote provenance and uncertainty.
- Do not optimize solely for premium collection or backtest return.

For payments:
- Separate drafting from approval and submission.
- Bind authorization to the exact target, amount, and action.
- Use idempotency and reconciliation.

Apply equivalent controls to other consequential domains.

## 11. Think conformance

For each designated Think agent, verify:
- Supported APIs for the installed version.
- Actual entrypoint and routing.
- Model/tool loop ownership.
- Persistence and session handling.
- Streaming and interrupted-turn recovery.
- Delegation behavior.
- Authorization.
- Runtime integration tests.

Do not build a competing manual agent loop without a documented need.
Do not migrate infrastructure-only components to Think for consistency.

Report framework adoption separately from production readiness.

## 12. Delivery phases and gates

### Phase 0: Discovery
Deliver baseline, as-is map, missing requirements, and risk register.

### Phase 1: Architecture
Deliver capability allocation, target topology, contracts, permission model,
memory design, and measurable acceptance criteria.

Gate: architecture approval.

### Phase 2: One vertical slice
Implement one bounded user journey end to end.
Demonstrate delegation, recovery, evaluation, and escalation.

Gate: evidence that the slice improves on the existing baseline.

### Phase 3: Incremental migration
Migrate additional capabilities separately.
Preserve rollback and avoid a big-bang rewrite.

### Phase 4: Bounded adaptation
Enable approved adaptive behavior with budgets and audit records.

### Phase 5: Improvement pipeline
Enable isolated experiments and review-based promotion.
Do not equate this with unrestricted self-modification.

## 13. Required deliverables

1. Executive assessment.
2. As-is architecture.
3. Target architecture.
4. Capability-to-component allocation.
5. Agent catalog and contracts.
6. Task/message state model.
7. Permission and approval matrix.
8. Memory and data-governance design.
9. Evaluation and benchmark plan.
10. Threat model and failure-mode analysis.
11. Incremental implementation backlog.
12. Rollout and rollback plan.
13. Evidence ledger: demonstrated, inferred, unverified, not applicable.

For each increment report:
- Files/components affected.
- Tests actually executed.
- Measured outcomes.
- Remaining limitations.
- Approval needed for the next stage.

## 14. Success criteria

Success means the implementation demonstrates:
- Correct goal completion.
- Useful delegation without unnecessary complexity.
- Safe adaptation to failures and changing evidence.
- Recoverable task execution.
- Enforced permissions and budgets.
- Reproducible evaluations.
- Measurable improvements over the previous baseline.
- Traceable human oversight at consequential boundaries.

Agent count, framework adoption, fluent explanations, and agents agreeing
with one another are not sufficient success criteria.
```

## Suggested message to accompany it

> Start with Phase 0 and Phase 1 only. Audit the existing implementation, identify which functionality should remain deterministic, and design the smallest justified Think-based multi-agent architecture. Include bounded autonomy, durable coordination, adaptive planning, and a separately governed improvement pipeline. Do not implement, deploy, or create external issues yet. Return an evidence-backed design and phased backlog for approval.

That gives the agent permission to design a substantial transformation without giving it permission to turn an ambiguous “state of the art” objective into an uncontrolled rewrite.
