/**
 * Issue #1133 (E1 of epic #1116): the provider capture store — every
 * retrieval routed through the data-provider platform leaves a
 * capture: what the provider returned (raw), what the platform
 * normalized it to (digest), which run fetched it, and under which
 * tenant scope. Metadata lives in `mas_data_captures` (service-owned
 * DDL in the mas_* pattern, like providerConfigStore.ts); raw payloads
 * live as blobs behind the reportBlobStore seam's duality (below).
 *
 * Before this store, raw provider responses were stored NOWHERE (the
 * #1116 survey): E*TRADE/Yahoo/Alpaca JSON was parsed, normalized, and
 * discarded, so no run could be reconstructed, audited against the
 * provider's actual response, replayed, or compared across providers.
 * For options chains this store SUPERSEDES the inert
 * `mas_options_chain_cache` table (DDL exists in src/orm/index.ts but
 * no writer ever landed); that table is not dropped in this slice.
 *
 * RAW FIDELITY — the deepest seam the platform path can reach.
 * The literal wire body TEXT is not captured in this slice:
 * ETradeRestClient consumes it via `res.json()` (src/trading/etrade/
 * client.ts), and intercepting the text would bypass
 * ETradeService.fetchQuoteRemote's live-error / sandbox-stub
 * semantics (src/services/etrade.ts) or intercept the global fetch —
 * both change what callers receive. What the capture stores instead
 * is the parsed JSON object exactly as `res.json()` produced it
 * (byte-for-byte at the JSON level), surfaced through the client's
 * additive, opt-in includeRawResponse hooks — pre-existing for
 * chains, added for quotes by this slice — which leave every
 * existing caller's behaviour and return shapes untouched. What IS
 * reachable, per capability, and what the capture's `rawKind`
 * honestly records:
 *
 *   optionsChains → "provider-response": the adapter requests the
 *     REST client's pre-existing includeRawResponse hook
 *     (client.ts getOptionChains), which attaches the parsed
 *     OptionChainResponse object — the provider's response payload
 *     before normalization. The capture serializes that object exactly
 *     as received (JSON.stringify preserves the parsed key order and
 *     values), so the stored bytes reproduce the response payload
 *     byte-for-byte at the JSON level.
 *   quotes → "provider-response": fetchQuoteDetailed carries the
 *     same includeRawResponse hook as chains (added for this slice;
 *     ETradeService.getQuoteAsync / fetchQuoteRemote forward it), so
 *     the adapter requests it and the parsed QuoteResponse wire
 *     object rides the quote as `raw` (ETradeQuote.raw) — the capture
 *     stores that object, serialized exactly as received, and the
 *     adapter strips the echo from the quote its caller receives.
 *   fallback → "provider-result": when the wrapped surface does not
 *     honor the hook (no `raw` on the returned chain/quote — e.g. the
 *     sandbox platform quote path, which has no wire payload), the
 *     service's result object is the deepest payload in existence
 *     downstream, so it is what is captured, labeled as the result
 *     seam — never dressed up as a wire body.
 *
 * BLOB SEAM. Raw payloads ride the reportBlobStore seam's contract —
 * a BlobStorage get/put store plus `env.REPORTS_BUCKET`: R2 when the
 * bucket is bound (metadata pointer left in DO storage), base64 in DO
 * storage otherwise — so the #605 bucket decision needs no capture
 * redesign when it lands. reportBlobStore's own exports are
 * PDF-specific (they hardcode the application/pdf content type and a
 * PDF fileName), so the capture helpers below mirror the seam's
 * mechanics with JSON semantics instead of calling them.
 *
 * FAILURE SEMANTICS (epic Requirement 3). recordCapture NEVER throws:
 * a failed capture write leaves the fetch result untouched, logs a
 * structured error, and records a failure marker row (status
 * "capture_failed", failureError set) that the store's queries return
 * alongside successful captures — the audit trail shows its own gaps.
 * If even the marker cannot be written, the failure is logged and an
 * unpersisted marker record is returned.
 *
 * RETENTION. Every row carries a retention classification from day
 * one, using assessment-01 §8.1's classes (Ephemeral / Retained 30d /
 * Retained 365d / Permanent Audit). Default for provider captures:
 * "retained-365d". Enforcement scheduling is a later slice's concern.
 */

