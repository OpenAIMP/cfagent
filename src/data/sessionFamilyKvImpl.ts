/**
 * Issue #2433 (#1976 step 5b) — the Kv-backed implementation
 * shared by the session family's adapters. Both adapters
 * (DO wire-protocol and in-memory) run THIS code over their
 * KvLike, so the conformance suite proves one semantics, not
 * two copies: session logic mirrors src/security/session.ts
 * statement-for-statement (absolute-TTL update/renewal over
 * SESSION_LIMITS, the single config source), bindings mirror
 * iaaaLogin.createKvBindingStore (two keys, no TTL),
 * membership delegates to iaaaMembershipStore's factories,
 * access requests delegate to iaaaAccessRequests' factory.
 *
 * The lister is supplied by the composition root / adapter:
 * over the DO it is the funnel's listStoreEntries on the
 * sessions bucket; in memory it reads the adapter's map.
 * A lister returning null means "listing unavailable" and
 * every listing operation preserves that as null.
 *
 * #CDO-mha7
 */
import { SESSION_LIMITS } from "../config/sessionLimits";
import type { SessionData } from "../types";
import type { KvLike } from "../security/kvResilience";
import type { IdentityBinding } from "../security/identityBinding";
import {
  createKvMembershipStore,
  listMembershipsFromEntries,
  readMembershipById,
} from "../security/iaaaMembershipStore";
import { createAccessRequestStore } from "../security/iaaaAccessRequests";
import {
  parseSessionRegistryEntries,
  type SessionRegistryEntry,
} from "../security/iaaaSessionRegistry";
import {
  SESSION_BINDING_KEY_PREFIX,
  SESSION_MEMBERSHIP_KEY_PREFIX,
  type SessionFamilyPorts,
  type SessionUpdateResult,
} from "./sessionPorts";

export type SessionLister = (
  prefix: string,
) => Promise<Array<{ key: string; value: string }> | null>;

const ABSOLUTE_TTL_SECONDS = SESSION_LIMITS.absoluteTtlSeconds;
const MAX_LIFETIME_SECONDS = SESSION_LIMITS.maxLifetimeSeconds;
const RENEW_WINDOW_SECONDS = SESSION_LIMITS.renewWindowSeconds;

function sessionRenewalDue(session: SessionData, nowMs: number): boolean {
  if (typeof session.createdAt !== "number" || !Number.isFinite(session.createdAt)) return false;
  const firstCreatedAt =
    typeof session.firstCreatedAt === "number" && Number.isFinite(session.firstCreatedAt)
      ? session.firstCreatedAt
      : session.createdAt;
  if (nowMs >= firstCreatedAt + MAX_LIFETIME_SECONDS * 1000) return false;
  const remainingMs = session.createdAt + ABSOLUTE_TTL_SECONDS * 1000 - nowMs;
  return remainingMs > 0 && remainingMs <= RENEW_WINDOW_SECONDS * 1000;
}

