/**
 * Issue #2433 (#1976 step 5b, ADR 0022 D-A.1 / D-I.5) — the
 * session/identity family ports: session records, identity
 * bindings, membership, and access requests.
 *
 * WHY ONE FAMILY PORT WITH NAMED SUB-CONTRACTS (Q-6 ruling):
 * the four aggregates share ONE backend (the SessionStore DO,
 * bucket "sessions"), ONE funnel client, ONE flag, and ONE
 * composition root, and their key families are deliberately
 * non-colliding prefixes inside that bucket (bare UUID session
 * keys, `iaaa-binding:`, `iaaa-membership:`,
 * `iaaa-access-request:`). Their operation sets are, however,
 * NOT interchangeable: sessions carry absolute-expiry TTL
 * semantics (§3.6), bindings are two-key lookups with no
 * expiry, membership carries grant-adjacent index rules, and
 * access requests carry a pending-decision state machine.
 * Q-6 therefore lands as: one family aggregate
 * (`SessionFamilyPorts`) exposing four NAMED sub-contracts —
 * no generic KvPort with an `ns` string, which would
 * re-create the bucket-shaped facade anti-pattern inside the
 * layer (step-5 audit §6). A named ClaimPort for `consume`
 * is NOT built here: no member of this family calls the
 * funnel's `consume` op (verified by grep over session.ts,
 * iaaaLogin.ts, iaaaMembershipStore.ts,
 * iaaaAccessRequests.ts, identityBinding.ts — `consume`
 * belongs to the payments / slack-link families, slice 5e).
 *
 * FLAG (Q-2(b), #1169 semantics): `SESSION_PORTS_ENABLED` —
 * "1"/"true"/"on" (trimmed, case-insensitive) = ON; absence
 * or any other value = OFF. The var is deliberately NOT in
 * wrangler.jsonc; rollback is unsetting it. Flag-off
 * composition is today's funnel, byte-identical; flag-on
 * composition is the adapters in this family over the SAME
 * SessionStore DO and the SAME kv_store table — the flag
 * switches the serving code path only. No data migration,
 * no dual-write.
 *
 * ADAPTER CONFIGURATION (declared, not incidental): both
 * production adapters declare `legacyFallback: false` —
 * KV is not part of this store at all (the #604 migration
 * window closed; auth material never moves back to KV).
 *
 * ABSOLUTE EXPIRY IS PORT CONTRACT (§3.6): `update` writes
 * at the REMAINING absolute TTL and refuses at/past expiry
 * or on an invalid createdAt; `get`/`getValidated` consumers
 * re-check absolute expiry on read (a store TTL clamp can
 * never resurrect a session); the isolate session cache
 * stays in front and its invalidation obligation is the
 * CALLER's, unchanged.
 *
 * BULK-REVOCATION LISTING IS A NAMED OPERATION:
 * `listSessionsForRevocation()` on the session sub-contract.
 * Its restriction is contractual: it lists ONLY the
 * "sessions" bucket through the DO `list` op and filters to
 * UUID-shaped keys — a listing must NEVER surface a
 * non-UUID key (binding / membership / audit /
 * access-request keys share the bucket) as a session. A
 * failed listing returns null (fail-visible), never an
 * empty list standing in for "no sessions".
 *
 * TRANSACTION HONESTY (ADR D-C / §7): no multi-write unit
 * in this family claims atomicity it does not have.
 * Binding `put` writes two keys sequentially (the incumbent
 * funnel shape); membership `put` writes record-then-index
 * (index drift fails closed, per iaaaMembershipStore's
 * header); access-request `create` writes record-then-index.
 * Each is the incumbent behaviour, named here, not a
 * transaction wrap.
 *
 * #CDO-mha7
 */
import type { SessionData } from "../types";
import type {
  IdentityBinding,
  IdentityBindingStore,
} from "../security/identityBinding";
import type {
  Membership,
  MembershipStore,
} from "../security/authorization";
import type {
  AccessRequestStore,
} from "../security/iaaaAccessRequests";
import type { SessionRegistryEntry } from "../security/iaaaSessionRegistry";
import type { KvLike } from "../security/kvResilience";

export type { SessionRegistryEntry };

/** The family's bucket inside the SessionStore DO. */
export const SESSION_FAMILY_BUCKET = "sessions";
/** Sessions-bucket key prefixes owned by this family. */
export const SESSION_BINDING_KEY_PREFIX = "iaaa-binding:";
export const SESSION_MEMBERSHIP_KEY_PREFIX = "iaaa-membership:";
export const SESSION_ACCESS_REQUEST_KEY_PREFIX = "iaaa-access-request:";

