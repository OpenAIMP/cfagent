/**
 * Unified Webhook & Integration Signature Security
 * Timing-safe HMAC-SHA256 signature verifiers for Webhooks, Slack, and external callbacks.
 */

/**
 * Timing-safe string comparison to protect against timing attacks.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const A = enc.encode(a);
  const B = enc.encode(b);
  if (A.length !== B.length) return false;
  let diff = 0;
  for (let i = 0; i < A.length; i++) {
    diff |= A[i] ^ B[i];
  }
  return diff === 0;
}

/**
 * Verifies an HMAC-SHA256 hex or standard signature against raw body content.
 *
 * FAIL CLOSED (issue #140): when no secret is configured, verification
 * FAILS — an unconfigured verifier must never report a caller as
 * verified. This previously returned `true` in a self-described
 * "permissive development mode", which meant any deployment missing
 * the secret accepted any (or no) signature on every inbound webhook
 * consumer. It mirrors the outbound decision in issue #123 (F20):
 * no configured secret → not verified, no default, no silent bypass.
 * Callers that need to distinguish "not configured" from "bad
 * signature" check for the secret themselves before calling (the
 * /nlq/webhook route answers 503; the trading webhook processors
 * answer 503 — see src/services/tradingWebhooks.ts).
 */
export async function verifyHmacSha256Signature(
  rawBody: string,
  signature: string | null,
  secret?: string
): Promise<boolean> {
  if (!secret) return false; // Not configured → not verified. Never permissive.
  if (!signature) return false;

  try {
    const cleanSig = signature.replace(/^sha256=/i, "").trim().toLowerCase();
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"]
    );

    const signatureBytes = Uint8Array.from(
      cleanSig.match(/.{2}/g) ?? [],
      (byte) => Number.parseInt(byte, 16)
    );

    return await crypto.subtle.verify("HMAC", key, signatureBytes, encoder.encode(rawBody));
  } catch {
    return false;
  }
}

/**
 * Verifies Slack HMAC-SHA256 request signature with timestamp replay prevention (5-minute window).
 */
