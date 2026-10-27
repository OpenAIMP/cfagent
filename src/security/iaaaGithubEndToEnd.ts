/**
 * #945 GitHub end-to-end — the final GitHub wiring slice.
 *
 * This module is the wiring layer that turns the Phase 2b-part2
 * machinery (membership store, bootstrap provisioning, migration
 * aliases, PDP seam) into live behaviour for the GitHub provider,
 * under the user-authorized defaults documented in
 * docs/iaaa-github-end-to-end-defaults.md. Nothing here is a
 * policy of its own: every decision delegates to Slice 1 (binding),
 * Slice 3 (PDP + grants), or the Phase 2b-part2 modules.
 *
 * Tenant default (USER-AUTHORIZED, read this first): the end-to-end
 * call sites resolve the tenant as IAAA_TENANT_ID when set, else
 * the single-tenant default "primary". This is a deliberate,
 * documented departure from the earlier "no default tenant" stance
 * of the audit seam and the bootstrap module: those modules still
 * take tenantId as an explicit argument and invent nothing — the
 * default lives ONLY here, at the call-site resolution, so it is
 * visible, auditable, and reversible (set IAAA_TENANT_ID to change
 * it). No other tenant value is ever invented. A multi-tenant
 * deployment must set IAAA_TENANT_ID explicitly; "primary" is the
 * single-tenant assumption, not a multi-tenant answer.
 *
 * Genesis rule (USER-AUTHORIZED): a bootstrap entry prefixed
 * "platform:" grants platform-admin ONLY while no platform-admin
 * genesis has happened in the tenant. The window is tracked by a
 * single Kv marker key (see platformGenesisMarkerKey); once the
 * marker exists, later platform: entries grant tenant-admin only.
 * One-time repair (#1208): if the stored marker's grantedTo is the
 * retired Oct 22 activation id and the logging-in user matches a
 * platform: entry without already holding platform-admin, the marker
 * is deleted before the genesis decision, so the genesis path grants
 * and re-sets it; after that the reset conditions can never hold
 * again. All other markers are untouched.
 * Genesis grants carry createdBy/grantedBy "system:bootstrap-genesis";
 * ordinary bootstrap grants carry "system:bootstrap". The marker is
 * check-then-set, not transactional — two concurrent genesis logins
 * could both observe an absent marker (same family as the audit and
 * membership read-modify-write races). Bootstrap logins are rare
 * and operator-driven, so the window is small, but a deployment
 * that needs a hard guarantee must serialize its first logins.
 *
 * Best-effort rule: runWiredPostLogin NEVER throws and NEVER fails
 * a login. Alias conflicts preserve the original alias; storage
 * failures are reported in the result and the login proceeds. This
 * is the same rule as the Phase 2b-part1 logout hook. Whether a
 * failed AUDIT write should block a wired login is still an open
 * CISO decision (see the defaults doc); this slice does not block
 * on audit failure.
 *
 * PDP flag: IAAA_PDP_ENABLED ("1"/"true" = on, default OFF).
 * shouldEnforcePdp() is true when the flag is on AND the session
 * is wired (carries internalUserId), OR when the flag is on and
 * the session is a legacy session past its #1749 grace bound
 * (isLegacyPdpGraceExpired). Legacy sessions INSIDE the bound are
 * exempt, exactly as in Phase 2b-part1, and flag OFF is byte-for-byte
 * the pre-change path. Default-deny within the gated set: a wired
 * session with no membership for the required permission is denied,
 * and a grace-expired legacy session is denied because it has no
 * internal id for the PDP to evaluate. That is why the flag
 * defaults OFF — with no bootstrap list set, turning it on would
 * lock out the legitimate owner. Activation is a config sequence
 * (bootstrap list + tenant + flag, then redeploy), documented in
 * the defaults doc.
 */

import type { Env, SessionData } from "../types";
import {
  createMembership,
  type MembershipStore,
  type Permission,
} from "./authorization";
import {
  getInternalUserId,
  type IdentityBindingStore,
} from "./identityBinding";
import {
  parseBootstrapAdmins,
  provisionBootstrapAdmins,
  type BootstrapEntry,
  type BootstrapRejection,
} from "./iaaaBootstrap";
import { recordLoginAlias } from "./iaaaMigration";
import { checkPermission } from "./iaaaPdpSeam";
import { SESSION_TTL } from "./session";
import type { KvLike } from "./kvResilience";

/** The documented single-tenant default tenant id. */
export const IAAA_DEFAULT_TENANT_ID = "primary";

/** Prefix for the platform-admin genesis marker keys. */
export const IAAA_PLATFORM_GENESIS_KEY_PREFIX = "iaaa-bootstrap:platform-genesis:";

