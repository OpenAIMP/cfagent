/**
 * #945 Wiring Phase 2b-part2 — env-configured bootstrap provisioning.
 *
 * The chicken-and-egg problem: the grant path (iaaaMembershipStore)
 * requires an existing granter, so the FIRST admin cannot be created
 * through it. This module is the genesis exception, and it is
 * deliberately narrow:
 *
 * - Source: ONLY the optional Env var IAAA_BOOTSTRAP_ADMINS (see
 *   types.ts). When it is unset, blank, or empty, ZERO members are
 *   provisioned — there is no hardcoded admin, no default user, and
 *   no fallback to a GitHub login anywhere in this module.
 * - Format: a comma-separated list. Each entry is either:
 *   (a) a bare internal user id, which MUST be a UUID (legacy
 *       minted ids, Slice 1) or a derived id (post-#1182: `v1:` +
 *       64 lowercase hex characters) — so a pasted GitHub login
 *       or display name is REJECTED, not silently stored as an
 *       admin id that matches nobody; or
 *   (b) a provider subject in issuer:subject form, split at the
 *       LAST colon — issuers contain "://" (https://github.com),
 *       so splitting at the first colon would mangle them.
 *   Anything else is reported in `rejected` with a reason and is
 *   never provisioned. Parsing is a pure function with no I/O.
 * - Resolution: provider entries resolve through the Slice 1
 *   binding store (getInternalUserId). An unbound subject is
 *   reported in `unresolved` and provisioned for nobody — identity
 *   is never invented from a subject string.
 * - Provisioning: provisionBootstrapAdmins() grants a tenant-admin
 *   membership (scope "tenant") in a CALLER-SUPPLIED tenantId to
 *   each resolved internal user, createdBy "system:bootstrap". It
 *   is idempotent: a user who already holds an active tenant-admin
 *   membership in that tenant is skipped, never duplicated. It
 *   REFUSES an empty tenant id — there is no default tenant, and
 *   inventing one would fabricate tenant attribution exactly as
 *   Phase 2b-part1 refused to do for audit events.
 *
 * What this module deliberately does NOT do (owner decisions):
 * - It never grants platform-admin. A platform-admin genesis
 *   mechanism (first platform admin with no existing granter) does
 *   not exist in this slice: granting platform scope from an env
 *   list would let anyone who can set one env var mint the highest
 *   privilege, and silently doing so would bypass the Slice 3 hard
 *   rule that platform privileges require a platform-admin granter.
 *   Until the owner decides that mechanism, platform-admins can
 *   only be granted by an existing platform-admin (grantMembership).
 * - It is NOT wired into any route or login path. The parent calls
 *   it only from an admin-only setup path. Nothing in this module
 *   runs on a request, so it cannot change any live request path.
 * - It does not decide the bootstrap tenant. The caller supplies
 *   tenantId (in production, expected to be IAAA_TENANT_ID); the
 *   module never reads Env itself, so the tenant choice stays
 *   explicit and auditable at the call site.
 */

import {
  createMembership,
  type MembershipStore,
} from "./authorization";
import {
  getInternalUserId,
  type IdentityBindingStore,
} from "./identityBinding";

const MAX_FIELD_LENGTH = 512;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// #1197: derived internal ids (post-#1182) are `v1:` + lowercase hex
// of SHA-256 over the normalized (issuer, subject) pair. Lowercase
// ONLY: derivation emits lowercase hex, and accepting uppercase
// would widen the accepted shape beyond what the system ever mints.
const DERIVED_ID_PATTERN = /^v1:[0-9a-f]{64}$/;

export type BootstrapEntry =
  | { kind: "internalUserId"; internalUserId: string }
  | {
      kind: "providerSubject";
      providerIssuer: string;
      providerSubject: string;
    };

export interface BootstrapRejection {
  entry: string;
  reason: string;
}

export interface ParsedBootstrapAdmins {
  entries: BootstrapEntry[];
  rejected: BootstrapRejection[];
}

/**
 * Pure parse of the IAAA_BOOTSTRAP_ADMINS value. Unset, blank, or
 * all-comma input yields zero entries and zero rejections: an
 * absent list provisions nobody, it is never an error.
 */
