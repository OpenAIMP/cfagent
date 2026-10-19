import { describe, it, expect } from "vitest";
import { getSessionId, isSessionIdFormat } from "../src/security/session";

/**
 * Issue #329: `requireAuth` used to hand any `session_id` cookie value straight
 * to the session cache, which meant a junk value cost a KV `get()` (the
 * negative cache only bounded it to one per value per 10s). `createSession`
 * mints `crypto.randomUUID()`, so anything that isn't a UUID cannot name a
 * session and is now rejected before the read.
 */
const SESSION_UUID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

describe("session id shape gate (#329)", () => {
  it("accepts UUIDs, including freshly created ones", () => {
    expect(isSessionIdFormat(SESSION_UUID)).toBe(true);
    expect(isSessionIdFormat(crypto.randomUUID())).toBe(true);
    expect(isSessionIdFormat(SESSION_UUID.toUpperCase())).toBe(true);
  });

  it.each([
    "",
    " ",
    "abc",
    "test-session-329",
    "3f2504e0-4f89-41d3-9a0c-0305e82c330", // one nibble short
    `${SESSION_UUID}x`,
    ` ${SESSION_UUID}`,
    "../../etc/passwd",
    "' OR 1=1 --",
    "null",
    "undefined",
  ])("rejects %j", (value) => {
    expect(isSessionIdFormat(value)).toBe(false);
  });

  it("rejects a missing cookie", () => {
    expect(isSessionIdFormat(null)).toBe(false);
    expect(isSessionIdFormat(undefined)).toBe(false);
  });

  it("gates exactly the value the Worker reads from the cookie", () => {
    const junk = new Request("https://agent.openaimp.com/api/nlq", {
      headers: { Cookie: "session_id=not-a-uuid" },
    });
    const real = new Request("https://agent.openaimp.com/api/nlq", {
      headers: { Cookie: `theme=dark; session_id=${SESSION_UUID}` },
    });

    expect(isSessionIdFormat(getSessionId(junk))).toBe(false);
    expect(isSessionIdFormat(getSessionId(real))).toBe(true);
  });
});
