import { describe, it, expect } from "vitest";
import {
  MemorySocialLedger,
  getOrCreateDraft,
  createDoSocialLedger,
  type SocialDraft,
} from "../src/agents/social/ledger";

function draft(date: string, channel: string, text = "hi"): SocialDraft {
  return {
    id: `${date}-${channel}`,
    date,
    channel: channel as SocialDraft["channel"],
    text,
    status: "draft",
    createdAtMs: 0,
    originalLength: text.length,
    truncated: false,
  };
}

describe("memory ledger", () => {
  it("round-trips a draft through put and get", () => {
    const ledger = new MemorySocialLedger();
    const d = draft("2026-10-26", "x");
    ledger.putDraft(d);
    expect(ledger.getDraft("2026-10-26", "x")).toEqual(d);
    expect(ledger.getDraft("2026-10-26", "threads")).toBeUndefined();
  });

  it("returns the existing draft on a second create and never calls create again", async () => {
    const ledger = new MemorySocialLedger();
    let calls = 0;
    const first = await getOrCreateDraft(ledger, "2026-10-26", "x", () => {
      calls += 1;
      return draft("2026-10-26", "x", "first");
    });
    const second = await getOrCreateDraft(ledger, "2026-10-26", "x", () => {
      calls += 1;
      return draft("2026-10-26", "x", "second");
    });
    expect(calls).toBe(1);
    expect(second).toEqual(first);
    expect(second.text).toBe("first");
  });

  it("lists only the drafts for the requested date", () => {
    const ledger = new MemorySocialLedger();
    ledger.putDraft(draft("2026-10-26", "x"));
    ledger.putDraft(draft("2026-10-26", "threads"));
    ledger.putDraft(draft("2026-10-27", "x"));
    const listed = ledger.listDrafts("2026-10-26").map((d) => d.channel).sort();
    expect(listed).toEqual(["threads", "x"]);
  });

  it("exposes the same idempotency through its method", async () => {
    const ledger = new MemorySocialLedger();
    let calls = 0;
    const mk = () => {
      calls += 1;
      return draft("2026-10-26", "threads");
    };
    await ledger.getOrCreateDraft("2026-10-26", "threads", mk);
    await ledger.getOrCreateDraft("2026-10-26", "threads", mk);
    expect(calls).toBe(1);
  });
});

describe("DO-shaped ledger adapter", () => {
  function fakeStorage() {
    const map = new Map<string, unknown>();
    return {
      map,
      get: async (key: string) => map.get(key),
      put: async (key: string, value: unknown) => {
        map.set(key, value);
      },
      list: async (options: { prefix: string }) => {
        const out = new Map<string, unknown>();
        for (const [k, v] of map) {
          if (k.startsWith(options.prefix)) out.set(k, v);
        }
        return out;
      },
    };
  }

  it("round-trips through the async adapter and filters non-draft values", async () => {
    const storage = fakeStorage();
    const ledger = createDoSocialLedger(storage);
    const d = draft("2026-10-26", "x");
    await ledger.putDraft(d);
    expect(await ledger.getDraft("2026-10-26", "x")).toEqual(d);
    // A junk value under the same prefix must not surface as a draft.
    storage.map.set("social-draft:2026-10-26:junk", { not: "a draft" });
    const listed = await ledger.listDrafts("2026-10-26");
    expect(listed).toEqual([d]);
  });

  it("is idempotent through the async adapter", async () => {
    const storage = fakeStorage();
    const ledger = createDoSocialLedger(storage);
    let calls = 0;
    const mk = () => {
      calls += 1;
      return draft("2026-10-26", "x", "one");
    };
    await ledger.getOrCreateDraft("2026-10-26", "x", mk);
    const again = await ledger.getOrCreateDraft("2026-10-26", "x", mk);
    expect(calls).toBe(1);
    expect(again.text).toBe("one");
  });
});
