import { describe, expect, it } from "vitest";
import { makeFakeSessionStore } from "./fake-session-store";
import {
  SOCIAL_BRIEF_MAX_CHARS,
  createSessionStoreSocialBriefStore,
  createSocialBriefStoreFromNamespace,
  isBriefDate,
  resolveBriefDate,
} from "../src/agents/social/briefStore";

function makeStore() {
  const { namespace, store } = makeFakeSessionStore();
  const stub = namespace.get(namespace.idFromName("kv"));
  return { stub, store, brief: createSessionStoreSocialBriefStore(stub) };
}

describe("social brief store", () => {
  it("round-trips a brief under the social-brief key", async () => {
    const { brief, store } = makeStore();
    await brief.putBrief("2026-10-26", "Morning market brief.");
    expect(await brief.getBrief("2026-10-26")).toBe("Morning market brief.");
    expect(store.get("social:social-brief:2026-10-26")).toBe(
      JSON.stringify({ text: "Morning market brief." }),
    );
  });

  it("overwrite wins: the most recent provision is the brief", async () => {
    const { brief } = makeStore();
    await brief.putBrief("2026-10-26", "First version.");
    await brief.putBrief("2026-10-26", "Second version wins.");
    expect(await brief.getBrief("2026-10-26")).toBe("Second version wins.");
  });

  it("dates are isolated: one date's brief never leaks to another", async () => {
    const { brief } = makeStore();
    await brief.putBrief("2026-10-26", "Monday brief.");
    await brief.putBrief("2026-10-27", "Tuesday brief.");
    expect(await brief.getBrief("2026-10-26")).toBe("Monday brief.");
    expect(await brief.getBrief("2026-10-27")).toBe("Tuesday brief.");
    expect(await brief.getBrief("2026-10-28")).toBeNull();
  });

  it("corrupt values read as absent and are self-healed by the next put", async () => {
    const { brief, store } = makeStore();
    store.set("social:social-brief:2026-10-26", "not json at all");
    expect(await brief.getBrief("2026-10-26")).toBeNull();
    store.set("social:social-brief:2026-10-26", JSON.stringify({ nope: 1 }));
    expect(await brief.getBrief("2026-10-26")).toBeNull();
    store.set("social:social-brief:2026-10-26", JSON.stringify({ text: 42 }));
    expect(await brief.getBrief("2026-10-26")).toBeNull();
    await brief.putBrief("2026-10-26", "Healed.");
    expect(await brief.getBrief("2026-10-26")).toBe("Healed.");
  });

  it("transport failure throws on both read and write (never a silent no-op)", async () => {
    const failing = {
      fetch: async () => new Response("boom", { status: 500 }),
    };
    const brief = createSessionStoreSocialBriefStore(failing);
    await expect(brief.getBrief("2026-10-26")).rejects.toThrow();
    await expect(brief.putBrief("2026-10-26", "x")).rejects.toThrow();
    const throwing = {
      fetch: async () => {
        throw new Error("network down");
      },
    };
    const brief2 = createSessionStoreSocialBriefStore(throwing);
    await expect(brief2.getBrief("2026-10-26")).rejects.toThrow("network down");
  });

  it("putBrief rejects bad dates, empty/whitespace text, and over-long text", async () => {
    const { brief } = makeStore();
    await expect(brief.putBrief("26-10-2026", "x")).rejects.toThrow();
    await expect(brief.putBrief("2026-13-01", "x")).rejects.toThrow();
    await expect(brief.putBrief("2026-10-26", "")).rejects.toThrow();
    await expect(brief.putBrief("2026-10-26", "   ")).rejects.toThrow();
    await expect(brief.putBrief("2026-10-26", "x".repeat(SOCIAL_BRIEF_MAX_CHARS + 1))).rejects.toThrow();
    await brief.putBrief("2026-10-26", "x".repeat(SOCIAL_BRIEF_MAX_CHARS));
    expect(await brief.getBrief("2026-10-26")).toBe("x".repeat(SOCIAL_BRIEF_MAX_CHARS));
  });

  it("getBrief on a malformed date returns null instead of throwing", async () => {
    const { brief } = makeStore();
    expect(await brief.getBrief("garbage")).toBeNull();
  });

  it("from-namespace returns null without a namespace and a working store with one", async () => {
    expect(createSocialBriefStoreFromNamespace(null)).toBeNull();
    expect(createSocialBriefStoreFromNamespace(undefined)).toBeNull();
    const { namespace } = makeFakeSessionStore();
    const brief = createSocialBriefStoreFromNamespace(namespace as never);
    expect(brief).not.toBeNull();
    await brief!.putBrief("2026-10-26", "Via namespace.");
    expect(await brief!.getBrief("2026-10-26")).toBe("Via namespace.");
  });
});

describe("brief dates", () => {
  it("isBriefDate accepts YYYY-MM-DD with real month/day ranges", () => {
    expect(isBriefDate("2026-10-26")).toBe(true);
    expect(isBriefDate("2026-02-29")).toBe(true);
    expect(isBriefDate("26-10-2026")).toBe(false);
    expect(isBriefDate("2026-13-01")).toBe(false);
    expect(isBriefDate("2026-10-32")).toBe(false);
    expect(isBriefDate("2026-10-00")).toBe(false);
    expect(isBriefDate("2026/10/26")).toBe(false);
    expect(isBriefDate("")).toBe(false);
  });

  it("resolveBriefDate reads the NY wall-clock date and shifts by dayOffset", () => {
    // 2026-10-26T13:00Z = 09:00 EDT on 2026-10-26.
    expect(resolveBriefDate(Date.parse("2026-10-26T13:00:00Z"), "America/New_York", 0)).toBe("2026-10-26");
    expect(resolveBriefDate(Date.parse("2026-10-26T13:00:00Z"), "America/New_York", 1)).toBe("2026-10-27");
    // 2026-10-26T02:00Z = 22:00 EDT on 2026-10-25: the NY date, not the UTC date.
    expect(resolveBriefDate(Date.parse("2026-10-26T02:00:00Z"), "America/New_York", 0)).toBe("2026-10-25");
    // Month boundary: 2026-10-31 + 1 day = 2026-11-01.
    expect(resolveBriefDate(Date.parse("2026-10-31T13:00:00Z"), "America/New_York", 1)).toBe("2026-11-01");
  });
});
