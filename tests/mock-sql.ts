/**
 * In-memory Mock SQLite Storage implementing SqlStorage for unit & integration testing.
 */

import type { SqlStorage } from "../src/orm";

export class MockSqlStorage implements SqlStorage {
  private tables = new Map<string, Array<Record<string, any>>>();
  private schema = new Map<string, Array<{ name: string; type: string; pk: number }>>();

  constructor() {
    this.initDefaultSchema();
  }

  private initDefaultSchema() {
    this.schema.set("mas_categories", [
      { name: "id", type: "TEXT", pk: 1 },
      { name: "name", type: "TEXT", pk: 0 },
      { name: "slug", type: "TEXT", pk: 0 },
      { name: "description", type: "TEXT", pk: 0 },
      { name: "icon", type: "TEXT", pk: 0 },
      { name: "is_active", type: "INTEGER", pk: 0 },
      { name: "sort_order", type: "INTEGER", pk: 0 },
      { name: "created_at", type: "TEXT", pk: 0 },
      { name: "updated_at", type: "TEXT", pk: 0 },
    ]);

    this.schema.set("mas_referrals", [
      { name: "id", type: "TEXT", pk: 1 },
      { name: "session_id", type: "TEXT", pk: 0 },
      { name: "title", type: "TEXT", pk: 0 },
      { name: "url", type: "TEXT", pk: 0 },
      { name: "category", type: "TEXT", pk: 0 },
      { name: "reward_text", type: "TEXT", pk: 0 },
      { name: "clicks", type: "INTEGER", pk: 0 },
      { name: "signups", type: "INTEGER", pk: 0 },
      { name: "created_at", type: "TEXT", pk: 0 },
    ]);

    this.schema.set("mas_ads", [
      { name: "id", type: "TEXT", pk: 1 },
      { name: "title", type: "TEXT", pk: 0 },
      { name: "tagline", type: "TEXT", pk: 0 },
      { name: "sponsor", type: "TEXT", pk: 0 },
      { name: "badge", type: "TEXT", pk: 0 },
      { name: "url", type: "TEXT", pk: 0 },
      { name: "cta_text", type: "TEXT", pk: 0 },
      { name: "accent_color", type: "TEXT", pk: 0 },
      { name: "impressions", type: "INTEGER", pk: 0 },
      { name: "clicks", type: "INTEGER", pk: 0 },
      { name: "created_at", type: "TEXT", pk: 0 },
    ]);

    this.schema.set("mas_external_ads", [
      { name: "id", type: "TEXT", pk: 1 },
      { name: "name", type: "TEXT", pk: 0 },
      { name: "network", type: "TEXT", pk: 0 },
      { name: "placement", type: "TEXT", pk: 0 },
      { name: "title", type: "TEXT", pk: 0 },
      { name: "tagline", type: "TEXT", pk: 0 },
      { name: "cta_text", type: "TEXT", pk: 0 },
      { name: "target_url", type: "TEXT", pk: 0 },
      { name: "banner_image_url", type: "TEXT", pk: 0 },
      { name: "cpm_rate", type: "REAL", pk: 0 },
      { name: "cpc_rate", type: "REAL", pk: 0 },
      { name: "impressions", type: "INTEGER", pk: 0 },
      { name: "clicks", type: "INTEGER", pk: 0 },
      { name: "earnings", type: "REAL", pk: 0 },
      { name: "is_active", type: "INTEGER", pk: 0 },
      { name: "created_at", type: "TEXT", pk: 0 },
    ]);

    this.schema.set("mas_transactions", [
      { name: "id", type: "TEXT", pk: 1 },
      { name: "session_id", type: "TEXT", pk: 0 },
      { name: "action", type: "TEXT", pk: 0 },
      { name: "amount", type: "REAL", pk: 0 },
      { name: "currency", type: "TEXT", pk: 0 },
      { name: "customer", type: "TEXT", pk: 0 },
      { name: "gateway", type: "TEXT", pk: 0 },
      { name: "gateway_ref", type: "TEXT", pk: 0 },
      { name: "status", type: "TEXT", pk: 0 },
      { name: "checkout_url", type: "TEXT", pk: 0 },
      { name: "proposer_did", type: "TEXT", pk: 0 },
      { name: "authorizer_did", type: "TEXT", pk: 0 },
      { name: "proof_signature", type: "TEXT", pk: 0 },
      { name: "note", type: "TEXT", pk: 0 },
      { name: "created_at", type: "TEXT", pk: 0 },
      { name: "updated_at", type: "TEXT", pk: 0 },
    ]);

    this.schema.set("mas_messages", [
      { name: "id", type: "TEXT", pk: 1 },
      { name: "session_id", type: "TEXT", pk: 0 },
      { name: "role", type: "TEXT", pk: 0 },
      { name: "content", type: "TEXT", pk: 0 },
      { name: "agent", type: "TEXT", pk: 0 },
      { name: "created_at", type: "TEXT", pk: 0 },
    ]);

    this.schema.set("mas_memory", [
      { name: "key", type: "TEXT", pk: 1 },
      { name: "value", type: "TEXT", pk: 0 },
      { name: "updated_at", type: "TEXT", pk: 0 },
    ]);

    this.schema.set("mas_events", [
      { name: "id", type: "TEXT", pk: 1 },
      { name: "session_id", type: "TEXT", pk: 0 },
      { name: "type", type: "TEXT", pk: 0 },
      { name: "agent", type: "TEXT", pk: 0 },
      { name: "payload", type: "TEXT", pk: 0 },
      { name: "created_at", type: "TEXT", pk: 0 },
    ]);

    for (const key of this.schema.keys()) {
      this.tables.set(key, []);
    }
  }

