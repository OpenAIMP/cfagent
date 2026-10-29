/**
 * src/data/ormRepositoryCore.ts — #2345 (#1976 step 3a, ADR
 * 0022 D-A/D-B): the DO-SQLite repository implementation the
 * ORM core's ports run on, moved from src/orm/index.ts. Raw
 * SQL lives behind the ports (D-B dialect ruling: DO-SQLite
 * adapters speak SQL; nothing above this layer does).
 *
 * DISCLOSED D-E FIXES (ADR 0022 D-E.2 — silently-wrong cases
 * only; enumerated on the PR):
 *  1. delete() returned true UNCONDITIONALLY — a caller
 *     summing deletions (retention accounting) counted rows
 *     that were never removed. It now verifies: the cursor's
 *     rowsWritten when the store reports it, otherwise an
 *     existence probe + post-delete re-read.
 *  2. update() re-read the row but never verified the write
 *     landed — a no-op UPDATE returned the stale row as if
 *     updated. It now checks every applied field against the
 *     re-read row and throws on divergence rather than
 *     returning a row that does not carry the update.
 * create()'s conflict policy is declared, not changed
 * (D-E.1): INSERT-or-throw — a PK conflict surfaces as the
 * store's error. upsert stays check-then-act, correct under
 * per-instance serialization (D-0 (b)).
 *
 * Everything else is byte-for-byte the legacy behaviour:
 * camelCase ↔ snake_case mapping with is_* boolean coercion,
 * findMany/findOne/count statement shapes, create returning
 * the passed record.
 *
 * #CDO-mha7
 */
import type { AuditEvent } from "../types";
import {
  linkAuditRow,
} from "../security/auditChain";
import { ensureAuditChainColumns } from "./ormSchema";
import type {
  RepositoryPort,
  RepositoryQueryOptions,
  SqlStorage,
} from "./repositoryPorts";

/** The legacy QueryOptions name, kept for the shim's callers. */
export type QueryOptions = RepositoryQueryOptions;

