/**
 * Issue #2460 (Agent Mesh S19, programme #2225 G13c) — the
 * per-door cost-budget guard: the SubrequestBudget one-ledger /
 * hard-cap shape (#1204, src/trading/optionsScreener.ts) applied
 * to the registry's per-door budget records
 * (MESH_DOOR_COST_BUDGETS in src/agents/registry.ts).
 *
 * The shape is deliberately the fleet's existing one: ONE ledger
 * per budget scope, charged synchronously at the seam, so
 * concurrent calls cannot overspend; `used`/`exhausted` are the
 * whole state. What this module adds over the raw ledger is the
 * honesty discipline the registry records:
 *
 *  - "enforced" records refuse over-cap charges by throwing
 *    MeshDoorBudgetError with the stable code
 *    MESH_DOOR_BUDGET_EXCEEDED. Charging an enforced record
 *    without a ledger is a wiring error and fails loud — an
 *    enforced budget that silently no-ops is a fabricated
 *    control.
 *  - "accounting-only" records accumulate into a supplied ledger
 *    and never refuse: the door is metered (its real charges are
 *    recorded by its accounting source) but carries no cap.
 *  - "not-measurable" records charge nothing and touch no
 *    ledger: nobody measured the cost, so there is nothing
 *    honest to charge.
 *
 * This is substrate, not a billing system. The caps that bind in
 * production today are PaymentsAgent's BudgetGuard caps, named
 * on the chat-turn and A2A records; this guard is the mechanism
 * a future door-level cap is charged through once the metering
 * its record names exists (the registry records each gap).
 */
import type { MeshDoorCostBudgetEntry } from "../agents/registry";

/** Stable refusal code for an over-cap charge on an enforced door. */
export const MESH_DOOR_BUDGET_EXCEEDED = "MESH_DOOR_BUDGET_EXCEEDED";
/** Stable code for a charge that is itself malformed. */
export const MESH_DOOR_BUDGET_INVALID_COST = "MESH_DOOR_BUDGET_INVALID_COST";
/** Stable code for charging an enforced record with no ledger. */
export const MESH_DOOR_BUDGET_LEDGER_MISSING = "MESH_DOOR_BUDGET_LEDGER_MISSING";

/** A coded budget refusal — callers match on `code`, never on prose. */
export class MeshDoorBudgetError extends Error {
  readonly code: string;
  readonly door: string;

  constructor(code: string, door: string, message: string) {
    super(message);
    this.name = "MeshDoorBudgetError";
    this.code = code;
    this.door = door;
  }
}

/**
 * One door-budget ledger (SubrequestBudget's shape, cost-weighted):
 * shared across every charge in its scope, charged synchronously,
 * so the bound applies to the scope and not to each caller.
 */
export interface MeshDoorBudgetLedger {
  readonly limit: number;
  used: number;
  exhausted: boolean;
  /** Charge `cost` units; false (and nothing charged) when over the limit. */
  tryConsume(cost?: number): boolean;
}

export function createMeshDoorBudgetLedger(limit: number): MeshDoorBudgetLedger {
  const ledger: MeshDoorBudgetLedger = {
    limit: Math.max(0, limit),
    used: 0,
    exhausted: false,
    tryConsume(cost = 1) {
      if (ledger.used + cost > ledger.limit) {
        ledger.exhausted = true;
        return false;
      }
      ledger.used += cost;
      if (ledger.used >= ledger.limit) ledger.exhausted = true;
      return true;
    },
  };
  return ledger;
}

/** What one charge did — the verdict a seam logs or surfaces. */
export interface DoorBudgetCharge {
  /** True when the cost was recorded into the ledger. */
  charged: boolean;
  /** True when this record's cap is enforced (a refusal was possible). */
  enforced: boolean;
  used: number;
  limit: number | null;
}

/**
 * Charge `cost` (in the record's unit) against a door's budget.
 * Throws MeshDoorBudgetError only for an enforced record's
 * over-cap charge, an enforced record charged without a ledger,
 * or a malformed cost — accounting-only and not-measurable
 * records return their verdict instead of refusing.
 */
export function chargeDoorBudget(
  record: MeshDoorCostBudgetEntry,
  ledger: MeshDoorBudgetLedger | null,
  cost: number,
): DoorBudgetCharge {
  if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) {
    throw new MeshDoorBudgetError(
      MESH_DOOR_BUDGET_INVALID_COST,
      record.door,
      `door budget charge for ${record.door} must be a finite, non-negative cost; got ${String(cost)}`,
    );
  }
  switch (record.enforcement) {
    case "enforced": {
      if (!ledger) {
        throw new MeshDoorBudgetError(
          MESH_DOOR_BUDGET_LEDGER_MISSING,
          record.door,
          `door ${record.door} has an enforced cost budget but was charged without a ledger — the cap cannot be evaluated`,
        );
      }
      if (!ledger.tryConsume(cost)) {
        throw new MeshDoorBudgetError(
          MESH_DOOR_BUDGET_EXCEEDED,
          record.door,
          `door budget exceeded for ${record.door}: ${ledger.used} + ${cost} > ${ledger.limit} ${record.unit}`,
        );
      }
      return { charged: true, enforced: true, used: ledger.used, limit: ledger.limit };
    }
    case "accounting-only": {
      if (ledger) ledger.tryConsume(cost);
      return {
        charged: ledger !== null,
        enforced: false,
        used: ledger?.used ?? 0,
        limit: ledger?.limit ?? null,
      };
    }
    case "not-measurable": {
      // Nobody measured this cost; charging a number anyway
      // would fabricate the accounting the record says is absent.
      return { charged: false, enforced: false, used: ledger?.used ?? 0, limit: null };
    }
  }
}
