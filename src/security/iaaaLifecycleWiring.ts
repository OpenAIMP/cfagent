/**
 * Issue #1758 (#1717 lifecycle wiring) — offboard + verify orchestration.
 *
 * lifecycle.ts defines the pure revocation/offboarding policy over
 * three stores (sessions, memberships, delegations) but takes
 * caller-supplied session ids — the F-16 gap. This module closes
 * that gap and extends the checklist to the stores F-16/F-17 name:
 * it discovers sessions from the session registry
 * (iaaaSessionRegistry.ts) instead of trusting a caller-supplied
 * list, then revokes API keys and E*TRADE tokens for the logins
 * those sessions reveal, records mail suppression, emits one audit
 * event, and VERIFIES the result by re-reading every store.
 * Offboard + verify, never fire-and-forget: `verified` is true
 * only when a fresh re-read proves nothing revocable remains.
 *
 * Ports, not backends: every store behind this module is an
 * injected port, so the module performs no Cloudflare I/O and no
 * route, job, or tool calls it. Production adapters live at the
 * route call sites in server.ts (SessionStore DO listing, the
 * Kv membership store, apiKeys helpers, etradeOAuth revocation,
 * the wired audit store). The one Cloudflare-adjacent helper here
 * is the mail-suppression Kv record, which rides whatever KvLike
 * the caller supplies — the same seam the membership and audit
 * stores already use.
 *
 * Identity rules, stated so a caller cannot misread them:
 * - The principal is the Slice 1 internal user id. Logins are
 *   used only to reach login-keyed stores (API keys, E*TRADE
 *   tokens) and are taken from the principal's own session
 *   records, never from a caller-supplied identity claim — except
 *   the admin offboard route's optional login hint, which only
 *   adds LEGACY sessions (no internalUserId) and login-keyed
 *   cleanup for that login; it can never select a wired session,
 *   which only its internalUserId selects.
 * - A legacy session (no internalUserId) is revoked when its
 *   login matches a login the principal's wired sessions reveal
 *   (or the admin's login hint). Rationale: a login is the only
 *   attribution a legacy session carries, and leaving it live
 *   would leave the principal authenticated. Residual: if a
 *   login was transferred to a different person after the legacy
 *   session was created, that session is revoked with the
 *   offboard — sessions expire within 7 days, which bounds the
 *   window, and the audit event records the actor and logins.
 * - Delegations: there is no durable delegation store wired in
 *   production (delegation.ts ships a memory store only), so a
 *   null delegations port means the step is "not-applicable" and
 *   the report names it as a residual — never a silent success.
 * - Queued work and active tasks are NOT cancelled here (the
 *   lifecycle module's stated scope): revocation removes
 *   authority, it does not stop already-running work. That is a
 *   named residual in the slice doc, not a claim otherwise.
 * - Mail suppression is a recorded flag (see below). Existing
 *   mail send paths do not yet consult it — that sender wiring
 *   is a named residual in the slice doc; the flag is the
 *   enforcement point they must check, and isMailSuppressed()
 *   is the check.
 */

import type { MembershipStore } from "./authorization";
import {
  createMemoryDelegationStore,
  type DelegationStore,
} from "./delegation";
import { offboardPrincipal } from "./lifecycle";
import type { RevocationStore } from "./sessionPolicy";
import {
  sessionsForPrincipal,
  type SessionRegistryEntry,
} from "./iaaaSessionRegistry";
import type { KvLike } from "./kvResilience";

/** Session-registry port: list all live sessions, delete one by id. */
export interface OffboardSessionPort {
  list(): Promise<SessionRegistryEntry[]>;
  delete(sessionId: string): Promise<void>;
}

/** Login-keyed API-key port (production: src/security/apiKeys.ts). */
export interface OffboardKeyPort {
  list(login: string): Promise<string[]>;
  revoke(login: string, keyId: string): Promise<boolean>;
}

/** Login-keyed E*TRADE token port (production: etradeOAuth revocation). */
export interface OffboardEtradePort {
  revoke(login: string): Promise<void>;
  hasTokens(login: string): Promise<boolean>;
}

