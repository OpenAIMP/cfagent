/**
 * #945 Wiring Phase 1 — login provider registry + config-gated enablement.
 *
 * The point of this module: a new provider plugs in WITHOUT changing the
 * system. server.ts never hard-codes a provider in the wired path — it
 * asks this registry for the provider named by config and dispatches
 * through the adapter's startLogin/handleCallback. Adding a provider
 * later means: (1) write an adapter implementing LoginProvider,
 * (2) register it (see registerProvider), (3) add its id to
 * IAAA_ENABLED_PROVIDERS. No change to server.ts dispatch, no change
 * to any existing adapter.
 *
 * How to register a future provider (Auth0, Google, another social login):
 *   import { defaultRegistry } from "./providers";
 *   defaultRegistry.registerProvider({
 *     providerId: "auth0",
 *     protocol: "oidc",
 *     issuer: "https://<tenant>.auth0.com/",
 *     startLogin: async (env) => { ...redirect to the provider... },
 *     handleCallback: async (env, request) => { ...validate, bind, session... },
 *   });
 * The adapter owns its own token/profile validation and its own
 * binding (issuer + provider-stable subject, never login/email). An id
 * listed in IAAA_ENABLED_PROVIDERS with no registered adapter is
 * ignored: resolveLoginProvider reports "provider-not-registered" and
 * login is refused — it never falls back to another provider.
 *
 * Enablement / rollback (config only, no code change):
 * - IAAA_WIRING_ENABLED: "1" or "true" (case-insensitive, trimmed) = on.
 *   Anything else, including absence, = off. Default: off.
 * - IAAA_ENABLED_PROVIDERS: comma-separated provider ids. Default when
 *   wiring is on and no list is set: ["github"]. Duplicates and empty
 *   entries are dropped; ids are trimmed and lower-cased.
 * - Rollback = set IAAA_WIRING_ENABLED off, or remove the provider id
 *   from IAAA_ENABLED_PROVIDERS. Sessions already created by the wired
 *   flow keep working: the wired session fields are optional and the
 *   legacy fields are unchanged (see iaaaLogin.ts).
 *
 * Registered providers: "github" (OAuth2 + profile fetch, wired
 * callback in iaaaLogin.ts, legacy login start in githubOAuth.ts —
 * the redirect is identical wired or not) and "google" (the worked
 * plugin example: one createOidcProvider call in this module, no
 * other file changed to register it). No PDP, delegation, or audit
 * wiring lives here. To onboard another provider, see
 * docs/iaaa-provider-onboarding.md.
 */
import type { Env } from "../types";
import type { AuditStore } from "./iaaaAudit";
import { handleLogin } from "./githubOAuth";
import { handleGithubCallbackWired } from "./iaaaLogin";
import { createOidcProvider } from "./oidcProvider";

/**
 * #945 GitHub end-to-end — options a dispatch site may pass to a
 * provider callback. All optional: a provider called without them
 * behaves exactly as before (no audit recording, no post-login
 * work). server.ts passes all three for the wired GitHub callback:
 * the audit store + resolved tenant switch login audit on, and
 * postLoginEnabled switches alias recording + bootstrap-on-login on.
 */
export interface LoginCallbackOptions {
  auditStore?: AuditStore;
  auditTenantId?: string;
  postLoginEnabled?: boolean;
}

/** A login provider adapter. startLogin begins the flow; handleCallback finishes it. */
export interface LoginProvider {
  providerId: string;
  /** "oidc" for ID-token providers, "oauth2" for OAuth2 + profile-fetch providers (GitHub). */
  protocol: "oidc" | "oauth2";
  /** Validated issuer for the provider (used for binding, never for display). */
  issuer: string;
  /** Human-readable name for the login page button. Optional; falls back to providerId. */
  displayName?: string;
  startLogin(env: Env): Promise<Response>;
  handleCallback(env: Env, request: Request, options?: LoginCallbackOptions): Promise<Response>;
}

/** A registry of LoginProviders. The default registry is the production one. */
export class ProviderRegistry {
  private readonly providers = new Map<string, LoginProvider>();

  /** Register an adapter. Returns false (and registers nothing) for an invalid or duplicate id. */
  registerProvider(provider: LoginProvider): boolean {
    if (!provider || typeof provider.providerId !== "string") return false;
    const id = provider.providerId.trim().toLowerCase();
    if (!id || this.providers.has(id)) return false;
    if (typeof provider.startLogin !== "function" || typeof provider.handleCallback !== "function") {
      return false;
    }
    this.providers.set(id, { ...provider, providerId: id });
    return true;
  }

  getProvider(providerId: string): LoginProvider | null {
    if (typeof providerId !== "string") return null;
    return this.providers.get(providerId.trim().toLowerCase()) ?? null;
  }

