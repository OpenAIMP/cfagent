/**
 * #1750 (parent #1717, IAAA-2): numeric revocation-propagation targets
 * per trigger, with proving tests.
 *
 * Before this slice, authz.md §9 stated revocation propagation as an
 * observed property only ("wired sessions re-validate on fresh reads,
 * bounded by a 60-second isolate cache") with NO numeric target. This
 * file pins the replacement targets (src/security/revocationTargets.ts)
 * AND proves each one against the real gate mechanism — revoke, then
 * check the gate at the bound, with no weaker substitute:
 *
 * - membership-revocation: PDP check denies at the SAME timestamp as
 *   the revoking write (0 ms grace — the PDP reads the membership
 *   store fresh; there is no membership cache between store and PDP).
 * - admin-removal: the admin-overview gate denies at the SAME
 *   timestamp as the revoking write (same fresh-read mechanism).
 * - api-key-deletion: verifyApiKey denies at the SAME tick as the
 *   deletion (the MCP transport reads the key store fresh).
 * - session-revocation: a wired session whose store record is gone
 *   is denied by the wired validation path even though a cached copy
 *   exists (fresh read, not the cache). The cross-isolate cached
 *   path is proved in the companion file
 *   (iaaa_revocation_session_cache_1750.test.ts): same-isolate 0 ms
 *   via invalidation, every other isolate within the 60 s cache TTL.
 * - token-expiry: absolute expiry denies exactly at createdAt + 7 d
 *   (SESSION_TTL); idle expiry denies exactly at recorded
 *   last-activity + 30 min (the enforced default); an OIDC claim
 *   denies exactly at its exp. A session with NO recorded activity
 *   is idle-exempt by design (legacy contract) — pinned here as the
 *   documented residual, not as a passing idle target.
 *
 * Targets are constants, not configuration: no caller, session, or
 * env value can widen them (security guard for this program — a
 * caller-extendable revocation grace would let a caller disable
 * their own enforcement). The table is frozen; the test asserts it.
 *
 * Written FIRST (TDD Red): these tests fail on the pre-change tree,
 * which has no src/security/revocationTargets.ts module at all.
 */
import { describe, expect, it } from "vitest";
import {
  REVOCATION_TARGETS,
  REVOCATION_TARGET_BY_TRIGGER,
  SESSION_REVOCATION_SAME_ISOLATE_BOUND_MS,
  type RevocationTrigger,
} from "../src/security/revocationTargets";
import { SESSION_TTL } from "../src/security/session";
import { SESSION_CACHE_POSITIVE_TTL_MS } from "../src/security/sessionCache";
import {
  DEFAULT_IDLE_TIMEOUT_MS,
  googleOidcProviderDescriptor,
  validateOidcClaims,
} from "../src/security/sessionPolicy";
import {
  createMembership,
  type MembershipStore,
} from "../src/security/authorization";
import { createKvMembershipStore } from "../src/security/iaaaMembershipStore";
import type { KvLike } from "../src/security/kvResilience";
import { checkRoutePermission } from "../src/security/iaaaGithubEndToEnd";
import {
  buildAdminOverview,
} from "../src/security/iaaaAdminOverview";
import { createMemoryAuditStore } from "../src/security/iaaaAudit";
import { getValidatedSession } from "../src/security/iaaaLogin";
import { validateAndTouchWiredSession } from "../src/security/iaaaEnforcement";
import type { Env, SessionData } from "../src/types";
import { makeFakeSessionStore } from "./fake-session-store";
import {
  mintApiKey,
  revokeApiKey,
  verifyApiKey,
} from "../src/security/apiKeys";

const NOW = 1_800_000_000_000;
const USER = "user-1750";
const TENANT = "tenant-a";

function memoryKv(): KvLike {
  const map = new Map<string, string>();
  return {
    async get(key: string): Promise<string | null> {
      return map.get(key) ?? null;
    },
    async put(key: string, value: string): Promise<void> {
      map.set(key, value);
    },
    async delete(key: string): Promise<void> {
      map.delete(key);
    },
  };
}

async function grantTenantAdmin(
  store: MembershipStore,
  user: string,
): Promise<string> {
  const created = await createMembership(store, {
    internalUserId: user,
    tenantId: TENANT,
    roleBindings: [
      { role: "tenant-admin", scope: "tenant", grantedBy: "platform-admin-1" },
    ],
    createdBy: "platform-admin-1",
    nowMs: NOW,
  });
  if (!created.ok) throw new Error(`expected membership ok: ${created.code}`);
  return created.membership.membershipId;
}

function wiredSession(overrides?: Partial<SessionData>): SessionData {
  return {
    githubLogin: "octo-1750",
    githubAvatar: "https://avatars.example/u/1750",
    githubName: "Octo 1750",
    createdAt: NOW,
    internalUserId: USER,
    lastActivityMs: NOW,
    authTimeMs: NOW,
    ...overrides,
  };
}

