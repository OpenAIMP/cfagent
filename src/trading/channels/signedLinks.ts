/**
 * Issue #1262 Phase 5 — signed approval links (#149 pattern).
 *
 * A bare email APPROVE no longer executes anything. Execution requires
 * a signed approval link: HMAC-SHA256 over the link claims (order id,
 * login, sender address, expiry), issued only to a trade-tier mapped
 * principal at preview time, and re-checked against the principal map
 * at use time — unmapping a sender (or downgrading them below trade)
 * revokes their outstanding links. The same token verifies on both
 * paths that can execute it:
 *  - the link-click route (GET /api/trading/email/approve?token=…),
 *    where there is no message principal — the token + map are the
 *    whole authorization;
 *  - an email reply quoting the preview (the reply body contains the
 *    link URL), where the token's login must also equal the replying
 *    message's resolved principal.
 *
 * Token format: base64url(JSON claims) + "." + hex HMAC. The claims
 * JSON keeps field names short (o/l/a/e) so the token survives email
 * quoting; extraction strips all whitespace first because mail clients
 * line-wrap long URLs in quoted replies.
 *
 * Secret: CHANNEL_APPROVAL_LINK_SECRET when set, else SESSION_SECRET
 * (the #149 signed-state precedent — the same key family signs OAuth
 * state). With neither configured, issuance returns null and every
 * verification fails closed: email approvals are unavailable until a
 * secret exists, and the refusal replies say so.
 */

import type { Env } from "../../types";
import { computeHmacSha256Hex } from "../../services/cryptoUtils";
import { timingSafeEqual } from "../../security/webhookSecurity";
import { parseEmailPrincipals, type ChannelPrincipal } from "./intake";

export interface ApprovalLinkClaims {
  orderId: string;
  login: string;
  address: string;
  exp: number;
}

export const APPROVAL_LINK_DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

export function approvalLinkSecret(env: Env): string | null {
  const record = env as unknown as Record<string, unknown>;
  const dedicated = record.CHANNEL_APPROVAL_LINK_SECRET;
  if (typeof dedicated === "string" && dedicated.length > 0) return dedicated;
  const session = record.SESSION_SECRET;
  if (typeof session === "string" && session.length > 0) return session;
  return null;
}

function b64urlEncode(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function b64urlDecode(b64: string): string | null {
  try {
    const padded = b64.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

export async function issueApprovalLink(
  env: Env,
  args: { orderId: string; login: string; address: string; baseUrl: string; ttlMs?: number }
): Promise<{ token: string; url: string } | null> {
  const secret = approvalLinkSecret(env);
  if (!secret) return null;
  const exp = Date.now() + (args.ttlMs ?? APPROVAL_LINK_DEFAULT_TTL_MS);
  const payload = b64urlEncode(
    JSON.stringify({ o: args.orderId, l: args.login, a: args.address, e: exp })
  );
  const sig = await computeHmacSha256Hex(secret, payload);
  const token = `${payload}.${sig}`;
  const base = (args.baseUrl || "https://agent.openaimp.com").replace(/\/$/, "");
  return { token, url: `${base}/api/trading/email/approve?token=${encodeURIComponent(token)}` };
}

export type VerifyApprovalLinkResult =
  | { ok: true; claims: ApprovalLinkClaims }
  | { ok: false; error: string };

export async function verifyApprovalLink(env: Env, token: string): Promise<VerifyApprovalLinkResult> {
  const secret = approvalLinkSecret(env);
  if (!secret) return { ok: false, error: "Approval links are not configured." };
  if (!token || typeof token !== "string") return { ok: false, error: "No approval token supplied." };
  const idx = token.lastIndexOf(".");
  if (idx <= 0) return { ok: false, error: "Malformed approval token." };
  const payload = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  const expected = await computeHmacSha256Hex(secret, payload);
  if (!timingSafeEqual(sig, expected)) return { ok: false, error: "Approval token signature mismatch." };
  const json = b64urlDecode(payload);
  if (!json) return { ok: false, error: "Malformed approval token." };
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, error: "Malformed approval token." };
  }
  const claims = parsed as { o?: unknown; l?: unknown; a?: unknown; e?: unknown };
  if (
    typeof claims.o !== "string" ||
    typeof claims.l !== "string" ||
    typeof claims.a !== "string" ||
    typeof claims.e !== "number"
  ) {
    return { ok: false, error: "Malformed approval token." };
  }
  if (Date.now() > claims.e) return { ok: false, error: "Approval link expired." };
  return {
    ok: true,
    claims: { orderId: claims.o, login: claims.l, address: claims.a, exp: claims.e },
  };
}

/**
 * Full authorization check for a token presented on a channel path.
 * Beyond the signature + expiry, the sender address must STILL map to
 * the token's login at the trade tier (revocation by unmapping), and —
 * when the presenting message has a resolved principal (the email
 * reply path) — the token's login must equal that principal's login,
 * so a forwarded preview cannot execute under someone else's identity.
 * With no message principal (the link-click path), the token + map are
 * the authorization.
 */
export async function verifyApprovalLinkForPrincipal(
  env: Env,
  token: string,
  principal?: ChannelPrincipal | null
): Promise<VerifyApprovalLinkResult> {
  const verified = await verifyApprovalLink(env, token);
  if (!verified.ok) return verified;
  const claims = verified.claims;
  if (principal && claims.login !== principal.userLogin) {
    return { ok: false, error: "Approval link belongs to a different account than the sender." };
  }
  const entry = parseEmailPrincipals(env)[claims.address.trim().toLowerCase()];
  if (!entry || entry.login !== claims.login || entry.tier !== "trade") {
    return {
      ok: false,
      error: "The sender is no longer mapped at the trade tier; the approval link is revoked.",
    };
  }
  return verified;
}

/**
 * Extract an approval token from email text. Tokens have a fixed
 * shape — base64url payload, a dot, and a 64-hex HMAC — so extraction
 * matches that shape exactly (a following word is never swallowed).
 * Quoted replies line-wrap long URLs, so when no single-line match is
 * found the text is re-scanned with line breaks (and "> " quote
 * prefixes) removed, which reassembles a wrapped token; the fixed
 * 64-hex tail still bounds the match.
 */
export function extractApprovalTokenFromText(text: string): string | null {
  const raw = text || "";
  const tokenPattern = /[?&]token=([A-Za-z0-9_-]+\.[0-9a-fA-F]{64})/;
  const direct = raw.match(tokenPattern);
  if (direct) return direct[1];
  const joined = raw.replace(/\r?\n[ \t]*>?[ \t]*/g, "");
  const rewrapped = joined.match(tokenPattern);
  if (rewrapped) return rewrapped[1];
  return null;
}
