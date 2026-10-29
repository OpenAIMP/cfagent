/**
 * Issue #2223 (AiSearchAgent slice) — the agent's three-path search
 * runner. Kept OUT of the class module on purpose: the Think/Agents
 * module graph cannot load under Node vitest, so the behavior that
 * needs pins lives here, free of the class graph (the same split
 * slice 1 used: standalone dispatch module + thin class).
 *
 * The agent reaches the SAME Cloudflare AI Search instance the
 * SearchHub knowledge surface serves (src/agents/routes/searchHub.ts:
 * POST /search/agent -> ETradeAISearchService over the shared
 * AI_SEARCH_ENDPOINT var — the instance configuration is NOT
 * re-vocabularied here; AI_SEARCH_INSTANCE and AI_SEARCH_MCP_ENDPOINT
 * are additive config for the other two doors onto that instance).
 *
 * Access paths, in the priority order set by the user directive of
 * 2026-10-29 (tool first, MCP second, API last-resort):
 *
 * 1. namespace (PRIMARY) — the ai_search_namespaces binding:
 *    env.AI_SEARCH.get(AI_SEARCH_INSTANCE).search({ messages }).
 *    This is the agent-tool door: it powers BOTH the class's turn
 *    tool (getTools) and its direct search() method.
 * 2. mcp (SECOND) — the instance's public /mcp endpoint, tool
 *    "search", consumed through the repo's RemoteMcpClient exactly
 *    as any MCP client would. Gated on AI_SEARCH_MCP_ENDPOINT; the
 *    endpoint itself exists only when the owner enables the
 *    instance's Public Endpoint in the dashboard.
 * 3. rest (LAST RESORT) — ETradeAISearchService (src/services/
 *    aiSearch.ts) reused exactly as-is: its S2 mapping, provenance
 *    and KNOWLEDGE_SERVING_ENABLED behaviour come along untouched.
 *
 * Result items are hub-consistent: the S2 fields of
 * AISearchResultItem (title / snippet / source / score, plus
 * bucket-key provenance where the serving path provides it). The
 * namespace and MCP paths return the binding's chunk shape, so
 * their chunks are adapted (documented field renames only) and then
 * mapped by the SAME mapAiSearchChunks the REST leg's service uses
 * — one mapping, one story, whichever door served the answer. The
 * serving path is always labelled via `path`.
 *
 * Honesty (hard rules):
 * - No path configured -> a typed not_configured degraded result.
 *   Zero results are fabricated, ever.
 * - A configured path that throws (or returns an unrecognized
 *   shape) falls through to the next configured path, and the
 *   failure is recorded in the result's `degraded` note.
 * - If the REST leg returns fallback-labelled results (provider
 *   "semantic_cache" — the service's built-in FINANCIAL_KNOWLEDGE_BASE
 *   matcher), they are surfaced as DEGRADED and withheld from
 *   `results`: this agent does not launder the fallback #1169 S3
 *   exists to remove.
 * - This module never throws.
 *
 * OUT of scope (the #1169 S4-5 bridge, dashboard-gated): runtime
 * provisioning — no namespace create call, no items.upload. This
 * module only ever reads.
 */
import {
  ETradeAISearchService,
  mapAiSearchChunks,
  type AISearchQueryResponse,
  type AISearchResultItem,
} from "../services/aiSearch";
import { isKnowledgeServingEnabled } from "../services/knowledgeCorpus";
import { RemoteMcpClient } from "../services/mcpClient";
import { AGENT_ERROR_CATALOG, AgentErrorCode } from "../aspects/errorCodes";
import type { Env } from "../types";

/** The access path that served (or last attempted) a search. */
export type AiSearchPath = "namespace" | "mcp" | "rest";

/**
 * One search result, hub-consistent with the SearchHub knowledge
 * surface: the S2 AISearchResultItem fields, with the item's URL (or
 * its R2 key, per the service mapping) carried as `source`.
 * bucketKey / servedFileLink / indexingState provenance is present
 * exactly when the serving path provides it (KNOWLEDGE_SERVING_ENABLED
 * on, per the S2 mapping) — never invented.
 */
export interface AiSearchAgentResultItem {
  title?: string;
  snippet?: string;
  source?: string;
  score?: number;
  category?: AISearchResultItem["category"];
  bucketKey?: string;
  servedFileLink?: string;
  indexingState?: AISearchResultItem["indexingState"];
}

