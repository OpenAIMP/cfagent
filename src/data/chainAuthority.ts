/**
 * Issue #1688 ([AGENTIC] Slice 3, audit authority) — the
 * chain-scoped authority matrix (R7-adjacent: authorization
 * decided in code, at the boundary, never in a model loop).
 *
 * This module is deliberately small and chain-scoped: it is
 * NOT a repo-wide authority system. Roles:
 *  - "platform-admin": live platform-admin membership (the
 *    IAAA admin pattern's allowed caller).
 *  - "tenant-admin": a tenant administrator.
 *  - "signed-in": any authenticated caller.
 *  - "system": the projection writers themselves (no caller).
 *
 * Operations on chain records:
 *  - "read": tenant-scoped projection reads (any signed-in
 *    role; the tenant predicate, not the role, is what scopes
 *    the rows — a role alone never widens visibility).
 *  - "reconcile": deliberate operator repair passes.
 *  - "project": versioned projection writes, system only —
 *    no caller role may write projection rows directly.
 *  - "seed": one-time operator seeds of canonical rows.
 *
 * Enforcement points: the reconcile route handler (which
 * derives its role from the admin check), deleteCanonicalReport
 * (platform-admin only, in auditReportProjection), and the
 * seed route handler (platform-admin only). A matrix refusal
 * is a hard refusal: nothing is written, nothing is returned.
 */

export type ChainRole =
  | "platform-admin"
  | "tenant-admin"
  | "signed-in"
  | "system";

export type ChainOperation = "read" | "reconcile" | "project" | "seed";

/** The matrix itself: which roles may perform each operation. */
export const CHAIN_OPERATION_MATRIX: Record<
  ChainOperation,
  readonly ChainRole[]
> = {
  read: ["platform-admin", "tenant-admin", "signed-in"],
  reconcile: ["platform-admin"],
  project: ["system"],
  seed: ["platform-admin"],
};

/** Pure predicate: is this role allowed this operation? */
export function isChainOperationAllowed(
  role: ChainRole,
  operation: ChainOperation,
): boolean {
  return CHAIN_OPERATION_MATRIX[operation].includes(role);
}

/** Throwing guard for boundary enforcement; the message names the refusal. */
export function assertChainOperationAllowed(
  role: ChainRole,
  operation: ChainOperation,
): void {
  if (!isChainOperationAllowed(role, operation)) {
    throw new Error(
      `Forbidden: role ${role} may not perform chain operation ${operation}.`,
    );
  }
}
