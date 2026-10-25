/**
 * Issue #1262 Phase 5 — signed approval links (#149 pattern).
 *
 * A bare email APPROVE no longer executes: execution requires a signed
 * approval link (HMAC-SHA256 over the link claims + expiry), issued only
 * to a trade-tier mapped principal and re-checked against the principal
 * map at use time (unmapping revokes outstanding links). The token is
 * bound to one order id and one login; the link click and the quoted
 * reply path verify the same token.
 */
import { describe, it, expect } from "vitest";

import {
  approvalLinkSecret,
  extractApprovalTokenFromText,
  issueApprovalLink,
  verifyApprovalLink,
  verifyApprovalLinkForPrincipal,
} from "../src/trading/channels/signedLinks";
import type { ChannelPrincipal } from "../src/trading/channels/intake";

const env = {
  CHANNEL_APPROVAL_LINK_SECRET: "test-link-secret",
  CHANNEL_EMAIL_PRINCIPALS: JSON.stringify({
    "boss@example.com": { login: "boss-login", tier: "trade" },
    "reader@example.com": { login: "reader-login", tier: "read" },
  }),
} as any;

const tradePrincipal: ChannelPrincipal = {
  userLogin: "boss-login",
  authorizerDid: "did:user:email:boss@example.com",
  tier: "trade",
};

describe("issueApprovalLink / verifyApprovalLink", () => {
  it("round-trips: issued links verify with their order id, login, and address", async () => {
    const issued = await issueApprovalLink(env, {
      orderId: "ord_1",
      login: "boss-login",
      address: "boss@example.com",
      baseUrl: "https://agent.openaimp.com",
    });
    expect(issued).not.toBeNull();
    expect(issued!.url).toContain("/api/trading/email/approve?token=");
    const verified = await verifyApprovalLink(env, issued!.token);
    expect(verified).toMatchObject({
      ok: true,
      claims: { orderId: "ord_1", login: "boss-login", address: "boss@example.com" },
    });
  });

  it("rejects tampered tokens, tokens from another secret, and malformed tokens", async () => {
    const issued = (await issueApprovalLink(env, {
      orderId: "ord_1",
      login: "boss-login",
      address: "boss@example.com",
      baseUrl: "https://agent.openaimp.com",
    }))!;
    const [payload, sig] = issued.token.split(".");
    const tampered = `${payload}.${"0".repeat(sig.length)}`;
    expect(await verifyApprovalLink(env, tampered)).toMatchObject({ ok: false });
    const otherSecret = { ...env, CHANNEL_APPROVAL_LINK_SECRET: "different-secret" };
    expect(await verifyApprovalLink(otherSecret, issued.token)).toMatchObject({ ok: false });
    expect(await verifyApprovalLink(env, "not-a-token")).toMatchObject({ ok: false });
    expect(await verifyApprovalLink(env, "")).toMatchObject({ ok: false });
  });

  it("rejects expired links", async () => {
    const issued = (await issueApprovalLink(env, {
      orderId: "ord_1",
      login: "boss-login",
      address: "boss@example.com",
      baseUrl: "https://agent.openaimp.com",
      ttlMs: -1000,
    }))!;
    expect(await verifyApprovalLink(env, issued.token)).toMatchObject({ ok: false });
  });

  it("without a configured secret, issuance returns null and verification fails closed", async () => {
    const bare = {} as any;
    expect(await issueApprovalLink(bare, {
      orderId: "ord_1",
      login: "boss-login",
      address: "boss@example.com",
      baseUrl: "https://agent.openaimp.com",
    })).toBeNull();
    expect(approvalLinkSecret(bare)).toBeNull();
    expect(await verifyApprovalLink(bare, "abc.def")).toMatchObject({ ok: false });
  });

  it("falls back to SESSION_SECRET when no dedicated link secret is set", async () => {
    const sessionOnly = { SESSION_SECRET: "session-secret", CHANNEL_EMAIL_PRINCIPALS: env.CHANNEL_EMAIL_PRINCIPALS } as any;
    expect(approvalLinkSecret(sessionOnly)).toBe("session-secret");
    const issued = (await issueApprovalLink(sessionOnly, {
      orderId: "ord_1",
      login: "boss-login",
      address: "boss@example.com",
      baseUrl: "https://agent.openaimp.com",
    }))!;
    expect(await verifyApprovalLink(sessionOnly, issued.token)).toMatchObject({ ok: true });
  });
});

