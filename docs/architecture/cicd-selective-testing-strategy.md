# CI/CD Selective Testing Strategy & Architectural Guidance

## Executive Summary

As software codebases and test suites grow, running the entire test suite on every single feature branch push becomes a major bottleneck for developer velocity and CI cost. Moving to **selective testing** (running only tests affected by changed code) is an effective solution.

However, running limited tests on feature branches introduces potential risk if not paired with appropriate safety gates. This document outlines an architectural framework for executing affected tests, maintaining zero-regression guarantees, evaluating `main` branch test execution policy, and choosing modern Trunk-Based release workflows over intermediate branches.

---

## 1. How to Execute Tests Affecting Changes (Test Impact Analysis)

To run only tests affected by a change, CI pipelines employ **Test Impact Analysis (TIA)** techniques. TIA can be implemented at three levels depending on project maturity:

### A. Static Import Dependency Graph Analysis (Recommended Baseline)
Modern test runners build a module dependency graph during execution or static analysis:
- **Vitest**: `vitest run --changed` (runs tests for modified files) or `vitest related src/utils/math.ts` (runs tests that import modified files).
- **Jest**: `jest --onlyChanged` or `jest --findRelatedTests $(git diff --name-only origin/main...HEAD)`.
- **Monorepos (Turborepo / Nx)**:
  - Turborepo: `turbo run test --filter=...[HEAD^1]` (runs tests in affected workspaces and their downstream dependents).
  - Nx: `nx affected:test --base=origin/main`.

### B. Dynamic Code Coverage Tracing & Predictive Selection (Advanced)
For large or non-JavaScript/TypeScript codebases:
- **Coverage Mapping**: CI tools record line/method coverage for every test during full runs. When a source line changes, CI executes only tests known to execute that line.
- **Predictive Test Selection (PTS)** (e.g. Launchable, Datadog Test Optimization, Gradle Predictive Test Selection): Uses machine learning models to analyze git diffs, historical test results, and file churn to predict and run the top 10% of tests most likely to fail.

---

## 2. Ensuring Operational Health & Preventing Regressions

Executing a subset of tests on feature branches introduces the risk of missing indirect failures (e.g., changes in global state, shared database schemas, unimported side effects, or distant contracts). To guarantee full system health without losing fast developer feedback, adopt a **Multi-Tiered Safety Net Strategy**:

```
 [ Feature Branch PR ] ──► Tier 1: Fast Gate (TIA Affected Tests + Typecheck)
                                │ (Pass)
                                ▼
 [ Merge Queue / Gate ] ──► Tier 2: Integration Gate (Affected Tests + Bite-Proof Pins)
                                │ (Pass)
                                ▼
 [ Main Branch Commit ] ──► Tier 3: Asynchronous Full Test Suite Execution
                                │ (Pass)
                                ▼
 [ Nightly / Scheduled] ──► Tier 4: Full E2E, Performance & Penetration Suite
```

### Key Safety Net Mechanisms

1. **Bite-Proof Invariants & Critical Path Pins**:
   - Always run a mandatory set of **Critical Path Invariant Suites** (e.g., core authentication, payment processing, router/API inventories, database migration sanity) regardless of which files changed.
   - In this repository, for example, route inventory tests (`tests/thin_router_inventory.test.ts`) and security contract pins are always executed to protect core contracts.

2. **Strict Static Type Checking & Linting**:
   - Run global type checks (`tsc --noEmit`) and linter checks on every PR. Static type systems catch a large percentage of cross-module interface regressions instantly without running heavy runtime tests.

3. **Asynchronous Post-Merge Full Suite Runs**:
   - Feature branches run limited tests for fast feedback (< 2–3 minutes). Upon merge into `main`, the full test suite runs asynchronously.

4. **Production Observability & Post-Deploy Automated Verification**:
   - Deploys are protected by automated post-deployment smoke tests (`scripts/qa-smoke.mjs`), canary releases, and error-budget-based auto-rollback mechanisms.

---

## 3. Should We Still Run the Full Test Suite on `main`?

### Decision: **YES, absolutely.**

Even when feature branches perform clean rebases on `main` before merging, running the full test suite on `main` post-merge remains **mandatory**.

### Technical Rationale:

