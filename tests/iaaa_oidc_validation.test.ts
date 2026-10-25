import { describe, it, expect } from "vitest";
import {
  GITHUB_PROVIDER,
  createOidcProviderDescriptor,
  googleOidcProviderDescriptor,
  validateOidcClaims,
} from "../src/security/sessionPolicy";

/**
 * Issue #945, Slice 2 — login/session hardening, OIDC claim validation.
 *
 * What this file does NOT claim: cryptographic signature verification.
 * These checks run on claims a caller has already obtained from a
 * provider assertion; signature/JWKS verification is a later wiring
 * step (see the module header). A token that passes here is not yet
 * proven authentic — only that its issuer, audience, subject, and
 * expiry are the ones expected.
 *
 * Identity remains (issuer, subject) per Slice 1. Email and display
 * login are deliberately NOT inputs here, and passing these checks
 * does not establish legal identity.
 */

const NOW_S = 1_800_000_000; // seconds since epoch, test seam
const NOW_MS = NOW_S * 1000;
const GOOGLE = googleOidcProviderDescriptor("test-client-id");

function validClaims() {
  return {
    iss: "https://accounts.google.com",
    aud: "test-client-id",
    sub: "google-subject-123",
    exp: NOW_S + 3600,
  };
}

describe("iaaa oidc validation (#945 slice 2)", () => {
  it("accepts a valid token for the expected issuer, audience, subject, and expiry", () => {
    const result = validateOidcClaims(GOOGLE, validClaims(), NOW_MS);
    expect(result.ok).toBe(true);
  });

  it("accepts an audience list that contains the expected audience", () => {
    const result = validateOidcClaims(
      GOOGLE,
      { ...validClaims(), aud: ["other-client", "test-client-id"] },
      NOW_MS
    );
    expect(result.ok).toBe(true);
  });

  it("rejects a wrong issuer", () => {
    const result = validateOidcClaims(
      GOOGLE,
      { ...validClaims(), iss: "https://evil.example" },
      NOW_MS
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("WRONG_ISSUER");
  });

  it("rejects a missing issuer", () => {
    const result = validateOidcClaims(GOOGLE, { ...validClaims(), iss: "" }, NOW_MS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("WRONG_ISSUER");
  });

  it("rejects a wrong audience", () => {
    const result = validateOidcClaims(
      GOOGLE,
      { ...validClaims(), aud: "someone-elses-client-id" },
      NOW_MS
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("WRONG_AUDIENCE");
  });

  it("rejects an audience list that does not contain the expected audience", () => {
    const result = validateOidcClaims(
      GOOGLE,
      { ...validClaims(), aud: ["a", "b"] },
      NOW_MS
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("WRONG_AUDIENCE");
  });

  it("rejects an expired token", () => {
    const result = validateOidcClaims(
      GOOGLE,
      { ...validClaims(), exp: NOW_S - 1 },
      NOW_MS
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("TOKEN_EXPIRED");
  });

  it("rejects a token expiring exactly at now (expiry is exclusive)", () => {
    const result = validateOidcClaims(
      GOOGLE,
      { ...validClaims(), exp: NOW_S },
      NOW_MS
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("TOKEN_EXPIRED");
  });

  it("rejects a token with no expiry", () => {
    const { exp: _exp, ...noExp } = validClaims();
    const result = validateOidcClaims(GOOGLE, noExp, NOW_MS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("MISSING_EXPIRY");
  });

  it("rejects a missing or empty subject", () => {
    for (const sub of ["", "   ", undefined]) {
      const result = validateOidcClaims(
        GOOGLE,
        { ...validClaims(), sub },
        NOW_MS
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("INVALID_SUBJECT");
    }
  });

  it("does not apply OIDC claim validation to the non-OIDC GitHub OAuth2 provider", () => {
    const result = validateOidcClaims(GITHUB_PROVIDER, validClaims(), NOW_MS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("NOT_OIDC_PROVIDER");
  });

  it("rejects an OIDC descriptor with an empty audience", () => {
    const descriptor = createOidcProviderDescriptor({
      providerId: "example",
      issuer: "https://example.example",
      audience: "   ",
    });
    expect(descriptor.ok).toBe(false);
    if (!descriptor.ok) expect(descriptor.code).toBe("INVALID_AUDIENCE");
  });

  it("creates a valid generic OIDC descriptor usable for a future provider", () => {
    const descriptor = createOidcProviderDescriptor({
      providerId: "auth0-example",
      issuer: "https://example.auth0.com/",
      audience: "client-123",
    });
    expect(descriptor.ok).toBe(true);
    if (descriptor.ok) {
      expect(descriptor.provider.protocol).toBe("oidc");
      expect(descriptor.provider.issuer).toBe("https://example.auth0.com/");
    }
  });
});