import type { SqlStorage } from "../../orm";
import type {
  DataProviderCapability,
  DataProviderId,
  DataRunContext,
} from "./contract";

export const DATA_CAPTURE_TABLE = "mas_data_captures";

/** Retention classifications — assessment-01 §8.1 target principles. */
export type DataCaptureRetentionClass =
  | "ephemeral"
  | "retained-30d"
  | "retained-365d"
  | "permanent-audit";

export const DEFAULT_CAPTURE_RETENTION_CLASS: DataCaptureRetentionClass =
  "retained-365d";

/**
 * Which seam supplied the raw payload (see the module header):
 * "provider-response" = the provider's pre-normalization response
 * payload; "provider-result" = the deepest object the seam exposes,
 * the wrapped implementation's result. A literal wire-body capture
 * ("wire-body") is not producible in this slice and is deliberately
 * absent from the vocabulary rather than claimed.
 */
export type DataCaptureRawKind = "provider-response" | "provider-result";

/**
 * captured     — raw payload stored, metadata complete.
 * capture_failed — the capture WRITE failed; the fetch succeeded.
 * no_payload   — the fetch completed with no payload to store (e.g. a
 *                null chain); an audit row exists so the run's trail
 *                is complete, but no raw is fabricated for it.
 */
export type DataCaptureStatus = "captured" | "capture_failed" | "no_payload";

export interface DataCaptureRecord {
  id: string;
  providerId: DataProviderId;
  capability: DataProviderCapability;
  /** The caller's request parameters, in canonical (normalized) form. */
  requestParams: Record<string, unknown>;
  runId: string;
  tenantId: string;
  userLogin: string | null;
  fetchedAt: string;
  status: DataCaptureStatus;
  rawKind: DataCaptureRawKind | null;
  /** Blob-seam key of the stored raw payload; null when nothing is stored. */
  rawBlobRef: string | null;
  rawByteSize: number | null;
  rawSha256: string | null;
  /** SHA-256 of the canonical JSON of the normalized result the caller received. */
  normalizedDigest: string | null;
  retentionClass: DataCaptureRetentionClass;
  failureError: string | null;
  createdAt: string;
}

/** The blob seam's storage half — the same shape reportBlobStore consumes. */
export interface CaptureBlobStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
}

/** The blob seam's env half — R2 when the #605 bucket gets bound. */
export interface CaptureBlobEnv {
  REPORTS_BUCKET?: R2Bucket;
}

export interface CaptureBlobDeps {
  storage: CaptureBlobStorage;
  env: CaptureBlobEnv;
}

export interface RecordCaptureInput {
  providerId: DataProviderId;
  capability: DataProviderCapability;
  /** The caller's request parameters (normalized to canonical JSON for storage). */
  requestParams: unknown;
  runId: string;
  tenantId: string;
  userLogin?: string | null;
  /**
   * The raw payload object as received at the seam. A string payload is
   * stored as its exact bytes (the future wire-body path); anything
   * else is serialized with JSON.stringify, preserving the received
   * key order. Omit for a completed fetch that produced no payload
   * (recorded as status "no_payload").
   */
  rawPayload?: unknown;
  /** Required in spirit when rawPayload is present; defaults to "provider-result". */
  rawKind?: DataCaptureRawKind;
  /** The normalized result the caller received; its canonical digest is stored. */
  normalizedResult?: unknown;
  retentionClass?: DataCaptureRetentionClass;
  /** Fetch timestamp override (tests / backfill); defaults to now. */
  fetchedAt?: string;
}

// ---------------------------------------------------------------------------
// Run-context resolution — no platform fetch is ever unattributable.
// ---------------------------------------------------------------------------

export function generateCollectionRunId(): string {
  return `collection-${crypto.randomUUID()}`;
}

export interface ResolvedRunContext {
  runId: string;
  tenantId: string;
  userLogin: string | null;
}

/**
 * Resolve a caller's optional run context to the concrete attribution
 * every capture carries: a missing runId becomes a generated
 * collection-run id, a missing tenant becomes "default" (the
 * platform's established default scope).
 */
