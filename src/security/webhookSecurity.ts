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
