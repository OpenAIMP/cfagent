/**
 * #1250 — live transport for platform publishing.
 *
 * Pinned here:
 * - the transport is one POST over injected fetch, returning the
 *   status and the parsed body; it never rewrites the publisher defs
 *   (endpoints, headers, payloads all come from publisher.ts);
 * - a network rejection propagates (the publisher's never-throws
 *   mapping turns it into an error result, never a silent fallback);
 * - non-2xx responses surface as error results through the same
 *   mapping — a failed live gate is an error entry, never a dry run;
 * - missing token / missing account id never reach fetch at all;
 * - no real network, no real token: stubbed fetch, placeholder token.
 */
import { describe, it, expect, vi } from "vitest";
import { createFetchSocialTransport } from "../src/agents/social/liveTransport";
import {
  CHANNEL_PUBLISHERS,
  publishWithPublisher,
} from "../src/agents/social/publisher";

const PLACEHOLDER_TOKEN = "test-placeholder-token";

type FetchStub = ReturnType<typeof vi.fn>;

function jsonResponse(status: number, body: unknown): { status: number; text: () => Promise<string> } {
  return { status, text: async () => JSON.stringify(body) };
}

describe("createFetchSocialTransport", () => {
  it("posts once with the given url, headers, and body, and returns status + parsed body", async () => {
    const fetchStub: FetchStub = vi.fn(async () => jsonResponse(201, { id: "abc" }));
    const transport = createFetchSocialTransport(fetchStub as never);
    const result = await transport.post(
      "https://example.invalid/post",
      { Authorization: "Bearer test-placeholder-token", "Content-Type": "application/json" },
      '{"text":"hi"}',
    );
    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(fetchStub).toHaveBeenCalledWith("https://example.invalid/post", {
      method: "POST",
      headers: { Authorization: "Bearer test-placeholder-token", "Content-Type": "application/json" },
      body: '{"text":"hi"}',
    });
    expect(result).toEqual({ status: 201, body: { id: "abc" } });
  });

  it("returns non-JSON bodies as text", async () => {
    const fetchStub: FetchStub = vi.fn(async () => ({ status: 200, text: async () => "ok" }));
    const transport = createFetchSocialTransport(fetchStub as never);
    await expect(
      transport.post("https://example.invalid/post", {}, "x"),
    ).resolves.toEqual({ status: 200, body: "ok" });
  });

  it("returns null for an empty body", async () => {
    const fetchStub: FetchStub = vi.fn(async () => ({ status: 204, text: async () => "" }));
    const transport = createFetchSocialTransport(fetchStub as never);
    await expect(
      transport.post("https://example.invalid/post", {}, "x"),
    ).resolves.toEqual({ status: 204, body: null });
  });

  it("lets a network rejection propagate for the publisher to map", async () => {
    const fetchStub: FetchStub = vi.fn(async () => {
      throw new Error("network down");
    });
    const transport = createFetchSocialTransport(fetchStub as never);
    await expect(transport.post("https://example.invalid/post", {}, "x")).rejects.toThrow(
      "network down",
    );
  });
});

