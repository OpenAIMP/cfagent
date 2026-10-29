import { describe, it, expect } from "vitest";
import {
  MAX_SESSION_COOKIE_CANDIDATES,
  getSessionId,
  getSessionIdCandidates,
  getSessionIds,
  isSessionIdFormat,
} from "../src/security/session";

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

  it("tries every session_id cookie and prefers a UUID-shaped value", () => {
    const req = new Request("https://agent.openaimp.com/", {
      headers: { Cookie: `session_id=stale-legacy; session_id=${SESSION_UUID}; theme=dark` },
    });
    expect(getSessionIds(req)).toEqual(["stale-legacy", SESSION_UUID]);
    expect(getSessionId(req)).toBe(SESSION_UUID);
  });

  it("returns the first cookie when no candidate is UUID-shaped", () => {
    const req = new Request("https://agent.openaimp.com/", {
      headers: { Cookie: "session_id=old-one; session_id=old-two" },
    });
    expect(getSessionId(req)).toBe("old-one");
  });

  it("deduplicates repeated values", () => {
    const req = new Request("https://agent.openaimp.com/", {
      headers: { Cookie: `session_id=${SESSION_UUID}; session_id=${SESSION_UUID}` },
    });
    expect(getSessionIds(req)).toEqual([SESSION_UUID]);
  });

  it("hands the auth path only UUID-shaped candidates, in header order and capped", () => {
    const uuids = Array.from({ length: MAX_SESSION_COOKIE_CANDIDATES + 2 }, () => crypto.randomUUID());
    const req = new Request("https://agent.openaimp.com/", {
      headers: { Cookie: `session_id=junk; ${uuids.map((id) => `session_id=${id}`).join("; ")}` },
    });
    expect(getSessionIdCandidates(req)).toEqual(uuids.slice(0, MAX_SESSION_COOKIE_CANDIDATES));
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
