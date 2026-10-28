/**
 * Issue #2120 (slice 1): thin REST routes for the Search hub.
 *
 * Two POST routes, no new envelope, no new store, no new binding:
 * - POST /search/agent -> ETradeAISearchService.searchFinancialDocs
 *   (service-native AISearchQueryResponse: query/results/totalMatches/
 *   provider/timestamp). The service's fallback branch is untouched
 *   (S3, probe-first); the tab renders `provider` honestly per result
 *   set (cloudflare_ai_search vs semantic_cache).
 * - POST /search/knowledge -> searchPlatformKnowledge, PLATFORM MODE
 *   ONLY: the catalog function is called directly, with no AI-endpoint
 *   attempt and no blend, so agent chunks and catalog entries never
 *   conflate. Returns the catalog-native shape (query/count/results/
 *   formattedAnswer); relevanceScore is the catalog's keyword
 *   relevance, not an index score — the tab discloses that.
 *
 * The hub does NOT depend on KNOWLEDGE_SERVING_ENABLED: the flag gates
 * mapping/serving, not queries, and neither route checks it.
 * Session gate: the shared 401 (routeIdentity.unauthenticatedResponse)
 * when no login is present, mirroring knowledgeCorpus.
 */
import { ETradeAISearchService } from "../../services/aiSearch";
import { searchPlatformKnowledge } from "../../services/platformKnowledge";
import { unauthenticatedResponse } from "./routeIdentity";
import type { Env } from "../../types";

export interface SearchHubRouteContext {
  env?: Env;
  userLogin?: string;
}

export async function handleSearchHubRoutes(
  request: Request,
  url: URL,
  path: string,
  sessionId: string,
  ctx: SearchHubRouteContext
): Promise<Response | null> {
  if (path.endsWith("/search/agent") && request.method === "POST") {
    const login = ctx.userLogin || request.headers.get("x-user-login") || "";
    if (!login) return unauthenticatedResponse();
    const body = (await request.json().catch(() => ({}))) as {
      query?: string;
      limit?: number;
    };
    const query = (body.query || "").trim();
    if (!query) {
      return Response.json({ error: "Query parameter is required" }, { status: 400 });
    }
    const limit = typeof body.limit === "number" && body.limit > 0 ? body.limit : 5;
    const service = new ETradeAISearchService(ctx.env);
    const result = await service.searchFinancialDocs(query, limit);
    return Response.json(result);
  }

  if (path.endsWith("/search/knowledge") && request.method === "POST") {
    const login = ctx.userLogin || request.headers.get("x-user-login") || "";
    if (!login) return unauthenticatedResponse();
    const body = (await request.json().catch(() => ({}))) as {
      query?: string;
      category?: string;
      maxResults?: number;
    };
    const query = (body.query || "").trim();
    if (!query) {
      return Response.json({ error: "Query parameter is required" }, { status: 400 });
    }
    const result = searchPlatformKnowledge(query, {
      maxResults: typeof body.maxResults === "number" && body.maxResults > 0 ? body.maxResults : 8,
      category: typeof body.category === "string" && body.category ? body.category : undefined,
    });
    return Response.json(result);
  }

  return null;
}
