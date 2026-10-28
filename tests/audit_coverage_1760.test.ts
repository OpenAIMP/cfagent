import { describe, it, expect } from "vitest";
import { handleLogout } from "../src/security/githubOAuth";
import { makeFakeSessionStore } from "./fake-session-store";
import {
  createMemoryAuditStore,
  type IaaaAuditEvent,
} from "../src/security/iaaaAudit";
import type { KvLike } from "../src/security/kvResilience";
import {
  createMemoryIdentityBindingStore,
} from "../src/security/identityBinding";
import {
  createMemoryMembershipStore,
} from "../src/security/authorization";
import { runWiredPostLogin } from "../src/security/iaaaGithubEndToEnd";
import type { Env } from "../src/types";

/**
 * Issue #1760 — the previously silent occurrences. Emitted here:
 * logout-audit skips (legacy sessions), alias recording, bootstrap
 * grants, and genesis grants. PDP denials, step-up denials, and
 * idle-expiry rejections stay explicitly-decided silences (see the
 * #1760 slice doc for the per-occurrence reasons + triggers);
 * they are NOT covered by this file, and must not be read as
 * covered because this file exists.
 */

const SESSION_UUID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_UUID = "11111111-1111-4111-8111-111111111111";
const NOW = 1780000000000;

function mapKv(): KvLike {
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

async function logoutEvents(
  sessionRecord: Record<string, unknown> | null,
): Promise<IaaaAuditEvent[]> {
  const fake = makeFakeSessionStore();
  if (sessionRecord !== null) {
    fake.seed("sessions", SESSION_UUID, sessionRecord);
  }
  const auditStore = createMemoryAuditStore();
  const env = { SESSION_STORE: fake.namespace } as unknown as Env;
  const response = await handleLogout(
    env,
    new Request("https://agent.local/auth/logout", {
      headers: { Cookie: `session_id=${SESSION_UUID}` },
    }),
    { wiringEnabled: true, auditStore, tenantId: "primary" },
  );
  expect(response.status).toBe(302);
  return auditStore.list();
}

function postLoginDeps(auditStore: ReturnType<typeof createMemoryAuditStore>) {
  return {
    kv: mapKv(),
    bindingStore: createMemoryIdentityBindingStore(),
    membershipStore: createMemoryMembershipStore(),
    audit: { store: auditStore, correlationId: "sess-1" },
  };
}

describe("audit coverage (#1760) — logout skips", () => {
  it("a legacy session logout emits a logout_audit_skipped event, not silence", async () => {
    const events = await logoutEvents({ createdAt: NOW });
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("auth.logout_audit_skipped");
    expect(events[0].action).toBe("auth.logout_audit_skipped");
    expect(events[0].actorPrincipalId).toBe("unknown");
    expect(events[0].errorCode).toBe("LEGACY_SESSION_NO_INTERNAL_USER_ID");
  });

  it("a wired session logout emits the logout event and no skip event", async () => {
    const events = await logoutEvents({ createdAt: NOW, internalUserId: USER_UUID });
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("auth.logout");
    expect(events[0].actorPrincipalId).toBe(USER_UUID);
  });

  it("a missing session record emits nothing (no session ended)", async () => {
    const events = await logoutEvents(null);
    expect(events).toHaveLength(0);
  });
});

describe("audit coverage (#1760) — post-login occurrences", () => {
  it("alias recording + ordinary bootstrap grant both emit", async () => {
    const auditStore = createMemoryAuditStore();
    const result = await runWiredPostLogin(postLoginDeps(auditStore), {
      githubLogin: "alice",
      internalUserId: USER_UUID,
      providerIssuer: "https://github.com",
      providerSubject: "123",
      bootstrapRaw: USER_UUID,
      tenantId: "primary",
      nowMs: NOW,
    });
    expect(result.alias.status).toBe("recorded");
    expect(result.bootstrap.status).toBe("provisioned");
    const events = await auditStore.list();
    const types = events.map((e) => e.type);
    expect(types).toContain("iaaa.alias.record");
    expect(types).toContain("iaaa.bootstrap.grant");
    const grant = events.find((e) => e.type === "iaaa.bootstrap.grant")!;
    expect(grant.actorPrincipalId).toBe("system:bootstrap");
    expect(grant.initiatingPrincipalId).toBe(USER_UUID);
  });

  it("a genesis grant emits a distinct genesis event", async () => {
    const auditStore = createMemoryAuditStore();
    const result = await runWiredPostLogin(postLoginDeps(auditStore), {
      githubLogin: "alice",
      internalUserId: USER_UUID,
      providerIssuer: "https://github.com",
      providerSubject: "123",
      bootstrapRaw: `platform:${USER_UUID}`,
      tenantId: "primary",
      nowMs: NOW,
    });
    expect(result.bootstrap.status).toBe("genesis");
    const events = await auditStore.list();
    const grant = events.find((e) => e.type === "iaaa.genesis.grant");
    expect(grant).toBeDefined();
    expect(grant!.actorPrincipalId).toBe("system:bootstrap-genesis");
  });

  it("a non-occurrence emits nothing: already-listed user re-login grants nothing", async () => {
    const auditStore = createMemoryAuditStore();
    const deps = postLoginDeps(auditStore);
    const first = await runWiredPostLogin(deps, {
      githubLogin: "alice",
      internalUserId: USER_UUID,
      providerIssuer: "https://github.com",
      providerSubject: "123",
      bootstrapRaw: USER_UUID,
      tenantId: "primary",
      nowMs: NOW,
    });
    expect(first.bootstrap.status).toBe("provisioned");
    const second = await runWiredPostLogin(deps, {
      githubLogin: "alice",
      internalUserId: USER_UUID,
      providerIssuer: "https://github.com",
      providerSubject: "123",
      bootstrapRaw: USER_UUID,
      tenantId: "primary",
      nowMs: NOW + 1000,
    });
    expect(second.bootstrap.status).toBe("already-admin");
    const grants = (await auditStore.list()).filter(
      (e) => e.type === "iaaa.bootstrap.grant",
    );
    expect(grants).toHaveLength(1);
  });

  it("a failing audit store never fails post-login work", async () => {
    const throwing = {
      async append(): Promise<void> {
        throw new Error("store down");
      },
      async list(): Promise<IaaaAuditEvent[]> {
        throw new Error("store down");
      },
    };
    const deps = {
      kv: mapKv(),
      bindingStore: createMemoryIdentityBindingStore(),
      membershipStore: createMemoryMembershipStore(),
      audit: { store: throwing, correlationId: "sess-1" },
    };
    const result = await runWiredPostLogin(deps, {
      githubLogin: "alice",
      internalUserId: USER_UUID,
      providerIssuer: "https://github.com",
      providerSubject: "123",
      bootstrapRaw: USER_UUID,
      tenantId: "primary",
      nowMs: NOW,
    });
    expect(result.alias.status).toBe("recorded");
    expect(result.bootstrap.status).toBe("provisioned");
  });
});