export function resolveRunContext(
  ctx?: DataRunContext | null
): ResolvedRunContext {
  return {
    runId: ctx?.runId ?? generateCollectionRunId(),
    tenantId: ctx?.tenantId ?? "default",
    userLogin: ctx?.userLogin ?? null,
  };
}

// ---------------------------------------------------------------------------
// Canonical JSON + hashing — the normalized forms digests are taken over.
// ---------------------------------------------------------------------------

/**
 * Canonical JSON: object keys sorted recursively, so two structurally
 * equal values serialize identically regardless of construction
 * order. This is the NORMALIZED form (digests, stored request params)
 * — never used for raw payloads, which keep their received order.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
    .join(",")}}`;
}

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ---------------------------------------------------------------------------
// Blob seam — mirrors reportBlobStore's mechanics with JSON semantics.
// ---------------------------------------------------------------------------

interface CaptureBlobMeta {
  storedAt: string;
  /** Present when the blob lives in R2. Absent for DO-storage blobs. */
  r2Key?: string;
  /** DO-storage blobs only (pre-#605 binding). */
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

export async function putCaptureBlob(
  env: CaptureBlobEnv,
  storage: CaptureBlobStorage,
  key: string,
  bytes: Uint8Array
): Promise<void> {
  const bucket = env.REPORTS_BUCKET;
  if (bucket) {
    await bucket.put(key, bytes, {
      httpMetadata: { contentType: "application/json" },
      customMetadata: { captureKey: key },
    });
    const meta: CaptureBlobMeta = {
      storedAt: new Date().toISOString(),
      r2Key: key,
    };
    await storage.put(key, meta);
  } else {
    const meta: CaptureBlobMeta = {
      storedAt: new Date().toISOString(),
      base64: bytesToBase64(bytes),
    };
    await storage.put(key, meta);
  }
}

export async function getCaptureBlob(
  env: CaptureBlobEnv,
  storage: CaptureBlobStorage,
  key: string
): Promise<Uint8Array | null> {
  const meta = await storage.get<CaptureBlobMeta>(key).catch(() => undefined);
  if (!meta) return null;
  const bucket = env.REPORTS_BUCKET;
  if (bucket && meta.r2Key) {
    try {
      const obj = await bucket.get(meta.r2Key);
      if (!obj) return null;
      return new Uint8Array(await obj.arrayBuffer());
    } catch (err) {
      console.warn("[dataProviders] capture blob R2 read failed:", err);
      return null;
    }
  }
  if (meta.base64) return base64ToBytes(meta.base64);
  return null;
}

// ---------------------------------------------------------------------------
// Metadata table — mas_data_captures.
// ---------------------------------------------------------------------------

