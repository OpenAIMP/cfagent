/**
 * #1756 (parent #1717, F-10) — atomic genesis claim + marker hygiene.
 *
 * The genesis marker was check-then-set: two concurrent first-logins
 * could both observe an absent marker and both win platform-admin.
 * The fix claims the marker atomically (KvLike.putIfAbsent, backed
 * in production by the SessionStore DO's atomic consume op): the
 * claim winner grants platform-admin, the loser falls through to
 * the existing genesis-closed tenant-admin path and never writes
 * the marker. No enforcement decision changes — only which caller
 * wins the one-shot window, and only once.
 *
 * The concurrency pin below is written against an interleaving kv:
 * get() yields before reading, so two concurrent logins both
 * observe an absent marker under the old get-then-put code (RED:
 * both report "genesis" and both hold platform-admin). Under the
 * claim code exactly one wins (GREEN). putIfAbsent itself performs
 * its check-and-set synchronously (no await between them), mirroring
 * the DO's serialized consume op, so it cannot interleave.
 *
 * Marker hygiene (F-59) pins: the #1208 repair still runs before
 * the claim (a stranded marker is deleted, then claimed and re-set
 * to the logging-in id); a live marker is never overwritten by the
 * claim path; a lost claim never writes the marker; a claim won but
 * followed by a failed grant releases the marker so a retry can win.
 */
import { describe, expect, it } from "vitest";
import {
  createMemoryIdentityBindingStore,
} from "../src/security/identityBinding";
import {
  createMemoryMembershipStore,
  type MembershipStore,
} from "../src/security/authorization";
import type { KvLike } from "../src/security/kvResilience";
import {
  platformGenesisMarkerKey,
  runWiredPostLogin,
} from "../src/security/iaaaGithubEndToEnd";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";
const RETIRED_OCT22_ID = "00fbb0ba-9e4b-43ec-a7d6-df2a1dfc5d6c";
const NOW = 1780000000000;
const MARKER_KEY = platformGenesisMarkerKey("primary");

/** Yield to the event loop so a concurrent caller can interleave. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * KvLike modelling two Worker isolates talking to one store: get()
 * and put() each yield before touching the map (the network round
 * trip), so under the old get-then-put code two concurrent callers
 * both observe an absent marker and both win. putIfAbsent() is
 * atomic (synchronous check-and-set, no await between them),
 * mirroring the DO's serialized consume op, so it cannot interleave.
 */
function interleavingAtomicKv(): KvLike {
  const map = new Map<string, string>();
  return {
    async get(key: string) {
      await tick();
      return map.get(key) ?? null;
    },
    async put(key: string, value: string) {
      await tick();
      map.set(key, value);
    },
    async delete(key: string) {
      map.delete(key);
    },
    async putIfAbsent(key: string, value: string) {
      if (map.has(key)) return false;
      map.set(key, value);
      return true;
    },
  };
}

/** KvLike whose claim always loses (marker already held elsewhere). */
function alwaysLosesKv(): KvLike {
  const map = new Map<string, string>();
  return {
    async get(key: string) {
      return map.get(key) ?? null;
    },
    async put(key: string, value: string) {
      map.set(key, value);
    },
    async delete(key: string) {
      map.delete(key);
    },
    async putIfAbsent() {
      return false;
    },
  };
}

/** Plain KvLike with no atomic claim (the legacy check-then-set path). */
function legacyKv(): KvLike {
  const map = new Map<string, string>();
  return {
    async get(key: string) {
      return map.get(key) ?? null;
    },
    async put(key: string, value: string) {
      map.set(key, value);
    },
    async delete(key: string) {
      map.delete(key);
    },
  };
}

function loginInput(
  githubLogin: string,
  internalUserId: string,
  bootstrapRaw: string | undefined,
) {
  return {
    githubLogin,
    internalUserId,
    providerIssuer: "https://github.com",
    providerSubject: "123",
    bootstrapRaw,
    tenantId: "primary",
    nowMs: NOW,
  };
}

function deps(kv: KvLike, membershipStore?: MembershipStore) {
  return {
    kv,
    bindingStore: createMemoryIdentityBindingStore(),
    membershipStore: membershipStore ?? createMemoryMembershipStore(),
  };
}

async function platformAdminHolders(
  store: MembershipStore,
  userIds: string[],
): Promise<string[]> {
  const holders: string[] = [];
  for (const userId of userIds) {
    const memberships = await store.getMembershipsByUser(userId);
    if (
      memberships.some((m) =>
        m.roleBindings.some(
          (b) => b.role === "platform-admin" && b.scope === "platform",
        ),
      )
    ) {
      holders.push(userId);
    }
  }
  return holders;
}

function strandedMarker(): string {
  return JSON.stringify({
    grantedTo: RETIRED_OCT22_ID,
    tenantId: "primary",
    atMs: NOW - 1000,
  });
}