/** Kv key recording that a platform-admin genesis happened in a tenant. */
export function platformGenesisMarkerKey(tenantId: string): string {
  return `${IAAA_PLATFORM_GENESIS_KEY_PREFIX}${tenantId}`;
}

/**
 * #1208 one-time repair: the minted internal id of the Oct 22
 * activation identity, retired by #1182 derivation and replaced in
 * wrangler.jsonc by #1196. Its platform-admin genesis grant is
 * stranded: no current login carries this id, so the marker it set
 * blocks every later platform: grant. The reset below deletes a
 * marker ONLY when its grantedTo is exactly this id (and the
 * logging-in user matches a platform: entry without already
 * holding platform-admin); after the re-grant the marker points
 * at the logging-in id, so the reset can never fire again.
 */
export const RETIRED_OCT22_GENESIS_ID =
  "00fbb0ba-9e4b-43ec-a7d6-df2a1dfc5d6c";

/**
 * Tenant resolution for end-to-end call sites: IAAA_TENANT_ID when
 * set and non-blank, else the documented default "primary".
 */
export function resolveIaaaTenant(
  env: Partial<Env> | null | undefined,
): string {
  const raw = env?.IAAA_TENANT_ID;
  if (typeof raw === "string" && raw.trim() !== "") return raw.trim();
  return IAAA_DEFAULT_TENANT_ID;
}

/** True only when IAAA_PDP_ENABLED is "1" or "true" (case-insensitive, trimmed). */
export function isPdpEnabled(
  env: Partial<Env> | null | undefined,
): boolean {
  const raw = env?.IAAA_PDP_ENABLED;
  if (typeof raw !== "string") return false;
  const value = raw.trim().toLowerCase();
  return value === "1" || value === "true";
}

/**
 * #1749 legacy-session PDP grace bound (parent #1717, IAAA-1).
 *
 * A legacy session (no internalUserId) is PDP-exempt ONLY while it
 * is inside its absolute session lifetime: createdAt + SESSION_TTL
 * (7 days, the same deadline the SessionStore record already
 * expires at, and the same exclusive boundary getValidatedSession
 * enforces). Past that deadline the exemption ends at the gate,
 * not just in the store: the session is denied at PDP-gated routes
 * until it re-logs in through wiring and becomes wired. That is
 * the migration path, not a lockout cliff — ungated routes are
 * unaffected, and login itself is never PDP-gated.
 *
 * Fail-closed corners, all deliberate:
 * - Flag OFF: no bound applies, because there is no PDP
 *   enforcement for the exemption to be relative to (byte-for-byte
 *   the pre-change path).
 * - Wired sessions: never grace-expired. Their absolute/idle
 *   expiry lives on the requireAuth path, not here.
 * - No session: not grace-expired. That is a 401 upstream, not a
 *   grace denial.
 * - Missing or non-finite createdAt: expired. A session that
 *   cannot prove it is inside its bound is not granted one.
 *
 * The bound is deliberately NOT configurable at any scope: it
 * reuses the SESSION_TTL constant, so no caller — and no config
 * typo — can widen, narrow, or disable their own enforcement.
 * A scoped override here would let the gated subject tune its own
 * gate, which this program's security guard forbids. There is no
 * divergent pair to unify, so there is no switch to add: one
 * session lifetime, one bound, enforced at the single choke point
 * (shouldEnforcePdp) every gated route already calls.
 *
 * Time is a caller-supplied nowMs seam, never Date.now() inside
 * this decision, so every boundary is testable exactly.
 */
export function isLegacyPdpGraceExpired(
  env: Partial<Env> | null | undefined,
  session: SessionData | null | undefined,
  nowMs: number,
): boolean {
  if (!isPdpEnabled(env)) return false;
  if (!session || session.internalUserId) return false;
  if (typeof session.createdAt !== "number" || !Number.isFinite(session.createdAt)) {
    return true;
  }
  return nowMs >= session.createdAt + SESSION_TTL * 1000;
}

/**
 * Whether PDP enforcement applies to this request: flag on AND
 * (a wired session, or a legacy session past its #1749 grace
 * bound). Flag OFF, or a legacy session inside its bound, means
 * the pre-change path, unchanged. A grace-expired legacy session
 * enforces — and then denies, because checkRoutePermission has no
 * internal id to evaluate — rather than silently bypassing the PDP.
 */
export function shouldEnforcePdp(
  env: Partial<Env> | null | undefined,
  session: SessionData | null | undefined,
  nowMs: number,
): boolean {
  if (!isPdpEnabled(env)) return false;
  if (session?.internalUserId) return true;
  return isLegacyPdpGraceExpired(env, session, nowMs);
}

