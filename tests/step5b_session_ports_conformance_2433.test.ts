// @vitest-environment node
/**
 * Issue #2433 (#1976 step 5b) — session/identity family port
 * conformance + dual-composition characterization.
 *
 * The SAME suite runs against (a) the DO adapter over
 * tests/fake-session-store.ts's protocol fake (via the
 * composition root's namespace seam) and (b) the in-memory
 * adapter. The family's 5a characterization leg (§3.6, plus
 * the registry listing rule) is then dual-run through the
 * REAL family factories (session.ts / iaaaLogin.ts) with
 * SESSION_PORTS_ENABLED off (today's funnel) and on (the
 * port composition) — flag-off expectations are the 5a ones,
 * unchanged.
 *
 * Sabotage pins (mutation evidence in the slice's evidence
 * dir): flag ignored either way, an update extending
 * absolute expiry, and a listing leaking a non-UUID key as
 * a session each turn this suite red.
 */
import { describe, it, expect } from "vitest";
import {
  createInMemorySessionPorts,
  createSessionPortsFromNamespace,
} from "../src/data/createSessionPorts";
import { isSessionPortsEnabled, type SessionFamilyPorts } from "../src/data/sessionPorts";
import {
  createSession,
  deleteSession,
  getSession,
  updateSession,
  wiredAccessRequestStore,
  wiredMembershipStore,
  SESSION_TTL,
} from "../src/security/session";
import { createWiredBindingStore } from "../src/security/iaaaLogin";
import type { Membership } from "../src/security/authorization";
import { makeFakeSessionStore } from "./fake-session-store";
import type { Env, SessionData } from "../src/types";

function sessionData(createdAt: number, name = "Octo Cat"): SessionData {
  return {
    githubLogin: "octocat",
    githubAvatar: "https://avatars.example/4242",
    githubName: name,
    createdAt,
  };
}

function membership(id: string, user: string): Membership {
  return {
    membershipId: id,
    internalUserId: user,
    tenantId: "tenant-1",
    roleBindings: [],
    createdBy: "bootstrap",
    createdAtMs: 1_000,
  };
}

const compositions: Array<[string, () => SessionFamilyPorts]> = [
  [
    "DO adapter over the protocol fake",
    () => createSessionPortsFromNamespace(makeFakeSessionStore().namespace as never),
  ],
  ["in-memory adapter", () => createInMemorySessionPorts()],
];

