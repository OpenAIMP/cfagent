/**
 * Issue #945, Slice 4 — bounded, revocable agent delegation (pure policy).
 *
 * This module is deliberately NOT live enforcement. It does not touch
 * any agent, task, job, execution flow, route, API, storage backend,
 * session, or existing permission check, and it changes no production
 * delegation, permission, or session. A later slice wires these pure
 * rules into live call sites; until then they are testable policy,
 * not behaviour change, and nothing here should be read as a claim
 * that live agent/task execution is currently governed by it.
 *
 * Effective authority, as an intersection (spec §5, #945 §5):
 *   effective authority = initiator (delegator holds the permission
 *     in the tenant, checked through the Slice 3 PDP at creation)
 *     ∩ tenant policy (the delegation's tenant; a delegation from
 *       Tenant A grants nothing in Tenant B)
 *     ∩ resource policy (the delegation's resourceScope, when a
 *       resource is named at use time)
 *     ∩ delegation (not revoked, not expired, budget not exhausted,
 *       action delegated, delegate named)
 *     ∩ approval (Slice 5/6 territory: NOT built here; the caller
 *       supplies an approvalValid flag at use time, and an explicit
 *       false denies. Absence of the flag means no approval gate
 *       was applied by the caller — it is not evidence of approval.)
 * A missing factor denies. No single factor ever grants.
 *
 * What is covered:
 * - Delegation records: delegator principal, delegate agent,
 *   tenant, explicit allowedActions (from the Slice 3 permission
 *   matrix, never a new permission model), resourceScope, expiry,
 *   an optional action-count budget, and a re-delegation flag.
 * - Creation rule: a delegation can only grant permissions the
 *   delegator themselves holds in that tenant (Slice 3 PDP). A
 *   delegation can never expand scope beyond the delegator.
 * - Use checks: expired, revoked, wrong delegate, cross-tenant,
 *   un-delegated action, out-of-scope resource, exhausted budget,
 *   and invalid approval all deny. Budget consumption is pure:
 *   authorizeDelegatedAction returns a new delegation copy with
 *   usedActions incremented on allow (unchanged on deny); it does
 *   not mutate the record passed in or any store. The caller
 *   persists the returned copy if it wants the count to stick.
 * - Revocation: revokeDelegation and revokeAllForUser. A revoked
 *   delegation is unusable on the next check.
 * - Re-check rule for delayed/consequential execution: a
 *   delegation valid at creation must be re-checked at execution
 *   time. recheckDelegation performs that check without consuming
 *   budget; authorizeDelegatedAction always re-checks, so
 *   creation-time validity never persists by assumption.
 * - Re-delegation: only when the original allows it, and the new
 *   grant is bounded by the original's actions, scope, expiry, and
 *   remaining budget — never wider, never longer, never more total
 *   actions than the original had left. Re-delegation authority derives
 *   from the original delegation, not from a fresh PDP check of
 *   the re-delegating agent (an agent principal may hold no
 *   membership of its own).
 *
 * What is NOT covered, explicitly:
 * - Approval workflows (Slice 5/6): no approval record is created,
 *   validated, or invalidated here.
 * - Audit events (Slice 5): decisions are returned, not recorded.
 * - Live enforcement at agents, tasks, jobs, tools, or execution
 *   (later wiring).
 * - Identity: identity here is the Slice 1 stable internal user id
 *   for the delegator and an agent principal id for the delegate.
 *   Email and display login are NOT inputs to any function in this
 *   module, so an email change cannot create or transfer authority.
 * - Cost budgets: the budget here is an action count only. The
 *   spec §4 maxCost field is not modelled until a cost model
 *   exists; claiming a cost budget from this module would be false.
 *
 * Resource-scope semantics, stated so callers cannot misread them:
 * an empty resourceScope means the delegation is not resource-
 * restricted within its tenant (tenant-scoped for its actions);
 * a non-empty resourceScope restricts a use request that names a
 * resource to exactly those resources. A use request that names no
 * resource is not resource-checked (the permission check governs).
 *
 * Time is always a caller-supplied `nowMs` seam, never Date.now()
 * inside a decision, so every rule is testable at its exact boundary.
 * Identifiers are trimmed and compared exactly, as in Slices 1–3: no
 * case folding, no URL canonicalization. Expiry is exclusive: a
 * delegation is expired once nowMs reaches expiresAtMs.
 */

