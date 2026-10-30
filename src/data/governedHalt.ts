/**
 * Issue #1548 ([AGENTIC] Slice 0) — the canonical halt setter and
 * the one-time cutover seed.
 *
 * Context: no in-repo writer for the `adaptation.killSwitch`
 * setting exists today — the shipped code only reads it
 * (`isAdaptationHalted` over the Orchestrator `mas_settings`
 * table). This module introduces the single writer going forward:
 * every halt transition writes BOTH the durable-object setting
 * (the existing read path) and the mirrored row (the new read
 * path). A future admin route calls `setGovernedHalt`; slice 0
 * proves it with tests and bridges current state with the seed.
 *
 * Safety-directed ordering (verified reasoning, see the ADR):
 * the ordering protects the TICK-FACING read path — the mirror —
 * on partial failure, because the tick is the safety-critical
 * firing path and the mirror is its source of truth.
 *  - SET (clear → halted): mirror FIRST, then the durable-object
 *    setting. If the setting write then fails, the error surfaces
 *    to the caller (never silent) and the mirror already reads
 *    halted, so the tick refuses to fire while the operator
 *    reconciles the setting. If the mirror write fails first, the
 *    setting is untouched and the error surfaces; the system stays
 *    in its previous state and the caller retries.
 *  - CLEAR (halted → clear): setting FIRST, then the mirror. If
 *    the mirror write then fails, the error surfaces and the
 *    mirror still reads halted, so the tick stays halted (safe
 *    side) while the operator reconciles. If the setting write
 *    fails first, nothing changes and the error surfaces.
 * In both directions a partial failure leaves the tick-facing
 * read halted OR the system unchanged — never silently clear.
 * Full convergence after any partial failure is the R5
 * reconciliation step (re-project durable-object state), which is
 * why a mirror failure must surface as an error, not a log line.
 *
 * The seed is a deliberate one-time step, NOT boot logic: it
 * copies the CURRENT durable-object state into the mirror once,
 * so a pre-existing halt is not invisible to the new read path.
 * It never writes the durable-object setting, and a second run is
 * a no-op (a mirror row already exists for the tenant).
 */
import {
  ADAPTATION_KILL_SWITCH_KEY,
  isAdaptationHalted,
} from "../services/adaptationAudit";
import { createSettingsPort } from "./createSettingsPorts";
import type {
  GovernanceHaltRow,
  GovernanceProjectionWriter,
  GovernanceStore,
} from "./governancePorts";

/** Minimal durable-object SQL surface (the incumbent `exec` idiom). */
export interface DoSql {
  exec: (query: string, ...args: unknown[]) => Iterable<unknown>;
}

export type GovernedHaltState = "halted" | "clear";

export interface SetGovernedHaltInput {
  doSql: DoSql;
  writer: GovernanceProjectionWriter;
  tenantId: string;
  scope?: "global" | "chain";
  scopeId?: string | null;
  state: GovernedHaltState;
  setBy: string;
  reason: string;
  nowMs: number;
}

function writeDoKillSwitch(
  doSql: DoSql,
  halted: boolean,
  nowMs: number,
): void {
  // The DO-side write routes through the dedicated settings
  // port (#2390, step 4g — the G-7 ruling): the port owns
  // mas_settings and its set() is the incumbent DELETE+INSERT
  // idiom (the table's key is its primary key; a bare INSERT
  // would fail on the second write). The caller-supplied
  // nowMs stays the row's timestamp. The dual-write ORDERING
  // protocol in setGovernedHalt below is unchanged — the port
  // neither joins nor reorders the two legs (two stores cannot
  // join one transaction unit; the ordering is the mechanism).
  createSettingsPort(doSql).set(
    ADAPTATION_KILL_SWITCH_KEY,
    halted ? "on" : "off",
    new Date(nowMs).toISOString(),
  );
}

/**
 * Set the governed halt, mirrored synchronously. Throws on any
 * partial failure (mirror or setting) — the caller must surface
 * it and reconcile; it is never swallowed.
 */
export async function setGovernedHalt(
  input: SetGovernedHaltInput,
): Promise<GovernanceHaltRow> {
  const scope = input.scope ?? "global";
  const scopeId = input.scopeId ?? null;
  const row: GovernanceHaltRow = {
    eventId: `halt:${input.tenantId}:${scope}:${scopeId ?? "-"}:${input.nowMs}:${input.state}`,
    tenantId: input.tenantId,
    scope,
    scopeId,
    state: input.state,
    setBy: input.setBy,
    setAtMs: input.nowMs,
    reason: input.reason,
    version: 1,
    provenance: "governed-halt-setter",
  };
  if (input.state === "halted") {
    await input.writer.recordHalt(row);
    writeDoKillSwitch(input.doSql, true, input.nowMs);
  } else {
    writeDoKillSwitch(input.doSql, false, input.nowMs);
    await input.writer.recordHalt(row);
  }
  return row;
}

export interface SeedGovernanceHaltInput {
  doSql: DoSql;
  writer: GovernanceStore;
  tenantId: string;
  setBy: string;
  nowMs: number;
}

export interface SeedGovernanceHaltResult {
  seeded: boolean;
  state: GovernedHaltState;
}

/**
 * One-time cutover seed: mirror the CURRENT durable-object halt
 * state. Returns seeded:false when a mirror row already exists
 * for the tenant (a second run is a no-op). Never writes the
 * durable-object setting. Never called on boot — the operator
 * runs it once at cutover (see the ADR for the procedure).
 */
export async function seedGovernanceHalt(
  input: SeedGovernanceHaltInput,
): Promise<SeedGovernanceHaltResult> {
  const existing = await input.writer.latestHalt(input.tenantId, {
    scope: "global",
  });
  if (existing !== null) {
    return { seeded: false, state: existing.state };
  }
  const halted = isAdaptationHalted(input.doSql);
  const state: GovernedHaltState = halted ? "halted" : "clear";
  await input.writer.recordHalt({
    eventId: `seed:${input.tenantId}:global:${input.nowMs}`,
    tenantId: input.tenantId,
    scope: "global",
    scopeId: null,
    state,
    setBy: input.setBy,
    setAtMs: input.nowMs,
    reason: "one-time cutover seed from mas_settings adaptation.killSwitch",
    version: 1,
    provenance: "seed:cutover",
  });
  return { seeded: true, state };
}
