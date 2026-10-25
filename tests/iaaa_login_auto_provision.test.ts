/**
 * Issue #1274 — auto-member inside the wired-login tail.
 *
 * completeWiredLogin is the single tail for every provider adapter
 * (GitHub wired callback and the generic OIDC tail alike), so these
 * tests prove the hook in both paths: a first login from either
 * provider lands with a tenant member membership in primary, a
 * repeat login adds nothing, and a provisioning store failure never
 * breaks the login (still 302, session still created).
 */
import { describe, expect, it } from "vitest";
import {
  createMemoryMembershipStore,
  type MembershipStore,
} from "../src/security/authorization";
import { createMemoryIdentityBindingStore } from "../src/security/identityBinding";
import {
  completeWiredLogin,
  type MigrationDeps,
} from "../src/security/iaaaLogin";
import type { KvLike } from "../src/security/kvResilience";
import type { Env } from "../src/types";
import { makeFakeSessionStore } from "./fake-session-store";

const GITHUB_ISSUER = "https://github.com";
const GOOGLE_ISSUER = "https://accounts.google.com";
const NOW = 5_000_000;

function memoryKv(): KvLike {
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

function makeEnv() {
  const { namespace } = makeFakeSessionStore();
  return {
    SESSION_STORE: namespace,
    SESSION_SECRET: "test-secret",
    APP_BASE_URL: "https://agent.test",
  } as unknown as Env;
}

async function login(
  env: Env,
  issuer: string,
  subject: string,
  loginKey: string,
  memberships: MembershipStore,
  extra: { postLoginEnabled?: boolean } = {},
) {
  return completeWiredLogin(
    env,
    issuer,
    { subject, loginKey, displayName: "Test User", avatarUrl: "" },
    {
      bindingStore: createMemoryIdentityBindingStore(),
      migration: { membershipStore: memberships, aliasKv: memoryKv() } satisfies MigrationDeps,
      nowMs: NOW,
      auditTenantId: "primary",
      ...extra,
    },
  );
}

describe("completeWiredLogin auto-member (#1274)", () => {
  it("first GitHub login lands with member in primary", async () => {
    const memberships = createMemoryMembershipStore();
    const res = await login(makeEnv(), GITHUB_ISSUER, "42", "octocat", memberships);
    expect(res.status).toBe(302);
    const all = await memberships.getMembershipsByUser(
      "v1:0962030c695d4b7f3a855132a8d14e814ede67f43f538a4e67bf68a59f99b72a",
    );
    expect(all).toHaveLength(1);
    expect(all[0].tenantId).toBe("primary");
    expect(all[0].roleBindings).toEqual([
      expect.objectContaining({ role: "member", scope: "tenant" }),
    ]);
  });

  it("first Google login (generic OIDC tail) lands with member in primary", async () => {
    const memberships = createMemoryMembershipStore();
    const res = await login(makeEnv(), GOOGLE_ISSUER, "google-sub-1", "user@example.com", memberships);
    expect(res.status).toBe(302);
    const all = await memberships.getMembershipsByUser(
      "v1:c009b4302606b406e1da408a7587c2e6684240a4ea1845e401d16f39be66b647",
    );
    expect(all).toHaveLength(1);
    expect(all[0].roleBindings[0].role).toBe("member");
  });

  it("repeat login with the same binding store adds no second membership", async () => {
    const memberships = createMemoryMembershipStore();
    const env = makeEnv();
    const bindingStore = createMemoryIdentityBindingStore();
    const opts = {
      bindingStore,
      migration: { membershipStore: memberships, aliasKv: memoryKv() } satisfies MigrationDeps,
      nowMs: NOW,
      auditTenantId: "primary",
    };
    const profile = { subject: "42", loginKey: "octocat", displayName: "O", avatarUrl: "" };
    expect((await completeWiredLogin(env, GITHUB_ISSUER, profile, opts)).status).toBe(302);
    expect((await completeWiredLogin(env, GITHUB_ISSUER, profile, opts)).status).toBe(302);
    const all = await memberships.getMembershipsByUser(
      "v1:0962030c695d4b7f3a855132a8d14e814ede67f43f538a4e67bf68a59f99b72a",
    );
    expect(all).toHaveLength(1);
  });

  it("a throwing membership store never breaks the login", async () => {
    const failing = {
      async getMembershipsByUser() {
        throw new Error("boom");
      },
      async put() {
        throw new Error("boom");
      },
      async revokeMembership() {
        return false;
      },
    } as unknown as MembershipStore;
    const res = await login(makeEnv(), GITHUB_ISSUER, "42", "octocat", failing);
    expect(res.status).toBe(302);
  });
});
