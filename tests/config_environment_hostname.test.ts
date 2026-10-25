import { describe, it, expect } from "vitest";
import {
  resolveETradeBaseUrl,
  resolveEnvironmentConfig,
  urlHostname,
  isETradeHost,
} from "../src/config/environment";

/**
 * CodeQL js/incomplete-url-substring-sanitization (#843–#847):
 * E*TRADE endpoint checks used substring matching (`includes` /
 * `startsWith`) instead of exact hostname comparison — bypassable via
 * lookalike hosts (api.etrade.com.evil.com) or userinfo tricks
 * (apisb.etrade.com@api.etrade.com, whose real host is api.etrade.com).
 * All checks now parse the URL and compare the hostname exactly.
 */

describe("urlHostname / isETradeHost — exact hostname checks (#843-#847)", () => {
  it("returns the lower-cased hostname", () => {
    expect(urlHostname("https://API.ETRADE.COM/v1")).toBe("api.etrade.com");
  });

  it("excludes the port from the hostname", () => {
    expect(urlHostname("https://api.etrade.com:443/v1")).toBe("api.etrade.com");
  });

  it("returns empty string for unparseable input", () => {
    expect(urlHostname("not a url")).toBe("");
    expect(urlHostname("")).toBe("");
  });

  it("matches the exact host", () => {
    expect(isETradeHost("https://api.etrade.com/v1", "api.etrade.com")).toBe(true);
    expect(isETradeHost("https://apisb.etrade.com/v1", "apisb.etrade.com")).toBe(true);
  });

  it("rejects lookalike hosts", () => {
    expect(isETradeHost("https://api.etrade.com.evil.com/v1", "api.etrade.com")).toBe(false);
    expect(isETradeHost("https://evil-apisb.etrade.com/v1", "apisb.etrade.com")).toBe(false);
  });

  it("rejects query-string smuggling", () => {
    expect(isETradeHost("https://evil.com/?x=apisb.etrade.com", "apisb.etrade.com")).toBe(false);
  });

  it("sees through the userinfo trick to the real host", () => {
    // The real host here is api.etrade.com (apisb.etrade.com is userinfo) —
    // the old substring check misread this as the sandbox host.
    expect(isETradeHost("https://apisb.etrade.com@api.etrade.com/v1", "api.etrade.com")).toBe(true);
    expect(isETradeHost("https://apisb.etrade.com@api.etrade.com/v1", "apisb.etrade.com")).toBe(false);
  });
});

describe("resolveETradeBaseUrl — unparseable-input host check (#847)", () => {
  it("keeps existing behavior for valid URLs", () => {
    expect(resolveETradeBaseUrl("https://apisb.etrade.com")).toBe("https://apisb.etrade.com/v1");
    expect(resolveETradeBaseUrl("https://api.etrade.com/v1/accounts/list")).toBe(
      "https://api.etrade.com/v1",
    );
    expect(resolveETradeBaseUrl("")).toBe("https://apisb.etrade.com/v1");
  });

  it("still honors a bare live hostname", () => {
    expect(resolveETradeBaseUrl("api.etrade.com")).toBe("https://api.etrade.com/v1");
    expect(resolveETradeBaseUrl("API.ETRADE.COM/v1")).toBe("https://api.etrade.com/v1");
  });

  it("does not resolve lookalikes or smuggled substrings to live (#847)", () => {
    expect(resolveETradeBaseUrl("evil.com/?x=api.etrade.com")).toBe("https://apisb.etrade.com/v1");
    expect(resolveETradeBaseUrl("api.etrade.com.evil.com")).toBe("https://apisb.etrade.com/v1");
    expect(resolveETradeBaseUrl("api.etrade.com@evil.com")).toBe("https://apisb.etrade.com/v1");
  });
});

describe("resolveEnvironmentConfig — ET_BASE_URL gating (#845, #846)", () => {
  it("rejects a deceptive sandbox-lookalike URL in TEST mode", () => {
    const cfg = resolveEnvironmentConfig({
      ETRADE_ENVIRONMENT: "sandbox",
      ET_BASE_URL: "https://evil.com/?x=apisb.etrade.com",
    });
    // Old code accepted the attacker host via substring match.
    expect(cfg.etrade.baseUrl).toBe("https://apisb.etrade.com/v1");
    expect(cfg.isLive).toBe(false);
  });

  it("still accepts the genuine sandbox host in TEST mode", () => {
    const cfg = resolveEnvironmentConfig({
      ETRADE_ENVIRONMENT: "sandbox",
      ET_BASE_URL: "https://apisb.etrade.com",
    });
    expect(cfg.etrade.baseUrl).toBe("https://apisb.etrade.com/v1");
  });

  it("keeps isLive derivation for the standard environments (#843, #844)", () => {
    expect(resolveEnvironmentConfig({ ETRADE_ENVIRONMENT: "live" }).isLive).toBe(true);
    expect(resolveEnvironmentConfig({ ETRADE_ENVIRONMENT: "sandbox" }).isLive).toBe(false);
  });
});