import {
  authorize,
  PERMISSIONS,
} from "./authorization";
import type { MembershipStore, Permission } from "./authorization";

// ---------------------------------------------------------------------------
// Delegation records and store
// ---------------------------------------------------------------------------

export interface DelegationBudget {
  /** Maximum number of allowed actions before the delegation is exhausted. */
  maxActions?: number;
}

export interface Delegation {
  id: string;
  delegatorInternalUserId: string;
  delegateAgentId: string;
  tenantId: string;
  allowedActions: Permission[];
  /** Empty = not resource-restricted within the tenant (see header). */
  resourceScope: string[];
  expiresAtMs: number;
  budget?: DelegationBudget;
  usedActions: number;
  reDelegationAllowed: boolean;
  revoked: boolean;
  revokedAtMs?: number;
  createdAtMs: number;
  /** Optional task this delegation was created for (traceability only). */
  taskId?: string;
}

export interface DelegationStore {
  get(id: string): Promise<Delegation | null>;
  put(delegation: Delegation): Promise<void>;
  listByDelegator(delegatorInternalUserId: string): Promise<Delegation[]>;
}

export function createMemoryDelegationStore(): DelegationStore {
  const byId = new Map<string, Delegation>();

  return {
    async get(id: string): Promise<Delegation | null> {
      return byId.get(id) ?? null;
    },
    async put(delegation: Delegation): Promise<void> {
      byId.set(delegation.id, delegation);
    },
    async listByDelegator(delegatorInternalUserId: string): Promise<Delegation[]> {
      return [...byId.values()].filter(
        (d) => d.delegatorInternalUserId === delegatorInternalUserId,
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

export type DelegationErrorCode =
  | "INVALID_DELEGATOR"
  | "INVALID_DELEGATE"
  | "INVALID_TENANT"
  | "INVALID_PERMISSION"
  | "EMPTY_ALLOWED_ACTIONS"
  | "INVALID_EXPIRY"
  | "INVALID_BUDGET"
  | "DELEGATOR_LACKS_PERMISSION";

export type DelegationResult =
  | { ok: true; delegation: Delegation }
  | { ok: false; code: DelegationErrorCode; error: string };

export interface CreateDelegationInput {
  delegatorInternalUserId: string;
  delegateAgentId: string;
  tenantId: string;
  allowedActions: Permission[];
  resourceScope: string[];
  expiresAtMs: number;
  budget?: DelegationBudget;
  reDelegationAllowed: boolean;
  nowMs: number;
  taskId?: string;
}

const MAX_FIELD_LENGTH = 512;

function isValidField(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.trim().length <= MAX_FIELD_LENGTH
  );
}

function normalize(value: string): string {
  return value.trim();
}

/**
 * Create a delegation, but only for permissions the delegator holds
 * in the tenant (Slice 3 PDP, one check per requested permission).
 * Any failure writes nothing to the store.
 */
export async function createDelegation(
  memberships: MembershipStore,
  delegations: DelegationStore,
  input: CreateDelegationInput,
): Promise<DelegationResult> {
  if (!isValidField(input.delegatorInternalUserId)) {
    return { ok: false, code: "INVALID_DELEGATOR", error: "delegatorInternalUserId must be a non-empty string" };
  }
  if (!isValidField(input.delegateAgentId)) {
    return { ok: false, code: "INVALID_DELEGATE", error: "delegateAgentId must be a non-empty string" };
  }
  if (!isValidField(input.tenantId)) {
    return { ok: false, code: "INVALID_TENANT", error: "tenantId must be a non-empty string" };
  }
  if (!Array.isArray(input.allowedActions) || input.allowedActions.length === 0) {
    return { ok: false, code: "EMPTY_ALLOWED_ACTIONS", error: "at least one allowed action is required" };
  }
  for (const action of input.allowedActions) {
    if (!(PERMISSIONS as readonly string[]).includes(String(action))) {
      return { ok: false, code: "INVALID_PERMISSION", error: `unknown permission: ${String(action)}` };
    }
  }
  if (!Array.isArray(input.resourceScope)) {
    return { ok: false, code: "INVALID_TENANT", error: "resourceScope must be an array" };
  }
  if (typeof input.expiresAtMs !== "number" || input.expiresAtMs <= input.nowMs) {
    return { ok: false, code: "INVALID_EXPIRY", error: "expiresAtMs must be after nowMs" };
  }
  if (
    input.budget?.maxActions !== undefined &&
    (typeof input.budget.maxActions !== "number" ||
      !Number.isInteger(input.budget.maxActions) ||
      input.budget.maxActions < 0)
  ) {
    return { ok: false, code: "INVALID_BUDGET", error: "budget.maxActions must be a non-negative integer" };
  }
  // The delegator cannot grant what they do not hold in this tenant.
  for (const action of input.allowedActions) {
    const decision = await authorize(memberships, {
      actorInternalUserId: input.delegatorInternalUserId,
      tenantId: input.tenantId,
      permission: action,
      nowMs: input.nowMs,
    });
    if (decision.decision === "deny") {
      return {
        ok: false,
        code: "DELEGATOR_LACKS_PERMISSION",
        error: `delegator does not hold permission in this tenant: ${action}`,
      };
    }
  }
  const delegation: Delegation = {
    id: crypto.randomUUID(),
    delegatorInternalUserId: normalize(input.delegatorInternalUserId),
    delegateAgentId: normalize(input.delegateAgentId),
    tenantId: normalize(input.tenantId),
    allowedActions: [...input.allowedActions],
    resourceScope: input.resourceScope.map((r) => normalize(String(r))),
    expiresAtMs: input.expiresAtMs,
    budget: input.budget ? { ...input.budget } : undefined,
    usedActions: 0,
    reDelegationAllowed: input.reDelegationAllowed,
    revoked: false,
    createdAtMs: input.nowMs,
    taskId: input.taskId ? normalize(input.taskId) : undefined,
  };
  await delegations.put(delegation);
  return { ok: true, delegation };
}

// ---------------------------------------------------------------------------
// Use checks (pure: returns a new delegation copy, never mutates input)
// ---------------------------------------------------------------------------

export type DelegatedDenyReason =
  | "DELEGATION_REVOKED"
  | "DELEGATION_EXPIRED"
  | "DELEGATE_MISMATCH"
  | "CROSS_TENANT"
  | "ACTION_NOT_DELEGATED"
  | "OUT_OF_RESOURCE_SCOPE"
  | "BUDGET_EXHAUSTED"
  | "APPROVAL_INVALID"
  | "UNKNOWN_PERMISSION";

export interface DelegatedActionRequest {
  delegateAgentId: string;
  tenantId: string;
  permission: Permission;
  resourceId?: string;
  /** Caller-supplied approval flag (Slice 5/6 territory); explicit false denies. */
  approvalId?: string;
  approvalValid?: boolean;
  nowMs: number;
}

export interface DelegatedActionDecision {
  decision: "allow" | "deny";
  reason: "ALLOW" | DelegatedDenyReason;
  /** New copy: usedActions incremented on allow, unchanged on deny. */
  delegation: Delegation;
  policyVersion: string;
}

export const DELEGATION_POLICY_VERSION = "iaaa-delegation-1";

/** Validity of a delegation alone, without consuming budget. */
export function recheckDelegation(
  delegation: Delegation,
  nowMs: number,
):
  | { valid: true; reason: "VALID" }
  | { valid: false; reason: "DELEGATION_REVOKED" | "DELEGATION_EXPIRED" } {
  if (delegation.revoked) return { valid: false, reason: "DELEGATION_REVOKED" };
  if (delegation.expiresAtMs <= nowMs) return { valid: false, reason: "DELEGATION_EXPIRED" };
  return { valid: true, reason: "VALID" };
}

/**
 * Authorize one delegated action. Every factor is re-checked at
 * execution time; a delegation valid at creation is never assumed
 * still valid. On allow, the returned copy has usedActions + 1.
 */
export function authorizeDelegatedAction(
  delegation: Delegation,
  request: DelegatedActionRequest,
): DelegatedActionDecision {
  const deny = (reason: DelegatedDenyReason): DelegatedActionDecision => ({
    decision: "deny",
    reason,
    delegation: { ...delegation },
    policyVersion: DELEGATION_POLICY_VERSION,
  });
  if (!(PERMISSIONS as readonly string[]).includes(String(request.permission))) {
    return deny("UNKNOWN_PERMISSION");
  }
  const validity = recheckDelegation(delegation, request.nowMs);
  if (!validity.valid) return deny(validity.reason);
  if (normalize(request.delegateAgentId) !== delegation.delegateAgentId) {
    return deny("DELEGATE_MISMATCH");
  }
  if (!isValidField(request.tenantId) || normalize(request.tenantId) !== delegation.tenantId) {
    return deny("CROSS_TENANT");
  }
  if (!delegation.allowedActions.includes(request.permission)) {
    return deny("ACTION_NOT_DELEGATED");
  }
  if (
    request.resourceId !== undefined &&
    delegation.resourceScope.length > 0 &&
    !delegation.resourceScope.includes(normalize(request.resourceId))
  ) {
    return deny("OUT_OF_RESOURCE_SCOPE");
  }
  if (
    delegation.budget?.maxActions !== undefined &&
    delegation.usedActions >= delegation.budget.maxActions
  ) {
    return deny("BUDGET_EXHAUSTED");
  }
  if (request.approvalValid === false) {
    return deny("APPROVAL_INVALID");
  }
  return {
    decision: "allow",
    reason: "ALLOW",
    delegation: { ...delegation, usedActions: delegation.usedActions + 1 },
    policyVersion: DELEGATION_POLICY_VERSION,
  };
}

// ---------------------------------------------------------------------------
// Revocation
// ---------------------------------------------------------------------------

/** Revoke one delegation; returns false when it does not exist. */
export async function revokeDelegation(
  store: DelegationStore,
  delegationId: string,
  nowMs: number,
): Promise<boolean> {
  const delegation = await store.get(delegationId);
  if (!delegation) return false;
  if (!delegation.revoked) {
    await store.put({ ...delegation, revoked: true, revokedAtMs: nowMs });
  }
  return true;
}

/** Revoke every not-yet-revoked delegation granted by a delegator; returns the count. */
export async function revokeAllForUser(
  store: DelegationStore,
  delegatorInternalUserId: string,
  nowMs: number,
): Promise<number> {
  const delegations = await store.listByDelegator(normalize(delegatorInternalUserId));
  let count = 0;
  for (const delegation of delegations) {
    if (!delegation.revoked) {
      await store.put({ ...delegation, revoked: true, revokedAtMs: nowMs });
      count += 1;
    }
  }
  return count;
}

// ---------------------------------------------------------------------------
// Re-delegation (bounded by the original, never wider or longer)
// ---------------------------------------------------------------------------

export type RedelegationErrorCode =
  | "ORIGINAL_NOT_FOUND"
  | "ORIGINAL_REVOKED"
  | "ORIGINAL_EXPIRED"
  | "INVALID_DELEGATE"
  | "EMPTY_ALLOWED_ACTIONS"
  | "INVALID_PERMISSION"
  | "INVALID_EXPIRY"
  | "REDELEGATION_FORBIDDEN"
  | "REDELEGATION_WIDER_ACTIONS"
  | "REDELEGATION_WIDER_SCOPE"
  | "REDELEGATION_LONGER_EXPIRY";

export type RedelegationResult =
  | { ok: true; delegation: Delegation }
  | { ok: false; code: RedelegationErrorCode; error: string };

export interface CreateRedelegationInput {
  originalDelegationId: string;
  newDelegateAgentId: string;
  allowedActions: Permission[];
  resourceScope: string[];
  expiresAtMs: number;
  reDelegationAllowed: boolean;
  nowMs: number;
  taskId?: string;
}

/**
 * Re-delegate within the original grant. The new delegator is the
 * original delegate (an agent principal, not necessarily a member);
 * authority comes from the original delegation, not a fresh PDP
 * check. Any widening, lengthening, or forbidden re-delegation
 * writes nothing.
 */
export async function createRedelegation(
  store: DelegationStore,
  input: CreateRedelegationInput,
): Promise<RedelegationResult> {
  const original = await store.get(input.originalDelegationId);
  if (!original) {
    return { ok: false, code: "ORIGINAL_NOT_FOUND", error: "original delegation not found" };
  }
  if (original.revoked) {
    return { ok: false, code: "ORIGINAL_REVOKED", error: "original delegation is revoked" };
  }
  if (original.expiresAtMs <= input.nowMs) {
    return { ok: false, code: "ORIGINAL_EXPIRED", error: "original delegation is expired" };
  }
  if (!isValidField(input.newDelegateAgentId)) {
    return { ok: false, code: "INVALID_DELEGATE", error: "newDelegateAgentId must be a non-empty string" };
  }
  if (!Array.isArray(input.allowedActions) || input.allowedActions.length === 0) {
    return { ok: false, code: "EMPTY_ALLOWED_ACTIONS", error: "at least one allowed action is required" };
  }
  for (const action of input.allowedActions) {
    if (!(PERMISSIONS as readonly string[]).includes(String(action))) {
      return { ok: false, code: "INVALID_PERMISSION", error: `unknown permission: ${String(action)}` };
    }
  }
  if (typeof input.expiresAtMs !== "number" || input.expiresAtMs <= input.nowMs) {
    return { ok: false, code: "INVALID_EXPIRY", error: "expiresAtMs must be after nowMs" };
  }
  if (!original.reDelegationAllowed) {
    return { ok: false, code: "REDELEGATION_FORBIDDEN", error: "original delegation does not allow re-delegation" };
  }
  if (input.allowedActions.some((a) => !original.allowedActions.includes(a))) {
    return { ok: false, code: "REDELEGATION_WIDER_ACTIONS", error: "re-delegation grants actions outside the original delegation" };
  }
  // Scope: an empty original scope is tenant-wide, so any new scope
  // narrows it; a non-empty original scope bounds the new scope, and
  // an empty new scope would widen it back to tenant-wide.
  const newScope = input.resourceScope.map((r) => normalize(String(r)));
  if (original.resourceScope.length > 0) {
    if (newScope.length === 0 || newScope.some((r) => !original.resourceScope.includes(r))) {
      return { ok: false, code: "REDELEGATION_WIDER_SCOPE", error: "re-delegation scope is wider than the original delegation" };
    }
  }
  if (input.expiresAtMs > original.expiresAtMs) {
    return { ok: false, code: "REDELEGATION_LONGER_EXPIRY", error: "re-delegation expires after the original delegation" };
  }
  const delegation: Delegation = {
    id: crypto.randomUUID(),
    delegatorInternalUserId: original.delegateAgentId,
    delegateAgentId: normalize(input.newDelegateAgentId),
    tenantId: original.tenantId,
    allowedActions: [...input.allowedActions],
    resourceScope: newScope,
    expiresAtMs: input.expiresAtMs,
    // Capped at the original's remaining budget, so a chain cannot
    // spend more total actions than the original delegation allowed.
    budget:
      original.budget?.maxActions !== undefined
        ? { maxActions: Math.max(0, original.budget.maxActions - original.usedActions) }
        : undefined,
    usedActions: 0,
    reDelegationAllowed: input.reDelegationAllowed && original.reDelegationAllowed,
    revoked: false,
    createdAtMs: input.nowMs,
    taskId: input.taskId ? normalize(input.taskId) : undefined,
  };
  await store.put(delegation);
  return { ok: true, delegation };
}