export interface GenesisBootstrapEntry {
  genesis: boolean;
  entry: BootstrapEntry;
}

export interface ParsedBootstrapListWithGenesis {
  entries: GenesisBootstrapEntry[];
  rejected: BootstrapRejection[];
}

const GENESIS_PREFIX = "platform:";

/**
 * Parse a bootstrap list with genesis support. Each comma-separated
 * entry is either a plain entry (delegated to parseBootstrapAdmins:
 * bare UUID or issuer:subject) or a "platform:"-prefixed entry whose
 * remainder parses the same way. A platform: entry with an
 * unparseable remainder is rejected with the original text, never
 * silently downgraded to a plain entry.
 */
export function parseBootstrapListWithGenesis(
  raw: string | undefined,
): ParsedBootstrapListWithGenesis {
  const entries: GenesisBootstrapEntry[] = [];
  const rejected: BootstrapRejection[] = [];
  if (raw === undefined) return { entries, rejected };
  for (const part of raw.split(",")) {
    const entry = part.trim();
    if (entry === "") continue;
    if (entry.startsWith(GENESIS_PREFIX)) {
      const remainder = entry.slice(GENESIS_PREFIX.length).trim();
      if (remainder === "") {
        rejected.push({
          entry,
          reason: "platform: entry has no identity after the prefix",
        });
        continue;
      }
      const parsed = parseBootstrapAdmins(remainder);
      if (parsed.entries.length === 0) {
        for (const rejection of parsed.rejected) {
          rejected.push({ entry, reason: rejection.reason });
        }
        if (parsed.rejected.length === 0) {
          rejected.push({ entry, reason: "platform: entry could not be parsed" });
        }
        continue;
      }
      entries.push({ genesis: true, entry: parsed.entries[0] });
      continue;
    }
    const parsed = parseBootstrapAdmins(entry);
    entries.push(
      ...parsed.entries.map((e) => ({ genesis: false, entry: e })),
    );
    rejected.push(...parsed.rejected);
  }
  return { entries, rejected };
}

export interface WiredPostLoginDeps {
  kv: KvLike;
  bindingStore: IdentityBindingStore;
  membershipStore: MembershipStore;
}

export interface WiredPostLoginInput {
  githubLogin: string;
  internalUserId: string;
  providerIssuer: string;
  providerSubject: string;
  bootstrapRaw: string | undefined;
  tenantId: string;
  nowMs: number;
}

export type AliasRunStatus =
  | "recorded"
  | "conflict-preserved"
  | "invalid"
  | "error";

export type BootstrapRunStatus =
  | "provisioned"
  | "genesis"
  | "genesis-closed-tenant-admin"
  | "already-admin"
  | "not-listed"
  | "blank"
  | "error";

export interface WiredPostLoginResult {
  alias: { status: AliasRunStatus };
  bootstrap: { status: BootstrapRunStatus };
}

async function resolveEntryUserId(
  bindingStore: IdentityBindingStore,
  entry: BootstrapEntry,
): Promise<string | null> {
  if (entry.kind === "internalUserId") return entry.internalUserId;
  return getInternalUserId(
    bindingStore,
    entry.providerIssuer,
    entry.providerSubject,
  );
}

/**
 * #1208: true iff a stored genesis marker is the stranded Oct 22
 * marker — parses as a JSON object whose grantedTo is exactly the
 * retired Oct 22 activation id. Unparsable or malformed markers
 * return false, so they take the genesis-closed path, never a
 * delete.
 */
function isStrandedOct22Marker(marker: string): boolean {
  try {
    const parsed: unknown = JSON.parse(marker);
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as { grantedTo?: unknown }).grantedTo ===
        RETIRED_OCT22_GENESIS_ID
    );
  } catch {
    return false;
  }
}

async function holdsPlatformAdmin(
  store: MembershipStore,
  internalUserId: string,
  nowMs: number,
): Promise<boolean> {
  const memberships = await store.getMembershipsByUser(internalUserId);
  return memberships.some(
    (m) =>
      m.revokedAtMs === undefined &&
      m.roleBindings.some(
        (b) =>
          b.role === "platform-admin" &&
          b.scope === "platform" &&
          (b.expiresAtMs === undefined || b.expiresAtMs > nowMs),
      ),
  );
}

/**
 * Wired post-login work: record the login alias, then bootstrap the
 * logging-in user if listed. Best-effort throughout: this function
 * never throws, and no failure here may change the login outcome.
 * The caller (the wired GitHub callback) awaits it only for its
 * side effects, never for a gate.
 */
