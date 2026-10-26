/**
 * Issue #1688 ([AGENTIC] Slice 3) — composition root for audit
 * + report ports (mirrors src/data/createChainSchedulePorts.ts).
 *
 * This is the ONLY module besides the adapters that may
 * touch the AGENT_DB binding, and it never lets a missing
 * binding throw: an unbound environment yields a null
 * adapter, a skipped audit write, and null reads. Callers
 * decide what null means (the read routes answer 503; the
 * projection paths treat it as a no-op).
 */
import {
  createD1AuditReportDb,
  D1AuditReportAdapter,
  ensureAuditReportSchema,
} from "./d1AuditReportAdapter";
import type {
  AuditEventDraft,
  AuditEventRow,
  CanonicalReportRow,
} from "./auditReportPorts";
import {
  recordAuditEvent,
  type RecordAuditEventResult,
} from "./auditReportProjection";

type EnvWithAgentDb = { AGENT_DB?: unknown };

/** Null when AGENT_DB is not bound; never throws. */
export function createAuditReportAdapter(
  env: EnvWithAgentDb,
): D1AuditReportAdapter | null {
  if (!env.AGENT_DB) return null;
  return new D1AuditReportAdapter(createD1AuditReportDb(env.AGENT_DB));
}

let auditEventCounter = 0;

/**
 * Best-effort audit write. Never throws: an unbound store is
 * a no-op and a store failure is reported, so an audit
 * failure can never fail the transition or run that produced
 * the event. Event ids carry a process counter so two events
 * for the same subject in the same millisecond stay distinct.
 */
export async function recordAuditEventBestEffort(
  env: EnvWithAgentDb,
  draft: AuditEventDraft,
  nowMs: number,
): Promise<RecordAuditEventResult & { skipped?: boolean }> {
  const adapter = createAuditReportAdapter(env);
  if (!adapter) {
    return { recorded: false, skipped: true };
  }
  try {
    await ensureAuditReportSchema(adapter.db);
    const eventId =
      `${draft.eventKind}:${draft.subjectType}:${draft.subjectId}:${nowMs}:${auditEventCounter++}`;
    return await recordAuditEvent(adapter, draft, eventId, nowMs);
  } catch (err) {
    return {
      recorded: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Tenant-scoped audit history for one chain, newest first.
 * Null when AGENT_DB is not bound.
 */
export async function readAuditHistory(
  env: EnvWithAgentDb,
  tenantId: string,
  chainId: string,
): Promise<AuditEventRow[] | null> {
  const adapter = createAuditReportAdapter(env);
  if (!adapter) return null;
  await ensureAuditReportSchema(adapter.db);
  return adapter.listAuditForChain(tenantId, chainId);
}

/**
 * Tenant-scoped canonical reports: one report when reportId
 * is given, otherwise latest per report, newest first.
 * Null when AGENT_DB is not bound.
 */
export async function readReports(
  env: EnvWithAgentDb,
  tenantId: string,
  reportId?: string | null,
): Promise<CanonicalReportRow[] | null> {
  const adapter = createAuditReportAdapter(env);
  if (!adapter) return null;
  await ensureAuditReportSchema(adapter.db);
  if (reportId) {
    const row = await adapter.latestReport(tenantId, reportId);
    return row ? [row] : [];
  }
  return adapter.listReports(tenantId);
}