describe("revocation targets table (#1750)", () => {
  it("covers all five required triggers, exactly once each", () => {
    const triggers: RevocationTrigger[] = [
      "membership-revocation",
      "session-revocation",
      "api-key-deletion",
      "admin-removal",
      "token-expiry",
    ];
    expect(REVOCATION_TARGETS.map((t) => t.trigger).sort()).toEqual(
      [...triggers].sort(),
    );
    for (const trigger of triggers) {
      expect(REVOCATION_TARGET_BY_TRIGGER[trigger].trigger).toBe(trigger);
    }
  });

  it("is frozen: no caller can widen a target at runtime", () => {
    expect(Object.isFrozen(REVOCATION_TARGETS)).toBe(true);
    for (const target of REVOCATION_TARGETS) {
      expect(Object.isFrozen(target)).toBe(true);
    }
  });

  it("sets 0 ms grace for every fresh-read gate, and the cache TTL for sessions", () => {
    expect(REVOCATION_TARGET_BY_TRIGGER["membership-revocation"].boundMs).toBe(0);
    expect(REVOCATION_TARGET_BY_TRIGGER["api-key-deletion"].boundMs).toBe(0);
    expect(REVOCATION_TARGET_BY_TRIGGER["admin-removal"].boundMs).toBe(0);
    expect(REVOCATION_TARGET_BY_TRIGGER["token-expiry"].boundMs).toBe(0);
    expect(REVOCATION_TARGET_BY_TRIGGER["session-revocation"].boundMs).toBe(
      SESSION_CACHE_POSITIVE_TTL_MS,
    );
    expect(SESSION_REVOCATION_SAME_ISOLATE_BOUND_MS).toBe(0);
  });

  it("reuses enforced values, inventing no new threshold", () => {
    // The session bound IS the isolate-cache TTL (single source of
    // truth in sessionCache.ts), not a second number that could drift.
    expect(REVOCATION_TARGET_BY_TRIGGER["session-revocation"].boundMs).toBe(
      60_000,
    );
    // The token-expiry row reuses SESSION_TTL (7 days) and the idle
    // default (30 min) — both already enforced; idle and step-up are
    // settled as CISO values by #1757 (values unchanged).
    expect(SESSION_TTL).toBe(7 * 24 * 60 * 60);
    expect(DEFAULT_IDLE_TIMEOUT_MS).toBeGreaterThan(0);
  });
});

describe("membership-revocation target: 0 ms at the PDP gate (#1750)", () => {
  it("revoke -> PDP denies at the same timestamp (no time advance)", async () => {
    const store = createKvMembershipStore(memoryKv());
    const membershipId = await grantTenantAdmin(store, USER);
    const session = wiredSession();

    expect(
      await checkRoutePermission(store, session, TENANT, "task:create", NOW),
    ).toBe(true);

    expect(await store.revokeMembership(membershipId, NOW)).toBe(true);

    // Same NOW: zero grace between the revoking write and the denial.
    expect(
      await checkRoutePermission(store, session, TENANT, "task:create", NOW),
    ).toBe(false);
  });

  it("a binding past its expiry denies exactly at the deadline", async () => {
    const store = createKvMembershipStore(memoryKv());
    const created = await createMembership(store, {
      internalUserId: USER,
      tenantId: TENANT,
      roleBindings: [
        {
          role: "tenant-admin",
          scope: "tenant",
          grantedBy: "platform-admin-1",
          expiresAtMs: NOW + 1,
        },
      ],
      createdBy: "platform-admin-1",
      nowMs: NOW,
    });
    if (!created.ok) throw new Error(`expected membership ok: ${created.code}`);
    const session = wiredSession();
    expect(
      await checkRoutePermission(store, session, TENANT, "task:create", NOW),
    ).toBe(true);
    expect(
      await checkRoutePermission(
        store,
        session,
        TENANT,
        "task:create",
        NOW + 1,
      ),
    ).toBe(false);
  });
});

describe("admin-removal target: 0 ms at the admin gate (#1750)", () => {
  it("revoke the platform-admin membership -> overview gate denies at the same timestamp", async () => {
    const kv = memoryKv();
    const store = createKvMembershipStore(kv);
    const created = await createMembership(store, {
      internalUserId: USER,
      tenantId: TENANT,
      roleBindings: [
        {
          role: "platform-admin",
          scope: "platform",
          grantedBy: "system:bootstrap",
        },
      ],
      createdBy: "system:bootstrap",
      nowMs: NOW,
    });
    if (!created.ok) throw new Error(`expected membership ok: ${created.code}`);
    const deps = {
      membershipStore: store,
      auditStore: createMemoryAuditStore(),
      kv,
      tenantId: TENANT,
      nowMs: NOW,
    };
    const before = await buildAdminOverview(deps, {
      callerInternalUserId: USER,
    });
    expect(before.allowed).toBe(true);

    expect(await store.revokeMembership(created.membership.membershipId, NOW)).toBe(true);

    const after = await buildAdminOverview(deps, {
      callerInternalUserId: USER,
    });
    expect(after).toEqual({ allowed: false });
  });
});