export function ensureCaptureTable(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS ${DATA_CAPTURE_TABLE} (
    id TEXT PRIMARY KEY,
    provider_id TEXT NOT NULL,
    capability TEXT NOT NULL,
    request_params_json TEXT NOT NULL DEFAULT '{}',
    run_id TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    user_login TEXT,
    fetched_at TEXT NOT NULL,
    status TEXT NOT NULL,
    raw_kind TEXT,
    raw_blob_ref TEXT,
    raw_byte_size INTEGER,
    raw_sha256 TEXT,
    normalized_digest TEXT,
    retention_class TEXT NOT NULL,
    failure_error TEXT,
    created_at TEXT NOT NULL
  )`);
  sql.exec(
    `CREATE INDEX IF NOT EXISTS idx_mas_data_captures_run ON ${DATA_CAPTURE_TABLE}(tenant_id, run_id)`
  );
  sql.exec(
    `CREATE INDEX IF NOT EXISTS idx_mas_data_captures_provider ON ${DATA_CAPTURE_TABLE}(tenant_id, provider_id)`
  );
}

function parseParams(text: unknown): Record<string, unknown> {
  if (typeof text !== "string" || text === "") return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function recordFromRow(r: any): DataCaptureRecord {
  return {
    id: r.id,
    providerId: r.provider_id,
    capability: r.capability,
    requestParams: parseParams(r.request_params_json),
    runId: r.run_id,
    tenantId: r.tenant_id,
    userLogin: r.user_login ?? null,
    fetchedAt: r.fetched_at,
    status: r.status,
    rawKind: r.raw_kind ?? null,
    rawBlobRef: r.raw_blob_ref ?? null,
    rawByteSize: r.raw_byte_size == null ? null : Number(r.raw_byte_size),
    rawSha256: r.raw_sha256 ?? null,
    normalizedDigest: r.normalized_digest ?? null,
    retentionClass: r.retention_class,
    failureError: r.failure_error ?? null,
    createdAt: r.created_at,
  };
}

function insertCaptureRow(sql: SqlStorage, record: DataCaptureRecord): void {
  ensureCaptureTable(sql);
  sql.exec(
    `INSERT INTO ${DATA_CAPTURE_TABLE}
     (id, provider_id, capability, request_params_json, run_id, tenant_id, user_login, fetched_at, status, raw_kind, raw_blob_ref, raw_byte_size, raw_sha256, normalized_digest, retention_class, failure_error, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    record.id,
    record.providerId,
    record.capability,
    canonicalJson(record.requestParams),
    record.runId,
    record.tenantId,
    record.userLogin,
    record.fetchedAt,
    record.status,
    record.rawKind,
    record.rawBlobRef,
    record.rawByteSize,
    record.rawSha256,
    record.normalizedDigest,
    record.retentionClass,
    record.failureError,
    record.createdAt
  );
}

/**
 * Record one capture. NEVER throws (see the header's failure
 * semantics): on success returns the stored record; on a write failure
 * returns the failure-marker record (persisted when the store allows,
 * unpersisted when it does not).
 */
export async function recordCapture(
  sql: SqlStorage,
  blobDeps: CaptureBlobDeps,
  input: RecordCaptureInput
): Promise<DataCaptureRecord> {
  const fetchedAt = input.fetchedAt ?? new Date().toISOString();
  const base: Omit<DataCaptureRecord, "status" | "rawKind" | "rawBlobRef" | "rawByteSize" | "rawSha256" | "normalizedDigest" | "failureError"> = {
    id: crypto.randomUUID(),
    providerId: input.providerId,
    capability: input.capability,
    requestParams: parseParams(canonicalJson(input.requestParams ?? {})),
    runId: input.runId,
    tenantId: input.tenantId,
    userLogin: input.userLogin ?? null,
    fetchedAt,
    retentionClass: input.retentionClass ?? DEFAULT_CAPTURE_RETENTION_CLASS,
    createdAt: fetchedAt,
  };
  const rawKind: DataCaptureRawKind | null =
    input.rawPayload === undefined
      ? null
      : (input.rawKind ?? "provider-result");
  let rawBytes: Uint8Array | null = null;
  let rawSha256: string | null = null;
  let normalizedDigest: string | null = null;

  try {
    if (input.normalizedResult !== undefined) {
      normalizedDigest = await sha256Hex(canonicalJson(input.normalizedResult));
    }
    if (input.rawPayload === undefined) {
      const record: DataCaptureRecord = {
        ...base,
        status: "no_payload",
        rawKind: null,
        rawBlobRef: null,
        rawByteSize: null,
        rawSha256: null,
        normalizedDigest,
        failureError:
          "Provider returned no payload for this request; no raw response was available at the adapter seam.",
      };
      insertCaptureRow(sql, record);
      return getCaptureById(sql, base.tenantId, base.id) ?? record;
    }
    rawBytes =
      typeof input.rawPayload === "string"
        ? new TextEncoder().encode(input.rawPayload)
        : new TextEncoder().encode(JSON.stringify(input.rawPayload));
    rawSha256 = await sha256Hex(rawBytes);
    const blobRef = `data-capture:${base.tenantId}:${base.id}`;
    await putCaptureBlob(blobDeps.env, blobDeps.storage, blobRef, rawBytes);
    const record: DataCaptureRecord = {
      ...base,
      status: "captured",
      rawKind,
      rawBlobRef: blobRef,
      rawByteSize: rawBytes.byteLength,
      rawSha256,
      normalizedDigest,
      failureError: null,
    };
    insertCaptureRow(sql, record);
    return getCaptureById(sql, base.tenantId, base.id) ?? record;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[dataProviders] capture write failed", {
      captureId: base.id,
      providerId: base.providerId,
      capability: base.capability,
      runId: base.runId,
      tenantId: base.tenantId,
      error: message,
    });
    const marker: DataCaptureRecord = {
      ...base,
      status: "capture_failed",
      rawKind,
      rawBlobRef: null,
      rawByteSize: rawBytes?.byteLength ?? null,
      rawSha256,
      normalizedDigest,
      failureError: message,
    };
    try {
      insertCaptureRow(sql, marker);
      return getCaptureById(sql, base.tenantId, base.id) ?? marker;
    } catch (markerErr) {
      console.error("[dataProviders] capture failure marker write failed", {
        captureId: base.id,
        providerId: base.providerId,
        capability: base.capability,
        runId: base.runId,
        tenantId: base.tenantId,
        error:
          markerErr instanceof Error ? markerErr.message : String(markerErr),
      });
      return marker;
    }
  }
}