/** Build the family over any KvLike + lister (the adapters' shared core). */
export function createKvBackedSessionFamily(
  kv: KvLike,
  lister: SessionLister,
): SessionFamilyPorts {
  const sessions: SessionFamilyPorts["sessions"] = {
    async create(data) {
      const sessionId = crypto.randomUUID();
      await kv.put(sessionId, JSON.stringify(data), {
        expirationTtl: ABSOLUTE_TTL_SECONDS,
      });
      return sessionId;
    },
    async get(sessionId) {
      const raw = await kv.get(sessionId);
      if (!raw) return null;
      try {
        return JSON.parse(raw) as SessionData;
      } catch {
        return null;
      }
    },
    async getRaw(sessionId) {
      return kv.get(sessionId);
    },
    async update(sessionId, data, nowMs): Promise<SessionUpdateResult> {
      if (typeof data.createdAt !== "number" || !Number.isFinite(data.createdAt)) {
        return {
          ok: false,
          code: "SESSION_INVALID_CREATED_AT",
          error:
            "session has no valid createdAt, so its absolute deadline cannot be preserved",
        };
      }
      const remainingMs = data.createdAt + ABSOLUTE_TTL_SECONDS * 1000 - nowMs;
      const remainingTtlSeconds = Math.floor(remainingMs / 1000);
      if (remainingTtlSeconds < 1) {
        return {
          ok: false,
          code: "SESSION_ABSOLUTE_EXPIRED",
          error:
            "session is past (or within one second of) its absolute expiry; nothing was stored",
        };
      }
      await kv.put(sessionId, JSON.stringify(data), {
        expirationTtl: remainingTtlSeconds,
      });
      return { ok: true, remainingTtlSeconds };
    },
    async renew(sessionId, session, nowMs) {
      if (!sessionRenewalDue(session, nowMs)) return false;
      const firstCreatedAt =
        typeof session.firstCreatedAt === "number" && Number.isFinite(session.firstCreatedAt)
          ? session.firstCreatedAt
          : session.createdAt;
      const renewed: SessionData = {
        ...session,
        createdAt: nowMs,
        firstCreatedAt,
        lastActivityMs: nowMs,
      };
      await kv.put(sessionId, JSON.stringify(renewed), {
        expirationTtl: ABSOLUTE_TTL_SECONDS,
      });
      return true;
    },
    async delete(sessionId) {
      await kv.delete(sessionId);
    },
    async listSessionsForRevocation(): Promise<SessionRegistryEntry[] | null> {
      const entries = await lister("");
      if (!entries) return null;
      // UUID filter lives in the registry parser: non-UUID
      // keys (bindings, membership, audit, access requests)
      // are skipped, never surfaced as sessions.
      return parseSessionRegistryEntries(entries);
    },
    async listRawEntries(prefix) {
      return lister(prefix);
    },
  };

  const byProviderKey = (issuer: string, subject: string) =>
    `${SESSION_BINDING_KEY_PREFIX}${issuer}\0${subject}`;
  const byUserKey = (userId: string, issuer: string) =>
    `${SESSION_BINDING_KEY_PREFIX}user:${userId}\0${issuer}`;
  async function readBinding(key: string): Promise<IdentityBinding | null> {
    const raw = await kv.get(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as IdentityBinding;
    } catch {
      return null;
    }
  }
  const bindings: SessionFamilyPorts["bindings"] = {
    async getByProvider(providerIssuer, providerSubject) {
      return readBinding(byProviderKey(providerIssuer, providerSubject));
    },
    async getByUserAndIssuer(internalUserId, providerIssuer) {
      return readBinding(byUserKey(internalUserId, providerIssuer));
    },
    async put(binding) {
      const value = JSON.stringify(binding);
      await kv.put(byProviderKey(binding.providerIssuer, binding.providerSubject), value);
      await kv.put(byUserKey(binding.internalUserId, binding.providerIssuer), value);
    },
    async removeByUserAndIssuer(internalUserId, providerIssuer) {
      await kv.delete(byUserKey(internalUserId, providerIssuer));
    },
  };

  const membershipStore = createKvMembershipStore(kv);
  const memberships: SessionFamilyPorts["memberships"] = {
    getMembershipsByUser: (id) => membershipStore.getMembershipsByUser(id),
    put: (m) => membershipStore.put(m),
    revokeMembership: (id, nowMs) => membershipStore.revokeMembership(id, nowMs),
    readById: (id) => readMembershipById(kv, id),
    listFromEntries: (entries) => listMembershipsFromEntries(entries),
    async listAll() {
      const entries = await lister(SESSION_MEMBERSHIP_KEY_PREFIX);
      if (!entries) return null;
      return listMembershipsFromEntries(entries);
    },
    async listRawEntries() {
      return lister(SESSION_MEMBERSHIP_KEY_PREFIX);
    },
  };

  return {
    sessions,
    bindings,
    memberships,
    accessRequests: createAccessRequestStore(kv),
    kv,
    legacyFallback: false,
  };
}