describe("live transport through publishWithPublisher", () => {
  it("runs the Threads two-step sequence with publisher headers and payloads", async () => {
    const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
    const fetchStub: FetchStub = vi.fn(async (url: string, init: any) => {
      calls.push({ url, headers: init.headers, body: init.body });
      return url.includes("threads_publish")
        ? jsonResponse(200, { id: "post-9" })
        : jsonResponse(200, { id: "container-1" });
    });
    const result = await publishWithPublisher(CHANNEL_PUBLISHERS.threads, {
      token: PLACEHOLDER_TOKEN,
      text: "Hello test.",
      transport: createFetchSocialTransport(fetchStub as never),
    });
    expect(result).toEqual({ ok: true, platformPostId: "post-9" });
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe("https://graph.threads.net/v1.0/me/threads");
    expect(calls[0].headers).toEqual({
      Authorization: `Bearer ${PLACEHOLDER_TOKEN}`,
      "Content-Type": "application/json",
    });
    expect(JSON.parse(calls[0].body)).toEqual({ media_type: "TEXT", text: "Hello test." });
    expect(calls[1].url).toBe("https://graph.threads.net/v1.0/me/threads_publish");
    expect(JSON.parse(calls[1].body)).toEqual({ creation_id: "container-1" });
  });

  it("publishes X in a single step and reads data.id", async () => {
    const fetchStub: FetchStub = vi.fn(async () => jsonResponse(200, { data: { id: "x-1" } }));
    const result = await publishWithPublisher(CHANNEL_PUBLISHERS.x, {
      token: PLACEHOLDER_TOKEN,
      text: "Hello test.",
      transport: createFetchSocialTransport(fetchStub as never),
    });
    expect(result).toEqual({ ok: true, platformPostId: "x-1" });
    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(fetchStub.mock.calls[0][0]).toBe("https://api.twitter.com/2/tweets");
    expect(JSON.parse(fetchStub.mock.calls[0][1].body)).toEqual({ text: "Hello test." });
  });

  it("maps a non-2xx first step to an error result, never a throw", async () => {
    const fetchStub: FetchStub = vi.fn(async () => jsonResponse(401, { error: "unauthorized" }));
    const result = await publishWithPublisher(CHANNEL_PUBLISHERS.x, {
      token: PLACEHOLDER_TOKEN,
      text: "Hello test.",
      transport: createFetchSocialTransport(fetchStub as never),
    });
    expect(result).toEqual({ ok: false, error: "publish failed for x: HTTP 401" });
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it("maps a non-2xx second step to an error result", async () => {
    const fetchStub: FetchStub = vi.fn(async (url: string) =>
      url.includes("threads_publish")
        ? jsonResponse(500, { error: "boom" })
        : jsonResponse(200, { id: "container-1" }),
    );
    const result = await publishWithPublisher(CHANNEL_PUBLISHERS.threads, {
      token: PLACEHOLDER_TOKEN,
      text: "Hello test.",
      transport: createFetchSocialTransport(fetchStub as never),
    });
    expect(result).toEqual({ ok: false, error: "publish failed for threads: HTTP 500" });
    expect(fetchStub).toHaveBeenCalledTimes(2);
  });

  it("maps a network error to an error result, never a throw or a dry-run fallback", async () => {
    const fetchStub: FetchStub = vi.fn(async () => {
      throw new Error("network down");
    });
    const result = await publishWithPublisher(CHANNEL_PUBLISHERS.x, {
      token: PLACEHOLDER_TOKEN,
      text: "Hello test.",
      transport: createFetchSocialTransport(fetchStub as never),
    });
    expect(result).toEqual({
      ok: false,
      error: "publish transport failed for x: network down",
    });
  });

  it("never calls fetch when the token is missing", async () => {
    const fetchStub: FetchStub = vi.fn(async () => jsonResponse(200, { data: { id: "x-1" } }));
    const result = await publishWithPublisher(CHANNEL_PUBLISHERS.x, {
      token: undefined,
      text: "Hello test.",
      transport: createFetchSocialTransport(fetchStub as never),
    });
    expect(result).toEqual({ ok: false, error: "missing token for x (set X_ACCESS_TOKEN)" });
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("never calls fetch when the required account id is missing", async () => {
    const fetchStub: FetchStub = vi.fn(async () => jsonResponse(200, { id: "li-1" }));
    const result = await publishWithPublisher(CHANNEL_PUBLISHERS.linkedin, {
      token: PLACEHOLDER_TOKEN,
      accountId: undefined,
      text: "Hello test.",
      transport: createFetchSocialTransport(fetchStub as never),
    });
    expect(result).toEqual({
      ok: false,
      error: "missing account id for linkedin (set LINKEDIN_AUTHOR_URN)",
    });
    expect(fetchStub).not.toHaveBeenCalled();
  });
});
