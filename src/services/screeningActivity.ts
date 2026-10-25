/**
 * Screening activity log (issue #1162, Phase 6 of epic #1096).
 *
 * The Public-style agent activity log for the autonomous screening
 * system: one tenant-scoped, append-only feed answering "what did the
 * screening system do, when, and on whose authority?" across
 *
 *  - discovery runs (scheduled tick + NLQ fit discovery),
 *  - strategy-bank re-selection (Phase 3 proposals),
 *  - champion/challenger promotions (Phase 5),
 *  - weights-v2 adjustments (Phase 5),
 *  - channel deliveries (Phase 6),
 *  - schedule/flag control changes (Phase 6).
 *
 * Storage follows the repo's existing idioms: new events land in
 * `mas_screening_activity` (service-owned idempotent DDL, the Phase 0
 * pattern; tenant-scoped by user_login like every mas_* store), and
 * the unified feed READS THROUGH to the systems of record that already
 * keep their own logs — re-selection proposals
 * (mas_strategy_bank_proposals) and promotions
 * (mas_challenger_promotions) — instead of copying them into a second
 * store that could drift. Recording never throws (the
 * scheduledReports metering idiom): a failed activity write is logged,
 * never allowed to break the work it describes.
 */

import { listReselectionProposals } from "./strategyBankReselection";
import { ensureChallengerTables } from "./championChallenger";

export const SCREENING_ACTIVITY_TABLE = "mas_screening_activity";

export type ScreeningActivityKind =
  | "discovery_run"
  | "screen_run"
  /** Consolidation C3 (#1277): one entry per stage-chain stage
   *  transition (stage completed / failed / skipped / held, with
   *  the reason in the summary + detail). */
  | "stage"
  | "goal_decision"
  | "reselection"
  | "weights_adjustment"
  | "promotion"
  | "delivery"
  | "schedule_control"
  | "bundle";

export interface ScreeningActivityEntry {
  id: string;
  userLogin: string;
  kind: ScreeningActivityKind;
  summary: string;
  detail: unknown;
  refId: string | null;
  actor: string | null;
  createdAt: string;
}

export interface ScreeningActivityFeedItem {
  id: string;
  at: string;
  kind: ScreeningActivityKind;
  summary: string;
  source: "activity" | "reselection" | "promotion";
  detail?: unknown;
}

type SqlExec = {
  exec: (query: string, ...args: unknown[]) => Iterable<unknown>;
};

export function ensureScreeningActivityTable(sql: SqlExec): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS ${SCREENING_ACTIVITY_TABLE} (
    id TEXT PRIMARY KEY,
    user_login TEXT NOT NULL,
    kind TEXT NOT NULL,
    summary TEXT NOT NULL,
    detail_json TEXT,
    ref_id TEXT,
    actor TEXT,
    created_at TEXT NOT NULL
  )`);
  sql.exec(
    `CREATE INDEX IF NOT EXISTS idx_screening_activity_user ON ${SCREENING_ACTIVITY_TABLE} (user_login, created_at DESC)`
  );
}

function activityId(): string {
  return `sact_${
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
  }`;
}

/**
 * Append one activity entry. Returns the entry id, or null when the
 * write failed (logged, never thrown — activity recording must not
 * break the operation it describes).
 */
export function recordScreeningActivity(
  sql: SqlExec,
  input: {
    userLogin: string;
    kind: ScreeningActivityKind;
    summary: string;
    detail?: unknown;
    refId?: string;
    actor?: string;
    createdAt?: string;
  }
): string | null {
  try {
    if (!input?.userLogin || !input?.kind || !input?.summary) return null;
    ensureScreeningActivityTable(sql);
    const id = activityId();
    sql.exec(
      `INSERT INTO ${SCREENING_ACTIVITY_TABLE} (id, user_login, kind, summary, detail_json, ref_id, actor, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.userLogin,
      input.kind,
      input.summary,
      input.detail === undefined ? null : JSON.stringify(input.detail),
      input.refId ?? null,
      input.actor ?? null,
      input.createdAt ?? new Date().toISOString()
    );
    return id;
  } catch (err) {
    console.error(
      `[screeningActivity] record failed for ${input?.userLogin ?? "?"}: ${err instanceof Error ? err.message : String(err)}`,
      err
    );
    return null;
  }
}

