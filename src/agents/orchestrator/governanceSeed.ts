/**
 * Issue #1559 ([AGENTIC] slice-0 cutover) — the governance halt
 * seed's execution, extracted from OrchestratorAgent following
 * the #992 decomposition pattern (thin delegating wrapper on the
 * class, execution here). This keeps orchestrator.ts within its
 * standing size budget.
 *
 * This function must run on the Orchestrator instance's storage:
 * the seed reads that instance's mas_settings adaptation.killSwitch
 * (the existing read path) and mirrors it into AgentDB. It never
 * writes the DO setting (mirror row only), and a second run is a
 * no-op. Throws when AGENT_DB is unbound — the caller surfaces
 * the error, never a fabricated result.
 */
import { createGovernanceAdapter } from "../../data/createGovernancePorts";
import { ensureGovernanceSchema } from "../../data/d1GovernanceAdapter";
import {
  seedGovernanceHalt,
  type DoSql,
  type GovernedHaltState,
} from "../../data/governedHalt";

export interface GovernanceSeedContext {
  doSql: DoSql;
  env: { AGENT_DB?: unknown };
}

export async function runGovernanceSeed(
  ctx: GovernanceSeedContext,
  setBy: string,
  tenantId: string,
): Promise<{ seeded: boolean; state: GovernedHaltState }> {
  const adapter = createGovernanceAdapter(ctx.env);
  if (!adapter) {
    throw new Error(
      "[data-foundation] AGENT_DB is not bound; cannot seed governance halt",
    );
  }
  await ensureGovernanceSchema(adapter.db);
  return seedGovernanceHalt({
    doSql: ctx.doSql,
    writer: adapter,
    tenantId,
    setBy,
    nowMs: Date.now(),
  });
}