export class Repository<T extends Record<string, any>>
  implements RepositoryPort<T>
{
  constructor(
    protected sql: SqlStorage,
    public readonly tableName: string,
    protected idField: string = "id",
    protected columnMap: Record<keyof T & string, string>
  ) {}

  private toDbCol(key: string): string {
    return this.columnMap[key] || key;
  }

  private fromDbRow(row: any): T {
    const obj: any = {};
    const reverseMap: Record<string, string> = {};
    for (const [prop, col] of Object.entries(this.columnMap)) {
      reverseMap[col] = prop;
    }

    for (const [key, val] of Object.entries(row)) {
      const propName = reverseMap[key] || key;
      // Handle boolean SQLite mapping (0/1 to boolean)
      if (typeof val === "number" && (key.startsWith("is_") || key === "is_active")) {
        obj[propName] = Boolean(val);
      } else {
        obj[propName] = val;
      }
    }
    return obj as T;
  }

  findMany(options: RepositoryQueryOptions = {}): T[] {
    const clauses: string[] = [];
    const args: unknown[] = [];

    if (options.where) {
      for (const [key, val] of Object.entries(options.where)) {
        if (val !== undefined && val !== null) {
          clauses.push(`${this.toDbCol(key)} = ?`);
          args.push(typeof val === "boolean" ? (val ? 1 : 0) : val);
        }
      }
    }

    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const orderClause = options.orderBy ? `ORDER BY ${options.orderBy}` : "";
    const limitClause = options.limit ? `LIMIT ${options.limit}` : "";
    const offsetClause = options.offset ? `OFFSET ${options.offset}` : "";

    const query = `SELECT * FROM ${this.tableName} ${whereClause} ${orderClause} ${limitClause} ${offsetClause}`.trim();
    const rows = Array.from(this.sql.exec(query, ...args)) as any[];
    return rows.map((r) => this.fromDbRow(r));
  }

  findById(id: string): T | null {
    const query = `SELECT * FROM ${this.tableName} WHERE ${this.idField} = ? LIMIT 1`;
    const rows = Array.from(this.sql.exec(query, id)) as any[];
    if (rows.length === 0) return null;
    return this.fromDbRow(rows[0]);
  }

  findOne(where: Record<string, unknown>): T | null {
    const results = this.findMany({ where, limit: 1 });
    return results.length > 0 ? results[0] : null;
  }

  create(record: T): T {
    const cols: string[] = [];
    const placeholders: string[] = [];
    const values: unknown[] = [];

    for (const [prop, val] of Object.entries(record)) {
      cols.push(this.toDbCol(prop));
      placeholders.push("?");
      values.push(typeof val === "boolean" ? (val ? 1 : 0) : val);
    }

    const query = `INSERT INTO ${this.tableName} (${cols.join(", ")}) VALUES (${placeholders.join(", ")})`;
    this.sql.exec(query, ...values);
    return record;
  }

  update(id: string, updates: Partial<T>): T | null {
    const sets: string[] = [];
    const values: unknown[] = [];

    for (const [prop, val] of Object.entries(updates)) {
      if (prop !== this.idField && val !== undefined) {
        sets.push(`${this.toDbCol(prop)} = ?`);
        values.push(typeof val === "boolean" ? (val ? 1 : 0) : val);
      }
    }

    if (sets.length === 0) return this.findById(id);

    values.push(id);
    const query = `UPDATE ${this.tableName} SET ${sets.join(", ")} WHERE ${this.idField} = ?`;
    this.sql.exec(query, ...values);
    const after = this.findById(id);
    if (!after) return null;
    // D-E.2 (disclosed fix #2345): verify the re-read row
    // carries every applied field — previously a no-op UPDATE
    // returned the stale row as if the write had landed.
    for (const [prop, val] of Object.entries(updates)) {
      if (prop === this.idField || val === undefined) continue;
      if ((after as Record<string, unknown>)[prop] !== val) {
        throw new Error(
          `Repository.update verification failed on ${this.tableName}: field ${prop} did not read back as written`
        );
      }
    }
    return after;
  }

  upsert(record: T): T {
    const id = record[this.idField];
    if (id && this.findById(id)) {
      this.update(id, record);
      return record;
    }
    return this.create(record);
  }

  delete(id: string): boolean {
    // D-E.2 (disclosed fix #2345): verify the removal —
    // previously this returned true unconditionally.
    const existed = this.findById(id) !== null;
    const query = `DELETE FROM ${this.tableName} WHERE ${this.idField} = ?`;
    const cursor = this.sql.exec(query, id) as Iterable<unknown> & {
      rowsWritten?: number;
    };
    Array.from(cursor);
    if (typeof cursor.rowsWritten === "number") {
      return cursor.rowsWritten > 0;
    }
    if (!existed) return false;
    return this.findById(id) === null;
  }

  count(where?: Record<string, unknown>): number {
    const clauses: string[] = [];
    const args: unknown[] = [];

    if (where) {
      for (const [key, val] of Object.entries(where)) {
        if (val !== undefined && val !== null) {
          clauses.push(`${this.toDbCol(key)} = ?`);
          args.push(typeof val === "boolean" ? (val ? 1 : 0) : val);
        }
      }
    }

    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const query = `SELECT COUNT(*) AS count FROM ${this.tableName} ${whereClause}`;
    const raw = Array.from(this.sql.exec(query, ...args)) as Array<{ count: number }>;
    return Number(raw[0]?.count || 0);
  }
}

/**
 * Issue #2178 (Q7 S1): mas_events inserts chain. Every create links
 * onto the table's current tail (last row by insertion order) and
 * stores the link + own hash, so verification can detect tampering,
 * reordering, or a gap. The payload is stored as JSON text: direct
 * Record inserts previously coerced to "[object Object]" in some
 * paths, which is exactly what made payloads unreadable (#1968).
 * The chain step is synchronous (no await between the tail read and
 * the insert), so within one DO instance — mas_events is
 * per-instance storage — appends cannot interleave and fork.
 *
 * Moved unchanged in #2345 (gate G-5: the chain's shape, hash
 * inputs, and verification rules are frozen).
 */
export class ChainedAuditRepository extends Repository<AuditEvent> {
  override create(record: AuditEvent): AuditEvent {
    ensureAuditChainColumns(this.sql);
    const tail = Array.from(
      this.sql.exec(`SELECT event_hash FROM mas_events ORDER BY rowid DESC LIMIT 1`),
    ) as Array<{ event_hash?: string | null }>;
    const previousEventHash = tail[0]?.event_hash ?? null;
    const payloadText =
      typeof record.payload === "string" ? record.payload : JSON.stringify(record.payload ?? {});
    const chained = linkAuditRow(
      {
        id: record.id,
        sessionId: record.sessionId,
        type: record.type,
        agent: record.agent,
        payload: payloadText,
        createdAt: record.createdAt,
      },
      previousEventHash,
    );
    return super.create({
      ...record,
      payload: payloadText as unknown as Record<string, unknown>,
      previousEventHash: chained.previousEventHash,
      eventHash: chained.eventHash,
    });
  }
}
