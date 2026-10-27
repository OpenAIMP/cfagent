/**
 * Issue #1468 ([AGENTIC] Phase 6, sub-issue of #1362) — governance wiring.
 *
 * Chains compile (Phase 2), synthesize behind a human confirmation gate
 * (Phase 3), reuse prior plans (Phase 4), and surface over MCP (Phase 5).
 * This module wires them to the SHIPPED governance machinery named on
 * #1362. It builds NO new governance machinery:
 *
 *  - Promotion (#1747, branch 2 — chain-native authority, superseding
 *    the #1468 reconciliation FOR CHAINS ONLY): a chain version reaches
 *    live use ONLY with a Phase 3 approval authorizing this chain's
 *    content, plus the registry verification recorded on the version,
 *    plus staged rollout. #759 verdicts are strategy-shaped evidence
 *    (counterfactual replay, z-test) and do not fit chains, which
 *    compose already-verified capabilities; the chain's held-out
 *    evidence mechanism is its shadow stage, with automatic rollback
 *    on failure signals. This module reads NO #759 verdict and mints
 *    NO verdicts. Phase 3 approval ALONE still does not satisfy the
 *    #759 shape — the authority here is the triple (approval +
 *    verification + staged rollout), not approval by itself. #759
 *    keeps serving strategy weights untouched (see stagedPromotion).
 *    RECONCILIATION UPDATE: the #1468 statement "Phase 3 approval
 *    does NOT satisfy the #759 shape on its own" stands for
 *    strategies; for chains it is superseded by this triple, which
 *    replaces the verdict requirement rather than re-checking it.
 *  - Rollback (#760): the shipped staged machinery is strategy-weight
 *    / D1 specific and cannot be invoked for chains directly, so chains
 *    follow its SHAPE — stage names (shadow → partial → full →
 *    completed), staged advance, automatic rollback on failure signals,
 *    exact prior-snapshot restore, audit through the #755 seam — over
 *    pure versioned chain records. The shape reuse is documented here,
 *    not disguised as a code call.
 *  - Kill (#756): TWO shipped layers, both used. The global switch
 *    (`adaptation.killSwitch` via shipped `isAdaptationHalted`) halts
 *    all governed firing; per-chain kill is the `killed` status on the
 *    Phase 3 record (durable in DO storage, enumerable via
 *    `listSynthesizedSchedules`, terminal against approval). No new
 *    switch store is introduced.
 *  - Audit (#755): chain runs write through shipped `recordAdaptation`
 *    to `mas_adaptation_audit` (subject = chain id, parameter = chain
 *    version). Capability versions come from the Phase 1 registry
 *    (status + verification ref — the registry carries no semver, so
 *    that pair IS the version).
 *
 * OUT OF SCOPE (disclosed follow-ups, not built here): real chain.run
 * executor wiring and firing/materialization for approved records.
 * The governed firing predicate below is the contract the firing path
 * must use: approved + unkilled + global halt clear.
 */
import { CAPABILITY_REGISTRY, type RegistryStatus } from "./capabilityRegistry";
import {
  shouldFireSynthesized,
  type SynthesizedSchedule,
} from "./jobSynthesis";
import {
  isAdaptationHalted,
  recordAdaptation,
  type AdaptationRecord,
} from "../services/adaptationAudit";
import type { CompiledChain, CompiledChainStep } from "../orchestrate";

/** #760 stage names, reused for chain versions. */
export type ChainPromotionStage =
  | "shadow"
  | "partial"
  | "full"
  | "completed"
  | "rolled_back";

/** A capability's version: the registry carries no semver, so the
 *  status + verification-test pair is the version (Phase 1 honesty
 *  rule: shipped means a test passes). */
export interface CapabilityVersion {
  id: string;
  status: RegistryStatus;
  verification: string | null;
}

export interface GovernedChainVersion {
  chainId: string;
  version: number;
  steps: Array<{ capabilityId: string; stage: CompiledChainStep["stage"] }>;
  capabilityVersions: CapabilityVersion[];
  /** "draft" until a Phase 3 approval promotes it to "shadow". */
  stage: "draft" | ChainPromotionStage;
  /** Version this version replaces; rollback restores it. Null for v1. */
  priorVersion: number | null;
  /**
   * Id of the Phase 3 approval record that authorized promotion to
   * "shadow", if any. Null until promoted. The approval's steps must
   * match this version's steps (see resolveChainAuthority); the
   * version's capabilityVersions carry the verification basis.
   */
  authorityRef: string | null;
  createdAt: string;
}