describe.each(compositions)("session family conformance — %s", (_name, makePorts) => {
  it("declares legacyFallback: false (KV is not part of the store)", () => {
    expect(makePorts().legacyFallback).toBe(false);
  });

  it("session create → get round-trips; corrupt value reads null; delete ends it", async () => {
    const ports = makePorts();
    const data = sessionData(Date.now());
    const id = await ports.sessions.create(data);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(await ports.sessions.get(id)).toEqual(data);

    const corruptId = "22222222-3333-4444-5555-666666666666";
    await ports.kv.put(corruptId, "{not json");
    expect(await ports.sessions.get(corruptId)).toBeNull();

    await ports.sessions.delete(id);
    expect(await ports.sessions.get(id)).toBeNull();
  });

  it("update writes at the remaining absolute TTL and never extends expiry", async () => {
    const ports = makePorts();
    const now = Date.now();
    const id = await ports.sessions.create(sessionData(now, "Before"));
    const res = await ports.sessions.update(id, sessionData(now, "After"), now + 5_000);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.remainingTtlSeconds).toBe(SESSION_TTL - 5);
    }
    expect((await ports.sessions.get(id))?.githubName).toBe("After");
  });

  it("update refuses at/past absolute expiry and stores nothing; invalid createdAt refused", async () => {
    const ports = makePorts();
    const now = Date.now();
    const expiredId = "33333333-4444-5555-6666-777777777777";
    const expiredData = sessionData(now - (SESSION_TTL + 60) * 1000, "Old");
    const res = await ports.sessions.update(expiredId, expiredData, now);
    expect(res).toMatchObject({ ok: false, code: "SESSION_ABSOLUTE_EXPIRED" });
    expect(await ports.sessions.get(expiredId)).toBeNull();

    const bad = await ports.sessions.update(
      expiredId,
      { ...sessionData(now), createdAt: Number.NaN },
      now,
    );
    expect(bad).toMatchObject({ ok: false, code: "SESSION_INVALID_CREATED_AT" });
  });

  it("renew slides only when due", async () => {
    const ports = makePorts();
    const now = Date.now();
    const fresh = await ports.sessions.create(sessionData(now));
    expect(await ports.sessions.renew(fresh, sessionData(now), now)).toBe(false);

    // Inside the renew window: created near the end of the absolute TTL.
    const dueData = sessionData(now - (SESSION_TTL - 60) * 1000);
    const dueId = await ports.sessions.create(dueData);
    expect(await ports.sessions.renew(dueId, dueData, now)).toBe(true);
    expect((await ports.sessions.get(dueId))?.createdAt).toBe(now);
  });

  it("bindings: two-key put, both lookups, reverse removal keeps provider lookup", async () => {
    const ports = makePorts();
    const binding = {
      internalUserId: "v1:abc",
      providerIssuer: "https://github.com",
      providerSubject: "4242",
      linkedAt: 1_000,
      proofOfControl: "oidc" as const,
    };
    await ports.bindings.put(binding);
    expect(await ports.bindings.getByProvider("https://github.com", "4242")).toEqual(binding);
    expect(await ports.bindings.getByUserAndIssuer("v1:abc", "https://github.com")).toEqual(binding);
    await ports.bindings.removeByUserAndIssuer("v1:abc", "https://github.com");
    expect(await ports.bindings.getByUserAndIssuer("v1:abc", "https://github.com")).toBeNull();
    expect(await ports.bindings.getByProvider("https://github.com", "4242")).toEqual(binding);
  });

  it("memberships: put / by-user / by-id / revoke / listAll agree", async () => {
    const ports = makePorts();
    const m = membership("m-1", "user-1");
    await ports.memberships.put(m);
    expect((await ports.memberships.getMembershipsByUser("user-1")).map((x) => x.membershipId)).toEqual(["m-1"]);
    expect((await ports.memberships.readById("m-1"))?.internalUserId).toBe("user-1");
    expect((await ports.memberships.listAll())?.map((x) => x.membershipId)).toEqual(["m-1"]);
    expect(await ports.memberships.revokeMembership("m-1", 2_000)).toBe(true);
    expect((await ports.memberships.readById("m-1"))?.revokedAtMs).toBe(2_000);
    expect(await ports.memberships.revokeMembership("missing", 2_000)).toBe(false);
  });

  it("access requests: create / pending dedupe / decide state machine", async () => {
    const ports = makePorts();
    const created = await ports.accessRequests.create({
      requesterInternalUserId: "user-1",
      requestedRole: "tenant-admin",
      tenantId: "tenant-1",
      nowMs: 1_000,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("unreachable");
    const dup = await ports.accessRequests.create({
      requesterInternalUserId: "user-1",
      requestedRole: "tenant-admin",
      tenantId: "tenant-1",
      nowMs: 1_100,
    });
    expect(dup).toMatchObject({ ok: false, code: "ALREADY_PENDING" });
    const badRole = await ports.accessRequests.create({
      requesterInternalUserId: "user-2",
      requestedRole: "platform-admin",
      tenantId: "tenant-1",
      nowMs: 1_200,
    });
    expect(badRole).toMatchObject({ ok: false, code: "INVALID_ROLE" });
    expect((await ports.accessRequests.list()).map((r) => r.requestId)).toEqual([created.request.requestId]);
    const decided = await ports.accessRequests.decide(created.request.requestId, "approved", "admin-1", 2_000);
    expect(decided).toMatchObject({ ok: true, request: { status: "approved" } });
    const again = await ports.accessRequests.decide(created.request.requestId, "denied", "admin-1", 3_000);
    expect(again).toMatchObject({ ok: false, code: "NOT_PENDING" });
  });

  it("bulk-revocation listing surfaces ONLY UUID-shaped session keys", async () => {
    const ports = makePorts();
    const data = sessionData(Date.now());
    const id = await ports.sessions.create(data);
    await ports.kv.put("iaaa-membership:m-9", JSON.stringify(membership("m-9", "user-9")));
    await ports.kv.put("iaaa-binding:https://github.com\u00004242", JSON.stringify({ internalUserId: "x" }));
    await ports.kv.put(
      "not-a-session",
      JSON.stringify({ githubLogin: "octocat", internalUserId: "user-1" }),
    );
    const listed = await ports.sessions.listSessionsForRevocation();
    expect(listed).not.toBeNull();
    expect(listed?.map((e) => e.sessionId)).toEqual([id]);
    expect(listed?.[0].githubLogin).toBe("octocat");
  });
});

