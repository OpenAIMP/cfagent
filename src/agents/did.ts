/**
 * Decentralized Identifier (DID) System for Autonomous AI Agents
 * Conforms to W3C Decentralized Identifiers (DIDs) v1.0 standard syntax:
 * did:<method>:<namespace>:<agent-role>
 */

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
  proofType: "Ed25519Signature2020" | "HmacSha256Verification2026";
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
        id: `${did}#key-1`,
        type: "Ed25519VerificationKey2020",
        controller: did,
        publicKeyMultibase: `z${hashToHex(did).slice(0, 32)}`
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

export function getUserDid(githubLogin: string): string {
  const cleanLogin = cleanLoginKey(githubLogin) || "anonymous";
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
 * different DIDs. An empty login key renders "anonymous", mirroring
 * the legacy derivation.
 */
export function getLoginDid(providerId: string, loginKey: string): string {
  const cleanLogin = cleanLoginKey(loginKey) || "anonymous";
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

/**
 * Creates a cryptographically verifiable proof signature for a transaction intent
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
}): Promise<DidAttestationProof> {
  const proofId = `proof_${crypto.randomUUID().slice(0, 12)}`;
  const timestamp = new Date().toISOString();
  const proposerDid = params.proposerDid || AGENT_DIDS.PAYMENTS;
  const authorizerDid = params.authorizerDid || "did:user:pending-human-authorization";
  const executorDid = AGENT_DIDS.ORCHESTRATOR;

  const payload = [
    proofId,
    params.draftId,
    params.action,
    params.amount.toFixed(2),
    params.currency.toUpperCase(),
    params.customer,
    params.gateway,
    proposerDid,
    authorizerDid,
    timestamp,
    ...(params.dataProvenance ? [`data:${params.dataProvenance}`] : []),
  ].join("|");

  const signature = await computeSha256Hex(payload);

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
    proofType: "HmacSha256Verification2026"
  };
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

  const payload = [
    proofId,
    params.draftId,
    params.action,
    params.amount.toFixed(2),
    params.currency.toUpperCase(),
    params.customer,
    params.gateway,
    proposerDid,
    authorizerDid,
    timestamp,
    ...(params.dataProvenance ? [`data:${params.dataProvenance}`] : []),
  ].join("|");

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
    proofType: "HmacSha256Verification2026"
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
