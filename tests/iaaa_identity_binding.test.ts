import { describe, it, expect } from "vitest";
import {
  createMemoryIdentityBindingStore,
  getInternalUserId,
  linkProviderToUser,
  resolveOrCreateBinding,
} from "../src/security/identityBinding";

/**
 * Issue #945, Slice 1 — stable internal identities + provider binding.
 *
 * The IAAA rule under test: an identity is (validated issuer, provider
 * subject) bound to a stable internal user ID. Email and display login
 * are deliberately NOT parameters of any function here, so an email
 * change cannot create a new identity or transfer another user's account.
 * Unproven linking is rejected and must not leave a binding behind.
 */

const GITHUB = "https://github.com";
const GOOGLE = "https://accounts.google.com";

describe("iaaa identity binding (#945 slice 1)", () => {
  it("resolves the same issuer+subject to the same internal user id", async () => {
    const store = createMemoryIdentityBindingStore();
    const first = await resolveOrCreateBinding(store, {
      providerIssuer: GITHUB,
      providerSubject: "12345",
      proofVerified: true,
    });
    const second = await resolveOrCreateBinding(store, {
      providerIssuer: GITHUB,
      providerSubject: "12345",
      proofVerified: true,
    });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(second.binding.internalUserId).toBe(first.binding.internalUserId);
      expect(second.binding.providerIssuer).toBe(GITHUB);
      expect(second.binding.providerSubject).toBe("12345");
    }
  });

  it("treats issuer as part of the identity: same subject, different issuer, different user", async () => {
    const store = createMemoryIdentityBindingStore();
    const a = await resolveOrCreateBinding(store, {
      providerIssuer: GITHUB,
      providerSubject: "12345",
      proofVerified: true,
    });
    const b = await resolveOrCreateBinding(store, {
      providerIssuer: GOOGLE,
      providerSubject: "12345",
      proofVerified: true,
    });
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(b.binding.internalUserId).not.toBe(a.binding.internalUserId);
    }
  });

  it("treats subject as part of the identity: same issuer, different subject, different user", async () => {
    const store = createMemoryIdentityBindingStore();
    const a = await resolveOrCreateBinding(store, {
      providerIssuer: GITHUB,
      providerSubject: "111",
      proofVerified: true,
    });
    const b = await resolveOrCreateBinding(store, {
      providerIssuer: GITHUB,
      providerSubject: "222",
      proofVerified: true,
    });
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(b.binding.internalUserId).not.toBe(a.binding.internalUserId);
    }
  });

  it("rejects unproven linking and leaves no binding behind", async () => {
    const store = createMemoryIdentityBindingStore();
    const rejected = await resolveOrCreateBinding(store, {
      providerIssuer: GITHUB,
      providerSubject: "999",
      proofVerified: false,
    });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.code).toBe("UNPROVEN_LINK");
    expect(await getInternalUserId(store, GITHUB, "999")).toBeNull();

    // A later proven attempt still works: the rejected attempt polluted nothing.
    const proven = await resolveOrCreateBinding(store, {
      providerIssuer: GITHUB,
      providerSubject: "999",
      proofVerified: true,
    });
    expect(proven.ok).toBe(true);
  });

  it("rejects linking a provider identity already bound to another user", async () => {
    const store = createMemoryIdentityBindingStore();
    const first = await resolveOrCreateBinding(store, {
      providerIssuer: GITHUB,
      providerSubject: "12345",
      proofVerified: true,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const clash = await linkProviderToUser(store, {
      internalUserId: "some-other-user-id",
      providerIssuer: GITHUB,
      providerSubject: "12345",
      proofVerified: true,
    });
    expect(clash.ok).toBe(false);
    if (!clash.ok) expect(clash.code).toBe("PROVIDER_ALREADY_BOUND");
    expect(await getInternalUserId(store, GITHUB, "12345")).toBe(
      first.binding.internalUserId
    );
  });

  it("rejects a second subject for the same user on the same issuer", async () => {
    const store = createMemoryIdentityBindingStore();
    const first = await resolveOrCreateBinding(store, {
      providerIssuer: GITHUB,
      providerSubject: "111",
      proofVerified: true,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = await linkProviderToUser(store, {
      internalUserId: first.binding.internalUserId,
      providerIssuer: GITHUB,
      providerSubject: "222",
      proofVerified: true,
    });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.code).toBe("USER_ALREADY_LINKED_TO_ISSUER");
  });

  it("linking the same provider identity to the same user is idempotent", async () => {
    const store = createMemoryIdentityBindingStore();
    const first = await resolveOrCreateBinding(store, {
      providerIssuer: GITHUB,
      providerSubject: "111",
      proofVerified: true,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const again = await linkProviderToUser(store, {
      internalUserId: first.binding.internalUserId,
      providerIssuer: GITHUB,
      providerSubject: "111",
      proofVerified: true,
    });
    expect(again.ok).toBe(true);
    if (again.ok) {
      expect(again.binding.internalUserId).toBe(first.binding.internalUserId);
    }
  });

  it("allows one user to link a second, different provider", async () => {
    const store = createMemoryIdentityBindingStore();
    const first = await resolveOrCreateBinding(store, {
      providerIssuer: GITHUB,
      providerSubject: "111",
      proofVerified: true,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const linked = await linkProviderToUser(store, {
      internalUserId: first.binding.internalUserId,
      providerIssuer: GOOGLE,
      providerSubject: "google-abc",
      proofVerified: true,
    });
    expect(linked.ok).toBe(true);
    expect(await getInternalUserId(store, GOOGLE, "google-abc")).toBe(
      first.binding.internalUserId
    );
  });

  it.each([
    ["", "123"],
    ["   ", "123"],
    [GITHUB, ""],
    [GITHUB, "   "],
    [GITHUB, "x".repeat(513)],
    ["x".repeat(513), "123"],
  ])("rejects invalid issuer/subject %j / %j", async (issuer, subject) => {
    const store = createMemoryIdentityBindingStore();
    const result = await resolveOrCreateBinding(store, {
      providerIssuer: issuer,
      providerSubject: subject,
      proofVerified: true,
    });
    expect(result.ok).toBe(false);
  });

  it("rejects unproven explicit linking", async () => {
    const store = createMemoryIdentityBindingStore();
    const result = await linkProviderToUser(store, {
      internalUserId: "user-1",
      providerIssuer: GITHUB,
      providerSubject: "111",
      proofVerified: false,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("UNPROVEN_LINK");
    expect(await getInternalUserId(store, GITHUB, "111")).toBeNull();
  });
});