describe("atomic genesis claim (#1756)", () => {
  it("two concurrent first-logins yield exactly one genesis winner", async () => {
    const kv = interleavingAtomicKv();
    const d = deps(kv);
    const [first, second] = await Promise.all([
      runWiredPostLogin(d, loginInput("alice", UUID_A, `platform:${UUID_A}`)),
      runWiredPostLogin(d, loginInput("bob", UUID_B, `platform:${UUID_B}`)),
    ]);
    expect([first.bootstrap.status, second.bootstrap.status].sort()).toEqual([
      "genesis",
      "genesis-closed-tenant-admin",
    ]);
    const holders = await platformAdminHolders(d.membershipStore, [UUID_A, UUID_B]);
    expect(holders).toHaveLength(1);
    const marker = await kv.get(MARKER_KEY);
    expect(marker).not.toBeNull();
    expect(JSON.parse(marker!).grantedTo).toBe(holders[0]);
    // The loser holds tenant-admin only, never platform-admin.
    const loser = holders[0] === UUID_A ? UUID_B : UUID_A;
    const loserMemberships = await d.membershipStore.getMembershipsByUser(loser);
    expect(loserMemberships).toHaveLength(1);
    expect(loserMemberships[0].roleBindings[0].role).toBe("tenant-admin");
  });

  it("a single first-login still wins via the atomic claim", async () => {
    const kv = interleavingAtomicKv();
    const d = deps(kv);
    const result = await runWiredPostLogin(
      d,
      loginInput("alice", UUID_A, `platform:${UUID_A}`),
    );
    expect(result.bootstrap.status).toBe("genesis");
    const marker = await kv.get(MARKER_KEY);
    expect(JSON.parse(marker!).grantedTo).toBe(UUID_A);
  });

  it("a live marker is never overwritten by the claim path", async () => {
    const kv = interleavingAtomicKv();
    const d = deps(kv);
    const liveMarker = JSON.stringify({
      grantedTo: UUID_B,
      tenantId: "primary",
      atMs: NOW - 1000,
    });
    await kv.put(MARKER_KEY, liveMarker);
    const result = await runWiredPostLogin(
      d,
      loginInput("alice", UUID_A, `platform:${UUID_A}`),
    );
    expect(result.bootstrap.status).toBe("genesis-closed-tenant-admin");
    expect(await kv.get(MARKER_KEY)).toBe(liveMarker);
    expect(await platformAdminHolders(d.membershipStore, [UUID_A])).toEqual([]);
  });

  it("the #1208 repair still runs before the claim: stranded marker is re-set to the caller", async () => {
    const kv = interleavingAtomicKv();
    const d = deps(kv);
    await kv.put(MARKER_KEY, strandedMarker());
    const result = await runWiredPostLogin(
      d,
      loginInput("alice", UUID_A, `platform:${UUID_A}`),
    );
    expect(result.bootstrap.status).toBe("genesis");
    const marker = await kv.get(MARKER_KEY);
    expect(JSON.parse(marker!).grantedTo).toBe(UUID_A);
    expect(await platformAdminHolders(d.membershipStore, [UUID_A])).toEqual([UUID_A]);
  });

  it("a lost claim falls through to tenant-admin and never writes the marker", async () => {
    const kv = alwaysLosesKv();
    const d = deps(kv);
    const result = await runWiredPostLogin(
      d,
      loginInput("alice", UUID_A, `platform:${UUID_A}`),
    );
    expect(result.bootstrap.status).toBe("genesis-closed-tenant-admin");
    expect(await kv.get(MARKER_KEY)).toBeNull();
    expect(await platformAdminHolders(d.membershipStore, [UUID_A])).toEqual([]);
    const memberships = await d.membershipStore.getMembershipsByUser(UUID_A);
    expect(memberships).toHaveLength(1);
    expect(memberships[0].roleBindings[0].role).toBe("tenant-admin");
  });

  it("a claim won but followed by a failed grant releases the marker so a retry can win", async () => {
    const kv = interleavingAtomicKv();
    const healthy = createMemoryMembershipStore();
    const failing: MembershipStore = {
      getMembershipsByUser: (userId: string) =>
        healthy.getMembershipsByUser(userId),
      put: async () => {
        throw new Error("store unavailable");
      },
      revokeMembership: (id: string, nowMs: number) =>
        healthy.revokeMembership(id, nowMs),
    };
    const failed = await runWiredPostLogin(
      deps(kv, failing),
      loginInput("alice", UUID_A, `platform:${UUID_A}`),
    );
    expect(failed.bootstrap.status).toBe("error");
    expect(await kv.get(MARKER_KEY)).toBeNull();
    const retried = await runWiredPostLogin(
      deps(kv, healthy),
      loginInput("alice", UUID_A, `platform:${UUID_A}`),
    );
    expect(retried.bootstrap.status).toBe("genesis");
    expect(await platformAdminHolders(healthy, [UUID_A])).toEqual([UUID_A]);
  });

  it("a backend without putIfAbsent keeps the legacy sequential behavior", async () => {
    const kv = legacyKv();
    const d = deps(kv);
    const result = await runWiredPostLogin(
      d,
      loginInput("alice", UUID_A, `platform:${UUID_A}`),
    );
    expect(result.bootstrap.status).toBe("genesis");
    const marker = await kv.get(MARKER_KEY);
    expect(JSON.parse(marker!).grantedTo).toBe(UUID_A);
  });
});