  exec(query: string, ...args: unknown[]): Iterable<unknown> {
    const q = query.trim();

    // CREATE TABLE IF NOT EXISTS
    if (q.startsWith("CREATE TABLE")) {
      return [];
    }

    // PRAGMA table_info(tableName)
    const pragmaMatch = q.match(/PRAGMA\s+table_info\((\w+)\)/i);
    if (pragmaMatch) {
      const tbl = pragmaMatch[1];
      const cols = this.schema.get(tbl) || [];
      return cols.map((c, i) => ({
        cid: i,
        name: c.name,
        type: c.type,
        notnull: 0,
        dflt_value: null,
        pk: c.pk,
      }));
    }

    // SELECT COUNT(*) FROM table [WHERE ...]
    const countMatch = q.match(/SELECT\s+COUNT\(\*\)\s+AS\s+count\s+FROM\s+(\w+)(?:\s+WHERE\s+(.+))?/i);
    if (countMatch) {
      const tbl = countMatch[1];
      const rows = this.tables.get(tbl) || [];
      const whereClause = countMatch[2];

      if (!whereClause) {
        return [{ count: rows.length }];
      }

      const filtered = this.filterRows(rows, whereClause, args);
      return [{ count: filtered.length }];
    }

    // SELECT * FROM table
    const selectMatch = q.match(/SELECT\s+\*\s+FROM\s+(\w+)(.*?)$/i);
    if (selectMatch) {
      const tbl = selectMatch[1];
      const rest = selectMatch[2] || "";
      let rows = [...(this.tables.get(tbl) || [])];

      // WHERE clause
      const whereMatch = rest.match(/WHERE\s+(.+?)(?:\s+ORDER\s+BY|\s+LIMIT|\s+OFFSET|$)/i);
      let argIndex = 0;
      if (whereMatch) {
        const whereClause = whereMatch[1];
        rows = this.filterRows(rows, whereClause, args);
        // count how many ? were consumed
        const questionMarks = (whereClause.match(/\?/g) || []).length;
        argIndex += questionMarks;
      }

      // ORDER BY clause
      const orderMatch = rest.match(/ORDER\s+BY\s+(\w+)\s+(ASC|DESC)/i);
      if (orderMatch) {
        const field = orderMatch[1];
        const dir = orderMatch[2].toUpperCase();
        rows.sort((a, b) => {
          const valA = a[field] ?? "";
          const valB = b[field] ?? "";
          if (valA < valB) return dir === "ASC" ? -1 : 1;
          if (valA > valB) return dir === "ASC" ? 1 : -1;
          return 0;
        });
      }

      // LIMIT and OFFSET
      const limitMatch = rest.match(/LIMIT\s+(\d+|\?)(?:\s+OFFSET\s+(\d+|\?))?/i);
      if (limitMatch) {
        let limit = limitMatch[1] === "?" ? Number(args[argIndex++]) : Number(limitMatch[1]);
        let offset = 0;
        if (limitMatch[2]) {
          offset = limitMatch[2] === "?" ? Number(args[argIndex++]) : Number(limitMatch[2]);
        }
        rows = rows.slice(offset, offset + limit);
      }

      return rows;
    }

    // INSERT INTO table (cols) VALUES (placeholders)
    const insertMatch = q.match(/INSERT\s+(?:OR\s+IGNORE\s+)?INTO\s+(\w+)\s*\((.*?)\)\s*VALUES\s*\((.*?)\)/i);
    if (insertMatch) {
      const tbl = insertMatch[1];
      const cols = insertMatch[2].split(",").map((c) => c.trim());
      const record: Record<string, any> = {};

      for (let i = 0; i < cols.length; i++) {
        record[cols[i]] = args[i];
      }

      let existing = this.tables.get(tbl);
      if (!existing) {
        existing = [];
        this.tables.set(tbl, existing);
      }

      const idCol = cols[0];
      const existsIndex = existing.findIndex((r) => r[idCol] === record[idCol]);
      if (existsIndex >= 0) {
        // IGNORE
      } else {
        existing.push(record);
      }
      return [];
    }

    // UPDATE table SET col = ?, ... WHERE id = ?
    const updateMatch = q.match(/UPDATE\s+(\w+)\s+SET\s+(.*?)\s+WHERE\s+(.*?)$/i);
    if (updateMatch) {
      const tbl = updateMatch[1];
      const setPart = updateMatch[2];
      const wherePart = updateMatch[3];
      const rows = this.tables.get(tbl) || [];

      // Parse SET assignments
      const assignments = setPart.split(",").map((s) => s.trim());
      let argIdx = 0;
      const updates: Array<{ col: string; val: any; isExpr?: string }> = [];

      for (const assign of assignments) {
        const [col, expr] = assign.split("=").map((s) => s.trim());
        if (expr === "?") {
          updates.push({ col, val: args[argIdx++] });
        } else if (expr.includes("+")) {
          // e.g. impressions = impressions + 1
          updates.push({ col, val: null, isExpr: expr });
        }
      }

      // Filter rows to update
      const whereArgs = args.slice(argIdx);
      const targetRows = this.filterRows(rows, wherePart, whereArgs);

      for (const row of targetRows) {
        for (const u of updates) {
          if (u.isExpr) {
            row[u.col] = (Number(row[u.col]) || 0) + 1;
          } else {
            row[u.col] = u.val;
          }
        }
      }
      return [];
    }

    // DELETE FROM table [WHERE id = ?]
    const deleteMatch = q.match(/DELETE\s+FROM\s+(\w+)(?:\s+WHERE\s+(.+))?/i);
    if (deleteMatch) {
      const tbl = deleteMatch[1];
      const wherePart = deleteMatch[2];

      if (!wherePart) {
        this.tables.set(tbl, []);
        return [];
      }

      const rows = this.tables.get(tbl) || [];
      const toKeep = rows.filter((r) => !this.matchesWhere(r, wherePart, args));
      this.tables.set(tbl, toKeep);
      return [];
    }

    return [];
  }

  private filterRows(rows: Array<Record<string, any>>, whereClause: string, args: unknown[]): Array<Record<string, any>> {
    return rows.filter((r) => this.matchesWhere(r, whereClause, args));
  }

  private matchesWhere(row: Record<string, any>, whereClause: string, args: unknown[]): boolean {
    const conditions = whereClause.split(/\s+AND\s+/i);
    let argIdx = 0;

    for (const cond of conditions) {
      const eqMatch = cond.match(/(\w+)\s*=\s*\?/);
      if (eqMatch) {
        const col = eqMatch[1];
        const val = args[argIdx++];
        if (row[col] != val) return false;
        continue;
      }

      const likeMatch = cond.match(/lower\((\w+)\)\s+LIKE\s+\?/i);
      if (likeMatch) {
        const col = likeMatch[1];
        const pattern = String(args[argIdx++] || "").toLowerCase().replace(/%/g, "");
        const cell = String(row[col] || "").toLowerCase();
        if (!cell.includes(pattern)) return false;
        continue;
      }
    }
    return true;
  }
}
