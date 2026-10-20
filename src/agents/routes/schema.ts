/**
 * Issue #359-17: schema introspection routes extracted from
 * OrchestratorAgent.routeRequest (src/agents/orchestrator.ts). Pure move -
 * no behavior change. FINAL slice of the #359 orchestrator breakup:
 * routeRequest is now a thin ordered dispatcher over src/agents/routes/.
 *
 * Owns the two schema blocks (invoked at the EXACT original position in
 * routeRequest's sequential matching sequence, between the MCP/chat/NLQ
 * delegation and the ads/revenue/referrals delegation):
 *   GET  /schema/tables   (ORM table inventory)
 *   POST /schema/query    (ORM table data: table/search/limit/offset)
 *
 * The handler ends with an explicit `return null` - never undefined.
 *
 * Handlers that used OrchestratorAgent state receive it via the explicit
 * SchemaRouteContext parameter; there are no new globals and no
 * back-references into the class.
 */

import type { DatabaseORM } from "../../orm";

/** The subset of OrchestratorAgent surface the schema handlers need. */
export interface SchemaRouteContext {
  /** ORM accessor (owner: OrchestratorAgent.getOrm - was `this.getOrm()`). */
  getOrm(): DatabaseORM;
}

/**
 * Handles the schema introspection routes. Returns a Response on match,
 * null when neither schema path matches (the orchestrator then continues
 * its sequential matching).
 */
export async function handleSchemaRoutes(
  request: Request,
  url: URL,
  path: string,
  sessionId: string,
  ctx: SchemaRouteContext
): Promise<Response | null> {
  // Schema Introspection & Database Tables via ORM
  if (path.endsWith("/schema/tables") && request.method === "GET") {
    try {
      const orm = ctx.getOrm();
      const tables = orm.listTables();
      return Response.json({ count: tables.length, tables });
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Failed to inspect database tables" }, { status: 500 });
    }
  }

  // Direct Table Query Execution via ORM
  if (path.endsWith("/schema/query") && request.method === "POST") {
    try {
      const body = (await request.json().catch(() => ({}))) as {
        table?: string;
        search?: string;
        limit?: number;
        offset?: number;
      };
      const table = body.table || "mas_categories";
      const orm = ctx.getOrm();
      const data = orm.getTableData(table, {
        search: body.search,
        limit: body.limit,
        offset: body.offset,
      });
      return Response.json(data);
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Failed to query table data" }, { status: 500 });
    }
  }

  return null;
}
