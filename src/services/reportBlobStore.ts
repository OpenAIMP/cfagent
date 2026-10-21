/**
 * Report PDF blob storage (issue #605, part of #415).
 *
 * PDF blobs move from base64-in-DO-storage to R2. The migration is designed
 * to be safe to merge BEFORE the bucket exists:
 *
 * - When `env.REPORTS_BUCKET` is bound, blobs go to R2 (keyed by the storage
 *   key) and DO storage keeps only a small metadata pointer
 *   `{ r2Key, fileName, storedAt }`.
 * - When the binding is absent (pre-migration), blobs stay in DO storage as
 *   base64, exactly as before.
 * - Reads try R2 first (via the metadata pointer), then fall back to the
 *   legacy base64 blob — so PDFs stored before the migration stay readable.
 *
 * The PDF is always a delivery artifact rendered from the canonical stored
 * copy in mas_reports (#308 model) — never a second copy of the report.
 */

interface BlobStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
}

interface ReportPdfMeta {
  fileName: string;
  storedAt: string;
  /** Present when the blob lives in R2. Absent for legacy DO-storage blobs. */
  r2Key?: string;
  /** Legacy pre-#605 blobs only. */
  base64?: string;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export async function putReportPdf(
  env: { REPORTS_BUCKET?: R2Bucket },
  storage: BlobStorage,
  key: string,
  fileName: string,
  bytes: Uint8Array
): Promise<void> {
  const bucket = env.REPORTS_BUCKET;
  if (bucket) {
    await bucket.put(key, bytes, {
      httpMetadata: { contentType: "application/pdf" },
      customMetadata: { fileName },
    });
    const meta: ReportPdfMeta = {
      fileName,
      r2Key: key,
      storedAt: new Date().toISOString(),
    };
    await storage.put(key, meta);
  } else {
    // Pre-migration: keep the legacy DO-storage blob.
    const meta: ReportPdfMeta = {
      fileName,
      base64: bytesToBase64(bytes),
      storedAt: new Date().toISOString(),
    };
    await storage.put(key, meta);
  }
}

export async function getReportPdf(
  env: { REPORTS_BUCKET?: R2Bucket },
  storage: BlobStorage,
  key: string
): Promise<{ bytes: Uint8Array; fileName: string } | null> {
  const meta = await storage.get<ReportPdfMeta>(key).catch(() => undefined);
  if (!meta) {
    const bucket = env.REPORTS_BUCKET;
    if (bucket) {
      try {
        const obj = await bucket.get(key);
        if (obj) {
          const bytes = new Uint8Array(await obj.arrayBuffer());
          const fileName = obj.customMetadata?.fileName || `${key.split(":").pop() || "report"}.pdf`;
          return { bytes, fileName };
        }
      } catch (err) {
        console.warn("[reportBlobStore] Direct R2 read failed:", err);
      }
    }
    return null;
  }
  const bucket = env.REPORTS_BUCKET;
  if (bucket && meta.r2Key) {
    try {
      const obj = await bucket.get(meta.r2Key);
      if (!obj) return null;
      const bytes = new Uint8Array(await obj.arrayBuffer());
      return { bytes, fileName: meta.fileName };
    } catch (err) {
      console.warn("[reportBlobStore] R2 read failed, trying legacy:", err);
    }
  }
  if (meta.base64) {
    return { bytes: base64ToBytes(meta.base64), fileName: meta.fileName };
  }
  return null;
}