/** Stable local outcome tokens for the search runner. */
export type AiSearchAgentErrorToken =
  | "invalid_input"
  | "not_configured"
  | "degraded_fallback"
  | "all_paths_failed";

/**
 * Map the local outcome tokens onto AGENT_ERROR_CATALOG keys (the
 * slice-1 pattern): invalid input and not-configured are "the
 * request/environment names something the agent cannot serve"
 * (ERR_UNKNOWN_AGENT_ERROR — the catalog has no validation or
 * configuration class); a degraded fallback answer and an
 * all-paths failure are execution failures
 * (ERR_TOOL_EXECUTION_FAILED). No catalog keys are invented here.
 */
const AISEARCH_CATALOG_CODES: Record<AiSearchAgentErrorToken, AgentErrorCode> = {
  invalid_input: AgentErrorCode.UNKNOWN_AGENT_ERROR,
  not_configured: AgentErrorCode.UNKNOWN_AGENT_ERROR,
  degraded_fallback: AgentErrorCode.TOOL_EXECUTION_FAILED,
  all_paths_failed: AgentErrorCode.TOOL_EXECUTION_FAILED,
};

/** Resolve a local token to its AGENT_ERROR_CATALOG token. */
function aiSearchCatalogCode(token: AiSearchAgentErrorToken): AgentErrorCode {
  const code = AISEARCH_CATALOG_CODES[token] ?? AgentErrorCode.UNKNOWN_AGENT_ERROR;
  // Defensive: the catalog is the authority; never emit a token it
  // does not define.
  return AGENT_ERROR_CATALOG[code] ? code : AgentErrorCode.UNKNOWN_AGENT_ERROR;
}

/** The typed result of one agent search. Never a fabricated success. */
export interface AiSearchAgentSearchResult {
  ok: boolean;
  /** Present only on a real (non-degraded) success. */
  results?: AiSearchAgentResultItem[];
  /** The path that served the answer; on failure, the last attempted path. */
  path?: AiSearchPath;
  /**
   * Set whenever the answer is degraded: earlier configured paths
   * failed before this one served, or the serving path's own output
   * was fallback-labelled and withheld.
   */
  degraded?: string;
  /** Stable local outcome token when ok is false. */
  code?: AiSearchAgentErrorToken;
  /** Stable AGENT_ERROR_CATALOG token when ok is false. */
  errorToken?: AgentErrorCode;
  /** Human-readable failure detail when ok is false. */
  error?: string;
  correlationId: string;
}

export interface AiSearchAgentSearchOptions {
  /** Max results to return (default 5, mirroring the service default). */
  limit?: number;
}

/**
 * Injectable path executors. The defaults are the real doors; tests
 * substitute fakes per path. namespaceSearch receives the resolved
 * binding instance; mcpSearch the endpoint URL; restSearch returns
 * the service's native response so the fallback label stays visible.
 */
export interface AiSearchAgentDeps {
  namespaceSearch?: (
    instance: AiSearchNamespaceInstanceLike,
    query: string,
  ) => Promise<unknown>;
  mcpSearch?: (endpoint: string, query: string) => Promise<unknown>;
  restSearch?: (
    env: Env,
    query: string,
    limit: number,
  ) => Promise<AISearchQueryResponse>;
}

/** Structural minimum of the binding's instance handle this runner uses. */
export interface AiSearchNamespaceInstanceLike {
  search(params: {
    messages: Array<{ role: "user"; content: string }>;
  }): Promise<unknown>;
}

const defaultNamespaceSearch: NonNullable<AiSearchAgentDeps["namespaceSearch"]> = (
  instance,
  query,
) => instance.search({ messages: [{ role: "user", content: query }] });

const defaultMcpSearch: NonNullable<AiSearchAgentDeps["mcpSearch"]> = (endpoint, query) =>
  RemoteMcpClient.callTool({
    serverUrl: endpoint,
    toolName: "search",
    arguments: { query },
  });

