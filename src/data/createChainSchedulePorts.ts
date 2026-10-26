/**
 * Issue #1651 ([AGENTIC] Slice 1) — composition root for the
 * chain/schedule ports (R1). This is the ONLY module that maps a
 * Worker binding to a port implementation: domain code imports
 * this helper and the port types, never a store client.
 *
 * Absence of the binding is a normal, non-error state:
 * `createChainScheduleAdapter` returns null and callers keep
 * their legacy behavior (the DO transition already committed;
 * projection is best-effort). A projection failure never throws
 * to the transition caller — it is logged and reported, and the
 * operator reconciles it through the admin-gated route.
 */
import {
  createD1ChainScheduleDb,
  D1ChainScheduleAdapter,
  ensureChainScheduleSchema,
} from "./d1ChainScheduleAdapter";
import type {
  ChainRow,
  ChainScheduleStore,
  ScheduleRow,
} from "./chainSchedulePorts";
import {
  projectTransition,
  type ChainScheduleTransition,
  type DoScheduleRecord,
  type ProjectTransitionResult,
} from "./chainScheduleProjection";

/** Build the chain/schedule adapter from Worker env, or null if unbound. */
export function createChainScheduleAdapter(env: {
  AGENT_DB?: unknown;
}): D1ChainScheduleAdapter | null {
  if (!env.AGENT_DB) return null;
  return new D1ChainScheduleAdapter(
    createD1ChainScheduleDb(env.AGENT_DB as D1Database),
  );
}

export interface ProjectAfterTransitionInput {
  tenantId: string;
  workspaceId: string;
  record: DoScheduleRecord;
  transition: ChainScheduleTransition;
  nowMs: number;
}

/**
 * Best-effort projection after a DO transition has committed.
 * Never throws: unbound env is a no-op, and a store failure is
 * logged and reported for later reconciliation.
 */
export async function projectAfterTransition(
  env: { AGENT_DB?: unknown },
  input: ProjectAfterTransitionInput,
): Promise<ProjectTransitionResult> {
  try {
    const adapter = createChainScheduleAdapter(env);
    if (!adapter) {
      return { projected: false, skipped: true };
    }
    await ensureChainScheduleSchema(adapter.db);
    return await projectTransition({
      store: adapter,
      tenantId: input.tenantId,
      workspaceId: input.workspaceId,
      record: input.record,
      transition: input.transition,
      nowMs: input.nowMs,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      "[data-foundation] Chain/schedule projection failed; transition already committed, reconcile later:",
      message,
    );
    return { projected: false, error: message };
  }
}

/** Tenant-scoped latest-row read from the projection only. */
export async function readChainStatus(
  env: { AGENT_DB?: unknown },
  tenantId: string,
  chainId: string,
): Promise<{ chain: ChainRow | null; schedule: ScheduleRow | null } | null> {
  const adapter = createChainScheduleAdapter(env);
  if (!adapter) return null;
  await ensureChainScheduleSchema(adapter.db);
  const [chain, schedule] = await Promise.all([
    adapter.latestChain(tenantId, chainId),
    adapter.latestSchedule(tenantId, chainId),
  ]);
  return { chain, schedule };
}

export type { ChainScheduleStore };