describe("verifyApprovalLinkForPrincipal", () => {
  it("accepts a token whose login matches the principal and whose address is still mapped at trade tier", async () => {
    const issued = (await issueApprovalLink(env, {
      orderId: "ord_1",
      login: "boss-login",
      address: "boss@example.com",
      baseUrl: "https://agent.openaimp.com",
    }))!;
    const result = await verifyApprovalLinkForPrincipal(env, issued.token, tradePrincipal);
    expect(result).toMatchObject({ ok: true, claims: { orderId: "ord_1" } });
  });

  it("rejects a token bound to a different login than the message principal", async () => {
    const issued = (await issueApprovalLink(env, {
      orderId: "ord_1",
      login: "boss-login",
      address: "boss@example.com",
      baseUrl: "https://agent.openaimp.com",
    }))!;
    const other: ChannelPrincipal = {
      userLogin: "reader-login",
      authorizerDid: "did:user:email:reader@example.com",
      tier: "trade",
    };
    expect(await verifyApprovalLinkForPrincipal(env, issued.token, other)).toMatchObject({ ok: false });
  });

  it("rejects when the address is unmapped or downgraded below trade tier (revocation by unmapping)", async () => {
    const issued = (await issueApprovalLink(env, {
      orderId: "ord_1",
      login: "boss-login",
      address: "boss@example.com",
      baseUrl: "https://agent.openaimp.com",
    }))!;
    const unmapped = { ...env, CHANNEL_EMAIL_PRINCIPALS: "{}" };
    expect(await verifyApprovalLinkForPrincipal(unmapped, issued.token, tradePrincipal)).toMatchObject({
      ok: false,
    });
    const downgraded = {
      ...env,
      CHANNEL_EMAIL_PRINCIPALS: JSON.stringify({
        "boss@example.com": { login: "boss-login", tier: "read" },
      }),
    };
    expect(await verifyApprovalLinkForPrincipal(downgraded, issued.token, tradePrincipal)).toMatchObject({
      ok: false,
    });
  });

  it("accepts token-only verification (link-click path, no message principal) when the map still holds", async () => {
    const issued = (await issueApprovalLink(env, {
      orderId: "ord_1",
      login: "boss-login",
      address: "boss@example.com",
      baseUrl: "https://agent.openaimp.com",
    }))!;
    expect(await verifyApprovalLinkForPrincipal(env, issued.token, undefined)).toMatchObject({ ok: true });
  });
});

describe("extractApprovalTokenFromText", () => {
  it("extracts the token from a plain approval URL without swallowing the following word", async () => {
    const issued = (await issueApprovalLink(env, {
      orderId: "ord_1",
      login: "boss-login",
      address: "boss@example.com",
      baseUrl: "https://agent.openaimp.com",
    }))!;
    expect(
      extractApprovalTokenFromText(`Approve here: ${issued.url} thanks`)
    ).toBe(issued.token);
  });

  it("extracts the token from a quoted reply whose URL was line-wrapped", async () => {
    const issued = (await issueApprovalLink(env, {
      orderId: "ord_1",
      login: "boss-login",
      address: "boss@example.com",
      baseUrl: "https://agent.openaimp.com",
    }))!;
    const mid = Math.floor(issued.token.length / 2);
    const wrapped =
      `On Mon, someone wrote:\n> Approve here: https://agent.openaimp.com/api/trading/email/approve?token=${issued.token.slice(0, mid)}\n> ${issued.token.slice(mid)}\n> Thanks`;
    expect(extractApprovalTokenFromText(wrapped)).toBe(issued.token);
  });

  it("returns null when no approval URL is present", () => {
    expect(extractApprovalTokenFromText("APPROVE ord_1")).toBeNull();
    expect(extractApprovalTokenFromText("")).toBeNull();
  });
});
