import { describe, it, expect } from "vitest";
import { formatDraftText, createDraft, CHANNEL_LIMITS } from "../src/agents/social/draft";

function longText(words: number): string {
  return Array.from({ length: words }, (_, i) => `word${i}`).join(" ");
}

describe("channel formatting limits", () => {
  it("exposes the documented per-channel limits", () => {
    expect(CHANNEL_LIMITS).toEqual({
      x: 280,
      threads: 500,
      facebook: 2000,
      instagram: 2200,
      linkedin: 3000,
    });
  });

  it("passes text at or under the limit through untruncated", () => {
    const res = formatDraftText("x", "hello");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.text).toBe("hello");
      expect(res.truncated).toBe(false);
      expect(res.originalLength).toBe(5);
    }
  });

  it("truncates over-limit text at a word boundary with an ellipsis", () => {
    const text = longText(300);
    const res = formatDraftText("x", text);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.truncated).toBe(true);
      expect(res.originalLength).toBe(text.length);
      expect(res.text.length).toBeLessThanOrEqual(280);
      expect(res.text.endsWith("…")).toBe(true);
      // The kept prefix ends exactly at a word boundary in the original:
      // the next original character after the prefix is a space.
      const kept = res.text.slice(0, -1);
      expect(text.startsWith(kept)).toBe(true);
      expect(text[kept.length]).toBe(" ");
    }
  });

  it("applies the Threads limit, not the X limit", () => {
    const text = longText(90); // ~500+ chars: over X, around Threads.
    const xRes = formatDraftText("x", text);
    expect(xRes.ok).toBe(true);
    if (xRes.ok) expect(xRes.truncated).toBe(true);
    const tRes = formatDraftText("threads", text);
    expect(tRes.ok).toBe(true);
    if (tRes.ok) expect(tRes.text.length).toBeLessThanOrEqual(500);
  });

  it("hard-cuts a single unbroken word and still stays within the limit", () => {
    const res = formatDraftText("x", "a".repeat(1000));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.text.length).toBeLessThanOrEqual(280);
      expect(res.text.endsWith("…")).toBe(true);
    }
  });

  it("fails closed for an unknown channel, never producing a postable draft", () => {
    const res = formatDraftText("tiktok", "hello");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toMatch(/unknown/i);
    }
  });

  it("fails closed for Object.prototype property names, which `in` would match", () => {
    for (const name of ["constructor", "toString", "hasOwnProperty", "__proto__"]) {
      const res = formatDraftText(name, "hello");
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error).toMatch(/unknown/i);
      }
    }
  });
});

describe("draft records", () => {
  it("builds a draft with id, NY date, channel, status, and original length", () => {
    const res = createDraft({
      channel: "threads",
      text: "Morning brief: markets steady.",
      date: "2026-10-26",
      createdAtMs: Date.parse("2026-10-26T13:00:00Z"),
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.draft.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
      expect(res.draft.date).toBe("2026-10-26");
      expect(res.draft.channel).toBe("threads");
      expect(res.draft.status).toBe("draft");
      expect(res.draft.text).toBe("Morning brief: markets steady.");
      expect(res.draft.originalLength).toBe("Morning brief: markets steady.".length);
      expect(res.draft.truncated).toBe(false);
      expect(res.draft.approval).toBeUndefined();
    }
  });

  it("records truncation on the draft and keeps the original length", () => {
    const text = longText(300);
    const res = createDraft({ channel: "x", text, date: "2026-10-26", createdAtMs: 0 });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.draft.truncated).toBe(true);
      expect(res.draft.originalLength).toBe(text.length);
      expect(res.draft.text.length).toBeLessThanOrEqual(280);
    }
  });

  it("refuses to create a draft for an unknown channel", () => {
    const res = createDraft({ channel: "tiktok", text: "hi", date: "2026-10-26", createdAtMs: 0 });
    expect(res.ok).toBe(false);
  });

  it("refuses to create a draft for Object.prototype property names", () => {
    for (const name of ["constructor", "toString", "__proto__"]) {
      const res = createDraft({ channel: name, text: "hi", date: "2026-10-26", createdAtMs: 0 });
      expect(res.ok).toBe(false);
    }
  });
});
