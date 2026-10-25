/**
 * Knowledge-corpus storage (issue #1169, S1).
 *
 * Corpus documents live in the SAME `screener` R2 bucket as reports
 * (REPORTS_BUCKET binding) — no second bucket, no new storage stack.
 * The key family is the declared `knowledge:` namespace in
 * r2KeyForStorageKey (reportBlobStore.ts, approved gate G3):
 *   storage key `knowledge:<category>:<sha256>` →
 *   bucket key  `knowledge/<category>/<sha256>`.
 *
 * Metadata on every document (all five required fields, typed):
 * title, category, source URL, ingested-at, content hash (SHA-256 hex
 * of the stored bytes). The DO-storage record holds only the metadata
 * pointer, never the bytes — the same shape as putReportPdf.
 *
 * Honesty rules (live-data only):
 * - Writes are hash-idempotent: the key derives from the content hash,
 *   so a second put of identical bytes is a no-op returning the
 *   original metadata (first title wins).
 * - Reads are hash-verified: bytes whose recomputed hash differs from
 *   the recorded hash are never served (null + warning).
 * - No bucket binding means honest failure (throw), never a silent
 *   DO-storage fallback: corpus bytes belong in R2 or nowhere.
 * - Access is session-gated at the call site: every function requires
 *   a non-empty ownerLogin (the verified session login the route
 *   layer passes through). The corpus is organization knowledge, so
 *   the gate is authentication, not per-tenant partitioning — keys
 *   are not namespaced by login.
 *
 * #1168 EXCLUSION (recorded here per #1169's Requirements; #1168
 * itself stays open and unsolved, its cross-instance key-collection
 * design question is CTO's): knowledge/ keys are corpus, not reports.
 * They deliberately have NO mas_reports row, so the #1168 orphan sweep
 * (which collects bucket objects with no mas_reports row pointing at
 * them) must exclude the knowledge/ prefix. Excluding them is not a
 * loophole — it is the definition: a sweep for orphaned REPORTS must
 * not delete the corpus.
 *
 * Out of scope for S1 (later slices): the serving route (S2), the
 * index (S2), fallback removal (S3), consumers + UI (S4), corpus
 * listing (S4 — DO storage here has get/put only, no key listing).
 */

import { r2KeyForStorageKey } from "./reportBlobStore";

export type KnowledgeCategory =
  | "sec_filing"
  | "broker_rules"
  | "options_disclosure"
  | "market_education";

export const KNOWLEDGE_CATEGORIES: readonly KnowledgeCategory[] = [
  "sec_filing",
  "broker_rules",
  "options_disclosure",
  "market_education",
];

export interface KnowledgeDocMeta {
  title: string;
  category: KnowledgeCategory;
  sourceUrl: string;
  ingestedAt: string;
  /** SHA-256 hex of the stored bytes. */
  contentHash: string;
  r2Key: string;
  fileName: string;
  contentType: string;
}

export class KnowledgeCorpusError extends Error {}

interface BlobStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
}

type CorpusEnv = { REPORTS_BUCKET?: R2Bucket };

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // Copy into a fresh ArrayBuffer-backed view: subtle.digest's
  // BufferSource requires ArrayBufferView<ArrayBuffer>, and a caller's
  // Uint8Array may be backed by a SharedArrayBuffer-like buffer.
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function knowledgeStorageKey(category: KnowledgeCategory, contentHash: string): string {
  return `knowledge:${category}:${contentHash}`;
}

