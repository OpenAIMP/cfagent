/**
 * #1726 (parent #1717, slice (f)): the SINGLE owner of the E*TRADE
 * order-execution gate — the port both the REST execute route and the
 * MCP etrade_execute_order command consume. Port-first (blueprint
 * #1795): pure module, no Cloudflare imports, no env, no network;
 * the only dependency is the trades record reader (a minimal
 * structural interface, so the gate is substitutable in tests).
 *
 * The gate encodes the REST route's checks VERBATIM (messages and
 * HTTP statuses copied from src/agents/routes/etradeBroker.ts):
 *   403 — authorizer DID is an agent DID (autonomous execution is
 *         strictly prohibited; orders require verified human auth).
 *   404 — no draft record exists for the order id.
 *   400 — the draft exists but is not in `previewed` status.
 *   422 — caller-supplied action/symbol/quantity differ from the
 *         stored draft (Strict Immutability Verification).
 * Order: 403 → 404 → 400, then (REST only, after the rejection
 * branch) the 422 immutability checks — the rejection branch must
 * run before immutability, exactly as the REST route does, because
 * rejecting a draft moves no funds and needs no parameter match.
 *
 * DID resolution preserves an explicit DID (the
 * trading/etrade/client.ts:905 rule): a sessionId/login that already
 * starts with `did:` is used as-is, so a `did:agent:` caller trips
 * the 403; anything else resolves via getUserDid to a
 * `did:user:github:<login>` (which can never be an agent DID).
 *
 * What this gate is NOT: it does not run the autopilot policy
 * verdict, the orders-today counter, or the expiry scheduler — those
 * are OrchestratorAgent host capabilities, available on the REST
 * surface and unavailable in MCP context. They are NOT re-implemented
 * here (a weaker re-implementation would be a defect); the residual
 * is stated in the #1726 §15. What the gate DOES guarantee on both
 * surfaces: no agent-DID execution, no execution without a previewed
 * draft, no execution of a draft in any other status, and — for
 * callers that supply execution parameters — no parameter drift from
 * the approved draft. MCP execute supplies NO parameters (orderId +
 * decision only), so its execution fields come exclusively from the
 * stored draft: parameter drift via the execute call is impossible
 * by construction, and the executed payload hash (audited by the
 * caller) is computed from those same stored fields.
 *
 * The gate is NEVER configurable: no switch, mode input, or scoped
 * value reaches this module. A caller that wants a different gate is
 * asking for a different issue.
 */

import { getUserDid } from "../agents/did";

export interface EtradeTradesReader {
  findById(id: string): any | null | undefined;
}

export interface EtradeGateOrm {
  trades?: EtradeTradesReader | null;
}

/** Typed gate failure: the HTTP status the REST route returns. */
export class EtradeGateError extends Error {
  readonly status: 403 | 404 | 400 | 422;
  constructor(status: 403 | 404 | 400 | 422, message: string) {
    super(message);
    this.name = "EtradeGateError";
    this.status = status;
  }
}

/**
 * DID-preserving authorizer resolution (client.ts:905 rule).
 * A `did:` input is used verbatim; anything else becomes a user DID.
 */
export function resolveEtradeAuthorizerDid(sessionIdOrLogin: string): string {
  const input = sessionIdOrLogin || "";
  if (input.startsWith("did:")) return input;
  return getUserDid(input);
}

/**
 * 403 → 404 → 400, in the REST route's order and wording.
 * Returns the stored draft record on success.
 */
export function checkEtradeExecuteGate(
  orm: EtradeGateOrm | undefined | null,
  args: { orderId: string; authorizerDid: string },
): any {
  const { orderId, authorizerDid } = args;
  if (authorizerDid.startsWith("did:agent:")) {
    throw new EtradeGateError(
      403,
      "HITL Enforcement: Autonomous trade execution is strictly prohibited. Orders require verified human authorization.",
    );
  }
  const existingRecord = orm?.trades?.findById(orderId);
  if (!existingRecord) {
    throw new EtradeGateError(
      404,
      `Order draft '${orderId}' not found. All orders must be previewed and drafted prior to execution.`,
    );
  }
  if (existingRecord.status !== "previewed") {
    throw new EtradeGateError(
      400,
      `Order draft '${orderId}' cannot be executed. Current status is '${existingRecord.status}'. Only 'previewed' drafts may be executed.`,
    );
  }
  return existingRecord;
}

/**
 * REST mapping for a gate failure: the Response the route returns.
 * Returns null for non-gate errors (the caller rethrows those).
 * Kept here so the dispatcher stays thin (the #359 <50 KB target).
 */
export function etradeGateErrorResponse(err: unknown): Response | null {
  if (err instanceof EtradeGateError) {
    return Response.json({ error: err.message }, { status: err.status });
  }
  return null;
}

/**
 * 422 Strict Immutability Verification (REST route wording). Only
 * supplied parameters are compared; absent parameters are not a
 * mismatch. MCP execute supplies none, so it never calls this.
 */
export function checkEtradeExecuteImmutability(
  existingRecord: any,
  caller: { action?: unknown; symbol?: unknown; quantity?: unknown },
): void {
  const reqAction = typeof caller.action === "string" ? caller.action.toUpperCase().trim() : "";
  if (reqAction && reqAction !== String(existingRecord.action || "").toUpperCase()) {
    throw new EtradeGateError(
      422,
      `Order Action Mismatch: Previewed action is '${existingRecord.action}', but execution request specifies '${reqAction}'. Submission rejected. A fresh preview is required.`,
    );
  }
  const reqSymbol = typeof caller.symbol === "string" ? caller.symbol.toUpperCase().trim() : "";
  if (reqSymbol && reqSymbol !== String(existingRecord.symbol || "").toUpperCase()) {
    throw new EtradeGateError(
      422,
      `Order Symbol Mismatch: Previewed symbol is '${existingRecord.symbol}', but execution request specifies '${reqSymbol}'. Submission rejected.`,
    );
  }
  if (caller.quantity !== undefined && Number(caller.quantity) !== Number(existingRecord.quantity)) {
    throw new EtradeGateError(
      422,
      `Order Quantity Mismatch: Previewed quantity is ${existingRecord.quantity}, but execution request specifies ${caller.quantity}. Submission rejected.`,
    );
  }
}
