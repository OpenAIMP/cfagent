import { describe, it, expect, beforeEach } from "vitest";
import { putReportPdf, getReportPdf, r2KeyForStorageKey } from "../src/services/reportBlobStore";

/**
 * #605: report PDF blob storage (R2 with legacy DO-storage fallback).
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

const BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]); // %PDF-1.4

describe("#605 report blob store", () => {
  let storage: ReturnType<typeof makeStorage>;

  beforeEach(() => {
    storage = makeStorage();
  });

  it("round-trips via DO storage when no R2 binding", async () => {
    await putReportPdf({}, storage, "k1", "a.pdf", BYTES);
    const got = await getReportPdf({}, storage, "k1");
    expect(got).not.toBeNull();
    expect(got!.fileName).toBe("a.pdf");
    expect(Array.from(got!.bytes)).toEqual(Array.from(BYTES));
  });

  it("stores to R2 when the binding is present", async () => {
    const r2map = new Map<string, Uint8Array>();
    const bucket = {
      async put(key: string, value: Uint8Array) {
        r2map.set(key, value);
      },
      async get(key: string) {
        const bytes = r2map.get(key);
        if (!bytes) return null;
        return { async arrayBuffer() { return bytes.buffer as ArrayBuffer; } };
      },
    } as unknown as R2Bucket;
    await putReportPdf({ REPORTS_BUCKET: bucket }, storage, "k2", "b.pdf", BYTES);
    // DO storage holds only the metadata pointer, not the blob.
    const meta = storage.raw.get("k2") as { r2Key?: string; base64?: string };
    expect(meta.r2Key).toBe("k2");
    expect(meta.base64).toBeUndefined();
    // Read-back comes from R2.
    const got = await getReportPdf({ REPORTS_BUCKET: bucket }, storage, "k2");
    expect(got).not.toBeNull();
    expect(got!.fileName).toBe("b.pdf");
    expect(Array.from(got!.bytes.slice(0, 8))).toEqual(Array.from(BYTES));
  });

  it("reads legacy pre-#605 blobs (base64 in DO storage)", async () => {
    // Simulate a blob stored by the old code path.
    let binary = "";
    for (const b of BYTES) binary += String.fromCharCode(b);
    storage.raw.set("k3", { base64: btoa(binary), fileName: "old.pdf" });
    const got = await getReportPdf({}, storage, "k3");
    expect(got).not.toBeNull();
    expect(got!.fileName).toBe("old.pdf");
    expect(Array.from(got!.bytes)).toEqual(Array.from(BYTES));
  });

  it("returns null for missing keys", async () => {
    expect(await getReportPdf({}, storage, "nope")).toBeNull();
  });
});

describe("#605 R2 bucket layout (bucket 'screener': stocks/ + options/ prefixes)", () => {
  let storage: ReturnType<typeof makeStorage>;

  beforeEach(() => {
    storage = makeStorage();
  });

  function makeBucket() {
    const map = new Map<string, Uint8Array>();
    const bucket = {
      async put(key: string, value: Uint8Array) {
        map.set(key, value);
      },
      async get(key: string) {
        const bytes = map.get(key);
        if (!bytes) return null;
        return {
          customMetadata: { fileName: "from-r2.pdf" },
          async arrayBuffer() {
            return bytes.buffer as ArrayBuffer;
          },
        };
      },
    } as unknown as R2Bucket;
    return { bucket, map };
  }

  it("maps storage keys to bucket keys by family", () => {
    expect(r2KeyForStorageKey("screener:pdf:abc123")).toBe("stocks/pdf/abc123");
    expect(r2KeyForStorageKey("screener:latest.pdf")).toBe("stocks/latest.pdf");
    expect(r2KeyForStorageKey("screener:xlsx:xyz")).toBe("stocks/xlsx/xyz");
    expect(r2KeyForStorageKey("screener:latest.xlsx")).toBe("stocks/latest.xlsx");
    expect(r2KeyForStorageKey("options:pdf:def456")).toBe("options/pdf/def456");
    expect(r2KeyForStorageKey("options:latest.pdf")).toBe("options/latest.pdf");
    expect(r2KeyForStorageKey("k2")).toBe("k2");
  });

  it("put writes screener blobs under stocks/ and stores the mapped pointer", async () => {
    const { bucket, map } = makeBucket();
    await putReportPdf({ REPORTS_BUCKET: bucket }, storage, "screener:pdf:abc123", "a.pdf", BYTES);
    expect([...map.keys()]).toEqual(["stocks/pdf/abc123"]);
    const meta = storage.raw.get("screener:pdf:abc123") as { r2Key?: string; base64?: string };
    expect(meta.r2Key).toBe("stocks/pdf/abc123");
    expect(meta.base64).toBeUndefined();
    const got = await getReportPdf({ REPORTS_BUCKET: bucket }, storage, "screener:pdf:abc123");
    expect(got!.fileName).toBe("a.pdf");
    expect(Array.from(got!.bytes)).toEqual(Array.from(BYTES));
  });

  it("put writes options blobs under options/", async () => {
    const { bucket, map } = makeBucket();
    await putReportPdf({ REPORTS_BUCKET: bucket }, storage, "options:pdf:def456", "o.pdf", BYTES);
    expect([...map.keys()]).toEqual(["options/pdf/def456"]);
  });

  it("lazily migrates a legacy base64 blob to R2 on first read (pointer rewrite, bytes preserved)", async () => {
    const { bucket, map } = makeBucket();
    let binary = "";
    for (const b of BYTES) binary += String.fromCharCode(b);
    storage.raw.set("screener:pdf:old1", { base64: btoa(binary), fileName: "old.pdf", storedAt: "2026-10-01T00:00:00.000Z" });
    const got = await getReportPdf({ REPORTS_BUCKET: bucket }, storage, "screener:pdf:old1");
    expect(got!.fileName).toBe("old.pdf");
    expect(Array.from(got!.bytes)).toEqual(Array.from(BYTES));
    expect([...map.keys()]).toEqual(["stocks/pdf/old1"]);
    const meta = storage.raw.get("screener:pdf:old1") as { r2Key?: string; base64?: string };
    expect(meta.r2Key).toBe("stocks/pdf/old1");
    expect(meta.base64).toBeUndefined();
  });

  it("direct R2 read (no DO pointer) resolves through the mapped key", async () => {
    const { bucket, map } = makeBucket();
    map.set("options/pdf/direct1", BYTES);
    const got = await getReportPdf({ REPORTS_BUCKET: bucket }, storage, "options:pdf:direct1");
    expect(got).not.toBeNull();
    expect(Array.from(got!.bytes)).toEqual(Array.from(BYTES));
  });
});
