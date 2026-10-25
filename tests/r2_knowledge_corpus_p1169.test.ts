import { describe, it, expect, beforeEach } from "vitest";
import { r2KeyForStorageKey } from "../src/services/reportBlobStore";
import {
  putKnowledgeDoc,
  getKnowledgeDoc,
  sha256Hex,
  knowledgeStorageKey,
  KnowledgeCorpusError,
} from "../src/services/knowledgeCorpus";
import { handleKnowledgeCorpusRoutes } from "../src/agents/routes/knowledgeCorpus";

/**
 * #1169 (S1): knowledge-corpus storage in R2 (bucket `screener`).
 *
 * Pins, in order:
 * - G3: the `knowledge:` key family maps into knowledge/ (mirroring
 *   stocks/ + options/ + goals/).
 * - Corpus put/get with full metadata (title, category, source URL,
 *   ingested-at, content hash) + hash-idempotent writes.
 * - Hash-verified reads (tampered bytes read back as null, never served).
 * - Honest failure without the bucket binding (no silent DO fallback).
 * - Session gates: empty login refuses reads and writes.
 * - Admin upload route (POST /knowledge/corpus): 201 fresh / 200 replay /
 *   401 without login / 400 on bad input; non-matching paths return null.
 *
 * Fixture bytes below are small synthetic markers, NOT corpus content:
 * real seed documents live in docs/knowledge-corpus-seed-manifest.json
 * and are ingested through the upload route, never committed here.
 */

function makeStorage() {
  const map = new Map<string, unknown>();
  return {
    async get<T>(key: string): Promise<T | undefined> {
      return map.get(key) as T | undefined;
    },
    async put(key: string, value: unknown): Promise<void> {
      map.set(key, value);
    },
    raw: map,
  };
}

function makeBucket() {
  const objects = new Map<string, { bytes: Uint8Array; options?: Record<string, unknown> }>();
  let puts = 0;
  const bucket = {
    async put(key: string, value: Uint8Array, options?: Record<string, unknown>) {
      puts += 1;
      objects.set(key, { bytes: value, options });
    },
    async get(key: string) {
      const obj = objects.get(key);
      if (!obj) return null;
      return {
        customMetadata: (obj.options?.customMetadata ?? {}) as Record<string, string>,
        async arrayBuffer() {
          return obj.bytes.buffer as ArrayBuffer;
        },
      };
    },
  } as unknown as R2Bucket;
  return { bucket, objects, puts: () => puts };
}

const BYTES = new Uint8Array([0x6b, 0x6e, 0x6f, 0x77, 0x2d, 0x64, 0x6f, 0x63]); // "know-doc"

// btoa-based base64 (vitest Node env; mirrors the repo's own test idiom
// in report-blob-store.test.ts — no Node-only Buffer in test code).
function b64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}
const LOGIN = "test-login";