/**
 * Snapshot a compiled chain as a governed version. Capability stages
 * and versions are registry-derived, never caller-supplied; unknown or
 * planned-only capabilities are refused (same honesty rule as Phase 3
 * synthesis).
 */
export function versionChain(
  chainId: string,
  chain: CompiledChain,
  version: number,
  opts: { priorVersion?: number | null; createdAt?: string } = {},
): GovernedChainVersion {
  if (!chain || !Array.isArray(chain.steps) || chain.steps.length === 0) {
    throw new Error("Cannot govern: chain has no steps.");
  }
  const steps: GovernedChainVersion["steps"] = [];
  const capabilityVersions: CapabilityVersion[] = [];
  for (const step of chain.steps) {
    const entry = CAPABILITY_REGISTRY.find((e) => e.id === step.capabilityId);
    if (!entry) {
      throw new Error(`Cannot govern: unknown chain step capability: ${step.capabilityId}.`);
    }
    if (entry.status !== "shipped" && entry.status !== "in_flight") {
      throw new Error(
        `Cannot govern: chain step ${step.capabilityId} is not usable: registry status is "${entry.status}" (only shipped/in_flight capabilities may be governed).`,
      );
    }
    steps.push({ capabilityId: step.capabilityId, stage: entry.stage });
    capabilityVersions.push({
      id: entry.id,
      status: entry.status,
      verification: entry.verification,
    });
  }
  return {
    chainId,
    version,
    steps,
    capabilityVersions,
    stage: "draft",
    priorVersion: opts.priorVersion ?? null,
    authorityRef: null,
    createdAt: opts.createdAt ?? new Date().toISOString(),
  };
}

/**
 * Chain-native promotion authority (#1747, branch 2). The authority
 * is the triple:
 *  (1) registry verification — versionChain already refused
 *      unknown/planned-only capabilities and recorded each
 *      capability's status + verification ref on the version;
 *  (2) a Phase 3 approval record for THIS chain's content;
 *  (3) staged rollout — the shadow stage is the chain's held-out
 *      evidence mechanism (advanceChainPromotion rolls back
 *      automatically on failure signals).
 * No #759 verdict is read, minted, or implied anywhere here.
 */
export interface ChainPromotionAuthority {
  /** Id of the Phase 3 approval record that authorized promotion. */
  approvalId: string;
  /** When that approval was granted. */
  approvedAt: string;
}

/**
 * The authority binding: the approval record authorizes exactly the
 * chain content it was synthesized from. A version carries no goal
 * and no approval pointer of its own, so the binding is the ordered
 * capability list — the chain's content identity. Capability ids
 * (not step ids) are compared: step ids are synthesis artifacts,
 * capability ids are the registry identity. Length must match too:
 * a strict prefix is different content, not a subset approval.
 */
function stepsMatch(version: GovernedChainVersion, approval: SynthesizedSchedule): boolean {
  return (
    version.steps.length === approval.steps.length &&
    version.steps.every((s, i) => s.capabilityId === approval.steps[i].capabilityId)
  );
}

/**
 * Resolve the chain-native authority for a promotion, or throw.
 * Every refusal names its reason; there is no silent fallback and
 * no inferred approval — the caller presents the approval record,
 * this function verifies it. A pending record, a killed record
 * (killed is terminal against approval), a timestamp-less record
 * (never trust a hand-built record shape), and an approval for
 * different chain content are all "no authority".
 */
export function resolveChainAuthority(
  version: GovernedChainVersion,
  approval: SynthesizedSchedule,
): ChainPromotionAuthority {
  if (approval.status !== "approved") {
    throw new Error(
      `Cannot promote chain ${version.chainId} v${version.version}: approval record ${approval.id} is not approved (status is "${approval.status}") — promotion without authority is refused.`,
    );
  }
  const approvedAt = approval.approvedAt;
  if (approvedAt === null) {
    throw new Error(
      `Cannot promote chain ${version.chainId} v${version.version}: approval record ${approval.id} has no approval timestamp — promotion without authority is refused.`,
    );
  }
  if (!stepsMatch(version, approval)) {
    throw new Error(
      `Cannot promote chain ${version.chainId} v${version.version}: approval record ${approval.id} does not authorize this chain version (approved steps differ from the version's steps) — promotion without authority is refused.`,
    );
  }
  return { approvalId: approval.id, approvedAt };
}