/** Q-2(b) flag name for this family. */
export const SESSION_PORTS_FLAG = "SESSION_PORTS_ENABLED";

/**
 * #1169 flag semantics: "1"/"true"/"on" (trimmed,
 * case-insensitive) = ON; absence = OFF; NOT in wrangler.
 */
export function isSessionPortsEnabled(
  env?: { SESSION_PORTS_ENABLED?: string } | null,
): boolean {
  const v = env?.SESSION_PORTS_ENABLED;
  if (typeof v !== "string") return false;
  const norm = v.trim().toLowerCase();
  return norm === "1" || norm === "true" || norm === "on";
}

export type SessionUpdateResult =
  | { ok: true; remainingTtlSeconds: number }
  | {
      ok: false;
      code: "SESSION_INVALID_CREATED_AT" | "SESSION_ABSOLUTE_EXPIRED";
      error: string;
    };

/** Session records sub-contract (bare-UUID keys, absolute TTL). */
export interface SessionRecordPort {
  /** Mint a UUID session id and store the record at the absolute TTL. */
  create(data: SessionData): Promise<string>;
  /** Parse-or-null read (corrupt bytes read as null, never thrown). */
  get(sessionId: string): Promise<SessionData | null>;
  /** Raw stored value (parse-or-null is `get`'s job); null on miss. */
  getRaw(sessionId: string): Promise<string | null>;
  /**
   * Persist an updated record under the SAME id at the
   * REMAINING absolute TTL. Refuses (stores nothing) when
   * createdAt is invalid or the session is at/past its
   * absolute expiry — an update NEVER extends absolute expiry.
   */
  update(
    sessionId: string,
    data: SessionData,
    nowMs: number,
  ): Promise<SessionUpdateResult>;
  /**
   * Slide the absolute window when renewal is due (see
   * session.ts sessionRenewalDue); returns false when not due.
   */
  renew(
    sessionId: string,
    session: SessionData,
    nowMs: number,
  ): Promise<boolean>;
  delete(sessionId: string): Promise<void>;
  /**
   * NAMED bulk-revocation listing: the sessions-bucket list
   * op filtered to UUID-shaped keys ONLY and parsed to
   * registry entries. Returns null when the listing is
   * unavailable (fail-visible; callers must fail closed).
   */
  listSessionsForRevocation(): Promise<SessionRegistryEntry[] | null>;
  /**
   * Raw sessions-bucket listing by prefix (the registry /
   * lifecycle seam server.ts and the admin routes consume).
   * Returns null when unavailable. Callers parsing sessions
   * from it must still apply the UUID filter — see
   * listSessionsForRevocation for the filtered contract.
   */
  listRawEntries(
    prefix: string,
  ): Promise<Array<{ key: string; value: string }> | null>;
}

/** Identity bindings sub-contract: the Slice-1 store shape, unchanged. */
export type SessionBindingPort = IdentityBindingStore;
export type { IdentityBinding };

/** Membership sub-contract: MembershipStore plus the #1758 reads. */
export interface SessionMembershipPort extends MembershipStore {
  /** Read one membership record by id (null missing; corrupt throws). */
  readById(membershipId: string): Promise<Membership | null>;
  /** Parse memberships from a sessions-bucket listing (index keys skipped). */
  listFromEntries(
    entries: Array<{ key: string; value: string }>,
  ): Membership[];
  /**
   * List every membership via the bucket list op
   * (prefix `iaaa-membership:`); null when unavailable.
   */
  listAll(): Promise<Membership[] | null>;
  /** Raw membership-prefixed listing; null when unavailable. */
  listRawEntries(): Promise<Array<{ key: string; value: string }> | null>;
}

/** Access-requests sub-contract: the #1274 store shape, unchanged. */
export type SessionAccessRequestPort = AccessRequestStore;

/**
 * The family aggregate returned by the composition root
 * (createSessionPorts.ts). `kv` is the family's declared
 * KvLike over the sessions bucket (legacyFallback: false)
 * for the legacy-shaped consumers that take a KvLike by
 * design (alias recording, DO-name resolution) — it is the
 * SAME backend handle the sub-contracts run over, not a
 * second store.
 */
export interface SessionFamilyPorts {
  sessions: SessionRecordPort;
  bindings: SessionBindingPort;
  memberships: SessionMembershipPort;
  accessRequests: SessionAccessRequestPort;
  kv: KvLike;
  /** Declared adapter configuration: KV is never a fallback. */
  readonly legacyFallback: false;
}
