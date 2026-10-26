import React from "react";

export interface TableColumn<T> {
  key: string;
  header: React.ReactNode;
  render: (row: T) => React.ReactNode;
  align?: "left" | "center" | "right";
  /** Class applied to every body cell in this column (surface cell styles); a function computes it per row. */
  cellClassName?: string | ((row: T) => string);
  /** Class applied to the column's <th> (e.g. sticky first columns). */
  headerClassName?: string;
  /** Inline style for the column's body cells, computed per row (e.g. heatmap shading). */
  cellStyle?: (row: T) => React.CSSProperties;
}

export interface TableProps<T> {
  columns: TableColumn<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  caption?: string;
  /** Rendered instead of the table when rows is empty (usually EmptyState). */
  empty?: React.ReactNode;
  rowClassName?: string | ((row: T) => string);
  className?: string;
  containerClassName?: string;
}

/**
 * Table (#492)
 * Semantic data table from a column config (docs/agents/ux-architecture.md
 * section 6: task table; section 13: charts/tables need text alternatives
 * — a real <table> is the accessible baseline). Styles: ./primitives.css.
 */
export function Table<T>({
  columns,
  rows,
  rowKey,
  caption,
  empty,
  rowClassName = "",
  className = "",
  containerClassName = "",
}: TableProps<T>) {
  if (rows.length === 0 && empty) return <>{empty}</>;
  return (
    <div className={containerClassName || undefined}>
      <table className={`ui-table ${className}`}>
        {caption && <caption className="ui-table-caption">{caption}</caption>}
        <thead>
          <tr>
            {columns.map((col) => (
              <th
                key={col.key}
                scope="col"
                className={`${col.headerClassName ?? ""} ${col.align ? `align-${col.align}` : ""}`.trim() || undefined}
              >
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={rowKey(row)}
              className={
                (typeof rowClassName === "function" ? rowClassName(row) : rowClassName) || undefined
              }
            >
              {columns.map((col) => (
                <td
                  key={col.key}
                  className={`${typeof col.cellClassName === "function" ? col.cellClassName(row) : (col.cellClassName ?? "")} ${col.align ? `align-${col.align}` : ""}`.trim() || undefined}
                  style={col.cellStyle?.(row)}
                >
                  {col.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