/**
 * Promote a draft chain version to the #760 "shadow" stage. Refuses
 * without a Phase 3 approval authorizing this chain's content.
 * Only draft versions can be promoted; promotion never mutates its
 * input. The caller presents the approval record it holds (from the
 * Phase 3 record store); nothing is looked up, inferred, or minted
 * here.
 */
export function promoteChainVersion(
  version: GovernedChainVersion,
  approval: SynthesizedSchedule,
): GovernedChainVersion {
  if (version.stage !== "draft") {
    throw new Error(
      `Cannot promote chain ${version.chainId} v${version.version}: only a draft version can be promoted (stage is "${version.stage}").`,
    );
  }
  const authority = resolveChainAuthority(version, approval);
  return { ...version, stage: "shadow", authorityRef: authority.approvalId };
}

const NEXT_STAGE: Record<string, ChainPromotionStage> = {
  shadow: "partial",
  partial: "full",
  full: "completed",
};

/**
 * Advance one #760 stage, or roll back automatically on a failure
 * signal. On rollback the returned `restoredPriorVersion` names the
 * version the caller must restore (this module holds version records,
 * not the live chain pointer — the caller restores the snapshot).
 * Completed and rolled-back versions are terminal: a regressed change
 * must re-prove itself from scratch as a new version.
 */
export function advanceChainPromotion(
  version: GovernedChainVersion,
  signal: { failed?: boolean } = {},
): { version: GovernedChainVersion; restoredPriorVersion: number | null } {
  if (version.stage === "completed") {
    throw new Error(
      `Cannot advance chain ${version.chainId} v${version.version}: promotion is completed.`,
    );
  }
  if (version.stage === "rolled_back") {
    throw new Error(
      `Cannot advance chain ${version.chainId} v${version.version}: promotion was rolled back — re-prove from scratch as a new version.`,
    );
  }
  if (version.stage === "draft") {
    throw new Error(
      `Cannot advance chain ${version.chainId} v${version.version}: promote it with a Phase 3 approval first (draft has no stage to advance).`,
    );
  }
  if (signal.failed) {
    return {
      version: { ...version, stage: "rolled_back" },
      restoredPriorVersion: version.priorVersion,
    };
  }
  return {
    version: { ...version, stage: NEXT_STAGE[version.stage] },
    restoredPriorVersion: null,
  };
}

/**
 * Roll a staged version back to its prior snapshot. The returned record
 * is terminal (`rolled_back`); the caller restores `priorVersion`.
 * Completed promotions cannot roll back this way — they are done.
 */
export function rollbackChainVersion(
  version: GovernedChainVersion,
): GovernedChainVersion {
  if (version.stage === "draft") {
    throw new Error(
      `Cannot roll back chain ${version.chainId} v${version.version}: it was never promoted.`,
    );
  }
  if (version.stage === "completed") {
    throw new Error(
      `Cannot roll back chain ${version.chainId} v${version.version}: promotion is completed — supersede it with a new authorized version instead.`,
    );
  }
  if (version.stage === "rolled_back") return version;
  return { ...version, stage: "rolled_back" };
}

// ---------------------------------------------------------------------------
// Kill switch (#756 layers)
// ---------------------------------------------------------------------------

/**
 * Kill one synthesized record: pending/approved → killed. Killed is
 * terminal — re-kill is a no-op, and `approveSynthesizedRecord` throws
 * on killed records (see jobSynthesis.ts), so kill cannot be
 * resurrected through the approval path. Because
 * `shouldFireSynthesized` fires ONLY approved records, a killed record
 * never fires through any predicate built on it.
 */
export function killSynthesizedRecord(
  record: SynthesizedSchedule,
): SynthesizedSchedule {
  if (record.status === "killed") return record;
  return { ...record, status: "killed" };
}

