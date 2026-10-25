/**
 * Issue #1499 (#940-E): resolve a stored screener preset at RUN time.
 *
 * A schedule's payload carries a presetId, not a frozen filter — so
 * preset edits apply to future runs without re-arming the schedule.
 * Resolution happens inside the scheduled run itself (the service's
 * failure path turns a bad preset into a loud failed run, never a
 * silent default run):
 * - The lookup is user-scoped (id AND user_login): another user's id
 *   returns "Preset not found.", the same as missing — no existence
 *   oracle, matching the #1495 API.
 * - Stored criteria are re-validated with the run path's own strict
 *   parsers, so a row written before validation (or hand-edited) can
 *   never inject criteria a run would reject.
 * - The resolver is asset-agnostic: it returns the row's asset class
 *   and criteria, and the CALLER enforces the match (a stock screen
 *   rejects an options preset, loudly).
 *
 * The sql handle is the DO-SQLite storage behind mas_screener_presets
 * (the same table the #1495 CRUD routes read). Only exec() is needed,
 * so tests can substitute an in-memory fake.
 */
import {
  parseOptionScreenerFilter,
  parseStockScreenerFilter,
} from "../trading/screeningSchemas";
import type { OptionScreenerFilter, StockScreenerFilter } from "../types";

export interface PresetSql {
  exec(query: string, ...params: unknown[]): Iterable<unknown>;
}

export type ResolvedPresetFilter =
  | {
      ok: true;
      assetClass: "stocks" | "options";
      criteria: StockScreenerFilter | OptionScreenerFilter;
    }
  | { ok: false; error: string };

interface PresetRow {
  asset_class: unknown;
  criteria_json: unknown;
}

export function resolvePresetFilter(
  sql: PresetSql,
  userLogin: string,
  presetId: string
): ResolvedPresetFilter {
  let rows: PresetRow[];
  try {
    rows = Array.from(
      sql.exec(
        "SELECT asset_class, criteria_json FROM mas_screener_presets WHERE id = ? AND user_login = ?",
        presetId,
        userLogin
      )
    ) as PresetRow[];
  } catch {
    return { ok: false, error: "Failed to load preset." };
  }
  const row = rows[0];
  if (!row) return { ok: false, error: "Preset not found." };
  if (row.asset_class !== "stocks" && row.asset_class !== "options") {
    return { ok: false, error: "Preset has an unknown asset class." };
  }
  let criteria: unknown;
  try {
    criteria = JSON.parse(String(row.criteria_json));
  } catch {
    return { ok: false, error: "Preset criteria are unreadable." };
  }
  const parsed =
    row.asset_class === "stocks"
      ? parseStockScreenerFilter(criteria)
      : parseOptionScreenerFilter(criteria);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  return { ok: true, assetClass: row.asset_class, criteria: parsed.value };
}