// ---------------------------------------------------------------------------
// Read-back — every query is tenant-scoped (assessment-01 §8.1: tenant
// context at the storage boundary). A cross-tenant query returns
// nothing, exactly as if the capture did not exist.
// ---------------------------------------------------------------------------

export function getCaptureById(
  sql: SqlStorage,
  tenantId: string,
  id: string
): DataCaptureRecord | null {
  ensureCaptureTable(sql);
  const rows = Array.from(
    sql.exec(
      `SELECT * FROM ${DATA_CAPTURE_TABLE} WHERE tenant_id = ? AND id = ?`,
      tenantId,
      id
    )
  ) as any[];
  return rows.length > 0 ? recordFromRow(rows[0]) : null;
}

function listCapturesWhere(
  sql: SqlStorage,
  tenantId: string,
  column: "run_id" | "provider_id" | "capability" | "status",
  value: string
): DataCaptureRecord[] {
  ensureCaptureTable(sql);
  const rows = Array.from(
    sql.exec(
      `SELECT * FROM ${DATA_CAPTURE_TABLE} WHERE tenant_id = ? AND ${column} = ? ORDER BY fetched_at ASC`,
      tenantId,
      value
    )
  ) as any[];
  return rows.map(recordFromRow);
}

/** Exactly the captures one run produced (including any failure markers). */
export function listCapturesByRun(
  sql: SqlStorage,
  tenantId: string,
  runId: string
): DataCaptureRecord[] {
  return listCapturesWhere(sql, tenantId, "run_id", runId);
}

export function listCapturesByProvider(
  sql: SqlStorage,
  tenantId: string,
  providerId: DataProviderId
): DataCaptureRecord[] {
  return listCapturesWhere(sql, tenantId, "provider_id", providerId);
}

export function listCapturesByCapability(
  sql: SqlStorage,
  tenantId: string,
  capability: DataProviderCapability
): DataCaptureRecord[] {
  return listCapturesWhere(sql, tenantId, "capability", capability);
}

/** The visible gaps in the audit trail: captures whose write failed. */
export function listCaptureFailures(
  sql: SqlStorage,
  tenantId: string
): DataCaptureRecord[] {
  return listCapturesWhere(sql, tenantId, "status", "capture_failed");
}

/**
 * Read one capture back in full: its metadata plus the raw payload
 * byte-for-byte. rawBytes is null when the capture stored no payload
 * (no_payload / capture_failed) or its blob is missing.
 */
export async function readCaptureRaw(
  sql: SqlStorage,
  blobDeps: CaptureBlobDeps,
  tenantId: string,
  id: string
): Promise<{ record: DataCaptureRecord; rawBytes: Uint8Array | null } | null> {
  const record = getCaptureById(sql, tenantId, id);
  if (!record) return null;
  if (!record.rawBlobRef) return { record, rawBytes: null };
  const rawBytes = await getCaptureBlob(
    blobDeps.env,
    blobDeps.storage,
    record.rawBlobRef
  );
  return { record, rawBytes };
}
