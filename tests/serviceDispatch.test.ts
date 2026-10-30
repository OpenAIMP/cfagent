import { describe, expect, it } from "vitest";
import {
  createMemoryMembershipStore,
  type AuthorizationScope,
  type Membership,
  type MembershipStore,
  type Role,
} from "../src/security/authorization";
import {
  enforceBrokerDispatch,
  enforceServiceDispatch,
  isPlatformServiceProvisioned,
  resolveAsyncJobIdentity,
  resolveDispatchCandidate,
  type DispatchDecision,
} from "../src/security/serviceDispatch";

const SERVICE_LOGIN = "svc-background";
const SERVICE_ID = `service:${SERVICE_LOGIN}`;
const NOW = 1_700_000_000_000;
const FUTURE = NOW + 60_000;
const PAST = NOW - 60_000;

function membershipFor(
  userId: string,
  opts: {
    role: Role;
    scope: AuthorizationScope;
    tenantId: string;
    expiresAtMs?: number;
    revokedAtMs?: number;
  },
): Membership {
  return {
    membershipId: `m-${userId}-${opts.tenantId}-${opts.role}-${opts.scope}`,
    internalUserId: userId,
    tenantId: opts.tenantId,
    roleBindings: [
      {
        role: opts.role,
        scope: opts.scope,
        grantedBy: "test",
        ...(opts.expiresAtMs !== undefined ? { expiresAtMs: opts.expiresAtMs } : {}),
      },
    ],
    createdBy: "test",
    createdAtMs: NOW - 2_000,
    ...(opts.revokedAtMs !== undefined ? { revokedAtMs: opts.revokedAtMs } : {}),
  };
}

async function seedStore(memberships: Membership[]): Promise<MembershipStore> {
  const store = createMemoryMembershipStore();
  for (const membership of memberships) await store.put(membership);
  return store;
}

describe("resolveDispatchCandidate", () => {
  it("denies an empty or unshaped candidate", () => {
    expect(resolveDispatchCandidate(undefined, SERVICE_LOGIN)).toEqual({
      denied: true,
      reason: "NO_IDENTITY",
    });
    expect(resolveDispatchCandidate("", SERVICE_LOGIN)).toEqual({
      denied: true,
      reason: "NO_IDENTITY",
    });
    expect(resolveDispatchCandidate("not a login!", SERVICE_LOGIN)).toEqual({
      denied: true,
      reason: "NO_IDENTITY",
    });
  });

  it("denies the shared-orchestrator address as an identity", () => {
    expect(resolveDispatchCandidate("default_trader", SERVICE_LOGIN)).toEqual({
      denied: true,
      reason: "SHARED_ADDRESS",
    });
    expect(resolveDispatchCandidate("default_trader", null)).toEqual({
      denied: true,
      reason: "SHARED_ADDRESS",
    });
  });

  it("resolves the configured service login as the service tier", () => {
    expect(resolveDispatchCandidate(SERVICE_LOGIN, SERVICE_LOGIN)).toEqual({
      kind: "service",
      login: SERVICE_LOGIN,
    });
  });

  it("resolves any other shaped login as the owner tier", () => {
    expect(resolveDispatchCandidate("alice", SERVICE_LOGIN)).toEqual({
      kind: "owner",
      login: "alice",
    });
  });

  it("treats the service-login string as an owner when no service login is configured", () => {
    // Service-ness is equality with the configured login only. A stale
    // service-login string with no configuration behind it is not a
    // service dispatch; it resolves as an owner login (system-written
    // payloads only) and still cannot present any user's token.
    expect(resolveDispatchCandidate(SERVICE_LOGIN, null)).toEqual({
      kind: "owner",
      login: SERVICE_LOGIN,
    });
  });
});

