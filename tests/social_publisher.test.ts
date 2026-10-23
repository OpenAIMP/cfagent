import { describe, it, expect } from "vitest";
import {
  CHANNEL_PUBLISHERS,
  getPublisherDef,
  publishWithPublisher,
  DryRunPublisher,
  createMemoryDryRunSink,
  resolvePublishTarget,
  type SocialTransport,
  type SocialTransportResponse,
} from "../src/agents/social/publisher";
import type { SocialDraft } from "../src/agents/social/draft";

function draft(channel: string, text = "Hello world"): SocialDraft {
  return {
    id: `draft-${channel}`,
    date: "2026-10-26",
    channel: channel as SocialDraft["channel"],
    text,
    status: "draft",
    createdAtMs: 0,
    originalLength: text.length,
    truncated: false,
  };
}

/** Fake transport: records every call, answers from a per-URL responder. */
function fakeTransport(
  respond: (url: string, body: Record<string, unknown>) => SocialTransportResponse = () => ({
    status: 200,
    body: { id: "platform-1" },
  }),
): SocialTransport & { calls: Array<{ url: string; headers: Record<string, string>; body: string }> } {
  const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  return {
    calls,
    async post(url, headers, body) {
      calls.push({ url, headers, body });
      return respond(url, JSON.parse(body) as Record<string, unknown>);
    },
  };
}

describe("publisher definitions", () => {
  it("names a token env var, endpoint, and payload builder for every known channel", () => {
    const expected: Record<string, string> = {
      threads: "THREADS_ACCESS_TOKEN",
      x: "X_ACCESS_TOKEN",
      facebook: "FACEBOOK_PAGE_ACCESS_TOKEN",
      instagram: "INSTAGRAM_ACCESS_TOKEN",
      linkedin: "LINKEDIN_ACCESS_TOKEN",
    };
    for (const [channel, tokenEnvVar] of Object.entries(expected)) {
      const def = CHANNEL_PUBLISHERS[channel as keyof typeof CHANNEL_PUBLISHERS];
      expect(def).toBeDefined();
      expect(def.tokenEnvVar).toBe(tokenEnvVar);
      expect(def.endpoint).toMatch(/^https:\/\//);
      expect(typeof def.buildPayload).toBe("function");
    }
    expect(getPublisherDef("tiktok")).toBeUndefined();
    expect(getPublisherDef("constructor")).toBeUndefined();
  });
});

describe("live publish token gating", () => {
  it("fails closed with no transport call when the token is missing", async () => {
    const transport = fakeTransport();
    const def = getPublisherDef("x")!;
    for (const token of [undefined, "", "   "]) {
      const res = await publishWithPublisher(def, { token, text: "hi", transport });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toMatch(/missing token/i);
    }
    expect(transport.calls).toHaveLength(0);
  });

  it("fails closed for unknown channels before any transport call", async () => {
    const transport = fakeTransport();
    const res = await publishWithPublisher(undefined as never, {
      token: "test-token",
      text: "hi",
      transport,
    });
    expect(res.ok).toBe(false);
    expect(transport.calls).toHaveLength(0);
  });
});

describe("live publish over a fake transport", () => {
  it("publishes to X in one step with a Bearer token and reads data.id", async () => {
    const transport = fakeTransport(() => ({ status: 200, body: { data: { id: "x-1" } } }));
    const res = await publishWithPublisher(getPublisherDef("x")!, {
      token: "test-token",
      text: "hello",
      transport,
    });
    expect(res).toEqual({ ok: true, platformPostId: "x-1" });
    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0].url).toBe("https://api.twitter.com/2/tweets");
    expect(transport.calls[0].headers.Authorization).toBe("Bearer test-token");
    expect(JSON.parse(transport.calls[0].body)).toEqual({ text: "hello" });
  });

  it("publishes to Threads in two steps, threading the container id", async () => {
    const transport = fakeTransport((url) => {
      // Exact match, not a substring guard (see the approval test note
      // on CodeQL's incomplete-URL-substring-sanitization rule).
      if (url === "https://graph.threads.net/v1.0/me/threads_publish") {
        return { status: 200, body: { id: "threads-post-9" } };
      }
      return { status: 200, body: { id: "container-7" } };
    });
    const res = await publishWithPublisher(getPublisherDef("threads")!, {
      token: "test-token",
      text: "hello",
      transport,
    });
    expect(res).toEqual({ ok: true, platformPostId: "threads-post-9" });
    expect(transport.calls).toHaveLength(2);
    expect(transport.calls[0].url).toBe("https://graph.threads.net/v1.0/me/threads");
    expect(JSON.parse(transport.calls[0].body)).toEqual({ media_type: "TEXT", text: "hello" });
    expect(transport.calls[1].url).toBe("https://graph.threads.net/v1.0/me/threads_publish");
    expect(JSON.parse(transport.calls[1].body)).toEqual({ creation_id: "container-7" });
  });

  it("fails the Threads publish when the container id is missing, after one call", async () => {
    const transport = fakeTransport(() => ({ status: 200, body: {} }));
    const res = await publishWithPublisher(getPublisherDef("threads")!, {
      token: "test-token",
      text: "hello",
      transport,
    });
    expect(res.ok).toBe(false);
    expect(transport.calls).toHaveLength(1);
  });

  it("publishes to a Facebook Page via /me/feed with a Page token", async () => {
    const transport = fakeTransport(() => ({ status: 200, body: { id: "fb-2" } }));
    const res = await publishWithPublisher(getPublisherDef("facebook")!, {
      token: "test-token",
      text: "hello",
      transport,
    });
    expect(res).toEqual({ ok: true, platformPostId: "fb-2" });
    expect(transport.calls[0].url).toBe("https://graph.facebook.com/v21.0/me/feed");
    expect(JSON.parse(transport.calls[0].body)).toEqual({ message: "hello" });
  });

  it("publishes to Instagram in two steps with a caption", async () => {
    const transport = fakeTransport((url) => {
      // Exact match, not a substring guard (see above).
      if (url === "https://graph.instagram.com/v21.0/me/media_publish") {
        return { status: 200, body: { id: "ig-post-3" } };
      }
      return { status: 200, body: { id: "ig-container-4" } };
    });
    const res = await publishWithPublisher(getPublisherDef("instagram")!, {
      token: "test-token",
      text: "hello",
      transport,
    });
    expect(res).toEqual({ ok: true, platformPostId: "ig-post-3" });
    expect(transport.calls).toHaveLength(2);
    expect(JSON.parse(transport.calls[0].body)).toEqual({ caption: "hello" });
    expect(JSON.parse(transport.calls[1].body)).toEqual({ creation_id: "ig-container-4" });
  });

  it("fails LinkedIn closed without an author URN, and publishes with one", async () => {
    const transport = fakeTransport(() => ({ status: 200, body: { id: "li-5" } }));
    const def = getPublisherDef("linkedin")!;
    const noUrn = await publishWithPublisher(def, { token: "test-token", text: "hello", transport });
    expect(noUrn.ok).toBe(false);
    if (!noUrn.ok) expect(noUrn.error).toMatch(/author/i);
    expect(transport.calls).toHaveLength(0);
    const withUrn = await publishWithPublisher(def, {
      token: "test-token",
      accountId: "urn:li:person:test-person",
      text: "hello",
      transport,
    });
    expect(withUrn).toEqual({ ok: true, platformPostId: "li-5" });
    expect(JSON.parse(transport.calls[0].body).author).toBe("urn:li:person:test-person");
  });

  it("turns transport throws and non-2xx responses into error results, never throws", async () => {
    const throwing: SocialTransport = {
      async post() {
        throw new Error("network down");
      },
    };
    const res1 = await publishWithPublisher(getPublisherDef("x")!, {
      token: "test-token",
      text: "hi",
      transport: throwing,
    });
    expect(res1.ok).toBe(false);
    const failing = fakeTransport(() => ({ status: 401, body: { error: "bad token" } }));
    const res2 = await publishWithPublisher(getPublisherDef("x")!, {
      token: "test-token",
      text: "hi",
      transport: failing,
    });
    expect(res2.ok).toBe(false);
    if (!res2.ok) expect(res2.error).toMatch(/401/);
  });
});

