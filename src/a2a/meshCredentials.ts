/**
 * Issue #2426 (Agent Mesh S16, programme #2225 goal G14) — per-agent
 * mesh credentials for the A2A door.
 *
 * Until this slice, every A2A surface authenticated at the edge
 * with ONE shared bearer secret (env A2A_API_TOKEN): possession of
 * a single secret authorized all 15 surfaces, no surface could be
 * rotated or revoked independently, and the authenticated caller
 * was indistinguishable across surfaces. Each surface now has its
 * own credential env var — A2A_TOKEN_<SURFACE> — following the
 * dedicated-token precedent of QA_INVESTIGATE_TOKEN (src/types.ts,
 * #1754: "Deliberately distinct from A2A_API_TOKEN"). The map below
 * is DERIVED from A2A_RESOLUTIONS (the surface source of truth), so
 * a surface added there gains its credential name automatically;
 * the registry's identity records pin the same derivation
 * (tests/mesh_identity_s16_2426.test.ts).
 *
 * Transition posture (the deploy-day contract, stated plainly):
 *
 * - A surface whose per-agent credential IS set accepts ONLY that
 *   credential. The shared token stops working for that surface
 *   the moment its own secret exists — rotation is per surface.
 * - A surface whose per-agent credential is NOT set falls back to
 *   the shared A2A_API_TOKEN. This fallback is TRANSITIONAL: it is
 *   recorded here, in the registry's A2A door record, and in issue
 *   #2426's completion report. Removal condition: once every
 *   surface carries its own per-agent secret in production, a
 *   follow-up slice deletes the fallback and the shared token
 *   authenticates nothing.
 * - A surface with NEITHER configured is unconfigured: the edge
 *   fails closed (503), exactly as the shared-only edge did when
 *   A2A_API_TOKEN was unset.
 *
 * Production today has only the shared secret set, so on deploy
 * day every surface behaves exactly as before (shared token,
 * attribution labelled shared-transitional), and the owner moves
 * surfaces onto per-agent credentials one secret at a time.
 *
 * The owner step (named in #2426's §15, not taken by this slice):
 * set the per-surface Worker secrets A2A_TOKEN_<SURFACE> (wrangler
 * secret put / dashboard), then — once all 15 are set — unset
 * A2A_API_TOKEN and land the fallback-removal follow-up.
 *
 * Existence disclosure: authentication runs per surface because
 * credentials are per surface. This leaks nothing the public
 * discovery cards do not already publish — every dispatch surface
 * but one (nlq) has a public card; for an unknown surface name the
 * outcome is the same 401/404 sequence the shared-token edge
 * produced (auth result first, resolution second).
 */
import { A2A_RESOLUTIONS } from "./resolution";
import { timingSafeEqual } from "../security/webhookSecurity";

/** The shared transitional token's env var name. */
export const A2A_SHARED_TOKEN_ENV = "A2A_API_TOKEN";

/**
 * The env var carrying a surface's per-agent mesh credential:
 * `A2A_TOKEN_<SURFACE>`, surface upper-cased with `-` → `_`
 * (report-asset → A2A_TOKEN_REPORT_ASSET).
 */
export function a2aSurfaceCredentialEnv(surface: string): string {
  return `A2A_TOKEN_${surface.toUpperCase().replace(/-/g, "_")}`;
}

/** Surface name → credential env var, for every dispatch surface. */
export const A2A_SURFACE_CREDENTIAL_ENVS: Readonly<Record<string, string>> =
  Object.freeze(
    Object.fromEntries(
      Object.keys(A2A_RESOLUTIONS).map((surface) => [
        surface,
        a2aSurfaceCredentialEnv(surface),
      ]),
    ),
  );

export type A2ACredentialKind = "per-agent" | "shared-transitional";

/**
 * Two-part attribution for one authenticated A2A call: the CALLER
 * part is the credential identity the edge authenticated (the
 * per-surface credential, or the shared token in its transitional
 * posture); the AGENT part is the surface being served (its owning
 * class and DID live in the registry's identity records). The edge
 * passes this into handleA2A as the third argument; agents that
 * write records (PaymentsAgent) record both parts.
 */
export interface A2AAttribution {
  /** The A2A surface name the call was dispatched to. */
  surface: string;
  /** The authenticated caller identity: `a2a-credential:<surface>`
   *  for a per-agent credential, `a2a-credential:shared-transitional`
   *  while the shared-token fallback authenticates the call. */
  caller: string;
  /** Which credential kind authenticated the call. */
  credential: A2ACredentialKind;
}

export type A2AAuthOutcome =
  | { ok: true; attribution: A2AAttribution }
  | { ok: false; reason: "unconfigured" | "unauthorized" };

function envSecret(env: Record<string, unknown>, name: string): string | undefined {
  const value = env[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Authenticate one A2A dispatch POST for `surface` (the name from
 * the URL path, or null when the path names no surface) against
 * the presented bearer token. Pure and total: every outcome is one
 * of the A2AAuthOutcome shapes; the edge maps unconfigured → 503
 * and unauthorized → 401, both before agent resolution (the #291 /
 * #1763 contract).
 */
export function authenticateA2A(
  env: Record<string, unknown>,
  surface: string | null,
  presented: string,
): A2AAuthOutcome {
  const perAgent =
    surface !== null && surface in A2A_SURFACE_CREDENTIAL_ENVS
      ? envSecret(env, A2A_SURFACE_CREDENTIAL_ENVS[surface])
      : undefined;
  if (perAgent !== undefined) {
    // The surface has its own credential: it is the ONLY accepted
    // one — the shared token stops working for this surface here.
    if (presented.length > 0 && timingSafeEqual(presented, perAgent)) {
      return {
        ok: true,
        attribution: {
          surface: surface as string,
          caller: `a2a-credential:${surface}`,
          credential: "per-agent",
        },
      };
    }
    return { ok: false, reason: "unauthorized" };
  }
  const shared = envSecret(env, A2A_SHARED_TOKEN_ENV);
  if (shared !== undefined) {
    // TRANSITIONAL fallback (see header): the shared token
    // authenticates any surface that has no per-agent credential
    // yet, and the attribution says so on every such call.
    if (presented.length > 0 && timingSafeEqual(presented, shared)) {
      return {
        ok: true,
        attribution: {
          surface: surface ?? "unknown",
          caller: "a2a-credential:shared-transitional",
          credential: "shared-transitional",
        },
      };
    }
    return { ok: false, reason: "unauthorized" };
  }
  return { ok: false, reason: "unconfigured" };
}