const defaultRestSearch: NonNullable<AiSearchAgentDeps["restSearch"]> = (env, query, limit) =>
  new ETradeAISearchService(env).searchFinancialDocs(query, limit);

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Adapt AI Search chunks from either native shape into the REST
 * chunk layout mapAiSearchChunks consumes:
 * - binding chunks (AiSearchSearchResponse) carry the chunk text in
 *   `text` and the item key at `item.key`;
 * - REST chunks already carry `snippet` and a top-level `key`.
 * The renames are the documented field correspondences (chunk text
 * IS the snippet; the item's key IS the chunk's R2 key) — values are
 * never invented, only relocated, and only when the target field is
 * absent. Accepts a bare chunk array or any envelope carrying a
 * `chunks` array (the binding response, the REST `{ result }`
 * envelope, an MCP tool payload). Returns null when no chunk array
 * exists — the caller treats that as a path failure, never as an
 * empty success.
 */
export function adaptAiSearchChunks(payload: unknown): unknown[] | null {
  let chunks: unknown = payload;
  if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
    const p = payload as Record<string, unknown>;
    if (Array.isArray(p.chunks)) {
      chunks = p.chunks;
    } else if (
      p.result !== null &&
      typeof p.result === "object" &&
      Array.isArray((p.result as Record<string, unknown>).chunks)
    ) {
      chunks = (p.result as Record<string, unknown>).chunks;
    } else if (Array.isArray(p.results)) {
      chunks = p.results;
    }
  }
  if (!Array.isArray(chunks)) return null;
  return chunks.map((chunk) => {
    if (chunk === null || typeof chunk !== "object" || Array.isArray(chunk)) return chunk;
    const c = chunk as Record<string, unknown>;
    const item =
      c.item !== null && typeof c.item === "object" && !Array.isArray(c.item)
        ? (c.item as Record<string, unknown>)
        : undefined;
    const snippet =
      typeof c.snippet === "string"
        ? c.snippet
        : typeof c.text === "string"
          ? c.text
          : undefined;
    const key =
      typeof c.key === "string" ? c.key : typeof item?.key === "string" ? item.key : undefined;
    if (snippet === c.snippet && key === c.key) return chunk;
    return {
      ...c,
      ...(snippet !== undefined ? { snippet } : {}),
      ...(key !== undefined ? { key } : {}),
    };
  });
}

/** Map S2 service items into the agent's hub-consistent item shape. */
function toAgentItems(items: readonly AISearchResultItem[]): AiSearchAgentResultItem[] {
  return items.map((item) => ({
    ...(item.title !== undefined ? { title: item.title } : {}),
    ...(item.snippet !== undefined ? { snippet: item.snippet } : {}),
    ...(item.url !== undefined ? { source: item.url } : {}),
    ...(item.score !== undefined ? { score: item.score } : {}),
    ...(item.category !== undefined ? { category: item.category } : {}),
    ...(item.bucketKey !== undefined ? { bucketKey: item.bucketKey } : {}),
    ...(item.servedFileLink !== undefined ? { servedFileLink: item.servedFileLink } : {}),
    ...(item.indexingState !== undefined ? { indexingState: item.indexingState } : {}),
  }));
}

/**
 * Map a chunk payload from the namespace or MCP path through the
 * shared S2 mapping. Throws when the payload carries no chunk array
 * (an unrecognized shape is a path failure, not an empty success)
 * and propagates the mapper's AiSearchMappingError on malformed
 * chunks — the visible-failure behaviour the service itself has.
 */
function mapChunkPayload(env: Env, payload: unknown): AiSearchAgentResultItem[] {
  const chunks = adaptAiSearchChunks(payload);
  if (chunks === null) {
    throw new Error("AI Search response carried no recognizable chunks array.");
  }
  return toAgentItems(mapAiSearchChunks(chunks, isKnowledgeServingEnabled(env)));
}

interface PathAttempt {
  path: AiSearchPath;
  run: () => Promise<AiSearchAgentResultItem[]>;
}

/**
 * Run one search across the configured paths in priority order
 * (namespace -> mcp -> rest). Never throws; every outcome is a
 * typed result.
 */