export function parseBootstrapAdmins(
  raw: string | undefined,
): ParsedBootstrapAdmins {
  const entries: BootstrapEntry[] = [];
  const rejected: BootstrapRejection[] = [];
  if (raw === undefined) return { entries, rejected };
  for (const part of raw.split(",")) {
    const entry = part.trim();
    if (entry === "") continue;
    if (entry.length > MAX_FIELD_LENGTH) {
      rejected.push({
        entry,
        reason: `entry exceeds ${MAX_FIELD_LENGTH} characters`,
      });
      continue;
    }
    if (/\s/.test(entry)) {
      rejected.push({
        entry,
        reason: "entry contains whitespace; internal ids and issuer:subject pairs contain none",
      });
      continue;
    }
    if (entry.includes("://")) {
      // Provider form: split at the LAST colon, because the issuer
      // itself contains "://" and may contain further colons.
      const splitAt = entry.lastIndexOf(":");
      const providerIssuer = entry.slice(0, splitAt).trim();
      const providerSubject = entry.slice(splitAt + 1).trim();
      if (providerIssuer === "" || providerSubject === "") {
        rejected.push({
          entry,
          reason: "issuer:subject entry must have a non-empty issuer and subject",
        });
        continue;
      }
      entries.push({ kind: "providerSubject", providerIssuer, providerSubject });
      continue;
    }
    if (!UUID_PATTERN.test(entry) && !DERIVED_ID_PATTERN.test(entry)) {
      rejected.push({
        entry,
        reason:
          "bare entry must be an internal user id (UUID or derived v1: id); a login or display name is not an identity and is rejected, not provisioned",
      });
      continue;
    }
    entries.push({ kind: "internalUserId", internalUserId: entry });
  }
  return { entries, rejected };
}

export interface ResolvedBootstrapAdmins {
  /** Internal user ids safe to provision (deduped, order preserved). */
  internalUserIds: string[];
  /** Provider entries with no Slice 1 binding: provisioned for nobody. */
  unresolved: Extract<BootstrapEntry, { kind: "providerSubject" }>[];
}

/** Resolve provider entries through Slice 1 bindings; bare ids pass through. */
export async function resolveBootstrapEntries(
  bindingStore: IdentityBindingStore,
  entries: BootstrapEntry[],
): Promise<ResolvedBootstrapAdmins> {
  const internalUserIds: string[] = [];
  const unresolved: ResolvedBootstrapAdmins["unresolved"] = [];
  for (const entry of entries) {
    if (entry.kind === "internalUserId") {
      if (!internalUserIds.includes(entry.internalUserId)) {
        internalUserIds.push(entry.internalUserId);
      }
      continue;
    }
    const internalUserId = await getInternalUserId(
      bindingStore,
      entry.providerIssuer,
      entry.providerSubject,
    );
    if (internalUserId === null) {
      unresolved.push(entry);
    } else if (!internalUserIds.includes(internalUserId)) {
      internalUserIds.push(internalUserId);
    }
  }
  return { internalUserIds, unresolved };
}

export interface ProvisionBootstrapInput {
  tenantId: string;
  internalUserIds: string[];
  nowMs: number;
}

export type ProvisionBootstrapResult =
  | {
      ok: true;
      provisioned: string[];
      skippedAlreadyAdmin: string[];
    }
  | { ok: false; code: "INVALID_TENANT_ID"; error: string };

/**
 * Grant each listed user a tenant-admin membership in the given
 * tenant, idempotently. Genesis exception to the grant path: no
 * granter exists yet, so no canGrantRole check is possible — that
 * is exactly why this grants tenant-admin ONLY and why the parent
 * must call it solely from an admin-only setup path. An empty
 * tenant id refuses everything and writes nothing.
 */
export async function provisionBootstrapAdmins(
  store: MembershipStore,
  input: ProvisionBootstrapInput,
): Promise<ProvisionBootstrapResult> {
  const tenantId =
    typeof input.tenantId === "string" ? input.tenantId.trim() : "";
  if (tenantId === "" || tenantId.length > MAX_FIELD_LENGTH) {
    return {
      ok: false,
      code: "INVALID_TENANT_ID",
      error: "tenantId must be a non-empty string; no default tenant is assumed",
    };
  }
  const provisioned: string[] = [];
  const skippedAlreadyAdmin: string[] = [];
  for (const internalUserId of input.internalUserIds) {
    const existing = await store.getMembershipsByUser(internalUserId);
    const alreadyAdmin = existing.some(
      (m) =>
        m.tenantId === tenantId &&
        m.revokedAtMs === undefined &&
        m.roleBindings.some(
          (b) =>
            b.role === "tenant-admin" &&
            b.scope === "tenant" &&
            (b.expiresAtMs === undefined || b.expiresAtMs > input.nowMs),
        ),
    );
    if (alreadyAdmin) {
      skippedAlreadyAdmin.push(internalUserId);
      continue;
    }
    const created = await createMembership(store, {
      internalUserId,
      tenantId,
      roleBindings: [
        {
          role: "tenant-admin",
          scope: "tenant",
          grantedBy: "system:bootstrap",
        },
      ],
      createdBy: "system:bootstrap",
      nowMs: input.nowMs,
    });
    if (!created.ok) {
      // createMembership only rejects malformed fields; the tenant
      // was validated above and ids come from the parser, so this
      // is unreachable in practice — but a failed grant must never
      // be reported as provisioned.
      return {
        ok: false,
        code: "INVALID_TENANT_ID",
        error: `bootstrap grant failed for ${internalUserId}: ${created.error}`,
      };
    }
    provisioned.push(internalUserId);
  }
  return { ok: true, provisioned, skippedAlreadyAdmin };
}
