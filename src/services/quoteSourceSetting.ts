/**
 * Issue #2108 (slice C) — the deployment-wide quote source setting.
 *
 * The WS + HTTP quotes surfaces share one Worker-level liveMarketCache,
 * so the source pick is deployment-wide, not per-user (per-user streams
 * are a named structural follow-up). The setting lives in D1 through
 * the Worker's own AGENT_DB binding, following the established
 * ensure-tables + CREATE TABLE IF NOT EXISTS pattern. Absent store,
 * missing row, or invalid value all fail open to "auto" — the legacy
 * env-driven behavior — never to an error.
 */

export type QuoteSource = "auto" | "alpaca" | "yahoo";

const SOURCES: QuoteSource[] = ["auto", "alpaca", "yahoo"];

export function normalizeQuoteSource(value: unknown): QuoteSource {
  return typeof value === "string" && (SOURCES as string[]).includes(value)
    ? (value as QuoteSource)
    : "auto";
}

/** Minimal structural shape of the D1 binding this module needs. */
export interface QuoteSourceStore {
  prepare(sql: string): {
    bind(...args: unknown[]): {
      first<T = Record<string, unknown>>(): Promise<T | null>;
      run(): Promise<unknown>;
    };
    run(): Promise<unknown>;
  };
}

const CREATE_SQL = `CREATE TABLE IF NOT EXISTS quote_source_setting (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  source TEXT NOT NULL,
  updated_at INTEGER NOT NULL
)`;

export async function ensureQuoteSourceTable(db: QuoteSourceStore): Promise<void> {
  await db.prepare(CREATE_SQL).run();
}

export async function getQuoteSource(db?: QuoteSourceStore | null): Promise<QuoteSource> {
  if (!db) return "auto";
  try {
    const row = await db
      .prepare("SELECT source FROM quote_source_setting WHERE id = 1")
      .bind()
      .first<{ source?: unknown }>();
    return normalizeQuoteSource(row?.source);
  } catch {
    // Missing table, unbound store, or any read failure: legacy behavior.
    return "auto";
  }
}

export async function setQuoteSource(
  db: QuoteSourceStore,
  source: QuoteSource,
): Promise<QuoteSource> {
  const normalized = normalizeQuoteSource(source);
  await ensureQuoteSourceTable(db);
  await db
    .prepare(
      `INSERT INTO quote_source_setting (id, source, updated_at) VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET source = excluded.source, updated_at = excluded.updated_at`,
    )
    .bind(normalized, Date.now())
    .run();
  return normalized;
}
