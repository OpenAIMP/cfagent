/**
 * Decentralized Identifier (DID) System for Autonomous AI Agents
 * Conforms to W3C Decentralized Identifiers (DIDs) v1.0 standard syntax:
 * did:<method>:<namespace>:<agent-role>
 *
 * Honesty contract (S16, issue #2426 — read before trusting a
 * "proof" from this module):
 *
 * - A proof is a cryptographic attestation ONLY when it was created
 *   with an HMAC key (env DID_ATTESTATION_KEY, threaded by the
 *   caller): then proofType is "HmacSha256Verification2026" — a
 *   claim that is now literally true — and verifyDidAttestation
 *   verifies it (and fails tampered payloads and wrong keys).
 * - A proof created WITHOUT a key is an unkeyed content label:
 *   proofType "UnkeyedContentLabel2026". Its value is a digest of
 *   the payload that anyone can recompute; it binds a record to
 *   its contents and proves NOTHING about who produced it. It
 *   never verifies. Before #2426 these values were labelled
 *   "HmacSha256Verification2026" with no key and no verify
 *   function anywhere — a labelling pattern, not a proof; the
 *   label now says what the value is.
 * - The DID document this module resolves is an identity LABEL
 *   document (role + capabilities). It publishes no key material:
 *   before #2426 its verificationMethod claimed an Ed25519 key
 *   whose "public key" was derived from a non-cryptographic string
 *   hash — fabricated key material, now removed and relabelled.
 */
import { timingSafeEqual } from "../security/webhookSecurity";

/** proofType of an unkeyed attestation: a content label, not a proof. */
export const UNKEYED_CONTENT_LABEL = "UnkeyedContentLabel2026" as const;

/** proofType of a keyed attestation: a real HMAC-SHA256 over the payload. */
export const KEYED_HMAC_PROOF_TYPE = "HmacSha256Verification2026" as const;

export interface AgentDidDocument {
  "@context": string[];
  id: string;
  controller: string;
  agentRole: string;
  verificationMethod: Array<{
    id: string;
    type: string;
    controller: string;
    publicKeyMultibase?: string;
  }>;
  authentication: string[];
  assertionMethod: string[];
  capabilities: string[];
  created: string;
}

export interface DidAttestationProof {
  proofId: string;
  proposerDid: string;
  authorizerDid: string;
  executorDid: string;
  gateway: string;
  action: string;
  amount: number;
  currency: string;
  timestamp: string;
  signature: string;
  proofType: "Ed25519Signature2020" | "HmacSha256Verification2026" | "UnkeyedContentLabel2026";
}

export const AGENT_DIDS = {
  ORCHESTRATOR: "did:agent:openaimp:orchestrator",
  JUDGE: "did:agent:openaimp:judge",
  PAYMENTS: "did:agent:openaimp:payments",
  SEARCH: "did:agent:openaimp:search",
  TASKS: "did:agent:openaimp:tasks",
  MEMORY: "did:agent:openaimp:memory",
  NLQ: "did:agent:openaimp:nlq",
  TRADING: "did:agent:openaimp:trading",
  RESEARCH: "did:agent:openaimp:research",
  BROWSER: "did:agent:openaimp:browser",
  SLACK: "did:agent:openaimp:slack",
} as const;

export type KnownAgentDid = typeof AGENT_DIDS[keyof typeof AGENT_DIDS];

/**
 * Resolves a W3C-compliant DID Document for an Agent or User
 */
export function resolveAgentDidDocument(did: string): AgentDidDocument {
  const parts = did.split(":");
  const role = parts[parts.length - 1] || "agent";

  return {
    "@context": [
      "https://www.w3.org/ns/did/v1",
      "https://w3id.org/security/suites/ed25519-2020/v1"
    ],
    id: did,
    controller: "did:agent:openaimp:root",
    agentRole: role,
    verificationMethod: [
      {
        // Issue #2426: this document is an identity label, not a
        // cryptographic identity — the agent holds no Ed25519 key,
        // and the previous entry published hash-derived bytes as a
        // public key. The method is labelled for what it is (the
        // unkeyed content-label family); key material is published
        // only when a real key exists to publish.
        id: `${did}#key-1`,
        type: UNKEYED_CONTENT_LABEL,
        controller: did,
      }
    ],
    authentication: [`${did}#key-1`],
    assertionMethod: [`${did}#key-1`],
    capabilities: getAgentCapabilities(role),
    created: "2026-01-01T00:00:00Z"
  };
}

/** Shared login-key cleaning for every user DID derivation (issue #1759). */
export function cleanLoginKey(value: string): string {
  return (value || "").toLowerCase().replace(/[^a-z0-9_-]/g, "");
}

/**
 * Shared provider-id cleaning for user DID derivations (issue #1759).
 * An empty or unusable id becomes "unknown" — never another
 * provider's id, and never a guessed one.
 */
