import { describe, expect, it } from "vitest";
import { renderLandingPage } from "../src/landing";
import { renderLoginPage } from "../src/oauth";

describe("pre-login pages", () => {
  it("landing page explains capabilities and links to sign-in", () => {
    const html = renderLandingPage("Test App");
    expect(html).toContain("Quant vs LLM comparison");
    expect(html).toContain("Fast order ticket");
    expect(html).toContain("trading-platform order preview");
    expect(html).toContain("Options strategy screening");
    expect(html).toContain("Signed, audited trade drafts");
    expect(html).toContain('href="/auth/login/github"');
  });

  it("login card is focused strictly on authentication without feature clutter", () => {
    const html = renderLoginPage({} as any);
    expect(html).toContain("Sign in with GitHub");
    expect(html).toContain('href="/auth/login/github"');
    expect(html).not.toContain("trading-platform order preview");
    expect(html).not.toContain("RAG");
    expect(html).not.toContain("Payment");
  });
});
