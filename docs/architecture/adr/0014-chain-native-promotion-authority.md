# ADR 0014: Chain-native promotion authority — approval + verification + staged rollout replaces #759 verdicts for chains

- Status: Accepted
- Date: 2026-10-27
- Deciders: owner (branch 2 approved via option tap 2026-10-27), #CAIO-quns
- Issue: #1747 (unblocks #1257; follows #1468, closed — referenced, never reopened)
- Implementing PR: (this slice's PR; main commit, when merged)
- Supersedes: #1468 reconciliation decision 1 ("Phase 3 approval does NOT
  satisfy the #759 shape on its own"), FOR CHAINS ONLY. That decision
  lives in the #1468 issue body and the `chainGovernance.ts` module
  header, not in an ADR, so no ADR status change applies; the module
  header is updated by this slice to record the supersession in code.
- Related: #1257 (retirement; COO lane — this ADR is the unblock
  evidence, not the retirement), #759/#760 machinery (unchanged for
  strategy weights), #755 audit, #756 kill

## Context

`src/agentic/chainGovernance.ts` consumed #759 promotion-gate verdicts
as chain-version promotion authority: `findPassingGateVerdict` returned
the latest passing verdict naming the chain, and `promoteChainVersion`
moved a draft version to `shadow` only with such a verdict, recording
`gateVerdictId`. That import is what blocked #1257's retirement, whose
acceptance criteria require the #757–#760 modules (including
`promotionGate`, #759) to be deleted after migration.

Migration of gate consumption to challenger verdicts was already
attempted from the COO side and proven infeasible (#1257 comment
6399136347): the ChallengerKind closed union has no chain kind, the
evidence leg for chains is empty, and no gateVerdictId-bearing
transition exists. That branch is closed and is not re-proposed here.

Two facts shape the replacement. First, #759 evidence is
strategy-shaped in kind, not just in degree: a passing verdict
requires counterfactual replay on a bounded window disjoint from every
prior window, sample >= 20, a delta in the expected direction, a
one-sided z-test at p < 0.05, and human approval decided AFTER the
held-out evaluation. Chains compose already-verified capabilities —
the Phase 1 rule is that a capability's status + verification-test
pair IS its version — so there is no chain counterfactual to replay
and no chain pnl to z-test. Second, no production caller invokes
`promoteChainVersion` or `runPromotionGate` today, so chain promotion
is refuse-by-default in practice; the migration changes the contract
for the future caller, and the tests must prove the new contract, not
the absence of callers.

## Decision

Chain promotion authority is the triple, enforced by
`resolveChainAuthority` and consumed by `promoteChainVersion`:

1. **Registry verification.** `versionChain` already refuses
   unknown/planned-only capabilities and records each capability's
   status + verification ref on the version. The version's
   `capabilityVersions` carry the verification basis; no new store.
2. **A Phase 3 approval record for this chain's content.** The caller
   presents the approval record it holds (from the Phase 3 record
   store, enumerated via `listSynthesizedSchedules` — the existing
   store, no new store). The binding is the ordered capability list:
   the approval's steps must equal the version's steps, capability
   ids in order, lengths equal. A version carries no goal and no
   approval pointer of its own, so the content list is the honest
   link; a strict prefix is different content, not a subset approval.
   Step ids are NOT compared (they are synthesis artifacts; capability
   ids are the registry identity). Approval alone is NOT the
   authority — it is one leg of the triple.
3. **Staged rollout.** `advanceChainPromotion` (shadow → partial →
   full → completed, automatic rollback on failure signals,
   completed/rolled-back terminal) is unchanged. The shadow stage IS
   the chain's held-out evidence mechanism: a version proves itself
   in shadow before it advances, and a failure signal rolls it back.

`promoteChainVersion(version, approval)` refuses unless the version
is a draft AND `resolveChainAuthority` passes; on success it records
`authorityRef` (the approval record's id) and moves the version to
`shadow`, never mutating its input. `GovernedChainVersion.gateVerdictId`
is renamed to `authorityRef` — no field named for a verdict points at
nothing. `findPassingGateVerdict` is deleted. `chainGovernance.ts`
has no import from `promotionGate` (verified by grep + import graph).

Fail-closed contract, proven by test: a pending record, a killed
record (killed is terminal against approval), an approved record
with a null timestamp (never trust a hand-built record shape), and
an approval for different chain content are all refusals, each
naming its reason. No code path promotes without authority; no
promotion without evidence, no placeholder evidence, no exemption
that changes a categorical honesty invariant.

## Consequences

- #1257's unblock branch (2)/(3) is satisfied by migration, not by
  declaration or by design alone: the import is gone, and the COO
  lane can restart the retirement through the full gate (including
  the live GET /adaptation/promotions/active empty check, which is
  the COO lane's check, not this slice's).
- #759 semantics for strategy weights are UNCHANGED:
  `src/services/stagedPromotion.ts` (the weights consumer) is
  untouched, and `promotionGate` keeps serving weights until #1257
  retires it after route migration + staged-promotion drain. This
  slice removes only the chain consumer.
- Phase 3 approval semantics are UNCHANGED (confirmation gate
  inviolable): `approveSynthesizedRecord` and the pending → approved
  → killed transitions are untouched. Kill terminality, the staged
  rollback shape, and #755 audit attribution (subject = chain id,
  parameter = chain version) are unchanged, proven by the untouched
  kill/audit test coverage.
- The #1468 reconciliation is superseded FOR CHAINS ONLY: approval
  alone still does not satisfy the #759 shape, but approval +
  verification + staged rollout replaces the verdict requirement
  for chains, because chains differ from strategies in kind. For
  strategies, the #759 shape stands exactly as before.
- Future upgrade note (not built here): if a chain-id registry ever
  lands, the approval binding should upgrade from steps-equality to
  id-equality. Steps-equality is the honest binding available from
  shipped data today; inventing an id link would be the placeholder
  this ADR refuses.

## Alternatives considered

- **Branch 1 (stability declaration + dependency removal).** Rejected
  as the outcome (not chosen by the owner): deleting the verdict
  requirement with no named replacement authority leaves promotion
  with no evidence at all, violating #1747's own exclusion — unless
  the owner explicitly declares the existing wiring sufficient, which
  is a judgment call, not a design.
- **Branch 3 (chain-evaluation design only).** Rejected as the
  outcome (not chosen by the owner): a design doc satisfies #1747's
  letter but leaves the import in place, so #1257's mechanical
  revisit check (grep the import gone, trial branch typechecks)
  still fails. It is a design, not a completion.
- **Challenger-verdict migration (#1257 option (a)).** Closed by
  #1257 comment 6399136347; not reconsidered.
- **Minting chain verdicts from a new chain-evaluation store.**
  Rejected for this slice: it requires a chain-evaluation design
  (branch 3) plus a new minting path and store, and it re-creates a
  verdict-shaped authority for something that is not a statistical
  claim. The triple reuses shipped machinery (registry, Phase 3
  records, staged rollout) instead of inventing a store.
- **Keeping `gateVerdictId` as the field name.** Rejected: a field
  named for a verdict that no longer exists would mislead every
  future reader about what authorized the promotion.