describe("dry-run publisher", () => {
  it("records the attempt and returns a dry-run id without touching the network", () => {
    const sink = createMemoryDryRunSink();
    const publisher = new DryRunPublisher(sink);
    const res = publisher.publish(draft("x", "hello"), 12345);
    expect(res).toEqual({ ok: true, platformPostId: "dry-run:draft-x" });
    expect(sink.records).toEqual([
      { channel: "x", draftId: "draft-x", text: "hello", recordedAtMs: 12345 },
    ]);
  });
});

describe("publish target resolution (defense in depth)", () => {
  const sink = createMemoryDryRunSink();
  const tokens = { X_ACCESS_TOKEN: "test-token" };

  it("defaults to dry-run when live is not requested, and to unavailable when posting is off", () => {
    const cases: Array<{
      env: Record<string, string>;
      tokens: Record<string, string>;
      expected: string;
    }> = [
      { env: {}, tokens, expected: "unavailable" },
      { env: { SOCIAL_POSTING_ENABLED: "1" }, tokens, expected: "dry-run" },
      {
        env: { SOCIAL_POSTING_ENABLED: "1", SOCIAL_LIVE_PUBLISHING: "0" },
        tokens,
        expected: "dry-run",
      },
    ];
    for (const c of cases) {
      const target = resolvePublishTarget("x", { ...c, dryRunSink: sink });
      expect(target.kind).toBe(c.expected);
    }
  });

  it("resolves live only when posting is on, live is on, and the token is present", () => {
    const target = resolvePublishTarget("x", {
      env: { SOCIAL_POSTING_ENABLED: "1", SOCIAL_LIVE_PUBLISHING: "1" },
      tokens,
      dryRunSink: sink,
    });
    expect(target.kind).toBe("live");
    if (target.kind === "live") expect(target.def.channel).toBe("x");
  });

  it("fails closed — never a dry-run fallback — when live is requested but the token is missing", () => {
    const target = resolvePublishTarget("x", {
      env: { SOCIAL_POSTING_ENABLED: "1", SOCIAL_LIVE_PUBLISHING: "true" },
      tokens: {},
      dryRunSink: sink,
    });
    expect(target.kind).toBe("unavailable");
    if (target.kind === "unavailable") expect(target.error).toMatch(/missing token/i);
  });

  it("fails closed for unknown channels", () => {
    const target = resolvePublishTarget("tiktok", {
      env: { SOCIAL_POSTING_ENABLED: "1" },
      tokens,
      dryRunSink: sink,
    });
    expect(target.kind).toBe("unavailable");
  });
});
