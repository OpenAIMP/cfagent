/**
 * Issue #945, Slice 1 — stable internal identities + provider binding.
 *
 * Pure identity-binding logic, no provider wiring, no storage backend
 * beyond the `IdentityBindingStore` interface (callers plug in a Durable
 * Object / KV store in a later slice; tests use the in-memory store).
 *
 * The IAAA rule enforced here:
 * - An identity is (validated provider issuer, provider subject) bound
 *   to a stable internal user ID.
 * - Email and display login are NOT inputs to any function in this
 *   module. There is therefore no code path by which an email change
 *   can create a new identity or transfer another user's account.
 * - Linking requires proven control (`proofVerified: true`, i.e. the
 *   caller has already validated the provider assertion). Unproven
 *   linking is rejected and writes nothing.
 * - One provider identity binds to at most one internal user, and one
 *   internal user has at most one binding per issuer. A second provider
 *   (different issuer) may still be linked to the same user.
 *
 * Normalization is deliberately conservative: issuer and subject are
 * trimmed of surrounding whitespace and otherwise compared exactly.
 * No case folding, no URL canonicalization — folding could merge two
 * distinct provider identities. Callers that need issuer-URL
 * normalization must do it before calling, and document it.
 */

export interface IdentityBinding {
  internalUserId: string;
  providerIssuer: string;
  providerSubject: string;
  linkedAt: number;
  /** Only "oidc" is produced by this slice: a validated provider assertion. */
  proofOfControl: "oidc";
}

export interface IdentityBindingStore {
  getByProvider(
    providerIssuer: string,
    providerSubject: string
  ): Promise<IdentityBinding | null>;
  getByUserAndIssuer(
    internalUserId: string,
    providerIssuer: string
  ): Promise<IdentityBinding | null>;
  put(binding: IdentityBinding): Promise<void>;
}

export type IdentityBindingErrorCode =
  | "INVALID_ISSUER"
  | "INVALID_SUBJECT"
  | "INVALID_USER_ID"
  | "UNPROVEN_LINK"
  | "PROVIDER_ALREADY_BOUND"
  | "USER_ALREADY_LINKED_TO_ISSUER";

export type IdentityBindingResult =
  | { ok: true; binding: IdentityBinding }
  | { ok: false; code: IdentityBindingErrorCode; error: string };

const MAX_FIELD_LENGTH = 512;

function isValidField(value: string): boolean {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.trim().length <= MAX_FIELD_LENGTH
  );
}

function normalize(value: string): string {
  return value.trim();
}

/** In-memory store for tests and for callers that have not wired a backend yet. */
export function createMemoryIdentityBindingStore(): IdentityBindingStore {
  const byProvider = new Map<string, IdentityBinding>();
  const byUserIssuer = new Map<string, IdentityBinding>();

  return {
    async getByProvider(providerIssuer, providerSubject) {
      return (
        byProvider.get(`${normalize(providerIssuer)}\0${normalize(providerSubject)}`) ??
        null
      );
    },
    async getByUserAndIssuer(internalUserId, providerIssuer) {
      return (
        byUserIssuer.get(`${internalUserId}\0${normalize(providerIssuer)}`) ?? null
      );
    },
    async put(binding) {
      byProvider.set(
        `${binding.providerIssuer}\0${binding.providerSubject}`,
        binding
      );
      byUserIssuer.set(
        `${binding.internalUserId}\0${binding.providerIssuer}`,
        binding
      );
    },
  };
}

export async function getInternalUserId(
  store: IdentityBindingStore,
  providerIssuer: string,
  providerSubject: string
): Promise<string | null> {
  if (!isValidField(providerIssuer) || !isValidField(providerSubject)) {
    return null;
  }
  const binding = await store.getByProvider(
    normalize(providerIssuer),
    normalize(providerSubject)
  );
  return binding ? binding.internalUserId : null;
}