/** Kill one record inside a list, by id. Throws on an unknown id;
 *  leaves every other record untouched. */
export function killSynthesizedInList(
  records: SynthesizedSchedule[],
  id: string,
): SynthesizedSchedule[] {
  const idx = records.findIndex((r) => r.id === id);
  if (idx < 0) {
    throw new Error(`Unknown synthesized schedule: ${id}.`);
  }
  if (records[idx].status === "killed") return records;
  return records.map((r, i) => (i === idx ? killSynthesizedRecord(r) : r));
}

/** Killed chains/schedules are enumerable: filter the stored list. */
export function listKilledSynthesized(
  records: SynthesizedSchedule[],
): SynthesizedSchedule[] {
  return records.filter((r) => r.status === "killed");
}

/**
 * The global #756 switch, exposed — this IS `isAdaptationHalted`, not
 * a second switch. When the global switch is thrown (or unreadable,
 * which fails closed in the shipped function), all governed firing
 * halts.
 */
export function isGovernedHalted(sql: any): boolean {
  return isAdaptationHalted(sql);
}

/**
 * The firing contract for governed chains. Builds on Phase 3's
 * `shouldFireSynthesized` (pending/killed never fire) and adds the
 * global #756 halt. Callers with D1 access pass
 * `halted: isGovernedHalted(sql)`; callers without it pass the halt
 * state they already know. Any future firing path MUST gate on this.
 */
export function shouldFireGoverned(
  record: SynthesizedSchedule,
  now: Date,
  opts: { halted?: boolean } = {},
): boolean {
  if (opts.halted) return false;
  return shouldFireSynthesized(record, now);
}

// ---------------------------------------------------------------------------
// Run attribution + #755 audit trail
// ---------------------------------------------------------------------------

export interface ChainRunAttribution {
  chainId: string;
  chainVersion: number;
  capabilityVersions: CapabilityVersion[];
  /** #1355 shape: chain shard ids in pipeline order. */
  shardProvenance: string[];
  outcome: "completed" | "failed" | "blocked" | "skipped";
  goal: string;
  runAt: string;
}

/** Attribute a chain run: what ran, which plan version, which
 *  capability versions, and the outcome. Pure — no store touched. */
export function attributeChainRun(
  version: GovernedChainVersion,
  run: {
    goal: string;
    shardProvenance: string[];
    outcome: ChainRunAttribution["outcome"];
    runAt?: string;
  },
): ChainRunAttribution {
  return {
    chainId: version.chainId,
    chainVersion: version.version,
    capabilityVersions: version.capabilityVersions,
    shardProvenance: run.shardProvenance,
    outcome: run.outcome,
    goal: run.goal,
    runAt: run.runAt ?? new Date().toISOString(),
  };
}

/** Map a run attribution onto the shipped #755 audit record shape:
 *  subject = chain id, parameter = chain version, dataWindow = the
 *  shard/provenance string. No new audit store: this record is written
 *  by `recordChainRunAudit` through shipped `recordAdaptation`. */
export function chainRunAuditRecord(
  attribution: ChainRunAttribution,
): AdaptationRecord {
  return {
    actor: "chain-run",
    subject: attribution.chainId,
    parameter: `chain-version:${attribution.chainVersion}`,
    before: `chain-version:${attribution.chainVersion}:pending`,
    after: `chain-version:${attribution.chainVersion}:${attribution.outcome}`,
    delta: null,
    rationale:
      `Chain run ${attribution.outcome} for goal "${attribution.goal}" ` +
      `(chain ${attribution.chainId} v${attribution.chainVersion}; ` +
      `capabilities: ${attribution.capabilityVersions.map((c) => `${c.id}@${c.status}`).join(", ") || "none"}).`,
    dataWindow:
      attribution.shardProvenance.length > 0
        ? attribution.shardProvenance.join(",")
        : "(no shards)",
  };
}

/** Write a chain run to the shipped #755 audit trail. Returns the
 *  audit row id. Delegates entirely to `recordAdaptation`. */
export function recordChainRunAudit(
  sql: any,
  attribution: ChainRunAttribution,
  now: Date = new Date(),
): string {
  return recordAdaptation(sql, chainRunAuditRecord(attribution), now);
}