describe("flag semantics (#1169 idiom)", () => {
  it("absence = off; 1/true/on (any case, trimmed) = on; anything else = off", () => {
    expect(isSessionPortsEnabled({})).toBe(false);
    expect(isSessionPortsEnabled({ SESSION_PORTS_ENABLED: "true" })).toBe(true);
    expect(isSessionPortsEnabled({ SESSION_PORTS_ENABLED: " ON " })).toBe(true);
    expect(isSessionPortsEnabled({ SESSION_PORTS_ENABLED: "1" })).toBe(true);
    expect(isSessionPortsEnabled({ SESSION_PORTS_ENABLED: "0" })).toBe(false);
    expect(isSessionPortsEnabled({ SESSION_PORTS_ENABLED: "false" })).toBe(false);
    expect(isSessionPortsEnabled(null)).toBe(false);
  });
});

describe("5a family characterization dual-run through the real factories (§3.6 + listing)", () => {
  const flagStates: Array<[string, string | undefined]> = [
    ["flag OFF (today's funnel)", undefined],
    ["flag ON (port composition)", "true"],
  ];

  it.each(flagStates)("%s: create → get round-trips; corrupt reads null; delete ends it", async (_n, flag) => {
    const fake = makeFakeSessionStore();
    const env = {
      SESSION_STORE: fake.namespace,
      ...(flag ? { SESSION_PORTS_ENABLED: flag } : {}),
    } as unknown as Env;
    const data = sessionData(Date.now());
    const id = await createSession(env, data);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(await getSession(env, id)).toEqual(data);

    const corruptId = "22222222-3333-4444-5555-666666666666";
    fake.seed("sessions", corruptId, "{not json");
    expect(await getSession(env, corruptId)).toBeNull();

    await deleteSession(env, id);
    expect(await getSession(env, id)).toBeNull();
  });

  it.each(flagStates)("%s: updateSession refuses past absolute expiry (port contract §3.6)", async (_n, flag) => {
    const fake = makeFakeSessionStore();
    const env = {
      SESSION_STORE: fake.namespace,
      ...(flag ? { SESSION_PORTS_ENABLED: flag } : {}),
    } as unknown as Env;
    const now = Date.now();
    const res = await updateSession(
      env,
      "33333333-4444-5555-6666-777777777777",
      sessionData(now - (SESSION_TTL + 60) * 1000),
      now,
    );
    expect(res).toMatchObject({ ok: false, code: "SESSION_ABSOLUTE_EXPIRED" });
  });

  it.each(flagStates)("%s: binding + membership + access factories serve the family", async (_n, flag) => {
    const fake = makeFakeSessionStore();
    const env = {
      SESSION_STORE: fake.namespace,
      ...(flag ? { SESSION_PORTS_ENABLED: flag } : {}),
    } as unknown as Env;

    const bindings = createWiredBindingStore(env);
    const binding = {
      internalUserId: "v1:abc",
      providerIssuer: "https://github.com",
      providerSubject: "4242",
      linkedAt: 1_000,
      proofOfControl: "oidc" as const,
    };
    await bindings.put(binding);
    expect(await bindings.getByProvider("https://github.com", "4242")).toEqual(binding);

    const memberships = wiredMembershipStore(env);
    await memberships.put(membership("m-1", "user-1"));
    expect((await memberships.getMembershipsByUser("user-1")).map((m) => m.membershipId)).toEqual(["m-1"]);

    const requests = wiredAccessRequestStore(env);
    const created = await requests.create({
      requesterInternalUserId: "user-1",
      requestedRole: "tenant-admin",
      tenantId: "tenant-1",
      nowMs: 1_000,
    });
    expect(created.ok).toBe(true);
    expect(await requests.list()).toHaveLength(1);
  });
});