export interface ResolveBindingInput {
  providerIssuer: string;
  providerSubject: string;
  /** True only when the caller has validated the provider assertion. */
  proofVerified: boolean;
  /** Test seam; defaults to Date.now(). */
  nowMs?: number;
}

/**
 * Resolve an existing binding, or create a new internal user and bind
 * this provider identity to it. Returns the existing binding unchanged
 * when one already exists — it never reassigns a provider identity.
 */
export async function resolveOrCreateBinding(
  store: IdentityBindingStore,
  input: ResolveBindingInput
): Promise<IdentityBindingResult> {
  if (!isValidField(input.providerIssuer)) {
    return { ok: false, code: "INVALID_ISSUER", error: "providerIssuer must be a non-empty string of at most 512 characters" };
  }
  if (!isValidField(input.providerSubject)) {
    return { ok: false, code: "INVALID_SUBJECT", error: "providerSubject must be a non-empty string of at most 512 characters" };
  }
  const issuer = normalize(input.providerIssuer);
  const subject = normalize(input.providerSubject);

  const existing = await store.getByProvider(issuer, subject);
  if (existing) return { ok: true, binding: existing };

  if (!input.proofVerified) {
    return { ok: false, code: "UNPROVEN_LINK", error: "provider linking requires a validated provider assertion" };
  }

  const binding: IdentityBinding = {
    internalUserId: crypto.randomUUID(),
    providerIssuer: issuer,
    providerSubject: subject,
    linkedAt: input.nowMs ?? Date.now(),
    proofOfControl: "oidc",
  };
  await store.put(binding);
  return { ok: true, binding };
}

export interface LinkProviderInput {
  internalUserId: string;
  providerIssuer: string;
  providerSubject: string;
  /** True only when the caller has validated the provider assertion. */
  proofVerified: boolean;
  /** Test seam; defaults to Date.now(). */
  nowMs?: number;
}

/**
 * Link a provider identity to an already-known internal user.
 * Idempotent for the exact same (user, issuer, subject) triple.
 */
export async function linkProviderToUser(
  store: IdentityBindingStore,
  input: LinkProviderInput
): Promise<IdentityBindingResult> {
  if (!isValidField(input.internalUserId)) {
    return { ok: false, code: "INVALID_USER_ID", error: "internalUserId must be a non-empty string of at most 512 characters" };
  }
  if (!isValidField(input.providerIssuer)) {
    return { ok: false, code: "INVALID_ISSUER", error: "providerIssuer must be a non-empty string of at most 512 characters" };
  }
  if (!isValidField(input.providerSubject)) {
    return { ok: false, code: "INVALID_SUBJECT", error: "providerSubject must be a non-empty string of at most 512 characters" };
  }
  const userId = input.internalUserId.trim();
  const issuer = normalize(input.providerIssuer);
  const subject = normalize(input.providerSubject);

  const byProvider = await store.getByProvider(issuer, subject);
  if (byProvider) {
    if (byProvider.internalUserId === userId) {
      return { ok: true, binding: byProvider };
    }
    return {
      ok: false,
      code: "PROVIDER_ALREADY_BOUND",
      error: "this provider identity is already bound to a different internal user",
    };
  }

  const byUserIssuer = await store.getByUserAndIssuer(userId, issuer);
  if (byUserIssuer) {
    return {
      ok: false,
      code: "USER_ALREADY_LINKED_TO_ISSUER",
      error: "this internal user already has a different binding for this issuer",
    };
  }

  if (!input.proofVerified) {
    return { ok: false, code: "UNPROVEN_LINK", error: "provider linking requires a validated provider assertion" };
  }

  const binding: IdentityBinding = {
    internalUserId: userId,
    providerIssuer: issuer,
    providerSubject: subject,
    linkedAt: input.nowMs ?? Date.now(),
    proofOfControl: "oidc",
  };
  await store.put(binding);
  return { ok: true, binding };
}