1. **Race Conditions and Semantic Conflicts in Concurrent Merges**:
   - Scenario: Developer A branches from `main` (commit X) and Developer B branches from `main` (commit X). Both rebase and test independently.
   - Developer A merges into `main` first (commit Y).
   - Developer B's PR was tested against commit X. Even if Developer B rebases on Y, if another PR merges right before B, `main` advances to commit Z.
   - When A and B land together, their changes may interact semantically (e.g. Developer A modifies a service function signature, Developer B adds a new call to the old signature). Neither PR failed in isolation, but `main` is now broken.

2. **Environment Context and Secret Security Boundaries**:
   - For security, pull request workflows on untrusted or fork branches often run with restricted secrets (e.g., read-only credentials, mocked API keys) to prevent secret exfiltration.
   - The `main` branch pipeline runs in a fully trusted environment with access to actual staging/integration credentials, validating true end-to-end integration.

3. **Single Source of Truth Protection**:
   - `main` is the canonical reference branch for all production deployments, hotfixes, and new feature forks. Unverified code on `main` risks propagating bugs to all future branches.

4. **Catching Flaky & Environmental Regressions**:
   - Full suite execution on `main` produces historical telemetry to detect flaky tests, memory leaks, or environmental drift before they block developer PRs.

---

## 4. Intermediate Branches vs. Modern Trunk-Based Development

### Recommendation: **Avoid long-lived intermediate branches (`staging`, `develop`). Adopt Trunk-Based Development with Merge Queues.**

### The Problems with Intermediate Branches (`staging` / `develop`):

| Issue | Impact |
|---|---|
| **Environment Drift** | `staging` and `main` inevitably diverge in commit history, making fixes tested on `staging` behave differently when deployed to `main`. |
| **"Merge Hell" & Integration Delays** | Batching multiple feature branches into `develop` delays feedback, complicates bisection, and makes identifying the author of a regression difficult. |
| **Double Overhead** | Developers must manage PRs to `develop`, then secondary PRs from `develop` to `main`, doubling CI runs and code review maintenance. |

### The Superior Modern Approach:

#### 1. Trunk-Based Development with GitHub Merge Queues

```
Feature Branch A ──┐
                   ├─► [ GitHub Merge Queue ] ──► (Validates combined HEAD against current main) ──► [ main ] ──► Deploy
Feature Branch B ──┘
```

- **How it works**:
  - Developers work on short-lived feature branches targeting `main`.
  - When approved, PRs enter the **Merge Queue**.
  - The Merge Queue automatically creates temporary draft merge commits combining `main` with queued PRs in sequence.
  - It runs the required CI test suite on the exact combined state. If a PR breaks the combination, it is removed from the queue without affecting `main`.

#### 2. Progressive Delivery & Feature Flags

- **Decouple Deployment from Release**:
  - Code is merged to `main` and continuously deployed to production behind **Feature Flags** (Dark Launching).
  - New code is tested safely in production by internal users or small canary cohorts before being enabled globally.

#### 3. Ephemeral Preview Environments

- **On-Demand Staging**:
  - Instead of a shared, static `staging` branch, spin up ephemeral preview environments per PR (e.g., Cloudflare Workers preview URLs, Vercel Preview Deployments).
  - Preview environments are automatically destroyed when the PR merges, eliminating intermediate branch maintenance while providing 100% realistic integration testing.

---

## Summary Matrix: Optimal CI/CD Pipeline Architecture

| Stage | Trigger | Test Scope | Goal |
|---|---|---|---|
| **Feature Branch PR** | Push to PR | Affected Tests (TIA) + Typecheck + Lint + Fast Gates | Developer velocity (< 3 mins feedback) |
| **Merge Queue** | PR Approved | Affected Tests + Critical Path Invariant Pins against latest queued `main` | Prevent integration race conditions before landing |
| **Main Branch** | Push / Merge to `main` | Full Test Suite + Production Build + Deployment Verification | Guarantee canonical system operational health |
| **Post-Deploy** | Post Deployment | Automated Smoke Tests + Synthetic Monitoring | Verify live environment health |
| **Scheduled / Nightly** | Cron (e.g. Midnight) | Full E2E, Load Testing, Security Scans, Dependency Audits | Catch slow drift and deep regressions |
