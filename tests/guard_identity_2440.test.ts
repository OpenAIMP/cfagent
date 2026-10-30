/**
 * Issue #2440: scheduled E*TRADE guard must resolve tokens through
 * identity, the way #2391 did for status/renew/revoke.
 *
 * The guard bound its token lookup and renewal WITHOUT identity, so
 * it only tried login-scoped + unscoped keys. A token stored under
 * an internal-id or alias-login key was visible to the panel and
 * invisible to the guard (FAILURE_AUTH_NO_SESSION on scheduled runs
 * for an already-connected account). These tests pin the fix:
 * identity threads through preflight → guard → bound deps → the
 * scheduled call site, and absence of a resolvable identity keeps
 * exactly today's behavior (fail closed, never sideways).
 */
import { describe, expect, it, vi } from "vitest";
import {
  bindETradeAuthPreflightDeps,
  guardScheduledETradeAuth,
  preflightETradeAuth,
  type ETradeAuthPreflightDeps,
} from "../src/services/etradeAuthPreflight";
import type { ETradeTokenIdentity } from "../src/security/etradeOAuth";
import { ScheduledTasksService } from "../src/services/scheduledTasks";
import type { Env } from "../src/types";
import { makeFakeSessionStore } from "./fake-session-store";

const LOGIN = "venus";
const INTERNAL_ID = "user-venus-1";
const ALIAS_LOGIN = "venus-old";

function freshToken() {
  return {
    accessToken: "at",
    accessSecret: "as",
    storedAt: new Date().toISOString(),
  };
}

function expiredToken() {
  return {
    accessToken: "at",
    accessSecret: "as",
    storedAt: new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString(),
  };
}

function aliasRecord(githubLogin: string, internalUserId: string) {
  return { githubLogin, internalUserId, recordedAtMs: 1, source: "wired-login" };
}

function envWithStore() {
  const fake = makeFakeSessionStore();
  const env = { SESSION_STORE: fake.namespace } as unknown as Env;
  return { fake, env };
}

function deps(over: Partial<ETradeAuthPreflightDeps>): ETradeAuthPreflightDeps {
  return {
    getTokens: async () => ({ storedAt: new Date().toISOString() }),
    renew: async () => ({ storedAt: new Date().toISOString() }),
    isExpired: () => false,
    now: () => Date.now(),
    ...over,
  };
}

describe("preflightETradeAuth identity forwarding", () => {
  it("forwards identity to getTokens", async () => {
    const getTokens = vi.fn(async () => ({ storedAt: new Date().toISOString() }));
    const identity: ETradeTokenIdentity = { internalUserId: INTERNAL_ID };
    const res = await preflightETradeAuth(
      deps({ getTokens }),
      LOGIN,
      "PROD",
      identity
    );
    expect(res).toEqual({ status: "ok", renewed: false });
    expect(getTokens).toHaveBeenCalledWith(LOGIN, "PROD", identity);
  });

  it("forwards identity to renew when the token is expired", async () => {
    const renew = vi.fn(async () => ({ storedAt: new Date().toISOString() }));
    const identity: ETradeTokenIdentity = { internalUserId: INTERNAL_ID };
    const res = await preflightETradeAuth(
      deps({ isExpired: () => true, renew }),
      LOGIN,
      "PROD",
      identity
    );
    expect(res).toEqual({ status: "ok", renewed: true });
    expect(renew).toHaveBeenCalledWith(LOGIN, "PROD", identity);
  });

  it("without identity, getTokens and renew are called identity-less (today's behavior)", async () => {
    const getTokens = vi.fn(async () => ({ storedAt: new Date().toISOString() }));
    const res = await preflightETradeAuth(deps({ getTokens }), LOGIN, "PROD");
    expect(res).toEqual({ status: "ok", renewed: false });
    expect(getTokens).toHaveBeenCalledWith(LOGIN, "PROD", undefined);
  });
});

describe("guardScheduledETradeAuth identity forwarding", () => {
  it("passes opts.identity through to the preflight deps", async () => {
    const getTokens = vi.fn(async () => ({ storedAt: new Date().toISOString() }));
    const identity: ETradeTokenIdentity = { internalUserId: INTERNAL_ID };
    const res = await guardScheduledETradeAuth({
      env: {} as Env,
      userLogin: LOGIN,
      environment: "PROD",
      kind: "options",
      label: "options screen",
      deps: deps({ getTokens }),
      identity,
      sendSlackAlert: async () => {},
    });
    expect(res.blocked).toBe(false);
    expect(getTokens).toHaveBeenCalledWith(LOGIN, "PROD", identity);
  });
});