describe("api-key-deletion target: 0 ms at the next verification (#1750)", () => {
  it("revoke -> verify denies on the very next check", async () => {
    const fake = makeFakeSessionStore();
    const env = { SESSION_STORE: fake.namespace } as unknown as Env;
    const { key, secret } = await mintApiKey(env, "alice-1750", "laptop");
    expect(await verifyApiKey(env, secret)).toEqual({
      login: "alice-1750",
      keyId: key.id,
    });

    expect(await revokeApiKey(env, "alice-1750", key.id)).toBe(true);

    // No timer advance, no grace: the next verification denies.
    expect(await verifyApiKey(env, secret)).toBeNull();
  });
});

describe("session-revocation target: wired path denies despite a cached copy (#1750)", () => {
  it("control: a live wired session still validates", async () => {
    const cached = wiredSession();
    const invalidated: string[] = [];
    const result = await validateAndTouchWiredSession(
      {
        freshRead: async () => ({ ...cached }),
        persist: async () => ({ ok: true }),
        invalidate: (id: string) => {
          invalidated.push(id);
        },
      },
      cached,
      "session-1750",
      NOW,
    );
    expect(result).toEqual({ wired: true, session: expect.anything() });
  });

  it("deleted store record -> wired validation denies (cache cannot resurrect it)", async () => {
    const cached = wiredSession();
    const invalidated: string[] = [];
    const result = await validateAndTouchWiredSession(
      {
        // The store record is gone (logout/delete in any isolate).
        freshRead: async () => null,
        persist: async () => ({ ok: true }),
        invalidate: (id: string) => {
          invalidated.push(id);
        },
      },
      cached,
      "session-1750",
      NOW,
    );
    expect(result).toEqual({ wired: true, session: null });
    expect(invalidated).toEqual(["session-1750"]);
  });
});

describe("token-expiry target: 0 ms past each deadline (#1750)", () => {
  it("absolute expiry denies exactly at createdAt + SESSION_TTL", () => {
    const ttlMs = SESSION_TTL * 1000;
    const justInside = wiredSession({
      createdAt: NOW - ttlMs + 1,
      lastActivityMs: NOW,
    });
    expect(getValidatedSession(justInside, NOW).ok).toBe(true);
    const atDeadline = wiredSession({
      createdAt: NOW - ttlMs,
      lastActivityMs: NOW,
    });
    const denied = getValidatedSession(atDeadline, NOW);
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.code).toBe("SESSION_EXPIRED");
  });

  it("idle expiry denies exactly at recorded last-activity + idle timeout", () => {
    const justInside = wiredSession({
      lastActivityMs: NOW - DEFAULT_IDLE_TIMEOUT_MS + 1,
    });
    expect(getValidatedSession(justInside, NOW).ok).toBe(true);
    const atDeadline = wiredSession({
      lastActivityMs: NOW - DEFAULT_IDLE_TIMEOUT_MS,
    });
    const denied = getValidatedSession(atDeadline, NOW);
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.code).toBe("SESSION_IDLE_EXPIRED");
  });

  it("a session with no recorded activity is idle-exempt (pinned residual, not a target)", () => {
    // Legacy / Phase 1 sessions carry no lastActivityMs and are
    // exempt from idle expiry by the Phase 2a contract. This is
    // NOT covered by the idle target: their only expiry bound is
    // the absolute deadline (store TTL) above. See authz.md §9.
    const legacy = wiredSession({ lastActivityMs: undefined });
    delete (legacy as Partial<SessionData>).lastActivityMs;
    expect(getValidatedSession(legacy, NOW).ok).toBe(true);
  });

  it("an OIDC claim denies exactly at its exp", () => {
    const provider = googleOidcProviderDescriptor("client-1750");
    const expSeconds = Math.floor(NOW / 1000);
    const claims = {
      iss: "https://accounts.google.com",
      aud: "client-1750",
      sub: "sub-1750",
      exp: expSeconds,
    };
    expect(validateOidcClaims(provider, claims, NOW)).toEqual({
      ok: false,
      code: "TOKEN_EXPIRED",
      error: "token has expired",
    });
    expect(
      validateOidcClaims(provider, { ...claims, exp: expSeconds + 1 }, NOW),
    ).toEqual({ ok: true });
  });
});
