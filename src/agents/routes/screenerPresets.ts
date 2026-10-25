/**
 * Issue #1495 (#940-A): user-scoped screener preset storage + CRUD API.
 *
 * Presets persist per user in DO/SQLite (mas_screener_presets — NOT KV,
 * per #415). Criteria are validated by the SAME strict parsers the run
 * path uses (parseStockScreenerFilter / parseOptionScreenerFilter), so a
 * stored preset can never hold criteria a run would reject, and unknown
 * fields are rejected, never silently dropped. The parser-normalized
 * value is what gets stored.
 *
 * Scoping: presets are keyed by the caller's login (x-user-login header,
 * else the session id — the same identity runs use). A user lists only
 * their own rows; deleting another user's id returns 404, the same as
 * missing — no existence oracle.
 *
 * Routes (client calls /api/screener/presets; server.ts strips /api
 * before the DO, so conditions match the stripped path):
 *  - GET /screener/presets — list the caller's presets
 *  - POST /screener/presets — create (201); validates name, asset class,
 *    and criteria with business errors
 *  - DELETE /screener/presets/:id — delete an own preset (404 otherwise)
 *
 * Invoked from routeRequest right after the reports routes. Returns a
 * Response on match, null when no preset path matches.
 */

import type { SqlStorage } from "../../orm";
import {
  parseOptionScreenerFilter,
  parseStockScreenerFilter,
} from "../../trading";

/** The subset of OrchestratorAgent surface the preset handlers need. */
export interface ScreenerPresetsRouteContext {
  ensureTables(): SqlStorage;
}

const MAX_NAME_LENGTH = 100;

interface PresetRow {
  id: string;
  user_login: string;
  name: string;
  asset_class: string;
  criteria_json: string;
  created_at: string;
  updated_at: string;
}

function rowToPreset(row: PresetRow) {
  return {
    id: row.id,
    name: row.name,
    assetClass: row.asset_class,
    criteria: JSON.parse(row.criteria_json) as unknown,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function validatePresetInput(body: unknown):
  | { ok: true; name: string; assetClass: "stocks" | "options"; criteria: unknown }
  | { ok: false; error: string } {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Preset name, asset class, and criteria are required." };
  }
  const { name, assetClass, criteria } = body as Record<string, unknown>;
  if (typeof name !== "string" || name.trim() === "") {
    return { ok: false, error: "Preset name is required." };
  }
  if (name.trim().length > MAX_NAME_LENGTH) {
    return { ok: false, error: `Preset name must be ${MAX_NAME_LENGTH} characters or fewer.` };
  }
  if (assetClass !== "stocks" && assetClass !== "options") {
    return { ok: false, error: "Asset class must be 'stocks' or 'options'." };
  }
  const parsed =
    assetClass === "stocks"
      ? parseStockScreenerFilter(criteria)
      : parseOptionScreenerFilter(criteria);
  if (!parsed.ok) {
    return { ok: false, error: parsed.error };
  }
  return { ok: true, name: name.trim(), assetClass, criteria: parsed.value };
}

export async function handleScreenerPresetRoutes(
  request: Request,
  _url: URL,
  path: string,
  sessionId: string,
  ctx: ScreenerPresetsRouteContext
): Promise<Response | null> {
  const userLogin = request.headers.get("x-user-login") || sessionId;

  if (path.endsWith("/screener/presets") && request.method === "GET") {
    try {
      const sql = ctx.ensureTables();
      const rows = Array.from(
        sql.exec(
          "SELECT id, user_login, name, asset_class, criteria_json, created_at, updated_at FROM mas_screener_presets WHERE user_login = ? ORDER BY updated_at DESC, created_at DESC",
          userLogin
        )
      ) as PresetRow[];
      return Response.json({ presets: rows.map(rowToPreset) });
    } catch {
      return Response.json({ error: "Failed to list presets." }, { status: 500 });
    }
  }

  if (path.endsWith("/screener/presets") && request.method === "POST") {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "Request body must be valid JSON." }, { status: 400 });
    }
    const validated = validatePresetInput(body);
    if (!validated.ok) {
      return Response.json({ error: validated.error }, { status: 400 });
    }
    try {
      const sql = ctx.ensureTables();
      const now = new Date().toISOString();
      const id = crypto.randomUUID();
      sql.exec(
        "INSERT INTO mas_screener_presets (id, user_login, name, asset_class, criteria_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        id,
        userLogin,
        validated.name,
        validated.assetClass,
        JSON.stringify(validated.criteria),
        now,
        now
      );
      return Response.json(
        {
          preset: {
            id,
            name: validated.name,
            assetClass: validated.assetClass,
            criteria: validated.criteria,
            createdAt: now,
            updatedAt: now,
          },
        },
        { status: 201 }
      );
    } catch {
      return Response.json({ error: "Failed to save preset." }, { status: 500 });
    }
  }

  if (path.startsWith("/screener/presets/") && request.method === "DELETE") {
    const id = path.slice("/screener/presets/".length);
    try {
      const sql = ctx.ensureTables();
      const existing = Array.from(
        sql.exec("SELECT id FROM mas_screener_presets WHERE id = ? AND user_login = ?", id, userLogin)
      );
      if (existing.length === 0) {
        return Response.json({ error: "Preset not found." }, { status: 404 });
      }
      sql.exec("DELETE FROM mas_screener_presets WHERE id = ? AND user_login = ?", id, userLogin);
      return Response.json({ deleted: true });
    } catch {
      return Response.json({ error: "Failed to delete preset." }, { status: 500 });
    }
  }

  return null;
}