/** Mail-suppression port (production: the Kv helpers below). */
export interface OffboardSuppressionPort {
  set(internalUserId: string, nowMs: number): Promise<void>;
  isSet(internalUserId: string): Promise<boolean>;
}

/** Audit port: returns true only when the event was recorded. */
export interface OffboardAuditPort {
  emit(input: {
    action: string;
    actorInternalUserId: string;
    tenantId: string;
    nowMs: number;
    correlationId: string;
  }): Promise<boolean>;
}

export interface OffboardDeps {
  sessions: OffboardSessionPort;
  memberships: MembershipStore;
  /** Null when no durable delegation store is wired (production today). */
  delegations: DelegationStore | null;
  apiKeys: OffboardKeyPort;
  etrade: OffboardEtradePort;
  suppression: OffboardSuppressionPort;
  /** Null means no audit sink: the report says so, it never claims one. */
  audit: OffboardAuditPort | null;
  /** Optional isolate-cache invalidation for each deleted session id. */
  invalidateSession?: (sessionId: string) => void;
}

export interface OffboardInput {
  internalUserId: string;
  tenantId: string;
  nowMs: number;
  actorInternalUserId: string;
  /** Admin-supplied login hint: legacy sessions + login-keyed cleanup only. */
  extraLogins?: string[];
  /** Audit action for the emitted event; defaults to "iaaa.offboard". */
  auditAction?: string;
}

export interface OffboardStep {
  step:
    | "revoke-sessions"
    | "revoke-memberships"
    | "revoke-delegations"
    | "revoke-api-keys"
    | "revoke-etrade-tokens"
    | "suppress-mail"
    | "audit";
  status: "done" | "failed" | "not-applicable";
  detail: string;
}

export interface OffboardReport {
  principalId: string;
  actorInternalUserId: string;
  /** True when the revocation run itself failed nothing. */
  offboarded: boolean;
  /** True only when a fresh re-read proves nothing revocable remains. */
  verified: boolean;
  steps: OffboardStep[];
  /** Everything not revoked, not verified, or structurally missing. */
  residuals: string[];
  sessionsRevoked: string[];
  membershipsRevoked: string[];
  delegationsRevoked: string[];
  apiKeysRevoked: string[];
  etradeLogins: string[];
  mailSuppressed: boolean;
  auditEmitted: boolean;
}

/** Kv key for one principal's mail-suppression record. */
export function mailSuppressionKey(internalUserId: string): string {
  return `iaaa-mail-suppression:${internalUserId}`;
}

/** Record mail suppression for a principal. Idempotent: re-setting overwrites. */
export async function setMailSuppression(
  kv: KvLike,
  internalUserId: string,
  nowMs: number,
): Promise<void> {
  await kv.put(
    mailSuppressionKey(internalUserId),
    JSON.stringify({ internalUserId, suppressedAtMs: nowMs, reason: "offboard" }),
  );
}

/**
 * True when a suppression record exists for the principal. A corrupt
 * record fails closed to suppressed: the key only ever exists
 * because an offboard set it, so corrupt bytes must not re-enable
 * mail to a deactivated principal.
 */