/** One tenant's recorded activity, newest first. Never throws; a broken store reads as empty. */
export function listScreeningActivity(
  sql: SqlExec,
  userLogin: string,
  limit = 100
): ScreeningActivityEntry[] {
  try {
    if (!userLogin) return [];
    ensureScreeningActivityTable(sql);
    const capped = Math.max(1, Math.min(Math.floor(limit) || 100, 500));
    const rows = Array.from(
      sql.exec(
        `SELECT id, user_login, kind, summary, detail_json, ref_id, actor, created_at FROM ${SCREENING_ACTIVITY_TABLE} WHERE user_login = ? ORDER BY created_at DESC LIMIT ?`,
        userLogin,
        capped
      )
    ) as Array<Record<string, unknown>>;
    return rows.map((r) => {
      let detail: unknown = null;
      if (typeof r.detail_json === "string" && r.detail_json) {
        try {
          detail = JSON.parse(r.detail_json);
        } catch {
          detail = { raw: r.detail_json };
        }
      }
      return {
        id: String(r.id ?? ""),
        userLogin: String(r.user_login ?? ""),
        kind: String(r.kind ?? "") as ScreeningActivityKind,
        summary: String(r.summary ?? ""),
        detail,
        refId: (r.ref_id as string | null) ?? null,
        actor: (r.actor as string | null) ?? null,
        createdAt: String(r.created_at ?? ""),
      };
    });
  } catch (err) {
    console.error(
      `[screeningActivity] list failed for ${userLogin}: ${err instanceof Error ? err.message : String(err)}`,
      err
    );
    return [];
  }
}

/**
 * The unified feed: this log's entries merged with the tenant's
 * re-selection proposals (Phase 3's transparency log) and challenger
 * promotions (Phase 5's promotion records), newest first. Each source
 * is read independently — one broken source never hides the others.
 */
export function buildScreeningActivityFeed(
  sql: SqlExec,
  userLogin: string,
  limit = 100
): ScreeningActivityFeedItem[] {
  const capped = Math.max(1, Math.min(Math.floor(limit) || 100, 500));
  const items: ScreeningActivityFeedItem[] = [];

  for (const entry of listScreeningActivity(sql, userLogin, capped)) {
    items.push({
      id: entry.id,
      at: entry.createdAt,
      kind: entry.kind,
      summary: entry.summary,
      source: "activity",
      detail: entry.detail ?? undefined,
    });
  }

  try {
    for (const row of listReselectionProposals(sql, userLogin, capped)) {
      const p = row.proposal;
      items.push({
        id: row.id,
        at: row.createdAt,
        kind: "reselection",
        source: "reselection",
        summary:
          `Strategy-bank re-selection (${p.regime}): ${p.activeSet.length} active ` +
          `[${p.activeSet.map((a) => a.strategy).join(", ") || "none"}] — ${p.governance} ` +
          `(${p.evaluatedCount} evaluated, cost ${p.costUnitsUsed}/${p.costCapUnits}).`,
        detail: { regime: p.regime, governance: p.governance, logEntries: p.log.length },
      });
    }
  } catch (err) {
    console.error(
      `[screeningActivity] reselection source failed for ${userLogin}: ${err instanceof Error ? err.message : String(err)}`,
      err
    );
  }

  try {
    ensureChallengerTables(sql);
    const rows = Array.from(
      sql.exec(
        `SELECT id, challenger_id, action, actor, reason, weights_version, created_at FROM mas_challenger_promotions WHERE user_login = ? ORDER BY created_at DESC LIMIT ?`,
        userLogin,
        capped
      )
    ) as Array<Record<string, unknown>>;
    for (const r of rows) {
      items.push({
        id: String(r.id ?? ""),
        at: String(r.created_at ?? ""),
        kind: "promotion",
        source: "promotion",
        summary:
          `Challenger ${String(r.challenger_id ?? "")} ${String(r.action ?? "")} by ${String(r.actor ?? "")}` +
          (r.reason ? ` — ${String(r.reason)}` : "") +
          (r.weights_version != null ? ` (weights v${String(r.weights_version)})` : "") +
          `.`,
        detail: { challengerId: r.challenger_id, action: r.action, actor: r.actor },
      });
    }
  } catch (err) {
    console.error(
      `[screeningActivity] promotion source failed for ${userLogin}: ${err instanceof Error ? err.message : String(err)}`,
      err
    );
  }

  items.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return items.slice(0, capped);
}