function isKnowledgeCategory(value: unknown): value is KnowledgeCategory {
  return (
    typeof value === "string" &&
    (KNOWLEDGE_CATEGORIES as readonly string[]).includes(value)
  );
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export interface PutKnowledgeDocInput {
  title: string;
  category: KnowledgeCategory;
  sourceUrl: string;
  bytes: Uint8Array;
  contentType?: string;
  fileName?: string;
}

export interface PutKnowledgeDocResult {
  meta: KnowledgeDocMeta;
  /** True when identical bytes were already stored (no rewrite). */
  idempotent: boolean;
}

export async function putKnowledgeDoc(
  env: CorpusEnv,
  storage: BlobStorage,
  ownerLogin: string,
  input: PutKnowledgeDocInput
): Promise<PutKnowledgeDocResult> {
  if (!ownerLogin) {
    throw new KnowledgeCorpusError(
      "Unauthorized: corpus ingestion requires an authenticated session."
    );
  }
  if (typeof input.title !== "string" || input.title.trim().length === 0) {
    throw new KnowledgeCorpusError("Corpus document title must be a non-empty string.");
  }
  if (!isKnowledgeCategory(input.category)) {
    throw new KnowledgeCorpusError(
      `Corpus document category must be one of ${KNOWLEDGE_CATEGORIES.join(", ")}.`
    );
  }
  if (!isHttpUrl(input.sourceUrl)) {
    throw new KnowledgeCorpusError("Corpus document sourceUrl must be an http(s) URL.");
  }
  if (!(input.bytes instanceof Uint8Array) || input.bytes.length === 0) {
    throw new KnowledgeCorpusError("Corpus document bytes must be non-empty.");
  }
  const contentHash = await sha256Hex(input.bytes);
  const key = knowledgeStorageKey(input.category, contentHash);
  const existing = await storage.get<KnowledgeDocMeta>(key).catch(() => undefined);
  if (existing && existing.contentHash === contentHash) {
    return { meta: existing, idempotent: true };
  }
  const bucket = env.REPORTS_BUCKET;
  if (!bucket) {
    throw new KnowledgeCorpusError(
      "REPORTS_BUCKET is not bound; corpus ingestion requires the screener bucket."
    );
  }
  const contentType = input.contentType || "application/octet-stream";
  const fileName = input.fileName || `${input.category}-${contentHash.slice(0, 12)}`;
  const r2Key = r2KeyForStorageKey(key);
  await bucket.put(r2Key, input.bytes, {
    httpMetadata: { contentType },
    customMetadata: {
      fileName,
      title: input.title,
      category: input.category,
      sourceUrl: input.sourceUrl,
      contentHash,
    },
  });
  const meta: KnowledgeDocMeta = {
    title: input.title,
    category: input.category,
    sourceUrl: input.sourceUrl,
    ingestedAt: new Date().toISOString(),
    contentHash,
    r2Key,
    fileName,
    contentType,
  };
  await storage.put(key, meta);
  return { meta, idempotent: false };
}

export async function getKnowledgeDoc(
  env: CorpusEnv,
  storage: BlobStorage,
  ownerLogin: string,
  key: string
): Promise<{ bytes: Uint8Array; meta: KnowledgeDocMeta } | null> {
  if (!ownerLogin) {
    throw new KnowledgeCorpusError(
      "Unauthorized: corpus reads require an authenticated session."
    );
  }
  const meta = await storage.get<KnowledgeDocMeta>(key).catch(() => undefined);
  if (!meta) return null;
  const bucket = env.REPORTS_BUCKET;
  if (!bucket) {
    throw new KnowledgeCorpusError(
      "REPORTS_BUCKET is not bound; corpus bytes are unreachable without the screener bucket."
    );
  }
  let obj: R2ObjectBody | null;
  try {
    obj = await bucket.get(meta.r2Key);
  } catch (err) {
    console.warn("[knowledgeCorpus] R2 read failed:", err);
    return null;
  }
  if (!obj) return null;
  const bytes = new Uint8Array(await obj.arrayBuffer());
  if ((await sha256Hex(bytes)) !== meta.contentHash) {
    console.warn(
      `[knowledgeCorpus] Hash mismatch for ${meta.r2Key}: stored bytes do not match recorded contentHash; refusing to serve.`
    );
    return null;
  }
  return { bytes, meta };
}