export async function isMailSuppressed(kv: KvLike, internalUserId: string): Promise<boolean> {
  const raw = await kv.get(mailSuppressionKey(internalUserId));
  if (raw === null) return false;
  try {
    const parsed: unknown = JSON.parse(raw);
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as { internalUserId?: unknown }).internalUserId === internalUserId
    );
  } catch {
    return true;
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

/**
 * Resolve the session set for an offboard: the principal's wired
 * sessions, plus legacy sessions (no internalUserId) whose login
 * matches a login the wired sessions reveal or an admin login hint.
 */
export function resolveOffboardSessions(
  entries: SessionRegistryEntry[],
  internalUserId: string,
  extraLogins: string[],
): SessionRegistryEntry[] {
  const wired = sessionsForPrincipal(entries, internalUserId);
  const logins = new Set<string>([
    ...wired.map((e) => e.githubLogin),
    ...extraLogins,
  ]);
  const legacy = entries.filter(
    (e) => e.internalUserId === undefined && logins.has(e.githubLogin),
  );
  return [...wired, ...legacy];
}

export async function runOffboard(
  deps: OffboardDeps,
  input: OffboardInput,
): Promise<OffboardReport> {
  const principalId = input.internalUserId.trim();
  const extraLogins = (input.extraLogins ?? []).map((l) => l.trim()).filter((l) => l !== "");
  const residuals: string[] = [];
  const steps: OffboardStep[] = [];

  // --- Discover, don't trust: the registry supplies the session ids.
  const listed = await deps.sessions.list();
  const resolved = resolveOffboardSessions(listed, principalId, extraLogins);
  const sessionIds = resolved.map((e) => e.sessionId);
  const logins = unique([...resolved.map((e) => e.githubLogin), ...extraLogins]);

  // --- Core revocation (lifecycle policy) over a registry-backed store.
  const sessionRevocationStore: RevocationStore = {
    async registerSession() {
      // Registration happens at login, not at offboard.
    },
    async revokeSession(sessionId: string) {
      await deps.sessions.delete(sessionId);
      deps.invalidateSession?.(sessionId);
    },
    async revokeAllSessionsForUser(internalUserId: string) {
      const entries = await deps.sessions.list();
      for (const entry of resolveOffboardSessions(entries, internalUserId, extraLogins)) {
        await deps.sessions.delete(entry.sessionId);
        deps.invalidateSession?.(entry.sessionId);
      }
    },
    async isSessionRevoked(sessionId: string) {
      const entries = await deps.sessions.list();
      return !entries.some((e) => e.sessionId === sessionId);
    },
  };
  const delegationsStore: DelegationStore =
    deps.delegations ?? createMemoryDelegationStore();
  const core = await offboardPrincipal(
    { sessions: sessionRevocationStore, memberships: deps.memberships, delegations: delegationsStore },
    { internalUserId: principalId, sessionIds, nowMs: input.nowMs },
  );
  for (const step of core.steps) {
    steps.push(step as OffboardStep);
  }
  if (deps.delegations === null) {
    residuals.push(
      "delegations: no durable delegation store is wired in production; delegations were not checked beyond the empty in-memory substitute",
    );
  }
  for (const failure of core.unrevoked) {
    residuals.push(`${failure.kind}:${failure.id} could not be revoked (${failure.reason})`);
  }

  // --- Login-keyed cleanup: API keys, then E*TRADE tokens.
  const apiKeysRevoked: string[] = [];
  const apiKeyFailures: string[] = [];
  for (const login of logins) {
    let ids: string[];
    try {
      ids = await deps.apiKeys.list(login);
    } catch {
      apiKeyFailures.push(login);
      continue;
    }
    for (const keyId of ids) {
      let revoked = false;
      try {
        revoked = await deps.apiKeys.revoke(login, keyId);
      } catch {
        revoked = false;
      }
      if (revoked) apiKeysRevoked.push(keyId);
      else apiKeyFailures.push(`${login}:${keyId}`);
    }
  }
  steps.push({
    step: "revoke-api-keys",
    status: apiKeyFailures.length > 0 ? "failed" : "done",
    detail:
      apiKeyFailures.length > 0
        ? `${apiKeyFailures.length} API key(s) could not be revoked`
        : `${apiKeysRevoked.length} API key(s) revoked`,
  });
  if (apiKeyFailures.length > 0) {
    residuals.push(`api-keys: ${apiKeyFailures.join(", ")} could not be revoked`);
  }

  const etradeLogins: string[] = [];
  const etradeFailures: string[] = [];
  for (const login of logins) {
    try {
      await deps.etrade.revoke(login);
      etradeLogins.push(login);
    } catch {
      etradeFailures.push(login);
    }
  }
  steps.push({
    step: "revoke-etrade-tokens",
    status: etradeFailures.length > 0 ? "failed" : "done",
    detail:
      etradeFailures.length > 0
        ? `${etradeFailures.length} E*TRADE token set(s) could not be revoked`
        : `${etradeLogins.length} E*TRADE login(s) revoked`,
  });
  if (etradeFailures.length > 0) {
    residuals.push(`etrade-tokens: ${etradeFailures.join(", ")} could not be revoked`);
  }

  // --- Mail suppression.
  let mailSuppressed = false;
  try {
    await deps.suppression.set(principalId, input.nowMs);
    mailSuppressed = await deps.suppression.isSet(principalId);
  } catch {
    mailSuppressed = false;
  }
  steps.push({
    step: "suppress-mail",
    status: mailSuppressed ? "done" : "failed",
    detail: mailSuppressed ? "mail suppression recorded" : "mail suppression could not be recorded",
  });
  if (!mailSuppressed) residuals.push("mail-suppression: suppression record could not be written");

  // --- Audit (emitted after revocation, so the event describes the run).
  let auditEmitted = false;
  if (deps.audit) {
    try {
      auditEmitted = await deps.audit.emit({
        action: input.auditAction ?? "iaaa.offboard",
        actorInternalUserId: input.actorInternalUserId,
        tenantId: input.tenantId,
        nowMs: input.nowMs,
        correlationId: crypto.randomUUID(),
      });
    } catch {
      auditEmitted = false;
    }
  }
  steps.push({
    step: "audit",
    status: auditEmitted ? "done" : "failed",
    detail: auditEmitted ? "offboard audit event recorded" : "offboard audit event was not recorded",
  });
  if (!auditEmitted) residuals.push("audit: offboard audit event was not recorded");

  const offboarded =
    core.offboarded && apiKeyFailures.length === 0 && etradeFailures.length === 0 && mailSuppressed;

  // --- Verify by re-reading: never claim what the stores do not confirm.
  const verifyFailures: string[] = [];
  const relisted = await deps.sessions.list();
  const remaining = resolveOffboardSessions(relisted, principalId, extraLogins);
  if (remaining.length > 0) {
    verifyFailures.push(`${remaining.length} session(s) still present after revocation`);
  }
  const membershipsAfter = await deps.memberships.getMembershipsByUser(principalId);
  if (membershipsAfter.some((m) => m.revokedAtMs === undefined)) {
    verifyFailures.push("membership(s) still active after revocation");
  }
  if (deps.delegations) {
    const delegationsAfter = await deps.delegations.listByDelegator(principalId);
    if (delegationsAfter.some((d) => !d.revoked)) {
      verifyFailures.push("delegation(s) still active after revocation");
    }
  }
  for (const login of logins) {
    let keysAfter: string[] = [];
    try {
      keysAfter = await deps.apiKeys.list(login);
    } catch {
      verifyFailures.push(`API keys for ${login} could not be re-read for verification`);
    }
    if (keysAfter.length > 0) verifyFailures.push(`API key(s) still present for ${login}`);
    let tokensAfter = false;
    try {
      tokensAfter = await deps.etrade.hasTokens(login);
    } catch {
      verifyFailures.push(`E*TRADE tokens for ${login} could not be re-read for verification`);
    }
    if (tokensAfter) verifyFailures.push(`E*TRADE token(s) still present for ${login}`);
  }
  if (!mailSuppressed) verifyFailures.push("mail suppression not recorded");
  const verified = offboarded && verifyFailures.length === 0 && auditEmitted;
  for (const failure of verifyFailures) {
    residuals.push(`verify: ${failure}`);
  }

  return {
    principalId,
    actorInternalUserId: input.actorInternalUserId,
    offboarded,
    verified,
    steps,
    residuals,
    sessionsRevoked: core.report.sessionsRevoked,
    membershipsRevoked: core.report.membershipsRevoked,
    delegationsRevoked: core.report.delegationsRevoked,
    apiKeysRevoked,
    etradeLogins,
    mailSuppressed,
    auditEmitted,
  };
}