export async function runWiredPostLogin(
  deps: WiredPostLoginDeps,
  input: WiredPostLoginInput,
): Promise<WiredPostLoginResult> {
  let aliasStatus: AliasRunStatus;
  try {
    const recorded = await recordLoginAlias(deps.kv, {
      githubLogin: input.githubLogin,
      internalUserId: input.internalUserId,
      nowMs: input.nowMs,
    });
    aliasStatus = recorded.ok
      ? "recorded"
      : recorded.code === "ALIAS_CONFLICT"
        ? "conflict-preserved"
        : "invalid";
  } catch {
    aliasStatus = "error";
  }

  let bootstrapStatus: BootstrapRunStatus;
  try {
    if (input.bootstrapRaw === undefined || input.bootstrapRaw.trim() === "") {
      bootstrapStatus = "blank";
    } else {
      const parsed = parseBootstrapListWithGenesis(input.bootstrapRaw);
      let matchedGenesis = false;
      let matched = false;
      for (const { genesis, entry } of parsed.entries) {
        const resolved = await resolveEntryUserId(deps.bindingStore, entry);
        if (resolved === input.internalUserId) {
          matched = true;
          if (genesis) matchedGenesis = true;
        }
      }
      if (!matched) {
        bootstrapStatus = "not-listed";
      } else if (matchedGenesis) {
        if (await holdsPlatformAdmin(deps.membershipStore, input.internalUserId, input.nowMs)) {
          bootstrapStatus = "already-admin";
        } else {
          const markerKey = platformGenesisMarkerKey(input.tenantId);
          let marker = await deps.kv.get(markerKey);
          // #1208 one-time repair: if the marker is the stranded
          // Oct 22 marker, delete it so the existing genesis path
          // below grants platform-admin and re-sets the marker to
          // the logging-in user. A delete failure propagates to
          // the outer catch (bootstrap status "error"); the login
          // itself is unaffected. All other markers are untouched.
          if (marker !== null && isStrandedOct22Marker(marker)) {
            await deps.kv.delete(markerKey);
            marker = null;
          }
          if (marker === null) {
            const created = await createMembership(deps.membershipStore, {
              internalUserId: input.internalUserId,
              tenantId: input.tenantId,
              roleBindings: [
                {
                  role: "platform-admin",
                  scope: "platform",
                  grantedBy: "system:bootstrap-genesis",
                },
              ],
              createdBy: "system:bootstrap-genesis",
              nowMs: input.nowMs,
            });
            if (!created.ok) {
              bootstrapStatus = "error";
            } else {
              await deps.kv.put(
                markerKey,
                JSON.stringify({
                  grantedTo: input.internalUserId,
                  tenantId: input.tenantId,
                  atMs: input.nowMs,
                }),
              );
              bootstrapStatus = "genesis";
            }
          } else {
            // Genesis window closed: a platform: entry now grants
            // tenant-admin only, through the ordinary bootstrap path.
            const provisioned = await provisionBootstrapAdmins(
              deps.membershipStore,
              {
                tenantId: input.tenantId,
                internalUserIds: [input.internalUserId],
                nowMs: input.nowMs,
              },
            );
            bootstrapStatus = provisioned.ok
              ? provisioned.skippedAlreadyAdmin.includes(input.internalUserId)
                ? "already-admin"
                : "genesis-closed-tenant-admin"
              : "error";
          }
        }
      } else {
        const provisioned = await provisionBootstrapAdmins(
          deps.membershipStore,
          {
            tenantId: input.tenantId,
            internalUserIds: [input.internalUserId],
            nowMs: input.nowMs,
          },
        );
        bootstrapStatus = provisioned.ok
          ? provisioned.skippedAlreadyAdmin.includes(input.internalUserId)
            ? "already-admin"
            : "provisioned"
          : "error";
      }
    }
  } catch {
    bootstrapStatus = "error";
  }

  return { alias: { status: aliasStatus }, bootstrap: { status: bootstrapStatus } };
}

/**
 * PDP check for one gated route: allow iff the wired session's
 * internal user holds the permission in the tenant. Returns false
 * for a non-wired session (defense in depth — callers also check
 * shouldEnforcePdp before calling). Pure decision, no side effects.
 */
export async function checkRoutePermission(
  membershipStore: MembershipStore,
  session: SessionData | null | undefined,
  tenantId: string,
  permission: Permission,
  nowMs: number,
): Promise<boolean> {
  if (!session?.internalUserId) return false;
  const decision = await checkPermission(membershipStore, {
    internalUserId: session.internalUserId,
    tenantId,
    permission,
    nowMs,
  });
  return decision.decision === "allow";
}
