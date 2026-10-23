/**
 * #1077 token-health slice (#1160) — per-channel token status.
 *
 * Presence comes from env (the Worker secrets the publisher layer
 * already reads): a token env var set and non-blank means
 * "configured", anything else means "unconfigured". Validity comes
 * ONLY from a live probe over an INJECTED transport: 2xx means
 * valid, 401/403 means invalid, any other status or a transport
 * throw means unknown. No live transport is wired in this slice
 * (production passes none, as in Phase 5a), so production validity
 * reads "unknown" by design — never assumed valid, never assumed
 * invalid. Wiring a production GET transport is an activation step,
 * not something this module does on its own.
 *
 * Secrecy, by construction:
 * - The transport surface carries a status number ONLY. Platform
 *   response bodies are never read, so platform error text can
 *   never leak into a result.
 * - Results contain fixed enums, env var names, endpoint URLs for
 *   CONFIRMED endpoints, and status numbers — never a token value,
 *   prefix, or account value. Tests pin this.
 * - No transport call is ever made for an unconfigured channel, a
 *   channel without an injected transport, or a channel whose
 *   validation endpoint is unconfirmed.
 *
 * Validation endpoints — confirmed vs unconfirmed (checked
 * 2026-10-23 against publisher definitions + platform docs):
 * - threads: GET https://graph.threads.net/v1.0/me — CONFIRMED.
 *   Same host/version as the publish endpoints.
 * - facebook: GET https://graph.facebook.com/v21.0/me — CONFIRMED.
 *   Canonical Graph API /me; v21.0 matches the publish endpoint.
 *   A Page token returns the Page identity for /me.
 * - instagram: GET https://graph.instagram.com/v21.0/me — CONFIRMED.
 *   graph.instagram.com/me is the documented profile endpoint;
 *   v21.0 matches the publish endpoint.
 * - linkedin: GET https://api.linkedin.com/v2/me — CONFIRMED
 *   (Microsoft Learn Profile API: "retrieve the current member's
 *   profile based on the access token"). It requires the
 *   X-RestLi-Protocol-Version: 2.0.0 header, which the probe sends.
 * - x: UNCONFIRMED. The candidate https://api.twitter.com/2/users/me
 *   could NOT be confirmed against X's own docs in this slice's
 *   checks (searches returned only generic OAuth pages), so it is
 *   NOT asserted here and NO live call is made for X. X validity
 *   stays "unknown" until the endpoint is confirmed against
 *   current X docs. Same-host as the publish endpoint does NOT
 *   count as confirmation for the /users/me path.
 *
 * This module never posts, never stores a token, and is never
 * called by the goal executor in this slice.
 */

import { KNOWN_SOCIAL_CHANNELS, type SocialChannel } from "./config";
import { getPublisherDef } from "./publisher";

export type TokenPresence = "configured" | "unconfigured";
export type TokenValidity = "valid" | "invalid" | "unknown";

/**
 * Minimal validation transport: one GET returning a status number
 * only. Tests inject a fake; production wiring (activation step)
 * supplies a real fetch-backed one. Bodies are deliberately absent
 * from this surface so they cannot leak.
 */
export interface TokenHealthTransport {
  get(url: string, headers: Record<string, string>): Promise<{ status: number }>;
}

export interface ChannelTokenHealth {
  channel: SocialChannel;
  tokenEnvVar: string;
  accountEnvVar?: string;
  presence: TokenPresence;
  /** Only present when the channel declares an account env var (LinkedIn). */
  accountPresence?: TokenPresence;
  validity: TokenValidity;
  /** True only when a live probe was actually attempted. */
  validated: boolean;
  /** Null when the validation endpoint is unconfirmed (X) — never a guess. */
  validationEndpoint: string | null;
  validationEndpointConfirmed: boolean;
  /** Fixed categories only — never platform body text. */
  validationDetail?: "unexpected-status" | "transport-error";
  /** HTTP status number of the probe, when one was attempted. Never a body. */
  validationStatus?: number;
}

interface ValidationDef {
  endpoint: string;
  extraHeaders?: Record<string, string>;
}

/**
 * Confirmed validation endpoints only. X is deliberately absent:
 * its candidate endpoint is unconfirmed (see the module docstring),
 * so X never gets a live probe in this slice.
 */
const VALIDATION_DEFS: Partial<Record<SocialChannel, ValidationDef>> = {
  threads: { endpoint: "https://graph.threads.net/v1.0/me" },
  facebook: { endpoint: "https://graph.facebook.com/v21.0/me" },
  instagram: { endpoint: "https://graph.instagram.com/v21.0/me" },
  linkedin: {
    endpoint: "https://api.linkedin.com/v2/me",
    extraHeaders: { "X-RestLi-Protocol-Version": "2.0.0" },
  },
};

function isBlank(value: string | undefined): boolean {
  return value === undefined || value.trim() === "";
}

/**
 * Check one channel. Returns undefined for an unknown channel
 * (same convention as getPublisherDef). Never throws, and never
 * calls the transport unless the token is configured, a transport
 * was injected, AND the endpoint is confirmed.
 */
export async function checkChannelTokenHealth(
  channel: string,
  tokens: Record<string, string | undefined>,
  transport?: TokenHealthTransport,
): Promise<ChannelTokenHealth | undefined> {
  const def = getPublisherDef(channel);
  if (!def) return undefined;
  const token = tokens[def.tokenEnvVar];
  const presence: TokenPresence = isBlank(token) ? "unconfigured" : "configured";
  const validationDef = VALIDATION_DEFS[def.channel];
  const result: ChannelTokenHealth = {
    channel: def.channel,
    tokenEnvVar: def.tokenEnvVar,
    ...(def.accountEnvVar ? { accountEnvVar: def.accountEnvVar } : {}),
    ...(def.accountEnvVar
      ? { accountPresence: isBlank(tokens[def.accountEnvVar]) ? "unconfigured" : "configured" }
      : {}),
    presence,
    validity: "unknown",
    validated: false,
    validationEndpoint: validationDef ? validationDef.endpoint : null,
    validationEndpointConfirmed: validationDef !== undefined,
  };
  // Fail closed on every missing input: no token, no transport, or
  // an unconfirmed endpoint all leave validity unknown with no call.
  if (presence === "unconfigured") return result;
  if (!transport) return result;
  if (!validationDef) return result;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token!.trim()}`,
    ...(validationDef.extraHeaders ?? {}),
  };
  try {
    const res = await transport.get(validationDef.endpoint, headers);
    result.validated = true;
    result.validationStatus = res.status;
    if (res.status >= 200 && res.status < 300) {
      result.validity = "valid";
    } else if (res.status === 401 || res.status === 403) {
      result.validity = "invalid";
    } else {
      result.validity = "unknown";
      result.validationDetail = "unexpected-status";
    }
  } catch {
    result.validated = true;
    result.validity = "unknown";
    result.validationDetail = "transport-error";
  }
  return result;
}

/**
 * Check every known channel, in KNOWN_SOCIAL_CHANNELS order.
 * Never throws: a channel failure degrades to that channel's
 * unknown result, never to a missing channel.
 */
export async function checkAllTokenHealth(
  tokens: Record<string, string | undefined>,
  transport?: TokenHealthTransport,
): Promise<ChannelTokenHealth[]> {
  const out: ChannelTokenHealth[] = [];
  for (const channel of KNOWN_SOCIAL_CHANNELS) {
    const checked = await checkChannelTokenHealth(channel, tokens, transport);
    if (checked) out.push(checked);
  }
  return out;
}
