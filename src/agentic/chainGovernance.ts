/**
 * Issue #1468 ([AGENTIC] Phase 6, sub-issue of #1362) — governance wiring.
 *
 * Chains compile (Phase 2), synthesize behind a human confirmation gate
 * (Phase 3), reuse prior plans (Phase 4), and surface over MCP (Phase 5).
 * This module wires them to the SHIPPED governance machinery named on
 * #1362. It builds NO new governance machinery:
 *
 *  - Promotion (#759): a chain version reaches live use ONLY with a
 *    passing #759 gate verdict naming the chain. The verdict is written
 *    by shipped `runPromotionGate` and read here via shipped
 *    `listGateVerdicts` — this module mints NO verdicts, recomputes NO
 *    significance, and re-checks NO approval. RECONCILIATION: Phase 3
 *    approval does NOT satisfy the #759 shape on its own — it supplies
 *    the human-approval leg only, with no held-out evidence. The gap is
 *    wired with the shipped gate, not a second approval gate: Phase 3
 *    approval remains the schedule-confirmation step; gate-verdict
 *    promotion is the chain-version step. Neither replaces the other.
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
import { listGateVerdicts } from "../services/promotionGate";
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
  /** "draft" until a passing #759 verdict promotes it to "shadow". */
  stage: "draft" | ChainPromotionStage;
  /** Version this version replaces; rollback restores it. Null for v1. */
  priorVersion: number | null;
  /** Id of the passing #759 verdict that promoted this version, if any. */
  gateVerdictId: string | null;
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
    gateVerdictId: null,
    createdAt: opts.createdAt ?? new Date().toISOString(),
  };
}

/**
 * The #759 gate, consumed — never minted. Returns the latest passing
 * verdict naming this chain from the shipped verdict store, or null.
 * A failed verdict, a verdict for another chain, and no verdict at all
 * are all "no gate pass".
 */
export function findPassingGateVerdict(sql: any, chainId: string) {
  const verdicts = listGateVerdicts(sql, chainId);
  return verdicts.find((v) => v.passed) ?? null;
}

/**
 * Promote a draft chain version to the #760 "shadow" stage. Refuses
 * without a passing #759 verdict naming the chain. Only draft versions
 * can be promoted; promotion never mutates its input.
 */
export function promoteChainVersion(
  version: GovernedChainVersion,
  sql: any,
): GovernedChainVersion {
  if (version.stage !== "draft") {
    throw new Error(
      `Cannot promote chain ${version.chainId} v${version.version}: only a draft version can be promoted (stage is "${version.stage}").`,
    );
  }
  const verdict = findPassingGateVerdict(sql, version.chainId);
  if (!verdict) {
    throw new Error(
      `Cannot promote chain ${version.chainId} v${version.version}: no passing promotion-gate verdict (#759) names this chain — promotion without the gate is refused.`,
    );
  }
  return { ...version, stage: "shadow", gateVerdictId: verdict.id };
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
      `Cannot advance chain ${version.chainId} v${version.version}: promote it through the gate first (draft has no stage to advance).`,
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
      `Cannot roll back chain ${version.chainId} v${version.version}: promotion is completed — supersede it with a new gated version instead.`,
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