export async function verifySlackSignature(
  signingSecret: string,
  timestamp: string | null,
  rawBody: string,
  signature: string | null
): Promise<boolean> {
  if (!signingSecret || !timestamp || !signature) return false;

  const now = Math.floor(Date.now() / 1000);
  const tsNum = Number(timestamp);
  if (isNaN(tsNum) || Math.abs(now - tsNum) > 300) {
    return false; // Replay attack protection: reject requests older or newer than 5 minutes
  }

  const sigBasestring = `v0:${timestamp}:${rawBody}`;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(signingSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const hashBuffer = await crypto.subtle.sign("HMAC", key, encoder.encode(sigBasestring));
  const expectedSig = "v0=" + Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return timingSafeEqual(expectedSig, signature);
}

export type SlackSignatureGateResult =
  | { ok: true; rawBody: string }
  | { ok: false; response: Response };

/**
 * Mandatory Slack ingress gate (issue #147).
 *
 * `verifySlackSignature` itself fails closed, but its callers used to
 * wrap it in `if (SLACK_SIGNING_SECRET) { … }` — so in any deployment
 * where the secret was not set, the LIVE Slack routes (slash commands,
 * events, interactions) processed completely unauthenticated requests,
 * including forged "approve <orderId>" events and approve-button
 * interactions that execute previewed orders on E*TRADE. The check is
 * now structural, shared by every Slack ingress layer (the worker
 * routes in src/server.ts and SlackAgent.onRequest):
 *
 * - No signing secret configured → HTTP 503 naming the missing
 *   configuration, BEFORE any request processing (the /nlq/webhook
 *   precedent from issue #140). The failure is loud and safe: Slack
 *   deliveries fail visibly instead of being silently trusted.
 * - Secret configured → the signature is REQUIRED: a missing or
 *   invalid signature is rejected with the same 401 the routes have
 *   always returned for a bad signature.
 * - Secret configured + valid signature → `{ ok: true, rawBody }` and
 *   the caller proceeds exactly as before.
 *
 * The gate consumes the request body; callers that still need the
 * body afterwards (e.g. Agent.onRequest routing) pass a clone.
 * The request parameter is structural (headers + text) so both the
 * DOM and Workers Request typings satisfy it.
 */
export async function gateSlackRequest(
  request: { headers: Headers; text(): Promise<string> },
  signingSecret?: string
): Promise<SlackSignatureGateResult> {
  if (!signingSecret) {
    return {
      ok: false,
      response: Response.json(
        { error: "SLACK_SIGNING_SECRET is not configured." },
        { status: 503 }
      ),
    };
  }

  const rawBody = await request.text();
  const isValid = await verifySlackSignature(
    signingSecret,
    request.headers.get("x-slack-request-timestamp"),
    rawBody,
    request.headers.get("x-slack-signature")
  );
  if (!isValid) {
    return {
      ok: false,
      response: new Response("Invalid Slack signature", { status: 401 }),
    };
  }

  return { ok: true, rawBody };
}

// ============================================================================
// Outbound SSRF guard (issue #240)
// ============================================================================

/**
 * Parses an IPv4 host string — dotted decimal, dotted octal/hex parts, or a
 * single 32-bit integer in decimal/octal/hex — into a uint32.
 * Returns null when the host is not an IPv4 literal at all.
 *
 * The exotic forms matter: `http://2130706433/`, `http://0x7f000001/` and
 * `http://0177.0.0.1/` all resolve to 127.0.0.1 on most stacks, so a
 * naive `startsWith("127.")` check is bypassable.
 */
function parseIPv4ToInt(host: string): number | null {
  const parsePart = (p: string): number | null => {
    if (/^0x[0-9a-f]+$/i.test(p)) return parseInt(p, 16);
    if (/^0[0-7]+$/.test(p) && p.length > 1) return parseInt(p, 8);
    if (/^[0-9]+$/.test(p)) return parseInt(p, 10);
    return null;
  };
  // Single-number forms: "2130706433", "0x7f000001", "037700000001"
  if (/^(0x[0-9a-f]+|0[0-7]+|[0-9]+)$/i.test(host)) {
    const n = parsePart(host);
    return n !== null && n >= 0 && n <= 0xffffffff ? n >>> 0 : null;
  }
  // inet_aton semantics: 2-4 part forms ("127.1" == 127.0.0.1).
  const parts = host.split(".");
  if (parts.length < 2 || parts.length > 4) return null;
  const nums: number[] = [];
  for (const part of parts) {
    const n = parsePart(part);
    if (n === null || n < 0) return null;
    nums.push(n);
  }
  let ip: number;
  if (nums.length === 4) {
    if (nums.some((n) => n > 255)) return null;
    ip = ((nums[0] * 256 + nums[1]) * 256 + nums[2]) * 256 + nums[3];
  } else if (nums.length === 3) {
    if (nums[0] > 255 || nums[1] > 255 || nums[2] > 65535) return null;
    ip = nums[0] * 16777216 + nums[1] * 256 + nums[2];
  } else {
    if (nums[0] > 255 || nums[1] > 16777215) return null;
    ip = nums[0] * 16777216 + nums[1];
  }
  return ip >= 0 && ip <= 0xffffffff ? ip >>> 0 : null;
}

// [base, prefixBits] — ranges a webhook must never be sent to.
const BLOCKED_V4_RANGES: Array<[number, number]> = [
  [0x0a000000, 8], // 10.0.0.0/8 — private
  [0xac100000, 12], // 172.16.0.0/12 — private
  [0xc0a80000, 16], // 192.168.0.0/16 — private
  [0x7f000000, 8], // 127.0.0.0/8 — loopback
  [0xa9fe0000, 16], // 169.254.0.0/16 — link-local (cloud metadata)
  [0x00000000, 8], // 0.0.0.0/8 — "this network"
  [0xe0000000, 4], // 224.0.0.0/4 — multicast
  [0x64400000, 10], // 100.64.0.0/10 — CGNAT shared space
  [0xc0000200, 24], // 192.0.2.0/24 — TEST-NET-1 (documentation)
  [0xc6336400, 24], // 198.51.100.0/24 — TEST-NET-2 (documentation)
  [0xcb007100, 24], // 203.0.113.0/24 — TEST-NET-3 (documentation)
];

function inCidr(ip: number, base: number, bits: number): boolean {
  const mask = bits === 32 ? 0xffffffff : ((0xffffffff << (32 - bits)) >>> 0);
  return ((ip & mask) >>> 0) === ((base & mask) >>> 0);
}

function isBlockedIPv4Literal(host: string): boolean {
  const ip = parseIPv4ToInt(host);
  if (ip === null) return false;
  return BLOCKED_V4_RANGES.some(([base, bits]) => inCidr(ip, base, bits));
}

function isBlockedIPv6Literal(host: string): boolean {
  const h = host.toLowerCase();
  // IPv4-mapped IPv6, e.g. ::ffff:127.0.0.1
  const mapped = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedIPv4Literal(mapped[1]);
  if (h === "::1" || h === "::") return true; // loopback / unspecified
  const first = h.split(":")[0] || "";
  const v = parseInt(first, 16);
  if (Number.isNaN(v)) return false;
  if ((v & 0xfe00) === 0xfc00) return true; // fc00::/7 — unique local
  if ((v & 0xffc0) === 0xfe80) return true; // fe80::/10 — link-local
  return false;
}

/**
 * Returns true when a webhook target hostname must never be fetched:
 * localhost names, private/loopback/link-local IP literals (including
 * decimal/octal/hex obfuscations), and IPv6 equivalents.
 *
 * NOTE: this is a literal check — it cannot see through DNS rebinding.
 * Webhook targets are operator-configured subscriber URLs, so literals
 * are the realistic attack surface (e.g. a caller-supplied `targetUrl`
 * on the `dispatch_trading_webhook` MCP tool).
 */
export function isBlockedWebhookHost(hostname: string): boolean {
  // URL.hostname keeps IPv6 brackets ("[::1]") — strip them; also tolerate a
  // trailing dot. Callers must pass a bare hostname (no port); use
  // assertSafeOutboundWebhookUrl for full URLs.
  const h = hostname.toLowerCase().trim().replace(/\.$/, "").replace(/^\[(.*)\]$/, "$1");
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h.includes(":")) return isBlockedIPv6Literal(h);
  return isBlockedIPv4Literal(h);
}

/**
 * Throws when `rawUrl` is not a safe outbound-webhook target.
 * Error messages deliberately omit the URL — it may carry secrets.
 */
export function assertSafeOutboundWebhookUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Refusing to dispatch webhook: invalid target URL.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Refusing to dispatch webhook: only http(s) targets are allowed.");
  }
  if (isBlockedWebhookHost(url.hostname)) {
    throw new Error("Refusing to dispatch webhook: target host is not allowed.");
  }
  return url;
}