  listProviders(): string[] {
    return [...this.providers.keys()];
  }
}

/** Fresh, empty registry (tests and future registration sites). */
export function createProviderRegistry(): ProviderRegistry {
  return new ProviderRegistry();
}

/** The production registry, shipped with GitHub and Google registered. */
export const defaultRegistry: ProviderRegistry = (() => {
  const registry = new ProviderRegistry();
  registry.registerProvider({
    providerId: "github",
    protocol: "oauth2",
    issuer: "https://github.com",
    displayName: "GitHub",
    startLogin: handleLogin,
    handleCallback: handleGithubCallbackWired,
  });
  // Google, the worked plugin example: one factory call, no other
  // file changed to register it. True identity is Slice 1
  // (https://accounts.google.com, sub); the verified email is only
  // the adapter-supplied legacy login key, never identity. The
  // client id/secret are owner-set secrets (Cloudflare dashboard
  // or `wrangler secret put`), never committed: until they exist,
  // startLogin fails closed with an error page and no button
  // appears (the button is gated on the enabled list, which the
  // owner changes in a separate enablement step).
  registry.registerProvider(
    createOidcProvider({
      providerId: "google",
      issuer: "https://accounts.google.com",
      displayName: "Google",
      authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenEndpoint: "https://oauth2.googleapis.com/token",
      userinfoEndpoint: "https://openidconnect.googleapis.com/v1/userinfo",
      clientIdEnv: "GOOGLE_CLIENT_ID",
      clientSecretEnv: "GOOGLE_CLIENT_SECRET",
      scope: "openid email profile",
      subjectField: "sub",
      loginKeyField: "email",
      requireEmailVerified: true,
    })
  );
  return registry;
})();

/** Registry-backed lookups against the default registry. */
export function getProvider(providerId: string): LoginProvider | null {
  return defaultRegistry.getProvider(providerId);
}

export function listProviders(): string[] {
  return defaultRegistry.listProviders();
}

/** True only when IAAA_WIRING_ENABLED is "1" or "true" (case-insensitive, trimmed). */
export function isWiringEnabled(env: Partial<Env> | null | undefined): boolean {
  const raw = env?.IAAA_WIRING_ENABLED;
  if (typeof raw !== "string") return false;
  const value = raw.trim().toLowerCase();
  return value === "1" || value === "true";
}

/**
 * Enabled provider ids from config. Defaults to ["github"] when wiring is
 * on and no list is set. Unknown ids are kept here — the registry, not
 * the parser, is what refuses them (see resolveLoginProvider).
 */
export function enabledProviders(env: Partial<Env> | null | undefined): string[] {
  if (!isWiringEnabled(env)) return [];
  const raw = env?.IAAA_ENABLED_PROVIDERS;
  if (typeof raw !== "string" || raw.trim() === "") return ["github"];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const id = part.trim().toLowerCase();
    if (id && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/** True only when wiring is on, the id is in the enabled list, AND an adapter is registered. */
export function isProviderEnabled(
  env: Partial<Env> | null | undefined,
  providerId: string
): boolean {
  if (!isWiringEnabled(env)) return false;
  if (typeof providerId !== "string") return false;
  const id = providerId.trim().toLowerCase();
  if (!enabledProviders(env).includes(id)) return false;
  return defaultRegistry.getProvider(id) !== null;
}

export type DisabledReason =
  | "wiring-disabled"
  | "provider-not-enabled"
  | "provider-not-registered";

export interface ResolvedLoginProvider {
  provider: LoginProvider | null;
  disabledReason: DisabledReason | null;
}

/**
 * Resolve a provider for dispatch: wiring off → wiring-disabled; id not
 * in the enabled list → provider-not-enabled; id not registered →
 * provider-not-registered. Never falls back to another provider.
 */
export function resolveLoginProvider(
  env: Partial<Env> | null | undefined,
  providerId: string
): ResolvedLoginProvider {
  if (!isWiringEnabled(env)) {
    return { provider: null, disabledReason: "wiring-disabled" };
  }
  if (typeof providerId !== "string" || !enabledProviders(env).includes(providerId.trim().toLowerCase())) {
    return { provider: null, disabledReason: "provider-not-enabled" };
  }
  const provider = defaultRegistry.getProvider(providerId);
  if (!provider) {
    return { provider: null, disabledReason: "provider-not-registered" };
  }
  return { provider, disabledReason: null };
}

/** The response a disabled login gets. No provider fallback, no redirect to login. */
export function disabledLoginResponse(reason: DisabledReason): Response {
  const messages: Record<DisabledReason, string> = {
    "wiring-disabled": "IAAA login wiring is disabled",
    "provider-not-enabled": "This login provider is not enabled",
    "provider-not-registered": "This login provider is not registered",
  };
  return new Response(messages[reason], { status: 403 });
}