export async function runAiSearchPaths(
  env: Env,
  query: string,
  opts: AiSearchAgentSearchOptions = {},
  deps: AiSearchAgentDeps = {},
): Promise<AiSearchAgentSearchResult> {
  const correlationId = crypto.randomUUID();
  const cleanQuery = typeof query === "string" ? query.trim() : "";
  if (!cleanQuery) {
    return {
      ok: false,
      code: "invalid_input",
      errorToken: aiSearchCatalogCode("invalid_input"),
      correlationId,
      error: "AiSearchAgent.search requires a non-empty query string.",
    };
  }
  const limit =
    typeof opts.limit === "number" && Number.isFinite(opts.limit) && opts.limit > 0
      ? Math.floor(opts.limit)
      : 5;

  const attempts: PathAttempt[] = [];

  // 1. namespace (PRIMARY): binding + instance name.
  const instanceName = nonEmptyString(env.AI_SEARCH_INSTANCE);
  if (env.AI_SEARCH && instanceName) {
    const binding = env.AI_SEARCH;
    const namespaceSearch = deps.namespaceSearch ?? defaultNamespaceSearch;
    attempts.push({
      path: "namespace",
      run: async () => {
        const instance = binding.get(instanceName);
        if (!instance || typeof instance.search !== "function") {
          throw new Error(
            `AI Search namespace binding resolved no searchable instance for "${instanceName}".`,
          );
        }
        return mapChunkPayload(env, await namespaceSearch(instance, cleanQuery));
      },
    });
  }

  // 2. mcp (SECOND): the instance's public /mcp endpoint.
  const mcpEndpoint = nonEmptyString(env.AI_SEARCH_MCP_ENDPOINT);
  if (mcpEndpoint) {
    const mcpSearch = deps.mcpSearch ?? defaultMcpSearch;
    attempts.push({
      path: "mcp",
      run: async () => mapChunkPayload(env, await mcpSearch(mcpEndpoint, cleanQuery)),
    });
  }

  // 3. rest (LAST RESORT): the hub's own service, reused as-is. Its
  // fallback label is checked by the runner below, not in the
  // attempt, because a fallback answer is a DEGRADED outcome, not a
  // path failure — there is no further path to fall through to.
  const restEndpoint = nonEmptyString(env.AI_SEARCH_ENDPOINT);
  let restResponse: AISearchQueryResponse | null = null;
  if (restEndpoint) {
    const restSearch = deps.restSearch ?? defaultRestSearch;
    attempts.push({
      path: "rest",
      run: async () => {
        restResponse = await restSearch(env, cleanQuery, limit);
        return toAgentItems(restResponse.results);
      },
    });
  }

  if (attempts.length === 0) {
    const degraded =
      "No AI Search access path is configured: the namespace path needs the ai_search_namespaces binding (env.AI_SEARCH) plus AI_SEARCH_INSTANCE, the MCP path needs AI_SEARCH_MCP_ENDPOINT (the instance's dashboard-enabled public endpoint), and the REST path needs AI_SEARCH_ENDPOINT.";
    return {
      ok: false,
      code: "not_configured",
      errorToken: aiSearchCatalogCode("not_configured"),
      correlationId,
      degraded,
      error: degraded,
    };
  }

  const failures: string[] = [];
  for (const attempt of attempts) {
    try {
      const items = await attempt.run();
      if (attempt.path === "rest" && restResponse !== null) {
        const provider = (restResponse as AISearchQueryResponse).provider;
        if (provider === "semantic_cache") {
          // The service's built-in knowledge-base matcher answered —
          // fabricated rows, honestly labelled by the service itself.
          // Surface as degraded and withhold them from results.
          const degraded =
            'The REST path answered from its built-in semantic cache (provider "semantic_cache") because the AI Search instance did not serve the query. Those fallback rows are not live AI Search results and are withheld here rather than presented as results.';
          return {
            ok: false,
            path: "rest",
            code: "degraded_fallback",
            errorToken: aiSearchCatalogCode("degraded_fallback"),
            correlationId,
            degraded,
            error: degraded,
          };
        }
      }
      const sliced = items.slice(0, limit);
      return {
        ok: true,
        path: attempt.path,
        correlationId,
        results: sliced,
        ...(failures.length > 0
          ? {
              degraded: `Served by the ${attempt.path} path after earlier configured path(s) failed: ${failures.join("; ")}.`,
            }
          : {}),
      };
    } catch (err) {
      failures.push(
        `${attempt.path}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return {
    ok: false,
    path: attempts[attempts.length - 1].path,
    code: "all_paths_failed",
    errorToken: aiSearchCatalogCode("all_paths_failed"),
    correlationId,
    error: `Every configured AI Search path failed: ${failures.join("; ")}.`,
  };
}