export function cleanProviderId(value: string): string {
  const cleaned = (value || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
  return cleaned === "" ? "unknown" : cleaned;
}

/**
 * Issue #2426 — DID derivations fail closed on an empty login.
 * Before this slice an empty (or fully uncleanable) login minted
 * `did:user:*:anonymous`: a synthetic identity, shared by every
 * caller that had no login, which then satisfied "has an
 * authorizer DID" checks downstream. A derivation that cannot name
 * its principal now refuses instead — callers that legitimately
 * have no login must say so in their own terms, not borrow a
 * pseudo-identity from here.
 */
function requireLoginKey(value: string, caller: string): string {
  const cleanLogin = cleanLoginKey(value);
  if (!cleanLogin) {
    throw new Error(
      `${caller} requires a non-empty login — refusing to derive an anonymous DID (issue #2426)`,
    );
  }
  return cleanLogin;
}

export function getUserDid(githubLogin: string): string {
  const cleanLogin = requireLoginKey(githubLogin, "getUserDid");
  return `did:user:github:${cleanLogin}`;
}

/**
 * Issue #1759 — provider-neutral user DID. The provider segment
 * comes from the session's own provider (see getSessionDid in
 * src/security/iaaaLoginKey.ts), never from a hardcoded default:
 * a Google session renders `did:user:google:<key>`, a GitHub
 * session `did:user:github:<key>`. The legacy getUserDid above is
 * kept unchanged for existing attestation call sites; new
 * display derivations use this function (or getDisplayUserDid).
 * Distinct providers never merge: the provider segment is part
 * of the DID, so the same login key on two providers yields two
 * different DIDs. An empty login key throws (issue #2426): the
 * derivation refuses to mint the synthetic "anonymous" DID the
 * legacy behavior produced.
 */
export function getLoginDid(providerId: string, loginKey: string): string {
  const cleanLogin = requireLoginKey(loginKey, "getLoginDid");
  return `did:user:${cleanProviderId(providerId)}:${cleanLogin}`;
}

/**
 * Issue #1759 — display DID for a client user object. When the
 * provider is known (wired sessions carry it from the server),
 * the provider-neutral derivation applies; when it is absent
 * (legacy sessions, which predate multi-provider login and are
 * historically GitHub-only), the legacy derivation applies — that
 * is historically accurate, not a cross-provider render. Callers
 * must not pass a hardcoded provider here.
 */
export function getDisplayUserDid(
  loginKey: string,
  providerId?: string | null,
): string {
  if (providerId && providerId.trim() !== "") {
    return getLoginDid(providerId, loginKey);
  }
  return getUserDid(loginKey);
}

function getAgentCapabilities(role: string): string[] {
  switch (role) {
    case "payments":
      return [
        "payment:draft:create",
        "payment:intent:sign",
        "payment:gateway:route",
        "settlement:verify"
      ];
    case "judge":
      return [
        "routing:classify",
        "guardrail:evaluate",
        "security:risk-score"
      ];
    case "orchestrator":
      return [
        "workflow:coordinate",
        "subagent:delegate",
        "sqlite:transaction:commit"
      ];
    case "search":
      return [
        "rag:semantic-search",
        "knowledge:retrieve"
      ];
    case "tasks":
      return [
        "task:schedule",
        "reminder:dispatch"
      ];
    case "memory":
      return [
        "memory:persist",
        "fact:recall"
      ];
    case "nlq":
      return [
        "nlq:plan:generate",
        "sqlite:readonly:query",
        "schema:introspect"
      ];
    default:
      return ["agent:general:execute"];
  }
}

/** The payload every attestation value is computed over. Shared by
 *  creation and verification so the two can never drift apart. The
 *  proof object deliberately does NOT carry draftId or customer —
 *  they are binding inputs the verifier supplies from the draft
 *  record the proof is attached to (see verifyDidAttestation). */
function attestationPayload(fields: {
  proofId: string;
  draftId: string;
  action: string;
  amount: number;
  currency: string;
  customer: string;
  gateway: string;
  proposerDid: string;
  authorizerDid: string;
  timestamp: string;
  dataProvenance?: string;
}): string {
  return [
    fields.proofId,
    fields.draftId,
    fields.action,
    fields.amount.toFixed(2),
    fields.currency.toUpperCase(),
    fields.customer,
    fields.gateway,
    fields.proposerDid,
    fields.authorizerDid,
    fields.timestamp,
    ...(fields.dataProvenance ? [`data:${fields.dataProvenance}`] : []),
  ].join("|");
}

async function computeHmacSha256Hex(key: string, message: string): Promise<string> {
  const encoder = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(message));
  return Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Creates an attestation for a transaction intent (issue #2426 for
 * the keyed form). With `key` (the DID_ATTESTATION_KEY secret,
 * threaded by call sites that hold env), the value is a real
 * HMAC-SHA256 over the payload and proofType is
 * "HmacSha256Verification2026" — verifiable via verifyDidAttestation.
 * Without a key, the value is the payload's SHA-256 digest and
 * proofType is "UnkeyedContentLabel2026": a content label anyone
 * can recompute, proving nothing about origin. The label always
 * says which of the two the value is.
 */
export async function createDidAttestation(params: {
  draftId: string;
  action: string;
  amount: number;
  currency: string;
  customer: string;
  gateway: string;
  proposerDid?: string;
  authorizerDid?: string;
  /** Optional data-provenance label bound into the signed payload (issue #117). */
  dataProvenance?: string;
}, key?: string): Promise<DidAttestationProof> {
  const proofId = `proof_${crypto.randomUUID().slice(0, 12)}`;
  const timestamp = new Date().toISOString();
  const proposerDid = params.proposerDid || AGENT_DIDS.PAYMENTS;
  const authorizerDid = params.authorizerDid || "did:user:pending-human-authorization";
  const executorDid = AGENT_DIDS.ORCHESTRATOR;

  const payload = attestationPayload({
    proofId,
    draftId: params.draftId,
    action: params.action,
    amount: params.amount,
    currency: params.currency,
    customer: params.customer,
    gateway: params.gateway,
    proposerDid,
    authorizerDid,
    timestamp,
    dataProvenance: params.dataProvenance,
  });

  const keyed = typeof key === "string" && key.length > 0;
  const signature = keyed
    ? await computeHmacSha256Hex(key, payload)
    : await computeSha256Hex(payload);

  return {
    proofId,
    proposerDid,
    authorizerDid,
    executorDid,
    gateway: params.gateway,
    action: params.action,
    amount: params.amount,
    currency: params.currency,
    timestamp,
    signature,
    proofType: keyed ? KEYED_HMAC_PROOF_TYPE : UNKEYED_CONTENT_LABEL
  };
}

/**
 * Verifies a keyed attestation (issue #2426). The verifier supplies
 * the binding inputs the proof does not carry (the draft id and
 * customer from the record the proof is attached to, plus the
 * data-provenance label when one was bound at creation). Returns
 * true only for a proof whose proofType is the keyed HMAC type,
 * whose payload — rebuilt from the proof's own fields plus the
 * binding inputs — HMACs under `key` to the proof's signature,
 * compared timing-safely. An unkeyed content label NEVER verifies,
 * under any key: it was never a proof.
 */
export async function verifyDidAttestation(
  proof: DidAttestationProof,
  binding: { draftId: string; customer: string; dataProvenance?: string },
  key: string,
): Promise<boolean> {
  if (!proof || proof.proofType !== KEYED_HMAC_PROOF_TYPE) return false;
  if (typeof key !== "string" || key.length === 0) return false;
  const payload = attestationPayload({
    proofId: proof.proofId,
    draftId: binding.draftId,
    action: proof.action,
    amount: proof.amount,
    currency: proof.currency,
    customer: binding.customer,
    gateway: proof.gateway,
    proposerDid: proof.proposerDid,
    authorizerDid: proof.authorizerDid,
    timestamp: proof.timestamp,
    dataProvenance: binding.dataProvenance,
  });
  const expected = await computeHmacSha256Hex(key, payload);
  return timingSafeEqual(expected, proof.signature);
}

export function createDidAttestationSync(params: {
  draftId: string;
  action: string;
  amount: number;
  currency: string;
  customer: string;
  gateway: string;
  proposerDid?: string;
  authorizerDid?: string;
  /**
   * Optional data-provenance label (issue #117). When provided it is bound
   * into the signed payload, so an attestation over non-live inputs says so
   * inside the signature itself. Omitted by existing callers — their payload
   * (and signatures' inputs) are unchanged.
   */
  dataProvenance?: string;
}): DidAttestationProof {
  const proofId = `proof_${crypto.randomUUID().slice(0, 12)}`;
  const timestamp = new Date().toISOString();
  const proposerDid = params.proposerDid || AGENT_DIDS.PAYMENTS;
  const authorizerDid = params.authorizerDid || "did:user:pending-human-authorization";
  const executorDid = AGENT_DIDS.ORCHESTRATOR;

  const payload = attestationPayload({
    proofId,
    draftId: params.draftId,
    action: params.action,
    amount: params.amount,
    currency: params.currency,
    customer: params.customer,
    gateway: params.gateway,
    proposerDid,
    authorizerDid,
    timestamp,
    dataProvenance: params.dataProvenance,
  });

  // Issue #2426: this value is unchanged (a hashToHex-based content
  // label — not a cryptographic digest, let alone a signature), but
  // its proofType now says so. The sync path stays unkeyed by
  // construction: WebCrypto HMAC is async-only, and this module
  // does not hand-roll synchronous crypto. Callers that need a
  // verifiable proof use createDidAttestation with a key.
  const signature = `sig_0x${hashToHex(payload)}${hashToHex(payload + "_salt")}${hashToHex(payload + "_end")}`;

  return {
    proofId,
    proposerDid,
    authorizerDid,
    executorDid,
    gateway: params.gateway,
    action: params.action,
    amount: params.amount,
    currency: params.currency,
    timestamp,
    signature,
    proofType: UNKEYED_CONTENT_LABEL
  };
}

async function computeSha256Hex(message: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(message);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function hashToHex(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(16).padStart(8, "0");
}