describe("#1169 S1 knowledge: key family (G3)", () => {
  it("maps knowledge: keys into knowledge/ by category and hash", () => {
    expect(r2KeyForStorageKey("knowledge:sec_filing:abc123")).toBe("knowledge/sec_filing/abc123");
    expect(r2KeyForStorageKey("knowledge:broker_rules:def456")).toBe("knowledge/broker_rules/def456");
    expect(r2KeyForStorageKey("knowledge:options_disclosure:ghi789")).toBe("knowledge/options_disclosure/ghi789");
    expect(r2KeyForStorageKey("knowledge:market_education:jkl012")).toBe("knowledge/market_education/jkl012");
  });

  it("leaves the existing families untouched", () => {
    expect(r2KeyForStorageKey("screener:pdf:abc123")).toBe("stocks/pdf/abc123");
    expect(r2KeyForStorageKey("options:pdf:def456")).toBe("options/pdf/def456");
    expect(r2KeyForStorageKey("goal_screen:pdf:ghi789")).toBe("goals/pdf/ghi789");
    expect(r2KeyForStorageKey("unrelated-key")).toBe("unrelated-key");
  });

  it("derives the storage key from category + content hash", async () => {
    const hash = await sha256Hex(BYTES);
    expect(knowledgeStorageKey("sec_filing", hash)).toBe(`knowledge:sec_filing:${hash}`);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("#1169 S1 corpus put/get + metadata", () => {
  let storage: ReturnType<typeof makeStorage>;
  let b: ReturnType<typeof makeBucket>;

  beforeEach(() => {
    storage = makeStorage();
    b = makeBucket();
  });

  it("writes the object under knowledge/<category>/<sha256> with full metadata", async () => {
    const { meta, idempotent } = await putKnowledgeDoc(
      { REPORTS_BUCKET: b.bucket },
      storage,
      LOGIN,
      { title: "Test Doc", category: "sec_filing", sourceUrl: "https://example.com/doc", bytes: BYTES, contentType: "text/html", fileName: "test-doc.html" }
    );
    expect(idempotent).toBe(false);
    const hash = await sha256Hex(BYTES);
    expect(meta.contentHash).toBe(hash);
    expect(meta.r2Key).toBe(`knowledge/sec_filing/${hash}`);
    expect(meta.title).toBe("Test Doc");
    expect(meta.category).toBe("sec_filing");
    expect(meta.sourceUrl).toBe("https://example.com/doc");
    expect(meta.fileName).toBe("test-doc.html");
    expect(meta.contentType).toBe("text/html");
    expect(typeof meta.ingestedAt).toBe("string");
    expect(meta.ingestedAt.length).toBeGreaterThan(0);
    // Bucket object carries the same metadata for S2's serving path.
    const obj = b.objects.get(`knowledge/sec_filing/${hash}`);
    expect(obj).toBeDefined();
    expect((obj!.options?.customMetadata as Record<string, string>).contentHash).toBe(hash);
    // DO storage holds only the pointer, not the bytes.
    const stored = storage.raw.get(`knowledge:sec_filing:${hash}`) as Record<string, unknown>;
    expect(stored.r2Key).toBe(`knowledge/sec_filing/${hash}`);
    expect(stored.contentHash).toBe(hash);
  });

  it("round-trips bytes + metadata through get", async () => {
    await putKnowledgeDoc(
      { REPORTS_BUCKET: b.bucket },
      storage,
      LOGIN,
      { title: "Round Trip", category: "broker_rules", sourceUrl: "https://example.com/rules", bytes: BYTES }
    );
    const hash = await sha256Hex(BYTES);
    const got = await getKnowledgeDoc({ REPORTS_BUCKET: b.bucket }, storage, LOGIN, `knowledge:broker_rules:${hash}`);
    expect(got).not.toBeNull();
    expect(Array.from(got!.bytes)).toEqual(Array.from(BYTES));
    expect(got!.meta.title).toBe("Round Trip");
    expect(got!.meta.contentHash).toBe(hash);
  });

  it("second put of identical bytes is a no-op: no second bucket write, first title wins", async () => {
    const input = { title: "First Title", category: "sec_filing" as const, sourceUrl: "https://example.com/a", bytes: BYTES };
    const first = await putKnowledgeDoc({ REPORTS_BUCKET: b.bucket }, storage, LOGIN, input);
    expect(first.idempotent).toBe(false);
    const second = await putKnowledgeDoc({ REPORTS_BUCKET: b.bucket }, storage, LOGIN, { ...input, title: "Second Title", sourceUrl: "https://example.com/b" });
    expect(second.idempotent).toBe(true);
    expect(second.meta.title).toBe("First Title");
    expect(second.meta.sourceUrl).toBe("https://example.com/a");
    expect(b.puts()).toBe(1);
  });

  it("tampered bucket bytes read back as null, never served", async () => {
    await putKnowledgeDoc(
      { REPORTS_BUCKET: b.bucket },
      storage,
      LOGIN,
      { title: "Tamper", category: "options_disclosure", sourceUrl: "https://example.com/odd", bytes: BYTES }
    );
    const hash = await sha256Hex(BYTES);
    b.objects.set(`knowledge/options_disclosure/${hash}`, { bytes: new Uint8Array([0x74, 0x61, 0x6d, 0x70, 0x65, 0x72, 0x65, 0x64]) });
    const got = await getKnowledgeDoc({ REPORTS_BUCKET: b.bucket }, storage, LOGIN, `knowledge:options_disclosure:${hash}`);
    expect(got).toBeNull();
  });

  it("missing document reads back as null", async () => {
    const got = await getKnowledgeDoc({ REPORTS_BUCKET: b.bucket }, storage, LOGIN, `knowledge:sec_filing:${"0".repeat(64)}`);
    expect(got).toBeNull();
  });

  it("put without the bucket binding throws honestly (no silent DO fallback)", async () => {
    await expect(
      putKnowledgeDoc({}, storage, LOGIN, { title: "No Bucket", category: "sec_filing", sourceUrl: "https://example.com/x", bytes: BYTES })
    ).rejects.toThrow(KnowledgeCorpusError);
  });

  it("empty login refuses reads and writes", async () => {
    await expect(
      putKnowledgeDoc({ REPORTS_BUCKET: b.bucket }, storage, "", { title: "No Login", category: "sec_filing", sourceUrl: "https://example.com/x", bytes: BYTES })
    ).rejects.toThrow(/Unauthorized/);
    await expect(
      getKnowledgeDoc({ REPORTS_BUCKET: b.bucket }, storage, "", "knowledge:sec_filing:abc")
    ).rejects.toThrow(/Unauthorized/);
  });

  it("rejects invalid input: bad category, empty title, empty bytes, non-http source URL", async () => {
    const base = { title: "T", category: "sec_filing" as const, sourceUrl: "https://example.com/x", bytes: BYTES };
    await expect(
      putKnowledgeDoc({ REPORTS_BUCKET: b.bucket }, storage, LOGIN, { ...base, category: "wrong" as never })
    ).rejects.toThrow();
    await expect(
      putKnowledgeDoc({ REPORTS_BUCKET: b.bucket }, storage, LOGIN, { ...base, title: "  " })
    ).rejects.toThrow();
    await expect(
      putKnowledgeDoc({ REPORTS_BUCKET: b.bucket }, storage, LOGIN, { ...base, bytes: new Uint8Array(0) })
    ).rejects.toThrow();
    await expect(
      putKnowledgeDoc({ REPORTS_BUCKET: b.bucket }, storage, LOGIN, { ...base, sourceUrl: "ftp://example.com/x" })
    ).rejects.toThrow();
  });
});

describe("#1169 S1 admin upload route (G4: API upload first)", () => {
  function routeCtx(bucket: R2Bucket, userLogin: string) {
    const storage = makeStorage();
    return {
      ctx: { env: { REPORTS_BUCKET: bucket }, storage, userLogin },
      storage,
    };
  }

  function postRequest(body: unknown, userLogin: string) {
    return new Request("https://worker/knowledge/corpus", {
      method: "POST",
      headers: userLogin ? { "x-user-login": userLogin } : {},
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  }

  it("fresh upload returns 201 with meta + idempotent false", async () => {
    const { bucket, objects, puts } = makeBucket();
    const { ctx } = routeCtx(bucket, LOGIN);
    const res = await handleKnowledgeCorpusRoutes(
      postRequest({ title: "Route Doc", category: "market_education", sourceUrl: "https://example.com/edu", contentBase64: b64(BYTES) }, LOGIN),
      new URL("https://worker/knowledge/corpus"),
      "/knowledge/corpus",
      "session-1",
      ctx
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(201);
    const body = await res!.json() as Record<string, unknown>;
    expect(body.success).toBe(true);
    expect(body.idempotent).toBe(false);
    expect(body.title).toBe("Route Doc");
    expect(typeof body.r2Key).toBe("string");
    expect(puts()).toBe(1);
    expect(objects.size).toBe(1);
  });

  it("replay upload returns 200 with idempotent true and no second bucket write", async () => {
    const { bucket, puts } = makeBucket();
    const { ctx } = routeCtx(bucket, LOGIN);
    const payload = { title: "Replay", category: "sec_filing", sourceUrl: "https://example.com/r", contentBase64: b64(BYTES) };
    const first = await handleKnowledgeCorpusRoutes(postRequest(payload, LOGIN), new URL("https://worker/knowledge/corpus"), "/knowledge/corpus", "s", ctx);
    expect(first!.status).toBe(201);
    const second = await handleKnowledgeCorpusRoutes(postRequest(payload, LOGIN), new URL("https://worker/knowledge/corpus"), "/knowledge/corpus", "s", ctx);
    expect(second!.status).toBe(200);
    const body = await second!.json() as Record<string, unknown>;
    expect(body.idempotent).toBe(true);
    expect(puts()).toBe(1);
  });

  it("missing login returns the shared 401 body", async () => {
    const { bucket } = makeBucket();
    const { ctx } = routeCtx(bucket, "");
    const res = await handleKnowledgeCorpusRoutes(
      postRequest({ title: "X", category: "sec_filing", sourceUrl: "https://example.com/x", contentBase64: b64(BYTES) }, ""),
      new URL("https://worker/knowledge/corpus"),
      "/knowledge/corpus",
      "s",
      ctx
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(401);
    const body = await res!.json() as Record<string, unknown>;
    expect(body.error).toBe("An authenticated E*TRADE account is required.");
  });

  it("malformed JSON and bad category return 400", async () => {
    const { bucket } = makeBucket();
    const { ctx } = routeCtx(bucket, LOGIN);
    const badJson = await handleKnowledgeCorpusRoutes(
      postRequest("{not json", LOGIN),
      new URL("https://worker/knowledge/corpus"),
      "/knowledge/corpus",
      "s",
      ctx
    );
    expect(badJson!.status).toBe(400);
    const badCat = await handleKnowledgeCorpusRoutes(
      postRequest({ title: "X", category: "nope", sourceUrl: "https://example.com/x", contentBase64: b64(BYTES) }, LOGIN),
      new URL("https://worker/knowledge/corpus"),
      "/knowledge/corpus",
      "s",
      ctx
    );
    expect(badCat!.status).toBe(400);
  });

  it("non-matching paths and methods return null", async () => {
    const { bucket } = makeBucket();
    const { ctx } = routeCtx(bucket, LOGIN);
    const getRes = await handleKnowledgeCorpusRoutes(
      new Request("https://worker/knowledge/corpus", { method: "GET", headers: { "x-user-login": LOGIN } }),
      new URL("https://worker/knowledge/corpus"),
      "/knowledge/corpus",
      "s",
      ctx
    );
    expect(getRes).toBeNull();
    const otherRes = await handleKnowledgeCorpusRoutes(
      postRequest({ title: "X", category: "sec_filing", sourceUrl: "https://example.com/x", contentBase64: b64(BYTES) }, LOGIN),
      new URL("https://worker/other"),
      "/other",
      "s",
      ctx
    );
    expect(otherRes).toBeNull();
  });
});
