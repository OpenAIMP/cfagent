/**
 * Issue #1169 (S1): knowledge-corpus admin/API upload route (approved
 * gate G4 — API upload first; repo-sync deferred to a later slice).
 *
 *   POST /knowledge/corpus   (externally /api/knowledge/corpus)
 *   JSON body: { title, category, sourceUrl, contentType?, fileName?,
 *                contentBase64 }
 *
 * The body carries base64 (not multipart) mirroring the repo's
 * DO-storage precedent; admin uploads are infrequent and small
 * (seed documents are KBs to low MBs — see
 * docs/knowledge-corpus-seed-manifest.json).
 *
 * Responses:
 * - 201 + full metadata + idempotent:false on a fresh ingest.
 * - 200 + original metadata + idempotent:true when identical bytes
 *   were already stored (hash-idempotent, first title wins).
 * - 401 (shared unauthenticatedResponse) when the x-user-login
 *   header is absent — server.ts sets it from the verified session
 *   and strips it for anonymous traffic (routeIdentity.ts).
 * - 400 on malformed JSON, wrong field types, invalid category,
 *   empty title/bytes, non-http(s) source URL, undecodable base64.
 * - 500 only on an unexpected failure; validation and bucket-binding
 *   failures are honest 400s via KnowledgeCorpusError.
 *
 * Exactly ONE path condition lives in this module (the inventory
 * scanner pins it): a single endsWith condition on /knowledge/corpus
 * combined with the POST method.
 * Non-matching paths/methods return null so routeRequest falls
 * through to the next handler.
 *
 * S1 scope is POST only: the GET serving route is S2's slice, which
 * will stream bytes through getKnowledgeDoc (hash-verified) the way
 * GET /screener/report.pdf streams reports today.
 *
 * #1168 note: knowledge/ keys are corpus, not reports — they carry
 * no mas_reports row by design and are excluded from the #1168
 * orphan sweep (see knowledgeCorpus.ts header).
 */

import { unauthenticatedResponse } from "./routeIdentity";
import { base64ToBytes } from "../../services/reportBlobStore";
import {
  putKnowledgeDoc,
  KnowledgeCorpusError,
  type KnowledgeCategory,
} from "../../services/knowledgeCorpus";

interface BlobStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
}

export interface KnowledgeCorpusRouteContext {
  env: { REPORTS_BUCKET?: R2Bucket };
  storage: BlobStorage;
  userLogin: string;
}

function badRequest(message: string): Response {
  return Response.json({ success: false, error: message }, { status: 400 });
}

export async function handleKnowledgeCorpusRoutes(
  request: Request,
  url: URL,
  path: string,
  sessionId: string,
  ctx: KnowledgeCorpusRouteContext
): Promise<Response | null> {
  if (path.endsWith("/knowledge/corpus") && request.method === "POST") {
    try {
      if (!ctx.userLogin) return unauthenticatedResponse();
      let body: Record<string, unknown>;
      try {
        body = (await request.json()) as Record<string, unknown>;
      } catch {
        return badRequest("Request body must be valid JSON.");
      }
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return badRequest("Request body must be a JSON object.");
      }
      const { title, category, sourceUrl, contentType, fileName, contentBase64 } = body;
      if (typeof title !== "string" || title.trim().length === 0) {
        return badRequest("Field 'title' must be a non-empty string.");
      }
      if (typeof category !== "string") {
        return badRequest("Field 'category' must be a string.");
      }
      if (typeof sourceUrl !== "string" || sourceUrl.trim().length === 0) {
        return badRequest("Field 'sourceUrl' must be a non-empty string.");
      }
      if (typeof contentBase64 !== "string" || contentBase64.length === 0) {
        return badRequest("Field 'contentBase64' must be a non-empty base64 string.");
      }
      if (contentType !== undefined && typeof contentType !== "string") {
        return badRequest("Field 'contentType' must be a string when present.");
      }
      if (fileName !== undefined && typeof fileName !== "string") {
        return badRequest("Field 'fileName' must be a string when present.");
      }
      let bytes: Uint8Array;
      try {
        bytes = base64ToBytes(contentBase64);
      } catch {
        return badRequest("Field 'contentBase64' is not valid base64.");
      }
      const result = await putKnowledgeDoc(ctx.env, ctx.storage, ctx.userLogin, {
        title,
        category: category as KnowledgeCategory,
        sourceUrl,
        bytes,
        contentType,
        fileName,
      });
      return Response.json(
        { success: true, ...result.meta, idempotent: result.idempotent },
        { status: result.idempotent ? 200 : 201 }
      );
    } catch (err) {
      if (err instanceof KnowledgeCorpusError) {
        return badRequest(err.message);
      }
      console.error("[knowledgeCorpus] Upload failed:", err);
      return Response.json(
        { success: false, error: "Failed to ingest knowledge document." },
        { status: 500 }
      );
    }
  }
  return null;
}
