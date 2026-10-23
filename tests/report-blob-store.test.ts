import { describe, it, expect, beforeEach } from "vitest";
import { putReportPdf, getReportPdf } from "../src/services/reportBlobStore";

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
    // #605 folder mapping: a non-options key maps under stocks/ in the bucket.
    const meta = storage.raw.get("k2") as { r2Key?: string; base64?: string };
    expect(meta.r2Key).toBe("stocks/k2");
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

describe("#605 R2 folder mapping (bucket 'screener': options/ + stocks/)", () => {
  let storage: ReturnType<typeof makeStorage>;

  beforeEach(() => {
    storage = makeStorage();
  });

  function makeBucket() {
    const objects = new Map<
      string,
      { bytes: Uint8Array; customMetadata?: Record<string, string> }
    >();
    const calls: string[] = [];
    const bucket = {
      async put(
        key: string,
        value: Uint8Array,
        opts?: { customMetadata?: Record<string, string> }
      ) {
        calls.push(`put:${key}`);
        objects.set(key, { bytes: value, customMetadata: opts?.customMetadata });
      },
      async get(key: string) {
        calls.push(`get:${key}`);
        const rec = objects.get(key);
        if (!rec) return null;
        return {
          customMetadata: rec.customMetadata,
          async arrayBuffer() {
            return rec.bytes.buffer as ArrayBuffer;
          },
        };
      },
    } as unknown as R2Bucket;
    return { bucket, objects, calls };
  }

  it("bucket-bound put writes the object at the mapped r2Key; meta holds the pointer and no base64", async () => {
    const { bucket, objects } = makeBucket();
    await putReportPdf(
      { REPORTS_BUCKET: bucket },
      storage,
      "screener:pdf:run-1",
      "screen.pdf",
      BYTES
    );
    // The R2 object lives at the mapped key only — never at the raw key.
    expect(objects.has("stocks/screener:pdf:run-1")).toBe(true);
    expect(objects.has("screener:pdf:run-1")).toBe(false);
    // The DO metadata record stays keyed by the ORIGINAL storage key.
    const meta = storage.raw.get("screener:pdf:run-1") as {
      r2Key?: string;
      base64?: string;
      fileName?: string;
    };
    expect(meta.r2Key).toBe("stocks/screener:pdf:run-1");
    expect(meta.base64).toBeUndefined();
    expect(meta.fileName).toBe("screen.pdf");
  });

  it("options-family keys map under options/; screener + research + report-asset keys under stocks/", async () => {
    const { bucket, objects } = makeBucket();
    const cases: Array<[string, string]> = [
      // Options family (screener-agent options PDFs + report-asset type).
      ["options:pdf:scan-1", "options/options:pdf:scan-1"],
      ["options:latest.pdf", "options/options:latest.pdf"],
      ["report:pdf:options:ab12cd34", "options/report:pdf:options:ab12cd34"],
      // Everything else → stocks/.
      ["screener:pdf:run-1", "stocks/screener:pdf:run-1"],
      ["screener:latest.pdf", "stocks/screener:latest.pdf"],
      ["research:pdf:deep-dive.pdf", "stocks/research:pdf:deep-dive.pdf"],
      ["research:pdf:latest", "stocks/research:pdf:latest"],
      ["report:pdf:screener:ab12cd34", "stocks/report:pdf:screener:ab12cd34"],
      ["report:pdf:research:ab12cd34", "stocks/report:pdf:research:ab12cd34"],
    ];
    for (const [key, mapped] of cases) {
      await putReportPdf({ REPORTS_BUCKET: bucket }, storage, key, "f.pdf", BYTES);
      expect(objects.has(mapped)).toBe(true);
      const meta = storage.raw.get(key) as { r2Key?: string };
      expect(meta.r2Key).toBe(mapped);
    }
    expect(objects.size).toBe(cases.length);
  });

  it("get reads back through meta.r2Key (the mapped key)", async () => {
    const { bucket, calls } = makeBucket();
    await putReportPdf(
      { REPORTS_BUCKET: bucket },
      storage,
      "options:pdf:scan-9",
      "opts.pdf",
      BYTES
    );
    calls.length = 0;
    const got = await getReportPdf(
      { REPORTS_BUCKET: bucket },
      storage,
      "options:pdf:scan-9"
    );
    expect(got).not.toBeNull();
    expect(got!.fileName).toBe("opts.pdf");
    expect(Array.from(got!.bytes)).toEqual(Array.from(BYTES));
    expect(calls).toContain("get:options/options:pdf:scan-9");
  });

  it("no-metadata direct-R2 fallback tries the mapped key", async () => {
    const { bucket, objects } = makeBucket();
    // Object exists in R2 at the mapped key but there is no DO meta record.
    objects.set("options/options:pdf:direct", {
      bytes: BYTES,
      customMetadata: { fileName: "direct.pdf" },
    });
    const got = await getReportPdf(
      { REPORTS_BUCKET: bucket },
      storage,
      "options:pdf:direct"
    );
    expect(got).not.toBeNull();
    expect(got!.fileName).toBe("direct.pdf");
    expect(Array.from(got!.bytes)).toEqual(Array.from(BYTES));
  });

  it("legacy base64 meta still reads with the bucket bound", async () => {
    const { bucket } = makeBucket();
    let binary = "";
    for (const b of BYTES) binary += String.fromCharCode(b);
    storage.raw.set("screener:pdf:legacy", {
      base64: btoa(binary),
      fileName: "legacy.pdf",
    });
    const got = await getReportPdf(
      { REPORTS_BUCKET: bucket },
      storage,
      "screener:pdf:legacy"
    );
    expect(got).not.toBeNull();
    expect(got!.fileName).toBe("legacy.pdf");
    expect(Array.from(got!.bytes)).toEqual(Array.from(BYTES));
  });

  it("unbound path is unchanged: base64 in DO storage, no r2Key, no R2 object", async () => {
    const { bucket, objects } = makeBucket();
    await putReportPdf({}, storage, "screener:pdf:nobind", "nb.pdf", BYTES);
    const meta = storage.raw.get("screener:pdf:nobind") as {
      r2Key?: string;
      base64?: string;
    };
    expect(meta.r2Key).toBeUndefined();
    expect(meta.base64).toBeDefined();
    expect(objects.size).toBe(0);
    // A bucket appearing later does not disturb the legacy read.
    const got = await getReportPdf(
      { REPORTS_BUCKET: bucket },
      storage,
      "screener:pdf:nobind"
    );
    expect(got).not.toBeNull();
    expect(Array.from(got!.bytes)).toEqual(Array.from(BYTES));
  });
});
