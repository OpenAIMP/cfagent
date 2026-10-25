/**
 * OpenAPI + Swagger spike (issue #1024 Phase 1 — no framework change).
 *
 * Generates an OpenAPI 3.x document from the IAAA-UI API catalog
 * (src/client/iaaaEndpointCatalog.ts), which is static code knowledge
 * derived by reading src/server.ts. The hand-rolled router stays; this
 * module only DESCRIBES it.
 *
 * Honesty rule (same as the catalog): hand-written schemas exist for
 * the pilot set only (GET /api/me, GET /health + /health alias,
 * GET /api/iaaa/overview). Every other path carries an explicit
 * "schema: not yet specified (spike pilot coverage)" marker — never
 * an invented request/response schema. WebSocket routes are listed
 * with an x-transport marker and no invented REST operation.
 *
 * Layering note (spike provisional): this server-side module imports
 * a client-side catalog. The catalog module itself imports only pure
 * data (src/client/mcpEndpointsData.ts has no component or CSS
 * imports), so the worker bundle is unaffected — but the #1024 design
 * should give the catalog a shared home instead of a client import.
 *
 * Version: package.json ("1.0.0") — the repo's version marker.
 * Servers: the production origin from wrangler.jsonc routes.
 */

import {
  API_ENDPOINT_CATALOG,
  type ApiEndpointEntry,
} from "../client/iaaaEndpointCatalog";

export const OPENAPI_NOT_SPECIFIED =
  "schema: not yet specified (spike pilot coverage)";

/** Pilot endpoints with hand-written schemas (shapes read from the handlers). */
const PILOT_PATHS = new Set(["/api/me", "/health", "/api/health", "/api/iaaa/overview"]);

/** Catalog auth kinds that require the session cookie for the operation. */
const SESSION_AUTH = new Set(["session", "session-or-apikey", "platform-admin"]);

type Operation = Record<string, unknown>;
type PathItem = Record<string, unknown>;

const errorResponse = {
  description: "Error (the handler returns { error: string }).",
  content: {
    "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
  },
};

function operationFor(
  entry: ApiEndpointEntry,
  path: string,
): Operation {
  const isPilot = PILOT_PATHS.has(path);
  const base: Operation = {
    description: entry.authNote,
  };
  if (entry.method === "ANY" && isPilot) {
    // The handler does not restrict the method (catalog method: ANY).
    // GET is the documented contract: /health is fetched with GET by
    // scripts/qa-smoke.mjs, and /api/me is read with a browser GET by
    // the owner (activation flow). No other method is claimed.
    base.description +=
      "\n\nNote: the handler does not restrict the method (catalog method: ANY); " +
      "GET is the documented contract.";
  }
  if (SESSION_AUTH.has(entry.auth)) {
    base.security = [{ sessionCookie: [] }];
  }
  if (isPilot) {
    base.responses = pilotResponses(entry, path);
    return base;
  }
  base.description =
    `${entry.authNote}\n\n${OPENAPI_NOT_SPECIFIED}`;
  base.responses = {
    "200": {
      description: "Response schema not yet specified (spike pilot coverage).",
    },
  };
  return base;
}

function pilotResponses(entry: ApiEndpointEntry, path: string): Record<string, unknown> {
  if (path === "/api/me") {
    return {
      "200": {
        description:
          "Caller session status. Unauthenticated callers get { authenticated: false } " +
          "with HTTP 200 (this handler does not 401). login/name/avatar are present " +
          "only when authenticated; internalUserId only for wired sessions.",
        content: {
          "application/json": { schema: { $ref: "#/components/schemas/MeResponse" } },
        },
      },
    };
  }
  if (path === "/health" || path === "/api/health") {
    return {
      "200": {
        description: "Public worker health (no session required).",
        content: {
          "application/json": { schema: { $ref: "#/components/schemas/HealthResponse" } },
        },
      },
    };
  }
  if (path === "/api/iaaa/overview") {
    return {
      "200": {
        description:
          "Caller memberships, tenant genesis status, and recent tenant audit events. " +
          "Only a live platform-admin membership returns 200.",
        content: {
          "application/json": { schema: { $ref: "#/components/schemas/IaaaOverviewResponse" } },
        },
      },
      "401": errorResponse,
      "403": errorResponse,
      "405": errorResponse,
      "500": errorResponse,
    };
  }
  return {
    "200": { description: "Response schema not yet specified (spike pilot coverage)." },
  };
}

function methodsFor(entry: ApiEndpointEntry, path: string): string[] {
  // Pilot ANY endpoints get their documented GET contract (see
  // operationFor). Non-pilot ANY endpoints keep a description-only
  // path item — no operation is invented for them.
  if (entry.method === "ANY" && PILOT_PATHS.has(path)) return ["get"];
  switch (entry.method) {
    case "GET":
      return ["get"];
    case "POST":
      return ["post"];
    case "DELETE":
      return ["delete"];
    case "GET|POST":
      return ["get", "post"];
    default:
      return [];
  }
}