describe("enforceServiceDispatch: platform tier", () => {
  it("allows a live platform-scope member binding for the service id", async () => {
    const store = await seedStore([
      membershipFor(SERVICE_ID, { role: "member", scope: "platform", tenantId: "primary" }),
    ]);
    const decision: DispatchDecision = await enforceServiceDispatch(store, {
      serviceLogin: SERVICE_LOGIN,
      tier: "platform",
      nowMs: NOW,
    });
    expect(decision).toEqual({ allowed: true, kind: "service", login: SERVICE_LOGIN });
  });

  it("denies when no membership exists for the service id", async () => {
    const store = createMemoryMembershipStore();
    const decision = await enforceServiceDispatch(store, {
      serviceLogin: SERVICE_LOGIN,
      tier: "platform",
      nowMs: NOW,
    });
    expect(decision).toEqual({ denied: true, reason: "SERVICE_NOT_PROVISIONED" });
  });

  it("denies when the only platform binding is revoked", async () => {
    const store = await seedStore([
      membershipFor(SERVICE_ID, {
        role: "member",
        scope: "platform",
        tenantId: "primary",
        revokedAtMs: NOW - 1,
      }),
    ]);
    const decision = await enforceServiceDispatch(store, {
      serviceLogin: SERVICE_LOGIN,
      tier: "platform",
      nowMs: NOW,
    });
    expect(decision).toEqual({ denied: true, reason: "SERVICE_NOT_PROVISIONED" });
  });

  it("denies when the only platform binding is expired", async () => {
    const store = await seedStore([
      membershipFor(SERVICE_ID, {
        role: "member",
        scope: "platform",
        tenantId: "primary",
        expiresAtMs: PAST,
      }),
    ]);
    const decision = await enforceServiceDispatch(store, {
      serviceLogin: SERVICE_LOGIN,
      tier: "platform",
      nowMs: NOW,
    });
    expect(decision).toEqual({ denied: true, reason: "SERVICE_NOT_PROVISIONED" });
  });

  it("denies a platform-admin binding for the service user (member-only gate)", async () => {
    // Slice 1 grants member only; a platform-admin binding for the service
    // id is an anomaly, not an upgrade. Denying surfaces it via audit
    // instead of silently running with admin.
    const store = await seedStore([
      membershipFor(SERVICE_ID, { role: "platform-admin", scope: "platform", tenantId: "primary" }),
    ]);
    const decision = await enforceServiceDispatch(store, {
      serviceLogin: SERVICE_LOGIN,
      tier: "platform",
      nowMs: NOW,
    });
    expect(decision).toEqual({ denied: true, reason: "SERVICE_NOT_PROVISIONED" });
  });

  it("denies when the service login is unconfigured", async () => {
    const store = await seedStore([
      membershipFor(SERVICE_ID, { role: "member", scope: "platform", tenantId: "primary" }),
    ]);
    const decision = await enforceServiceDispatch(store, {
      serviceLogin: null,
      tier: "platform",
      nowMs: NOW,
    });
    expect(decision).toEqual({ denied: true, reason: "SERVICE_NOT_CONFIGURED" });
  });

  it("ignores bindings belonging to other users", async () => {
    const store = await seedStore([
      membershipFor("alice", { role: "member", scope: "platform", tenantId: "primary" }),
    ]);
    const decision = await enforceServiceDispatch(store, {
      serviceLogin: SERVICE_LOGIN,
      tier: "platform",
      nowMs: NOW,
    });
    expect(decision).toEqual({ denied: true, reason: "SERVICE_NOT_PROVISIONED" });
  });

  it("accepts a binding whose expiry is in the future", async () => {
    const store = await seedStore([
      membershipFor(SERVICE_ID, {
        role: "member",
        scope: "platform",
        tenantId: "primary",
        expiresAtMs: FUTURE,
      }),
    ]);
    const decision = await enforceServiceDispatch(store, {
      serviceLogin: SERVICE_LOGIN,
      tier: "platform",
      nowMs: NOW,
    });
    expect(decision).toEqual({ allowed: true, kind: "service", login: SERVICE_LOGIN });
  });
});

describe("enforceServiceDispatch: tenant tier", () => {
  it("allows a live tenant member binding and passes the PDP task:create check", async () => {
    const store = await seedStore([
      membershipFor(SERVICE_ID, { role: "member", scope: "tenant", tenantId: "tenant-a" }),
    ]);
    const decision = await enforceServiceDispatch(store, {
      serviceLogin: SERVICE_LOGIN,
      tier: "tenant",
      tenantId: "tenant-a",
      nowMs: NOW,
    });
    expect(decision).toEqual({ allowed: true, kind: "service", login: SERVICE_LOGIN });
  });

  it("denies a tenant membership that lives in another tenant", async () => {
    const store = await seedStore([
      membershipFor(SERVICE_ID, { role: "member", scope: "tenant", tenantId: "tenant-b" }),
    ]);
    const decision = await enforceServiceDispatch(store, {
      serviceLogin: SERVICE_LOGIN,
      tier: "tenant",
      tenantId: "tenant-a",
      nowMs: NOW,
    });
    expect(decision).toEqual({ denied: true, reason: "SERVICE_TENANT_MISMATCH" });
  });

  it("denies a revoked tenant binding", async () => {
    const store = await seedStore([
      membershipFor(SERVICE_ID, {
        role: "member",
        scope: "tenant",
        tenantId: "tenant-a",
        revokedAtMs: NOW - 1,
      }),
    ]);
    const decision = await enforceServiceDispatch(store, {
      serviceLogin: SERVICE_LOGIN,
      tier: "tenant",
      tenantId: "tenant-a",
      nowMs: NOW,
    });
    expect(decision).toEqual({ denied: true, reason: "SERVICE_NOT_PROVISIONED" });
  });

  it("denies when the tenant is missing from the request", async () => {
    const store = await seedStore([
      membershipFor(SERVICE_ID, { role: "member", scope: "tenant", tenantId: "tenant-a" }),
    ]);
    const decision = await enforceServiceDispatch(store, {
      serviceLogin: SERVICE_LOGIN,
      tier: "tenant",
      nowMs: NOW,
    });
    expect(decision).toEqual({ denied: true, reason: "SERVICE_TENANT_MISMATCH" });
  });
});

