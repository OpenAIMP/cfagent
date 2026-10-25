import { describe, it, expect } from "vitest";
import { buildOpenApiSpec } from "../src/security/openapiSpec";
import { API_ENDPOINT_CATALOG } from "../src/client/iaaaEndpointCatalog";

/**
 * #1024 Phase 1 — OpenAPI + Swagger spike (no framework change).
 * The spec is generated from the IAAA-UI API catalog, not hand-written
 * per route. Hand-written schemas exist for the pilot set only; every
 * other path carries an explicit not-yet-specified marker — never an
 * invented schema.
 */
const NOT_SPECIFIED = "schema: not yet specified (spike pilot coverage)";

const HTTP_METHODS = ["get", "post", "delete"] as const;

function operationKeys(pathItem: Record<string, unknown>): string[] {
  return Object.keys(pathItem).filter((k) => (HTTP_METHODS as readonly string[]).includes(k));
}

describe("OpenAPI spec document", () => {
  it("is a valid OpenAPI 3.x document with the worker identity", () => {
    const spec = buildOpenApiSpec();
    const roundTripped = JSON.parse(JSON.stringify(spec)) as Record<string, unknown>;
    expect(typeof roundTripped.openapi).toBe("string");
    expect((roundTripped.openapi as string).startsWith("3.")).toBe(true);
    const info = roundTripped.info as Record<string, unknown>;
    expect(info.title).toBe("ai-search-agent");
    expect(info.version).toBe("1.0.0");
    const servers = roundTripped.servers as Array<Record<string, unknown>>;
    expect(servers[0].url).toBe("https://agent.openaimp.com");
  });

  it("covers every catalog HTTP endpoint path and alias, with its methods", () => {
    const spec = buildOpenApiSpec();
    const paths = spec.paths as Record<string, Record<string, any>>;
    for (const entry of API_ENDPOINT_CATALOG) {
      if (entry.kind !== "http") continue;
      for (const p of [entry.path, ...entry.aliases]) {
        expect(paths[p], `missing path item for ${p}`).toBeDefined();
        const ops = operationKeys(paths[p]);
        // Each operation keeps its own entry's gating note (paths shared
        // by two entries, e.g. GET + POST /api/schedule/goals, merge).
        const expected =
          entry.method === "GET|POST"
            ? ["get", "post"]
            : entry.method === "ANY"
              ? []
              : [entry.method.toLowerCase()];
        for (const m of expected) {
          expect(ops, `${p} missing ${m}`).toContain(m);
          expect(paths[p][m].description as string).toContain(entry.authNote.slice(0, 24));
        }
      }
    }
  });

  it("excludes the catch-all forwarder and static pre-route from paths", () => {
    const spec = buildOpenApiSpec();
    const paths = spec.paths as Record<string, unknown>;
    for (const entry of API_ENDPOINT_CATALOG) {
      if (entry.kind === "catchall" || entry.kind === "static") {
        expect(paths[entry.path]).toBeUndefined();
      }
    }
  });

  it("lists WebSocket routes as transport-marked items with no invented operation", () => {
    const spec = buildOpenApiSpec();
    const paths = spec.paths as Record<string, Record<string, unknown>>;
    for (const entry of API_ENDPOINT_CATALOG) {
      if (entry.kind !== "websocket") continue;
      for (const p of [entry.path, ...entry.aliases]) {
        expect(paths[p]).toBeDefined();
        expect(paths[p]["x-transport"]).toBe("websocket");
        expect(operationKeys(paths[p])).toEqual([]);
      }
    }
  });

  it("carries hand-written schemas for the pilot set only", () => {
    const spec = buildOpenApiSpec();
    const paths = spec.paths as Record<string, Record<string, any>>;
    const me = paths["/api/me"].get;
    expect(me.responses["200"].content["application/json"].schema.$ref).toBe(
      "#/components/schemas/MeResponse",
    );
    for (const p of ["/health", "/api/health"]) {
      expect(paths[p].get.responses["200"].content["application/json"].schema.$ref).toBe(
        "#/components/schemas/HealthResponse",
      );
    }
    const overview = paths["/api/iaaa/overview"].get;
    expect(overview.responses["200"].content["application/json"].schema.$ref).toBe(
      "#/components/schemas/IaaaOverviewResponse",
    );
    expect(overview.responses["401"]).toBeDefined();
    expect(overview.responses["403"]).toBeDefined();
    expect(overview.responses["405"]).toBeDefined();

    const components = spec.components as Record<string, Record<string, any>>;
    const meSchema = components.schemas.MeResponse;
    expect(meSchema.required).toEqual(["authenticated"]);
    for (const prop of ["login", "name", "avatar", "internalUserId"]) {
      expect(meSchema.properties[prop]).toBeDefined();
    }
    const healthSchema = components.schemas.HealthResponse;
    expect(healthSchema.required).toContain("status");
    expect(healthSchema.properties.telemetry).toBeDefined();
    const overviewSchema = components.schemas.IaaaOverviewResponse;
    for (const prop of ["tenantId", "callerInternalUserId", "memberships", "genesis", "recentAuditEvents"]) {
      expect(overviewSchema.properties[prop]).toBeDefined();
    }
    const membership = components.schemas.Membership;
    expect(membership.properties.roleBindings).toBeDefined();
    const auditView = components.schemas.AdminAuditEventView;
    expect(auditView.required).toContain("action");
  });

  it("marks every non-pilot path as not yet specified, and no pilot path as such", () => {
    const spec = buildOpenApiSpec();
    const paths = spec.paths as Record<string, Record<string, any>>;
    const pilot = new Set(["/api/me", "/health", "/api/health", "/api/iaaa/overview"]);
    const spikeMeta = new Set(["/openapi.json", "/api/docs"]);
    for (const [p, item] of Object.entries(paths)) {
      const text = (item.description as string) || "";
      if (pilot.has(p) || spikeMeta.has(p)) {
        expect(text).not.toContain(NOT_SPECIFIED);
      } else {
        expect(text, `missing marker on ${p}`).toContain(NOT_SPECIFIED);
      }
    }
    // A concrete non-pilot endpoint keeps its gating note alongside the marker.
    expect(paths["/api/api-keys"].get.description).toContain(NOT_SPECIFIED);
  });

  it("documents the spike routes themselves, session-gated", () => {
    const spec = buildOpenApiSpec();
    const paths = spec.paths as Record<string, Record<string, any>>;
    for (const p of ["/openapi.json", "/api/docs"]) {
      expect(paths[p].get).toBeDefined();
      expect(paths[p].get.description).toContain("authenticated session");
      expect(paths[p].get.responses["401"]).toBeDefined();
    }
    expect(paths["/openapi.json"].get.responses["200"].content["application/json"]).toBeDefined();
    expect(paths["/api/docs"].get.responses["200"].content["text/html"]).toBeDefined();
  });
});