/**
 * Build the full OpenAPI document. Pure function of the catalog (plus
 * the two spike routes, which the catalog predates and therefore does
 * not contain — they are added explicitly, with their real behavior).
 */
export function buildOpenApiSpec(): Record<string, unknown> {
  const paths: Record<string, PathItem> = {};

  for (const entry of API_ENDPOINT_CATALOG) {
    if (entry.kind === "catchall" || entry.kind === "static") continue;
    const urls = [entry.path, ...entry.aliases];
    if (entry.kind === "websocket") {
      for (const url of urls) {
        paths[url] = {
          description:
            `${entry.authNote}\n\nTransport: WebSocket upgrade (not a REST operation).` +
            `\n\n${OPENAPI_NOT_SPECIFIED}`,
          "x-transport": "websocket",
        };
      }
      continue;
    }
    for (const url of urls) {
      // Merge, never overwrite: two catalog entries can share one path
      // (e.g. GET + POST /api/schedule/goals, list + mint /api/api-keys).
      // Each operation keeps its own entry's gating note.
      const item: PathItem = paths[url] ?? {};
      const methods = methodsFor(entry, url);
      for (const method of methods) {
        item[method] = operationFor(entry, url);
      }
      if (methods.length === 0 && !item.description) {
        item.description = `${entry.authNote}\n\n${OPENAPI_NOT_SPECIFIED}`;
      } else if (!item.description && methods.length > 0) {
        // Path-item description mirrors the first operation's description,
        // so the not-yet-specified marker is visible at path level too.
        item.description = (item[methods[0]] as Operation).description as string;
      }
      paths[url] = item;
    }
  }

  // Spike routes themselves (issue #1024 Phase 1). Provisional gating:
  // both require an authenticated session (see the route comments in
  // src/server.ts) — the docs-exposure design decision is still open.
  // The operation descriptions lead with the catalog authNote so the
  // spec stays generated from the catalog, not hand-diverged from it.
  const specEntry = API_ENDPOINT_CATALOG.find((e) => e.path === "/openapi.json");
  const docsEntry = API_ENDPOINT_CATALOG.find((e) => e.path === "/api/docs");
  paths["/openapi.json"] = {
    description:
      "This generated OpenAPI document as JSON. Requires an authenticated session " +
      "(provisional spike gating; the #1024 docs-exposure decision is still open).",
    get: {
      description: `${specEntry?.authNote ?? "Requires an authenticated session."}\n\nReturns this OpenAPI document.`,
      security: [{ sessionCookie: [] }],
      responses: {
        "200": {
          description: "The generated OpenAPI document.",
          content: { "application/json": { schema: { type: "object" } } },
        },
        "401": errorResponse,
        "405": errorResponse,
      },
    },
  };
  paths["/api/docs"] = {
    description:
      "Swagger UI page for trying the API against /openapi.json. Requires an " +
      "authenticated session (provisional spike gating; the #1024 docs-exposure " +
      "decision is still open).",
    get: {
      description: `${docsEntry?.authNote ?? "Requires an authenticated session."}\n\nServes the Swagger UI HTML page.`,
      security: [{ sessionCookie: [] }],
      responses: {
        "200": {
          description: "Swagger UI HTML page (loads Swagger UI from CDN).",
          content: { "text/html": { schema: { type: "string" } } },
        },
        "401": errorResponse,
        "405": errorResponse,
      },
    },
  };

  return {
    openapi: "3.0.3",
    info: {
      title: "ai-search-agent",
      version: "1.0.0",
      description:
        "OpenAPI + Swagger spike (issue #1024 Phase 1). Spec generated from the " +
        "IAAA-UI API catalog; hand-written schemas cover the pilot set only " +
        "(/api/me, /health, /api/iaaa/overview). Every other path is marked " +
        "not yet specified — the marker, not an invented schema, is the honest state.",
    },
    servers: [{ url: "https://agent.openaimp.com" }],
    paths,
    components: {
      securitySchemes: {
        sessionCookie: {
          type: "apiKey",
          in: "cookie",
          name: "session_id",
          description:
            "Worker session cookie (src/security/session.ts COOKIE_NAME). " +
            "Same-origin requests from the Swagger UI page carry it automatically " +
            "when withCredentials is enabled (see SWAGGER_UI_HTML).",
        },
      },
      schemas: {
        ErrorResponse: {
          type: "object",
          required: ["error"],
          properties: { error: { type: "string" } },
        },
        MeResponse: {
          type: "object",
          required: ["authenticated"],
          properties: {
            authenticated: { type: "boolean" },
            login: { type: "string", description: "Present only when authenticated." },
            name: { type: "string", description: "Present only when authenticated." },
            avatar: { type: "string", description: "Present only when authenticated." },
            internalUserId: {
              type: "string",
              description:
                "Present only for wired (post-Phase-1) sessions; absent for legacy sessions.",
            },
          },
        },
        HealthResponse: {
          type: "object",
          required: ["status", "service", "version", "timestamp", "environment", "runtime", "telemetry"],
          properties: {
            status: { type: "string", example: "healthy" },
            service: { type: "string", example: "cfagent-multi-agent-studio" },
            version: { type: "string", example: "1.0.0" },
            timestamp: { type: "string", format: "date-time" },
            environment: { type: "string", description: "Worker environment (e.g. PROD)." },
            runtime: { type: "string", example: "cloudflare-workers" },
            telemetry: {
              type: "object",
              required: ["durableObjects", "mcp", "apiFirst", "fifteenFactorCompliant"],
              properties: {
                durableObjects: { type: "string", example: "healthy" },
                mcp: { type: "string", example: "available" },
                apiFirst: { type: "boolean" },
                fifteenFactorCompliant: { type: "boolean" },
              },
            },
          },
        },
        RoleBinding: {
          type: "object",
          required: ["role", "scope", "grantedBy"],
          properties: {
            role: {
              type: "string",
              enum: ["platform-admin", "tenant-admin", "workspace-admin", "member", "approver", "auditor"],
            },
            scope: { type: "string", enum: ["platform", "tenant", "workspace", "resource"] },
            workspaceId: { type: "string" },
            resourceId: { type: "string" },
            grantedBy: { type: "string" },
            expiresAtMs: { type: "number" },
          },
        },
        Membership: {
          type: "object",
          required: ["membershipId", "internalUserId", "tenantId", "roleBindings", "createdBy", "createdAtMs"],
          properties: {
            membershipId: { type: "string" },
            internalUserId: { type: "string" },
            tenantId: { type: "string" },
            workspaceId: { type: "string" },
            roleBindings: { type: "array", items: { $ref: "#/components/schemas/RoleBinding" } },
            createdBy: { type: "string" },
            createdAtMs: { type: "number" },
            revokedAtMs: { type: "number" },
          },
        },
        AdminAuditEventView: {
          type: "object",
          required: [
            "id",
            "timestamp",
            "type",
            "actorPrincipalId",
            "initiatingPrincipalId",
            "action",
            "decision",
            "outcome",
            "correlationId",
          ],
          properties: {
            id: { type: "string" },
            timestamp: { type: "number", description: "Epoch milliseconds." },
            type: { type: "string" },
            actorPrincipalId: { type: "string" },
            initiatingPrincipalId: { type: "string" },
            action: { type: "string" },
            decision: { type: "string" },
            outcome: { type: "string" },
            correlationId: { type: "string" },
            resourceId: { type: "string" },
            errorCode: { type: "string" },
          },
        },
        IaaaOverviewResponse: {
          type: "object",
          required: [
            "allowed",
            "tenantId",
            "callerInternalUserId",
            "memberships",
            "genesis",
            "recentAuditEvents",
          ],
          properties: {
            allowed: { type: "boolean", description: "Always true on the 200 shape." },
            tenantId: { type: "string" },
            callerInternalUserId: { type: "string" },
            memberships: { type: "array", items: { $ref: "#/components/schemas/Membership" } },
            genesis: {
              type: "object",
              required: ["platformGenesisOccurred"],
              properties: { platformGenesisOccurred: { type: "boolean" } },
            },
            recentAuditEvents: {
              type: "array",
              items: { $ref: "#/components/schemas/AdminAuditEventView" },
            },
          },
        },
      },
    },
  };
}

/**
 * Swagger UI page for GET /api/docs. Swagger UI itself loads from CDN
 * (no new dependency, nothing vendored). The worker sets no
 * Content-Security-Policy (verified by grep over src/ at spike time),
 * so CDN loading is not blocked by a worker CSP; if a CSP is added
 * later, cdn.jsdelivr.net must be allowlisted for scripts, styles,
 * and fonts, or the page breaks — recorded as a spike finding.
 *
 * withCredentials is enabled so the session cookie (same-origin) is
 * carried on /openapi.json fetches and on try-it requests; without a
 * live session the try-it console gets 401s, which is the correct
 * fail-closed behavior for the provisional gating.
 */
export const SWAGGER_UI_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>ai-search-agent API docs (spike)</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui.css" />
</head>
<body>
<div id="swagger-ui"></div>
<script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
<script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-standalone-preset.js"></script>
<script>
window.onload = function () {
  SwaggerUIBundle({
    url: "/openapi.json",
    dom_id: "#swagger-ui",
    withCredentials: true,
    presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],
  });
};
</script>
</body>
</html>
`;
