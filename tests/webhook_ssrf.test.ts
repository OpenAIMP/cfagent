import { describe, it, expect } from "vitest";
import {
  isBlockedWebhookHost,
  assertSafeOutboundWebhookUrl,
} from "../src/security/webhookSecurity";

/**
 * Issue #240 — SSRF guard on outbound webhook dispatch.
 *
 * `dispatchOutboundWebhook` fetches a caller-influenced URL (notably the
 * `targetUrl` on the `dispatch_trading_webhook` MCP tool). These tests pin
 * the blocklist: localhost, private/loopback/link-local IPv4 literals
 * (including decimal/octal/hex obfuscations), IPv6 equivalents, and
 * non-http(s) schemes. Public targets stay allowed.
 */
describe("outbound webhook SSRF guard (#240)", () => {
  describe("isBlockedWebhookHost", () => {
    it.each([
      "localhost",
      "foo.localhost",
      "127.0.0.1",
      "127.1",
      "2130706433", // 127.0.0.1 decimal
      "0x7f000001", // 127.0.0.1 hex
      "0177.0.0.1", // 127.0.0.1 octal parts
      "0x7f.0.0.1",
      "10.0.0.5",
      "10.255.255.255",
      "172.16.0.1",
      "172.31.255.254",
      "192.168.1.1",
      "169.254.169.254", // cloud metadata
      "0.0.0.0",
      "8.8.8.8.evil.example", // not an IP literal, but harmless either way
    ])("blocks %s", (host) => {
      // "8.8.8.8.evil.example" is a DNS name, not a literal — must NOT block
      const expected = host !== "8.8.8.8.evil.example";
      expect(isBlockedWebhookHost(host)).toBe(expected);
    });

    it("blocks decimal/octal/hex forms of 10.x", () => {
      expect(isBlockedWebhookHost("167772165")).toBe(true); // 10.0.0.5
      expect(isBlockedWebhookHost("0xa000005")).toBe(true);
    });

    it("does not block 172.15.x / 172.32.x (outside 172.16/12)", () => {
      expect(isBlockedWebhookHost("172.15.0.1")).toBe(false);
      expect(isBlockedWebhookHost("172.32.0.1")).toBe(false);
    });

    it("blocks IPv6 loopback / private equivalents", () => {
      expect(isBlockedWebhookHost("::1")).toBe(true);
      expect(isBlockedWebhookHost("fc00::1")).toBe(true);
      expect(isBlockedWebhookHost("fd12:3456::1")).toBe(true);
      expect(isBlockedWebhookHost("fe80::1")).toBe(true);
      expect(isBlockedWebhookHost("::ffff:127.0.0.1")).toBe(true);
    });

    it("allows public hosts", () => {
      expect(isBlockedWebhookHost("example.com")).toBe(false);
      expect(isBlockedWebhookHost("hooks.slack.com")).toBe(false);
      expect(isBlockedWebhookHost("93.184.216.34")).toBe(false); // example.com
      expect(isBlockedWebhookHost("2606:4700:4700::1111")).toBe(false); // public v6
    });
  });

  describe("assertSafeOutboundWebhookUrl", () => {
    it("allows a normal https subscriber URL", () => {
      const url = assertSafeOutboundWebhookUrl("https://example.com/hook");
      expect(url.hostname).toBe("example.com");
    });

    it.each([
      "http://127.0.0.1/hook",
      "http://2130706433/hook",
      "http://0x7f000001/hook",
      "http://169.254.169.254/latest/meta-data/",
      "http://10.1.2.3:8080/hook",
      "http://localhost/hook",
      "http://localhost:8080/hook",
      "http://[::1]/hook",
      "http://[::1]:8080/hook",
    ])("throws for %s", (raw) => {
      expect(() => assertSafeOutboundWebhookUrl(raw)).toThrow(/not allowed|invalid/i);
    });

    it("throws for non-http(s) schemes", () => {
      expect(() => assertSafeOutboundWebhookUrl("ftp://example.com/hook")).toThrow(/only http/i);
      expect(() => assertSafeOutboundWebhookUrl("file:///etc/passwd")).toThrow(/only http/i);
    });

    it("throws for garbage input", () => {
      expect(() => assertSafeOutboundWebhookUrl("not a url")).toThrow(/invalid/i);
      expect(() => assertSafeOutboundWebhookUrl("")).toThrow(/invalid/i);
    });

    it("never echoes the URL in the error (may carry secrets)", () => {
      const raw = "http://127.0.0.1/hook?token=supersecret123";
      try {
        assertSafeOutboundWebhookUrl(raw);
        expect.unreachable();
      } catch (err: any) {
        expect(err.message).not.toContain("supersecret123");
        expect(err.message).not.toContain("127.0.0.1");
      }
    });
  });
});