describe("bound deps against the real store (fake SessionStore)", () => {
  it("token under an internal-id key only + identity → guard ok", async () => {
    const { fake, env } = envWithStore();
    fake.seed("etrade", `etrade:token:PROD:${INTERNAL_ID}`, freshToken());
    const res = await guardScheduledETradeAuth({
      env,
      userLogin: LOGIN,
      environment: "PROD",
      kind: "options",
      label: "options screen",
      deps: bindETradeAuthPreflightDeps(env),
      identity: { internalUserId: INTERNAL_ID },
      sendSlackAlert: async () => {},
    });
    expect(res.blocked).toBe(false);
  });

  it("token under an internal-id key only, NO identity → blocked no-session (today's blind spot, preserved)", async () => {
    const { fake, env } = envWithStore();
    fake.seed("etrade", `etrade:token:PROD:${INTERNAL_ID}`, freshToken());
    const res = await guardScheduledETradeAuth({
      env,
      userLogin: LOGIN,
      environment: "PROD",
      kind: "options",
      label: "options screen",
      deps: bindETradeAuthPreflightDeps(env),
      sendSlackAlert: async () => {},
    });
    expect(res.blocked).toBe(true);
    if (res.blocked) expect(res.error).toContain("no stored session");
  });

  it("token under an alias-login key only + identity → guard ok (alias resolved via the alias record)", async () => {
    const { fake, env } = envWithStore();
    fake.seed("sessions", `iaaa-alias:user:${INTERNAL_ID}`, aliasRecord(ALIAS_LOGIN, INTERNAL_ID));
    fake.seed("sessions", `iaaa-alias:login:${LOGIN}`, aliasRecord(LOGIN, INTERNAL_ID));
    fake.seed("etrade", `etrade:token:PROD:${ALIAS_LOGIN}`, freshToken());
    const res = await guardScheduledETradeAuth({
      env,
      userLogin: LOGIN,
      environment: "PROD",
      kind: "options",
      label: "options screen",
      deps: bindETradeAuthPreflightDeps(env),
      identity: { internalUserId: INTERNAL_ID },
      sendSlackAlert: async () => {},
    });
    expect(res.blocked).toBe(false);
  });

  it("no token under any key + identity → blocked no-session in PROD", async () => {
    const { env } = envWithStore();
    const res = await guardScheduledETradeAuth({
      env,
      userLogin: LOGIN,
      environment: "PROD",
      kind: "options",
      label: "options screen",
      deps: bindETradeAuthPreflightDeps(env),
      identity: { internalUserId: INTERNAL_ID },
      sendSlackAlert: async () => {},
    });
    expect(res.blocked).toBe(true);
    if (res.blocked) expect(res.error).toContain("no stored session");
  });

  it("unknown login + another login's token → blocked, never sideways", async () => {
    const { fake, env } = envWithStore();
    fake.seed("etrade", "etrade:token:PROD:other-login", freshToken());
    const res = await guardScheduledETradeAuth({
      env,
      userLogin: "ghost",
      environment: "PROD",
      kind: "options",
      label: "options screen",
      deps: bindETradeAuthPreflightDeps(env),
      identity: { internalUserId: "ghost-id" },
      sendSlackAlert: async () => {},
    });
    expect(res.blocked).toBe(true);
    if (res.blocked) expect(res.error).toContain("no stored session");
  });

  it("expired token + identity-carrying renewal → guard ok (bound renew forwards identity)", async () => {
    const { fake, env } = envWithStore();
    fake.seed("etrade", `etrade:token:PROD:${INTERNAL_ID}`, expiredToken());
    const renew = vi.fn(async () => ({ storedAt: new Date().toISOString() }));
    const res = await guardScheduledETradeAuth({
      env,
      userLogin: LOGIN,
      environment: "PROD",
      kind: "options",
      label: "options screen",
      deps: {
        ...bindETradeAuthPreflightDeps(env),
        renew,
      },
      identity: { internalUserId: INTERNAL_ID },
      sendSlackAlert: async () => {},
    });
    expect(res.blocked).toBe(false);
    expect(renew).toHaveBeenCalledWith(LOGIN, "PROD", { internalUserId: INTERNAL_ID });
  });
});

describe("scheduled call site (ScheduledTasksService.guardScheduledAuth)", () => {
  it("resolves the run-as login to identity: internal-id token + alias record → not blocked", async () => {
    const { fake, env } = envWithStore();
    fake.seed("sessions", `iaaa-alias:login:${LOGIN}`, aliasRecord(LOGIN, INTERNAL_ID));
    fake.seed("sessions", `iaaa-alias:user:${INTERNAL_ID}`, aliasRecord(LOGIN, INTERNAL_ID));
    fake.seed("etrade", `etrade:token:PROD:${INTERNAL_ID}`, freshToken());
    const service = new ScheduledTasksService(env, undefined, LOGIN);
    const res = await (service as unknown as {
      guardScheduledAuth: (
        userLogin: string,
        environment: string | undefined,
        kind: "stock" | "options",
        label: string
      ) => Promise<{ blocked: boolean }>;
    }).guardScheduledAuth(LOGIN, "PROD", "options", "options screen");
    expect(res.blocked).toBe(false);
  });

  it("no resolvable identity → today's behavior: internal-id token missed → blocked", async () => {
    const { fake, env } = envWithStore();
    fake.seed("etrade", `etrade:token:PROD:${INTERNAL_ID}`, freshToken());
    const service = new ScheduledTasksService(env, undefined, LOGIN);
    const res = await (service as unknown as {
      guardScheduledAuth: (
        userLogin: string,
        environment: string | undefined,
        kind: "stock" | "options",
        label: string
      ) => Promise<{ blocked: boolean }>;
    }).guardScheduledAuth(LOGIN, "PROD", "options", "options screen");
    expect(res.blocked).toBe(true);
  });
});
