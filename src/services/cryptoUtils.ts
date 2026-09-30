/**
 * Cryptographic Utility Functions for Real Payments & Trading APIs
 *
 * Implements:
 * - RFC 5849 OAuth 1.0a Signature Generator (HMAC-SHA1) for E*TRADE Broker REST API.
 * - RFC 2104 HMAC-SHA256 Signature Verification for Stripe and Lemon Squeezy Webhooks.
 * - Web Crypto API standards (native in Cloudflare Workers and Node.js 18+).
 */

/**
 * RFC 3986 percent-encoding
 */
export function rfc3986(str: string): string {
  return encodeURIComponent(str).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

/**
 * Computes HMAC-SHA256 hex digest
 */
export async function computeHmacSha256Hex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Computes HMAC-SHA1 Base64 signature for OAuth 1.0a
 */
export async function computeHmacSha1Base64(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  const bytes = new Uint8Array(sig);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Generates an authentic RFC 5849 OAuth 1.0a Authorization header
 */
export async function generateOAuth1Header(options: {
  method: string;
  url: string;
  consumerKey: string;
  consumerSecret: string;
  token?: string;
  tokenSecret?: string;
  extraParams?: Record<string, string>;
  nonce?: string;
  timestamp?: string;
}): Promise<string> {
  const {
    method,
    url,
    consumerKey,
    consumerSecret,
    token = "",
    tokenSecret = "",
    extraParams = {},
    nonce = crypto.randomUUID().replace(/-/g, ""),
    timestamp = Math.floor(Date.now() / 1000).toString(),
  } = options;

  // Split URL into base URL and query parameters
  const [baseUrl, queryString] = url.split("?");

  const oauthParams: Record<string, string> = {
    oauth_consumer_key: consumerKey,
    oauth_nonce: nonce,
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: timestamp,
    oauth_version: "1.0",
    ...extraParams,
  };

  if (token) {
    oauthParams.oauth_token = token;
  }

  // Parse existing query string params if any
  const allParams: Array<[string, string]> = [];
  if (queryString) {
    const searchParams = new URLSearchParams(queryString);
    searchParams.forEach((val, key) => {
      allParams.push([key, val]);
    });
  }

  for (const [k, v] of Object.entries(oauthParams)) {
    allParams.push([k, v]);
  }

  // Sort alphabetically by encoded key, then encoded value
  allParams.sort((a, b) => {
    const keyA = rfc3986(a[0]);
    const keyB = rfc3986(b[0]);
    if (keyA === keyB) {
      return rfc3986(a[1]).localeCompare(rfc3986(b[1]));
    }
    return keyA.localeCompare(keyB);
  });

  const normalizedParamString = allParams
    .map(([k, v]) => `${rfc3986(k)}=${rfc3986(v)}`)
    .join("&");

  const signatureBaseString = `${method.toUpperCase()}&${rfc3986(baseUrl)}&${rfc3986(normalizedParamString)}`;
  const signingKey = `${rfc3986(consumerSecret)}&${rfc3986(tokenSecret)}`;

  const signature = await computeHmacSha1Base64(signingKey, signatureBaseString);
  oauthParams.oauth_signature = signature;

  const headerParams = Object.keys(oauthParams)
    .filter((k) => k.startsWith("oauth_"))
    .sort()
    .map((k) => `${k}="${rfc3986(oauthParams[k])}"`)
    .join(", ");

  return `OAuth ${headerParams}`;
}