describe("enforceBrokerDispatch", () => {
  it("denies a service dispatch that needs brokerage", () => {
    expect(enforceBrokerDispatch("service", true)).toEqual({
      denied: true,
      reason: "BROKER_REQUIRED",
    });
  });

  it("allows a service dispatch that does not need brokerage", () => {
    expect(enforceBrokerDispatch("service", false)).toEqual({ allowed: true, kind: "service" });
  });

  it("allows an owner dispatch with or without brokerage", () => {
    expect(enforceBrokerDispatch("owner", true)).toEqual({ allowed: true, kind: "owner" });
    expect(enforceBrokerDispatch("owner", false)).toEqual({ allowed: true, kind: "owner" });
  });
});

describe("isPlatformServiceProvisioned (Worker helper)", () => {
  it("returns false when no service login is configured", async () => {
    const store = await seedStore([
      membershipFor(SERVICE_ID, { role: "member", scope: "platform", tenantId: "primary" }),
    ]);
    expect(await isPlatformServiceProvisioned(store, null, NOW)).toBe(false);
  });

  it("returns true only for a live platform member binding", async () => {
    const store = await seedStore([
      membershipFor(SERVICE_ID, { role: "member", scope: "platform", tenantId: "primary" }),
    ]);
    expect(await isPlatformServiceProvisioned(store, SERVICE_LOGIN, NOW)).toBe(true);
    const empty = createMemoryMembershipStore();
    expect(await isPlatformServiceProvisioned(empty, SERVICE_LOGIN, NOW)).toBe(false);
  });
});

describe("resolveAsyncJobIdentity", () => {
  it("prefers payload userLogin, then actingLogin, then the x-user-login header", () => {
    expect(
      resolveAsyncJobIdentity(
        { userLogin: "alice", actingLogin: "bob" },
        { "x-user-login": "carol" },
        "session-1",
        SERVICE_LOGIN,
      ),
    ).toEqual({ kind: "owner", login: "alice" });
    expect(
      resolveAsyncJobIdentity(
        { actingLogin: "bob" },
        { "x-user-login": "carol" },
        "session-1",
        SERVICE_LOGIN,
      ),
    ).toEqual({ kind: "owner", login: "bob" });
    expect(
      resolveAsyncJobIdentity({}, { "x-user-login": "carol" }, "session-1", SERVICE_LOGIN),
    ).toEqual({ kind: "owner", login: "carol" });
  });

  it("resolves the service login from any of the identity fields", () => {
    expect(
      resolveAsyncJobIdentity({}, { "x-user-login": SERVICE_LOGIN }, "session-1", SERVICE_LOGIN),
    ).toEqual({ kind: "service", login: SERVICE_LOGIN });
    expect(
      resolveAsyncJobIdentity({ actingLogin: SERVICE_LOGIN }, {}, "session-1", SERVICE_LOGIN),
    ).toEqual({ kind: "service", login: SERVICE_LOGIN });
  });

  it("falls back to the instance session key, and denies the shared address", () => {
    expect(resolveAsyncJobIdentity({}, {}, "session-1", SERVICE_LOGIN)).toEqual({
      kind: "owner",
      login: "session-1",
    });
    expect(resolveAsyncJobIdentity({}, {}, "default_trader", SERVICE_LOGIN)).toEqual({
      denied: true,
      reason: "SHARED_ADDRESS",
    });
  });
});
